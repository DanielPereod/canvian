import { useEffect, useMemo, useRef, useState } from 'react';
import { parentMap } from './sections';
import type { NoteRow } from '../api';
import { daysUntil, dueLabel } from './dates';
import { TaskGlyph } from './TaskGlyph';
import { useExperiments } from '../lab/experiments';
import { actionFor, keysBlocked } from '../keys';
import { BackArrow } from '../BackArrow';

// Otra vista, fuera del mapa: todas las tareas activas (las que no están
// hechas) del perfil, vengan de la sección que vengan, en una sola lista.
// Arriba se apuntan tareas rápidas: cosas pequeñas que solo viven aquí, sin
// nota detrás, fuera del mapa y de la búsqueda.

export type TaskGrouping = 'estado' | 'seccion' | 'fecha';
const GROUPINGS: { id: TaskGrouping; label: string }[] = [
  { id: 'estado', label: 'Estado' },
  { id: 'fecha', label: 'Fecha' },
  { id: 'seccion', label: 'Dentro de' },
];
const GROUP_KEY = 'canvian.tasksGrouping';

function readGrouping(): TaskGrouping {
  try {
    const v = localStorage.getItem(GROUP_KEY);
    return v === 'seccion' || v === 'fecha' ? v : 'estado';
  } catch {
    return 'estado';
  }
}

// Lo que más urge arriba: en curso, vencida o cerca, prioridad, lo último tocado.
const urgency = (r: NoteRow) =>
  (r.status === 'doing' ? 1000 : r.status === 'blocked' ? -1000 : 0) +
  (r.dueAt ? 400 - Math.max(-30, Math.min(60, daysUntil(r.dueAt))) * 5 : 0) +
  (r.priority ?? 0) * 60 +
  (r.updatedAt ? Date.parse(r.updatedAt) / 1e11 : 0);

function whenGroup(r: NoteRow): [number, string] {
  if (!r.dueAt) return [5, 'Sin fecha'];
  const d = daysUntil(r.dueAt);
  if (d < 0) return [0, 'Vencidas'];
  if (d === 0) return [1, 'Hoy'];
  if (d <= 7) return [2, 'Esta semana'];
  if (d <= 31) return [3, 'Este mes'];
  return [4, 'Más adelante'];
}

type Props = {
  rows: NoteRow[];
  onOpen: (id: string) => void;
  onCycle: (id: string) => void;
  onBlock: (id: string) => void;
  quick: NoteRow[];
  onAddQuick: (title: string) => void;
  onEditQuick: (id: string, title: string) => void;
  onDeleteQuick: (id: string) => void;
  onClose: () => void;
  /** A dónde vuelve «←»: el mapa o la lista de Foco. */
  back: string;
  paused: boolean;
};

