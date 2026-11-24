import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

// La IA de Canvian es Claude Code (la herramienta de terminal) con la
// suscripción de Claude de la persona. Canvian no guarda ninguna clave de API:
// guarda el token largo que da `claude setup-token` y lanza `claude -p` por
// detrás para cada respuesta. Todo se conecta desde la web (Configuración ›
// Asistentes IA), sin tocar el contenedor: el inicio de sesión se hace con el
// mismo `claude setup-token`, que aquí corre en un terminal falso (`script`)
// para que la persona abra el enlace y pegue el código desde el navegador.

const TOKEN = 'claude_oauth_token';
const MODEL = 'claude_model';

export type AiAsk = {
  /** Las instrucciones fijas (el papel del tutor y sus reglas). */
  system: string;
  /** Lo que se le pide esta vez (con todo el contexto que necesita). */
  prompt: string;
  /** JSON Schema de la respuesta, si se quiere estructurada. */
  schema?: Record<string, unknown>;
  /** Deja buscar y leer páginas en internet (para elegir fuentes). */
  web?: boolean;
};
export type AiAnswer = { text: string; json: unknown };
export type Ai = { ask: (q: AiAsk) => Promise<AiAnswer> };

export class AiError extends Error {
  constructor(
    message: string,
    /** auth: hay que volver a conectar · off: no está conectado · fail: lo demás. */
    readonly code: 'auth' | 'off' | 'fail' = 'fail',
  ) {
    super(message);
  }
}

const get = (db: Db, key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
const put = (db: Db, key: string, value: string) =>
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();

export const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
export const MODELS = ['', 'opus', 'sonnet', 'haiku'] as const;

export function aiStatus(db: Db) {
  const token = get(db, TOKEN);
  return {
    connected: !!token,
    // Solo el final, para reconocerlo; el token entero no vuelve a salir.
    tokenHint: token ? `…${token.slice(-6)}` : null,
    model: get(db, MODEL) ?? '',
    checkedAt: get(db, 'claude_checked_at'),
    lastError: get(db, 'claude_last_error'),
  };
}
export const saveToken = (db: Db, token: string) => {
  put(db, TOKEN, token);
  db.delete(settings).where(eq(settings.key, 'claude_last_error')).run();
};
export const forgetToken = (db: Db) =>
  db.delete(settings).where(inArray(settings.key, [TOKEN, 'claude_checked_at', 'claude_last_error'])).run();
export const saveModel = (db: Db, model: string) => put(db, MODEL, model);

// Cómo se lanza Claude Code. `bin` se puede cambiar (CANVIAN_CLAUDE_BIN) y
// `home` es su carpeta de trabajo, junto a la base (en el volumen /data).
export type ClaudeEnv = { bin?: string; home: string; timeoutMs?: number };

function envFor(home: string, token?: string) {
  mkdirSync(join(home, 'work'), { recursive: true });
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ ?? '',
    DISABLE_AUTOUPDATER: '1',
    ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
  };
}

// Lo que dice Claude Code cuando el token ya no vale (caducado o revocado).
const AUTH_HINT = /(401|403|oauth|authenticat|unauthori[sz]ed|invalid api key|log ?in|token (has )?expired|revoked)/i;

export function claudeAi(db: Db, env: ClaudeEnv): Ai {
  const bin = env.bin ?? process.env.CANVIAN_CLAUDE_BIN ?? 'claude';
  return {
    ask: (q) =>
      new Promise<AiAnswer>((resolve, reject) => {
        const token = get(db, TOKEN);
        if (!token) return reject(new AiError('Conecta Claude en Configuración › Asistentes IA para que te enseñe.', 'off'));
        const model = get(db, MODEL);
        const args = [
          '-p',
          '--output-format', 'json',
          '--system-prompt', q.system,
          // Ni ajustes, ni CLAUDE.md, ni servidores MCP de nadie: solo esto.
          '--setting-sources', '',
          '--strict-mcp-config',
          '--no-session-persistence',
          '--tools', q.web ? 'WebSearch,WebFetch' : '',
          ...(q.web ? ['--allowedTools', 'WebSearch', 'WebFetch'] : []),
          ...(q.schema ? ['--json-schema', JSON.stringify(q.schema)] : []),
          ...(model ? ['--model', model] : []),
        ];
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn(bin, args, { cwd: join(env.home, 'work'), env: envFor(env.home, token) });
        } catch {
          return reject(new AiError('Claude Code no está instalado en el servidor.', 'fail'));
        }
        let out = '';
        let err = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), env.timeoutMs ?? (q.web ? 300_000 : 180_000));
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(new AiError(e.code === 'ENOENT' ? 'Claude Code no está instalado en el servidor.' : e.message, 'fail'));
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const fail = (msg: string) => {
            const auth = AUTH_HINT.test(msg);
            put(db, 'claude_last_error', msg.slice(0, 300));
            reject(new AiError(auth ? 'La sesión de Claude ha caducado: vuelve a conectarla en Configuración › Asistentes IA.' : `Claude no ha podido responder: ${msg.slice(0, 200)}`, auth ? 'auth' : 'fail'));
          };
          if (signal === 'SIGKILL') return fail('ha tardado demasiado');
          let res: { is_error?: boolean; result?: string; structured_output?: unknown; api_error_status?: number | null } | null = null;
          try {
            res = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '');
          } catch {
            res = null;
          }
          if (!res) return fail((err || out || `salió con ${code}`).trim());
          if (res.is_error || code !== 0) return fail(`${res.api_error_status ?? ''} ${res.result ?? err}`.trim());
          put(db, 'claude_checked_at', new Date().toISOString());
          db.delete(settings).where(eq(settings.key, 'claude_last_error')).run();
          let json: unknown = res.structured_output ?? null;
          if (q.schema && json === null && res.result) {
            try {
              json = JSON.parse(res.result);
            } catch {
              json = null;
            }
          }
          if (q.schema && (json === null || typeof json !== 'object')) return fail('la respuesta no tenía el formato esperado');
          resolve({ text: res.result ?? '', json });
        });
        child.stdin.end(q.prompt);
      }),
  };
}

