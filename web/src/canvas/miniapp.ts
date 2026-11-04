import { Node } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { t } from '../i18n';
import type { DbResult } from '../api';
import { dbSource } from './dbquery';
import { onDbChange } from './dbEvents';

// Mini apps: un bloque con HTML, CSS y JS propios (una calculadora, un
// conversor…) que se ejecuta dentro de la nota. Va en un iframe con
// `sandbox="allow-scripts"` y sin `allow-same-origin`: su origen es opaco, así
// que no ve la sesión, ni las cookies, ni la API, ni el resto de la página.
// Solo habla con la nota por postMessage: para decir cuánto mide, recibir los
// colores y letras del tema y consultar las bases de datos (solo leer, con
// canvian.db.query y canvian.db.watch; la nota hace la consulta por ella). En
// Markdown es un bloque ```app con el código dentro.

const SANDBOX = 'allow-scripts allow-forms allow-popups';
const MAX_HEIGHT = 2000;

// Los tokens que la mini app recibe, con el mismo nombre que en la app.
const TOKENS = [
  '--bg', '--text', '--text-muted', '--text-faint', '--surface-1', '--surface-2', '--surface-sunken', '--surface-hover',
  '--line', '--line-strong', '--accent', '--accent-ink', '--accent-soft', '--accent-line', '--accent-contrast',
  '--danger', '--success', '--warning', '--highlight', '--font-ui', '--font-mono', '--read-font', '--title-font',
  '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-btn', '--radius-pill',
  '--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-2xl', '--text-3xl',
];

type Theme = { vars: Record<string, string>; scheme: string };
function readTheme(): Theme {
  const vars: Record<string, string> = {};
  if (typeof document === 'undefined') return { vars, scheme: 'normal' };
  const cs = getComputedStyle(document.documentElement);
  for (const k of TOKENS) {
    const v = cs.getPropertyValue(k).trim();
    if (v) vars[k] = v;
  }
  return { vars, scheme: cs.colorScheme || 'normal' };
}

// Lo que va dentro del iframe antes del código: los estilos de base (para que
// un <button> o un <input> sin más ya parezcan de Canvian) y el puente.
const BASE_CSS = `
html{background:transparent}
body{margin:0;padding:10px 2px;font-family:var(--font-ui,system-ui,sans-serif);font-size:var(--text-md,15px);line-height:1.5;color:var(--text,CanvasText);-webkit-text-size-adjust:100%}
*,*::before,*::after{box-sizing:border-box}
h1,h2,h3,h4{font-family:var(--title-font,inherit);line-height:1.2;margin:0 0 .5em}
p{margin:0 0 .6em}
a{color:var(--accent-ink,var(--accent,LinkText))}
input,select,textarea,button{font:inherit;color:inherit}
input,select,textarea{min-height:36px;padding:6px 10px;border:1px solid var(--line-strong,#8886);border-radius:var(--radius-sm,6px);background:var(--surface-sunken,transparent);max-width:100%}
input[type=checkbox],input[type=radio]{min-height:0;accent-color:var(--accent)}
input[type=range]{padding:0;border:0;background:none;accent-color:var(--accent)}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent-line,var(--accent));outline-offset:1px}
button{min-height:36px;padding:0 16px;border:0;border-radius:var(--radius-btn,8px);background:var(--accent,ButtonFace);color:var(--accent-contrast,ButtonText);cursor:pointer;font-weight:600}
button:hover{filter:brightness(1.06)}
button:active{transform:scale(.97)}
button.secondary{background:transparent;color:var(--text);border:1px solid var(--line-strong,#8886);font-weight:400}
label{display:inline-grid;gap:4px;font-size:var(--text-sm,13px);color:var(--text-muted,inherit)}
output,.result{display:block;font-size:var(--text-xl,22px);font-weight:600;color:var(--text)}
.muted{color:var(--text-muted)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:end}
.grid{display:grid;gap:10px}
.card{padding:12px 14px;border:1px solid var(--line,#8884);border-radius:var(--radius-md,10px);background:var(--surface-1,transparent)}
table{border-collapse:collapse}th,td{padding:4px 10px;border-bottom:1px solid var(--line,#8884);text-align:left}
code,pre{font-family:var(--font-mono,ui-monospace,monospace);font-size:.92em}
`;

