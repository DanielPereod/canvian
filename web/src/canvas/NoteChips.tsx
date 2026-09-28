import type { CSSProperties } from 'react';
import { parseProps, type NoteRow, type PropertyDef } from '../api';
import { daysUntil, dueLabel } from './dates';
import { PRIORITIES, hueOf } from './Inspector';

const MAX = 4;

// Resumen de propiedades al pie de la nota. Un clic abre el panel (P).
export function NoteChips({ note, defs, onOpen }: { note: NoteRow; defs: PropertyDef[]; onOpen: () => void }) {
  const chips: { key: string; text: string; className?: string; style?: CSSProperties; title?: string }[] = [];

  if (note.priority)
    chips.push({ key: 'prio', text: PRIORITIES[note.priority], className: `chip-prio prio-${note.priority}`, title: `Prioridad ${PRIORITIES[note.priority].toLowerCase()}` });
  if (note.dueAt) {
    const n = daysUntil(note.dueAt);
    const open = note.status !== 'done';
    chips.push({
      key: 'due',
      text: dueLabel(note.dueAt),
      className: `chip-due${open && n < 0 ? ' overdue' : open && n <= 1 ? ' soon' : ''}`,
    });
  }
  const props = parseProps(note.props);
  for (const def of defs) {
    const v = props[def.id];
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v)) {
      for (const t of v) chips.push({ key: `${def.id}:${t}`, text: `#${t}`, className: 'chip-option', style: { '--chip': hueOf(t) } as CSSProperties, title: def.name });
      continue;
    }
    if (def.type === 'select')
      chips.push({ key: def.id, text: String(v), className: 'chip-option', style: { '--chip': hueOf(String(v)) } as CSSProperties, title: def.name });
    else if (def.type === 'checkbox') chips.push({ key: def.id, text: `✓ ${def.name}` });
    else if (def.type === 'date') chips.push({ key: def.id, text: `${def.name} · ${dueLabel(String(v))}` });
    else if (def.type === 'url') {
      let host = String(v);
      try {
        host = new URL(host).hostname.replace(/^www\./, '');
      } catch {
        // Si no es una URL válida se muestra tal cual.
      }
      chips.push({ key: def.id, text: `↗ ${host}`, title: def.name });
    } else chips.push({ key: def.id, text: `${def.name} · ${v}` });
  }
  if (!chips.length) return null;
  const shown = chips.slice(0, MAX);

  return (
    <div
      className="note-chips nodrag"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {shown.map((c, i) => (
        <span key={c.key} className={`note-chip ${c.className ?? ''}`} style={{ ...c.style, '--i': i } as CSSProperties} title={c.title}>
          {c.className?.includes('chip-prio') ? <i /> : null}
          {c.text}
        </span>
      ))}
      {chips.length > MAX && <span className="note-chip more">+{chips.length - MAX}</span>}
    </div>
  );
}