// ── Inicio de sesión desde la web ────────────────────────────────────
// `claude setup-token` abre el navegador para iniciar sesión y luego pide que
// se pegue un código. Aquí corre dentro de `script` (un terminal de mentira,
// muy ancho para que no parta el enlace ni el token), se lee el enlace de lo
// que pinta y el código que pega la persona en la web se le escribe por la
// entrada. Al final pinta el token, que se guarda.

const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;
const URL_RE = /https:\/\/[^\s\x07\x1b"'<>]*(oauth|authorize)[^\s\x07\x1b"'<>]*/;
export const clean = (raw: string) => raw.replace(ANSI, '');

type Login = { child: ChildProcessWithoutNullStreams; out: string; url: string | null; token: string | null; done: boolean; error: string | null; started: number };

export function loginFlow(db: Db, env: ClaudeEnv & { script?: string }) {
  const bin = env.bin ?? process.env.CANVIAN_CLAUDE_BIN ?? 'claude';
  let current: Login | null = null;

  const stop = () => {
    if (current && !current.done) current.child.kill('SIGKILL');
    current = null;
  };
  const waitFor = (l: Login, ok: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (ok()) return resolve(true);
        if (l.done || Date.now() - t0 > ms) return resolve(ok());
        setTimeout(tick, 150);
      };
      tick();
    });

  return {
    /** Empieza: devuelve el enlace en el que hay que iniciar sesión. */
    async start(): Promise<{ url: string }> {
      stop();
      const cmd = `stty cols 2000 rows 60 2>/dev/null; exec ${bin.replace(/[^\w./-]/g, '')} setup-token`;
      const child = spawn(env.script ?? 'script', ['-qfc', cmd, '/dev/null'], {
        cwd: join(env.home, 'work'),
        env: { ...envFor(env.home), BROWSER: 'true', TERM: 'xterm-256color' },
      });
      const l: Login = { child, out: '', url: null, token: null, done: false, error: null, started: Date.now() };
      current = l;
      const scan = () => {
        const raw = l.out;
        l.url ??= URL_RE.exec(raw)?.[0] ?? URL_RE.exec(clean(raw))?.[0] ?? null;
        if (!l.token) {
          const m = TOKEN_RE.exec(clean(raw).replace(/[│┃|]/g, ' '));
          if (m) {
            l.token = m[0];
            saveToken(db, l.token);
          }
        }
      };
      child.stdout.on('data', (d) => {
        l.out += d;
        scan();
      });
      child.stderr.on('data', (d) => (l.out += d));
      child.on('error', (e: NodeJS.ErrnoException) => {
        l.error = e.code === 'ENOENT' ? 'Falta Claude Code (o «script») en el servidor.' : e.message;
        l.done = true;
      });
      child.on('close', () => {
        scan();
        l.done = true;
      });
      // Si nadie termina, se cierra solo a los 15 minutos.
      setTimeout(() => {
        if (current === l) stop();
      }, 15 * 60_000).unref?.();
      await waitFor(l, () => !!l.url, 30_000);
      if (!l.url) {
        const why = l.error ?? (clean(l.out).trim().split('\n').slice(-3).join(' ') || 'no ha salido ningún enlace');
        stop();
        throw new AiError(`No se ha podido empezar a iniciar sesión: ${why.slice(0, 200)}`);
      }
      return { url: l.url };
    },
    /** Pega el código que da claude.ai al terminar; devuelve si ya hay token. */
    async code(code: string): Promise<boolean> {
      const l = current;
      if (!l || l.done) throw new AiError('El inicio de sesión ha caducado: empieza otra vez.');
      l.child.stdin.write(code.trim());
      // Como al pulsar Intro en el terminal.
      setTimeout(() => l.child.stdin.write('\r'), 300);
      await waitFor(l, () => !!l.token, 45_000);
      if (!l.token) {
        const tail = clean(l.out).trim().split('\n').slice(-4).join(' ');
        throw new AiError(`Claude no ha aceptado el código. ${/invalid|error|fail/i.test(tail) ? tail.slice(0, 200) : 'Prueba otra vez.'}`);
      }
      stop();
      return true;
    },
    cancel: stop,
  };
}