// Corre dentro del iframe. Avisa de lo que mide (para que no haya barras de
// desplazamiento) y de los errores, y aplica el tema que le manda la nota.
const BRIDGE = `(function(){
var root=document.documentElement,last=0;
function send(m){m.canvianApp=1;try{parent.postMessage(m,'*')}catch(e){}}
function size(){var h=Math.ceil(root.getBoundingClientRect().height);if(h!==last){last=h;send({height:h})}}
addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d||!d.canvianTheme)return;var v=d.canvianTheme;for(var k in v)root.style.setProperty(k,v[k]);root.style.colorScheme=d.scheme||'';size()});
addEventListener('error',function(e){send({error:String(e.message||e),line:e.lineno||0})});
addEventListener('unhandledrejection',function(e){send({error:String(e.reason&&e.reason.message||e.reason)})});
addEventListener('load',size);
var reqs={},n=0;
addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d||!d.canvianDb)return;var r=reqs[d.canvianDb];if(!r)return;if(!r.watch)delete reqs[d.canvianDb];if(d.error){if(r.watch)r.onError&&r.onError(new Error(d.error));else r.ko(new Error(d.error))}else if(r.watch)r.cb(d.result);else r.ok(d.result)});
window.canvian={db:{
query:function(q){return new Promise(function(ok,ko){var id=++n;reqs[id]={ok:ok,ko:ko};send({dbQuery:String(q),req:id})})},
watch:function(q,cb,onError){var id=++n;reqs[id]={watch:1,cb:cb,onError:onError};send({dbWatch:String(q),req:id});return function(){delete reqs[id];send({dbUnwatch:id})}}
}};
if(window.ResizeObserver)new ResizeObserver(size).observe(root);else setInterval(size,500);
send({ready:1});
})();`;

