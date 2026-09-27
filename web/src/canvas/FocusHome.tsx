import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteRow } from '../api';
import { parentMap, pathText, resolvePath, routeText } from './sections';
import { FROM_PALETTE } from '../ActionPalette';

// Experimento «Foco»: en vez del mapa, una sola lista en el centro que se
// funde arriba y abajo. Sin escribir, lo último que tocaste; al teclear,
// lo que coincide, lo más parecido en el centro.

type Props = {
  rows: NoteRow[];
  paused: boolean;
  onOpen: (id: string) => void;
  onSection: (id: string) => void;
  onCreate: (text: string) => void;
  // Crear con ruta «Padre>Hijo>Nota»: las secciones que falten, dentro de `zoneId`, y la nota al final.
  onCreatePath: (zoneId: string | null, sections: string[], title: string) => void;
  onMap: () => void;
};

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const STEP = 58;
const SPAN = 9;

type Hit = { row: NoteRow; score: number; title: string; path: string; depth: number };

function scoreOf(title: string, body: string, words: string[]) {
  let s = 0;
  for (const w of words) {
    const t = title.indexOf(w);
    if (t === 0) s += 4;
    else if (t > 0) s += /[\s\-_/.(]/.test(title[t - 1]) ? 3 : 1.5;
    else if (body.includes(w)) s += 1;
    else return 0;
  }
  return s;
}

// Trozo del texto alrededor de la primera coincidencia, para la nota del centro.
function snippet(text: string, words: string[]) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const n = norm(clean);
  const at = words.length ? Math.max(0, ...words.map((w) => n.indexOf(w)).filter((i) => i >= 0).slice(0, 1)) : 0;
  const from = Math.max(0, at - 40);
  return (from > 0 ? '…' : '') + clean.slice(from, from + 140) + (from + 140 < clean.length ? '…' : '');
}

function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  // Las marcas se buscan en el texto normalizado (sin tildes), que mide lo mismo.
  const n = norm(text);
  const on = new Array<boolean>(text.length).fill(false);
  for (const w of words) for (let i = n.indexOf(w); i >= 0; i = n.indexOf(w, i + 1)) on.fill(true, i, i + w.length);
  const parts: { t: string; m: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.m === on[i]) last.t += text[i];
    else parts.push({ t: text[i], m: on[i] });
  }
  return <>{parts.map((p, i) => (p.m ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>))}</>;
}