export function TasksView({ rows, quick, onOpen, onCycle, onBlock, onAddQuick, onEditQuick, onDeleteQuick, onClose, back, paused }: Props) {
  const { maduran } = useExperiments();
  const [grouping, setGrouping] = useState<TaskGrouping>(readGrouping);
  // El cursor sigue a la tarea aunque cambie de grupo; si desaparece, se queda en su sitio.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const lastAt = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const add = () => {
    const title = adding.trim();
    if (!title) return;
    onAddQuick(title);
    setAdding('');
  };

  // Al cerrar el campo también llega un blur: solo cuenta el primer final.
  const editDone = useRef(false);
  const startEdit = (r: NoteRow) => {
    editDone.current = false;
    setEditing({ id: r.id, text: r.title ?? '' });
  };
  const finishEdit = (save: boolean) => {
    if (!editing || editDone.current) return;
    editDone.current = true;
    const title = editing.text.trim();
    if (save) title ? onEditQuick(editing.id, title) : onDeleteQuick(editing.id);
    setEditing(null);
  };

  // Una tarea rápida se edita en su sitio; una con nota abre la nota.
  const open = (r: NoteRow) => (r.kind === 'quick' ? startEdit(r) : onOpen(r.id));

  const choose = (g: TaskGrouping) => {
    setGrouping(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      // Sin almacenamiento local no se recuerda, sin más.
    }
  };

  // Ruta de notas madre de cada tarea («Casa › Cocina»).
  const sectionOf = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parent = parentMap(rows);
    return (r: NoteRow) => {
      const names: string[] = [];
      for (let z = byId.get(parent.get(r.id) ?? ''); z; z = byId.get(parent.get(z.id) ?? '')) names.unshift(z.title || 'Nota sin título');
      return names.join(' › ');
    };
  }, [rows]);

  const tasks = [...rows.filter((r) => r.kind === 'task'), ...quick];
  const active = tasks.filter((r) => r.status !== 'done');
  const doneCount = tasks.length - active.length;

  const groups = useMemo(() => {
    const out = new Map<string, { key: number | string; title: string; items: NoteRow[] }>();
    for (const r of active) {
      let key: number | string;
      let title: string;
      if (grouping === 'estado') [key, title] = r.status === 'doing' ? [0, 'En curso'] : r.status === 'blocked' ? [2, 'Bloqueadas'] : [1, 'Por hacer'];
      else if (grouping === 'fecha') [key, title] = whenGroup(r);
      else if (r.kind === 'quick') [key, title] = ['\uFFFE', 'Tareas rápidas'];
      else {
        title = sectionOf(r) || 'Arriba del todo';
        key = sectionOf(r) ? title.toLocaleLowerCase('es') : '￿';
      }
      const g = out.get(title) ?? { key, title, items: [] };
      g.items.push(r);
      out.set(title, g);
    }
    const list = [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const g of list) g.items.sort((a, b) => urgency(b) - urgency(a));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, quick, grouping, sectionOf]);

  const flat = groups.flatMap((g) => g.items);
  const found = flat.findIndex((r) => r.id === cursorId);
  const at = found >= 0 ? found : Math.min(lastAt.current, Math.max(0, flat.length - 1));
  lastAt.current = at;
  const setCursor = (idx: number) => setCursorId(flat[idx]?.id ?? null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.tasks-row.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (paused || keysBlocked()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const action = actionFor(e, ['tasks', 'cycleStatus', 'blockTask', 'newNote', 'deleteCell']);
      const k = e.metaKey || e.ctrlKey || e.altKey ? '' : e.key.toLowerCase();
      const cur = flat[at];
      if (k === 'escape' || action === 'tasks') onClose();
      else if (action === 'cycleStatus') cur && onCycle(cur.id);
      else if (action === 'blockTask') cur && onBlock(cur.id);
      else if (action === 'newNote') addRef.current?.focus();
      else if (action === 'deleteCell' && cur?.kind === 'quick') onDeleteQuick(cur.id);
      else if (k === 'arrowdown' || k === 'j') setCursor(Math.min(flat.length - 1, at + 1));
      else if (k === 'arrowup' || k === 'k') setCursor(Math.max(0, at - 1));
      else if (k === 'enter' && cur) open(cur);
      else if (k === 'tab') choose(GROUPINGS[(GROUPINGS.findIndex((g) => g.id === grouping) + (e.shiftKey ? 2 : 1)) % 3].id);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  let i = 0;
  return (
    <div className="tasks-view">
      <header className="tasks-top">
        <button className="sheet-back meta" onClick={onClose}>
          <BackArrow /> {back}
        </button>
        <nav className="tasks-group-by" aria-label="Agrupar por">
          {GROUPINGS.map((g) => (
            <button key={g.id} className={`meta${g.id === grouping ? ' is-on' : ''}`} onClick={() => choose(g.id)}>
              {g.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="tasks-body" ref={listRef}>
        <h1 className="display tasks-title">
          Tareas <em>activas</em>
        </h1>
        <p className="meta tasks-sub">
          {active.length === 1 ? '1 activa' : `${active.length} activas`}
          {doneCount > 0 && ` · ${doneCount} hechas`}
        </p>
        <input
          ref={addRef}
          className="tasks-add"
          placeholder="Añadir tarea…"
          aria-label="Añadir tarea rápida"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
            else if (e.key === 'Escape') e.currentTarget.blur();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        {!active.length && <p className="tasks-empty">Nada pendiente.</p>}
        {groups.map((g) => (
          <section key={g.title} className="tasks-group">
            <h2 className="tasks-group-title">
              {g.title} <span className="meta">{g.items.length}</span>
            </h2>
            {g.items.map((r) => {
              const idx = i++;
              const where = grouping === 'seccion' ? '' : sectionOf(r);
              const due = r.dueAt ? daysUntil(r.dueAt) : null;
              return (
                <div
                  key={r.id}
                  className={`tasks-row${idx === at ? ' is-cursor' : ''}`}
                  style={{ '--i': Math.min(idx, 20) } as React.CSSProperties}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => editing?.id !== r.id && open(r)}
                >
                  <TaskGlyph status={r.status ?? 'todo'} ripe={maduran} onCycle={() => onCycle(r.id)} />
                  {editing?.id === r.id ? (
                    <input
                      className="tasks-row-edit"
                      autoFocus
                      aria-label="Editar tarea"
                      value={editing.text}
                      onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                      onBlur={() => finishEdit(true)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') finishEdit(true);
                        else if (e.key === 'Escape') finishEdit(false);
                        else return;
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    />
                  ) : (
                    <span className="tasks-row-title">{r.title || 'Tarea sin título'}</span>
                  )}
                  {r.kind === 'quick' && editing?.id !== r.id && (
                    <button
                      className="tasks-row-del meta"
                      aria-label="Borrar tarea"
                      title="Borrar"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteQuick(r.id);
                      }}
                    >
                      ×
                    </button>
                  )}
                  {!!r.priority && <span className="tasks-prio" aria-label={`Prioridad ${r.priority}`}>{'•'.repeat(Math.min(3, r.priority))}</span>}
                  {where && <span className="meta tasks-where">{where}</span>}
                  {r.dueAt && <span className={`meta tasks-due${due! < 0 ? ' is-late' : due! <= 1 ? ' is-soon' : ''}`}>{dueLabel(r.dueAt)}</span>}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