export function appDoc(code: string): string {
  const { vars, scheme } = readTheme();
  const root = Object.entries(vars).map(([k, v]) => `${k}:${v.replace(/[<>{}]/g, '')}`).join(';');
  const head = [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<style>:root{${root};color-scheme:${scheme}}${BASE_CSS}</style>`,
    `<script>${BRIDGE}</script>`,
    '</head><body>',
  ].join('');
  codeStart = head.split('\n').length - 1;
  return `${head}${code}</body></html>`;
}
// Cuántas líneas van antes del código, para que los errores digan su línea.
let codeStart = 0;

// ── El lado de la nota ────────────────────────────────────────────────
// Un solo oyente para todas las mini apps de la página (también las de las
// vistas previas, que son HTML suelto): cada mensaje se casa con su iframe.
let listening = false;
let theme: Theme | null = null;
const frames = () => document.querySelectorAll<HTMLIFrameElement>('iframe.note-app-frame');
const sendTheme = (f: HTMLIFrameElement) => {
  theme ??= readTheme();
  f.contentWindow?.postMessage({ canvianTheme: theme.vars, scheme: theme.scheme }, '*');
};

// Lo que recibe la mini app de una consulta: las filas como objetos (por
// nombre de columna), además de las columnas y el id de cada fila.
const forApp = (r: DbResult) => ({
  table: r.table.name,
  columns: r.columns.map((c) => c.name),
  rows: r.rows.map((row, i) => ({ ...Object.fromEntries(r.columns.map((c, j) => [c.name, row[j]])), ...(r.ids ? { _id: r.ids[i] } : {}) })),
  more: r.more,
});
type Watch = { frame: HTMLIFrameElement; req: number; query: string };
const watches: Watch[] = [];
let stopWatching: (() => void) | null = null;
function answer(f: HTMLIFrameElement, req: number, query: string) {
  const src = dbSource();
  const reply = (m: Record<string, unknown>) => f.contentWindow?.postMessage({ canvianDb: req, ...m }, '*');
  if (!src) return reply({ error: t('Aquí no hay bases de datos') });
  src.run(query).then(
    (r) => reply({ result: forApp(r) }),
    (e: Error) => reply({ error: e.message }),
  );
}
function rewatch() {
  for (let i = watches.length - 1; i >= 0; i--) if (!watches[i].frame.isConnected) watches.splice(i, 1);
  if (!watches.length) {
    stopWatching?.();
    stopWatching = null;
    return;
  }
  for (const w of watches) answer(w.frame, w.req, w.query);
}

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('message', (e) => {
    const d = e.data as { canvianApp?: number; ready?: number; height?: number; error?: string; line?: number; dbQuery?: string; dbWatch?: string; dbUnwatch?: number; req?: number } | null;
    if (!d || d.canvianApp !== 1 || !e.source) return;
    for (const f of frames()) {
      if (f.contentWindow !== e.source) continue;
      if (typeof d.dbQuery === 'string' && typeof d.req === 'number') answer(f, d.req, d.dbQuery.slice(0, 5000));
      if (typeof d.dbWatch === 'string' && typeof d.req === 'number') {
        watches.push({ frame: f, req: d.req, query: d.dbWatch.slice(0, 5000) });
        answer(f, d.req, d.dbWatch.slice(0, 5000));
        if (!stopWatching && dbSource()?.live) stopWatching = onDbChange(rewatch);
      }
      if (typeof d.dbUnwatch === 'number') {
        const i = watches.findIndex((w) => w.frame === f && w.req === d.dbUnwatch);
        if (i >= 0) watches.splice(i, 1);
      }
      if (d.ready) sendTheme(f);
      if (typeof d.height === 'number') f.style.height = `${Math.max(32, Math.min(MAX_HEIGHT, d.height))}px`;
      if (d.error) f.dispatchEvent(new CustomEvent('apperror', { detail: d.line && d.line > codeStart ? `${d.error} (${t('línea {n}', { n: d.line - codeStart })})` : d.error }));
      break;
    }
  });
  // El tema cambia en <html> (atributos y estilo del acento); el acento se
  // funde, así que se vuelve a mandar al acabar el fundido.
  let timer = 0;
  const again = () => {
    theme = null;
    frames().forEach(sendTheme);
  };
  const changed = () => {
    requestAnimationFrame(again);
    clearTimeout(timer);
    timer = window.setTimeout(again, 700);
  };
  new MutationObserver(changed).observe(document.documentElement, { attributes: true });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', changed);
}

function makeFrame(code: string) {
  listen();
  const f = document.createElement('iframe');
  f.className = 'note-app-frame';
  f.setAttribute('sandbox', SANDBOX);
  f.title = t('Mini app');
  f.referrerPolicy = 'no-referrer';
  f.srcdoc = appDoc(code);
  return f;
}

// La primera mini app que se crea desde el menú «/» sale con su código abierto.
let editNext = false;
export const editNextApp = () => {
  editNext = true;
};

export const APP_TEMPLATE = `<!-- Escribe aquí HTML, CSS y JavaScript. Los botones y campos ya llevan el estilo de tu tema. -->
<div class="row">
  <label>Importe <input id="importe" type="number" value="40" step="0.01"></label>
  <label>Propina % <input id="propina" type="number" value="10"></label>
  <label>Personas <input id="personas" type="number" value="2" min="1"></label>
</div>
<p class="muted" style="margin-top:12px">Cada uno paga</p>
<output id="total"></output>

<script>
  const $ = (id) => document.getElementById(id);
  function calcular() {
    const total = $('importe').valueAsNumber * (1 + $('propina').valueAsNumber / 100);
    const cada = total / Math.max(1, $('personas').valueAsNumber);
    $('total').textContent = isFinite(cada) ? cada.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }) : '—';
  }
  document.querySelectorAll('input').forEach((i) => i.addEventListener('input', calcular));
  calcular();