export function FocusHome({ rows, paused, onOpen, onSection, onCreate, onCreatePath, onMap }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  // «Padre>Hijo>texto»: los tramos antes del último «>» son secciones y lo
  // último es lo que se busca (o el título de la nota nueva).
  const segs = query.split('>');
  const last = segs[segs.length - 1];
  const prefixKey = segs.slice(0, -1).join('>');
  const words = useMemo(() => norm(last).split(/\s+/).filter(Boolean), [last]);

  // Madre de cada nota y cuáles tienen hijas (esas se ven como secciones).
  const parent = useMemo(() => parentMap(rows), [rows]);
  const branches = useMemo(() => new Set([...parent.values()].filter((p): p is string => !!p)), [parent]);

  // Hasta dónde existe la ruta escrita: las notas encontradas y los nombres que faltan.
  const route = useMemo(() => {
    if (!prefixKey && segs.length < 2) return null;
    return resolvePath(rows, parent, prefixKey.split('>').map((n) => n.trim()).filter(Boolean));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefixKey, segs.length > 1, rows, parent]);

  // La lista es el árbol: cada sección y, sangradas debajo, sus notas y
  // subsecciones. Sin escribir, lo tocado hace poco arriba; buscando, las
  // ramas con lo más parecido arriba, con sus secciones como contexto.
  const hits = useMemo<Hit[]>(() => {
    if (route && route.missing.length) return [];
    const t = (r: NoteRow) => (r.updatedAt ? Date.parse(r.updatedAt) : 0);
    const titleOf = (r: NoteRow) => r.title || (r.kind === 'task' ? 'Tarea sin título' : 'Nota sin título');
    const isBranch = (r: NoteRow) => branches.has(r.id);
    const kids = new Map<string | null, NoteRow[]>();
    for (const r of rows) {
      const p = parent.get(r.id) ?? null;
      kids.set(p, [...(kids.get(p) ?? []), r]);
    }
    const score = new Map<string, number>();
    if (words.length) for (const r of rows) {
      const s = scoreOf(norm(titleOf(r)), norm(r.bodyText ?? ''), words);
      if (s) score.set(r.id, s + (isBranch(r) ? 0.5 : 0));
    }
    // Lo que pesa una rama: su mejor coincidencia o, sin buscar, lo último tocado.
    const weight = new Map<string, number>();
    const seen = new Set<string>();
    const weigh = (r: NoteRow): number => {
      if (weight.has(r.id)) return weight.get(r.id)!;
      if (seen.has(r.id)) return 0;
      seen.add(r.id);
      let w = words.length ? (score.get(r.id) ?? 0) : t(r);
      for (const c of kids.get(r.id) ?? []) w = Math.max(w, weigh(c));
      weight.set(r.id, w);
      return w;
    };
    const out: Hit[] = [];
    const walk = (parent: string | null, depth: number, path: string) => {
      const list = (kids.get(parent) ?? []).filter((r) => !words.length || weigh(r) > 0);
      // Buscando, lo más parecido primero; si no, las notas del nivel y después las subsecciones.
      if (words.length) list.sort((a, b) => weigh(b) - weigh(a) || t(b) - t(a));
      else list.sort((a, b) => Number(isBranch(a)) - Number(isBranch(b)) || weigh(b) - weigh(a) || t(b) - t(a));
      for (const r of list) {
        if (out.length >= 600) return;
        out.push({ row: r, title: titleOf(r), score: score.get(r.id) ?? 0, path, depth });
        if (isBranch(r)) walk(r.id, depth + 1, path ? `${path} › ${titleOf(r)}` : titleOf(r));
      }
    };
    // Con ruta, solo lo que hay dentro de la última sección.
    if (route && route.zoneId) {
      walk(route.zoneId, 0, route.found.map(titleOf).join(' › '));
      return out;
    }
    // En la raíz, las secciones primero y lo suelto al final.
    const roots = (kids.get(null) ?? []).filter((r) => !words.length || weigh(r) > 0);
    const zones = roots.filter(isBranch).sort((a, b) => weigh(b) - weigh(a));
    const loose = roots.filter((r) => !isBranch(r)).sort((a, b) => weigh(b) - weigh(a) || t(b) - t(a));
    if (words.length) {
      // Buscando, manda la relevancia: lo suelto entra entre las ramas según su puntuación.
      const all = [...zones, ...loose].sort((a, b) => weigh(b) - weigh(a));
      for (const r of all) {
        out.push({ row: r, title: titleOf(r), score: score.get(r.id) ?? 0, path: '', depth: 0 });
        if (isBranch(r)) walk(r.id, 1, titleOf(r));
      }
    } else {
      for (const z of zones) {
        out.push({ row: z, title: titleOf(z), score: 0, path: '', depth: 0 });
        walk(z.id, 1, titleOf(z));
      }
      for (const r of loose) out.push({ row: r, title: titleOf(r), score: 0, path: '', depth: 0 });
    }
    return out;
  }, [rows, words, route, parent, branches]);

  // Buscando, el cursor empieza en la primera coincidencia, no en su sección.
  useEffect(() => {
    if (words.length) setCursor(Math.max(0, hits.findIndex((h) => h.score > 0)));
    else setCursor(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, prefixKey]);

  const at = Math.min(cursor, Math.max(0, hits.length - 1));
  const cur = hits[at];

  // La lista se desliza hacia el cursor con calma, no de golpe.
  const [pos, setPos] = useState(0);
  const posRef = useRef(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const d = at - posRef.current;
      posRef.current = Math.abs(d) < 0.002 ? at : posRef.current + d * 0.16;
      setPos(posRef.current);
      if (posRef.current !== at) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [at]);

  // Ruta completa de una fila, como se escribe: «Viaje a Japón>Qué ver>».
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const pathOf = (r: NoteRow) => pathText(r, byId, parent, branches.has(r.id));


  // Con ruta, Enter crea salvo que lo señalado se llame justo así.
  const title = last.trim();
  const creating = !!route && !!title && !(cur && norm(cur.title) === norm(title));

  const open = () => {
    if (route && (creating || (!cur && !title))) {
      if (title) onCreatePath(route.zoneId, route.missing, title);
      else if (!route.missing.length && route.zoneId) onSection(route.zoneId);
      else if (route.missing.length) onCreatePath(route.zoneId, route.missing, '');
      setQuery('');
      return;
    }
    if (cur) {
      if (branches.has(cur.row.id)) onSection(cur.row.id);
      else onOpen(cur.row.id);
    } else if (query.trim()) {
      onCreate(query.trim());
      setQuery('');
    }
  };

  // Todo lo que se teclea es la búsqueda; las combinaciones con Ctrl/⌘ siguen
  // yendo a sus atajos (Ctrl P, configuración…).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || FROM_PALETTE in e) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const mod = e.metaKey || e.ctrlKey || e.altKey;
      if (e.key === 'ArrowDown') setCursor(Math.min(hits.length - 1, at + 1));
      else if (e.key === 'ArrowUp') setCursor(Math.max(0, at - 1));
      else if (e.key === 'PageDown') setCursor(Math.min(hits.length - 1, at + 8));
      else if (e.key === 'PageUp') setCursor(Math.max(0, at - 8));
      else if (e.key === 'Enter') open();
      else if (e.key === 'Tab' && !mod) {
        // Completa con lo señalado; una sección queda abierta con «>» para seguir.
        if (cur) setQuery(pathOf(cur.row));
      }
      else if (e.key === 'Escape') {
        if (query) setQuery('');
        else onMap();
      } else if (e.key === 'Backspace') {
        setQuery((q) => (mod ? '' : q.slice(0, -1)));
      } else if (!mod && e.key.length === 1) {
        setQuery((q) => (q || e.key !== ' ' ? q + e.key : q));
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // La rueda también mueve la lista, de una en una.
  const wheel = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    wheel.current += e.deltaY;
    const steps = Math.trunc(wheel.current / 60);
    if (!steps) return;
    wheel.current -= steps * 60;
    setCursor(Math.max(0, Math.min(hits.length - 1, at + steps)));
  };

  const lo = Math.max(0, Math.floor(pos) - SPAN);
  const hi = Math.min(hits.length, Math.ceil(pos) + SPAN + 1);

  return (
    <div className="focus-home" onWheel={onWheel}>
      <div className={`focus-query${query ? ' has-text' : ''}`} aria-live="polite">
        {query ? (
          <>
            <span className="display">{query}</span>
            <span className="focus-caret" aria-hidden="true" />
          </>
        ) : (
          <span className="display focus-hint">Escribe para buscar</span>
        )}
      </div>
      <div className="focus-list" role="listbox" aria-label="Notas">
        {hits.slice(lo, hi).map((h, k) => {
          const i = lo + k;
          const d = i - pos;
          const a = Math.abs(d);
          const here = i === at;
          return (
            <div
              key={h.row.id}
              role="option"
              aria-selected={here}
              className={`focus-item${here ? ' is-here' : ''} focus-kind-${branches.has(h.row.id) ? 'zone' : h.row.kind}${h.row.status === 'done' ? ' is-done' : ''}${words.length && !h.score ? ' is-context' : ''}`}
              style={{
                transform: `translate(-50%, calc(-50% + ${d * STEP}px)) scale(${Math.max(0.55, 1 - a * 0.07)})`,
                opacity: Math.max(0, 1 - a * 0.14),
                '--depth': h.depth,
              } as React.CSSProperties}
              onClick={() => (here ? open() : setCursor(i))}
            >
              <span className="focus-glyph" aria-hidden="true" />
              <span className="focus-title">
                <Marked text={h.title} words={words} />
              </span>
              {here && !branches.has(h.row.id) && h.row.kind !== 'canvas' && h.row.bodyText && (
                <span className="focus-meta">
                  {h.row.bodyText && (
                    <span className="focus-snippet">
                      <Marked text={snippet(h.row.bodyText.split('\n').slice(h.row.title ? 1 : 0).join(' '), words)} words={words} />
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        })}
        {!hits.length && (
          <div className="focus-item is-here focus-empty" style={{ transform: 'translate(-50%, -50%)' }}>
            <span className="focus-title">{route ? title || route.missing[route.missing.length - 1] || 'Aquí no hay nada todavía' : 'Nada se llama así'}</span>
            <span className="focus-meta">
              <span className="meta">{route ? routeText(route, title) : `Enter crea una nota con «${query.trim()}»`}</span>
            </span>
          </div>
        )}
      </div>
      {route && creating && hits.length > 0 && <p className="meta focus-where">{routeText(route, title)}</p>}
      <p className="meta focus-foot">
        {words.length ? `${hits.length} ${hits.length === 1 ? 'coincidencia' : 'coincidencias'} · ` : ''}↑↓ moverse · Tab completar · Enter abrir · {'>'} dentro de · Esc {query ? 'borrar' : 'mapa'}
      </p>
    </div>
  );
}