</script>
`;

export const MiniApp = Node.create({
  name: 'miniApp',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ code: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-mini-app]', getAttrs: (el) => ({ code: el.dataset.code ?? '' }) }],
  // Fuera del editor (vistas previas, notas incrustadas) la mini app también
  // funciona, con el mismo aislamiento.
  renderHTML: ({ node }) => {
    const code = String(node.attrs.code ?? '');
    return ['div', { 'data-mini-app': '', 'data-code': code, class: 'note-app' }, ['iframe', { class: 'note-app-frame', sandbox: SANDBOX, srcdoc: appDoc(code), title: t('Mini app'), referrerpolicy: 'no-referrer', loading: 'lazy' }]];
  },
  renderText: () => '',
  addNodeView() {
    return ({ node: first, getPos, editor }) => {
      listen();
      let node: PMNode = first;
      const dom = document.createElement('div');
      dom.className = 'note-app';
      dom.dataset.miniApp = '';
      let frame = makeFrame(String(node.attrs.code ?? ''));
      dom.append(frame);
      const error = document.createElement('div');
      error.className = 'note-app-error';
      error.hidden = true;
      const onError = (e: Event) => {
        error.textContent = String((e as CustomEvent).detail ?? '');
        error.hidden = false;
      };
      frame.addEventListener('apperror', onError);
      // Rehacer el iframe: cambiar srcdoc en uno ya cargado no siempre lo reinicia.
      const run = (code: string) => {
        error.hidden = true;
        const next = makeFrame(code);
        next.style.height = frame.style.height;
        next.addEventListener('apperror', onError);
        frame.replaceWith(next);
        frame = next;
      };

      let panel: HTMLDivElement | null = null;
      let area: HTMLTextAreaElement | null = null;
      let editBtn: HTMLButtonElement | null = null;
      let timer = 0;
      const save = () => {
        clearTimeout(timer);
        const pos = getPos();
        if (!area || typeof pos !== 'number' || area.value === node.attrs.code) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, code: area.value }));
      };
      const close = () => {
        if (!panel) return;
        save();
        panel.remove();
        panel = area = null;
        dom.classList.remove('is-editing');
        if (editBtn) editBtn.textContent = t('Editar código');
      };
      const open = () => {
        if (panel) return;
        dom.classList.add('is-editing');
        if (editBtn) editBtn.textContent = t('Listo');
        panel = document.createElement('div');
        panel.className = 'note-app-editor';
        panel.contentEditable = 'false';
        area = document.createElement('textarea');
        area.className = 'note-app-code';
        area.value = String(node.attrs.code ?? '');
        area.spellcheck = false;
        area.setAttribute('autocapitalize', 'off');
        area.setAttribute('autocomplete', 'off');
        area.setAttribute('autocorrect', 'off');
        area.setAttribute('aria-label', t('Código de la mini app'));
        area.rows = Math.min(24, Math.max(8, area.value.split('\n').length + 1));
        // Se guarda (y se vuelve a ejecutar) al dejar de escribir un momento.
        area.addEventListener('input', () => {
          clearTimeout(timer);
          timer = window.setTimeout(save, 700);
        });
        area.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
            editor.commands.focus();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Tab' && !e.shiftKey && area) {
            e.preventDefault();
            area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
            area.dispatchEvent(new Event('input'));
          }
        });
        area.addEventListener('blur', save);
        const hint = document.createElement('div');
        hint.className = 'note-app-hint';
        hint.textContent = t('Se ejecuta aislada: no ve tus notas ni tu sesión. Puede leer tus bases de datos con canvian.db.query(…).');
        panel.append(area, hint);
        dom.append(panel);
        area.focus();
      };

      if (editor.isEditable) {
        const bar = document.createElement('div');
        bar.className = 'note-youtube-bar';
        bar.contentEditable = 'false';
        const button = (label: string, act: () => void) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.addEventListener('mousedown', (e) => e.preventDefault());
          b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            act();
          });
          bar.append(b);
          return b;
        };
        button(t('Reiniciar'), () => run(String(node.attrs.code ?? '')));
        editBtn = button(t('Editar código'), () => (panel ? close() : open()));
        button(t('Quitar'), () => {
          const pos = getPos();
          if (typeof pos !== 'number') return;
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
          editor.commands.focus();
        });
        dom.append(bar);
      }
      dom.append(error);
      if (editNext && editor.isEditable) {
        editNext = false;
        requestAnimationFrame(open);
      }

      return {
        dom,
        update: (next: PMNode) => {
          if (next.type !== node.type) return false;
          const changed = next.attrs.code !== node.attrs.code;
          node = next;
          if (changed) {
            run(String(next.attrs.code ?? ''));
            if (area && document.activeElement !== area) area.value = String(next.attrs.code ?? '');
          }
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: (e: Event) => e.target instanceof HTMLElement && !!e.target.closest('.note-youtube-bar, .note-app-editor'),
        destroy: () => clearTimeout(timer),
      };
    };
  },
});
