import { Extension } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { t } from '../i18n';
import { daysUntil, dueLabel } from './dates';
import { repeatLabel } from './repeat';

// Lo que va escrito detrás de una casilla («📅 2026-11-15 ⏫ #obra») se ve
// como fichas: «Hoy», una bandera de color, la etiqueta… como en Things o
// en Craft. El texto sigue siendo el mismo Markdown: con el cursor dentro de
// una ficha se ve tal cual, para cambiarlo a mano (como en Obsidian).

type Chip = { from: number; to: number; at: number; kind: string; label: string; tone?: string; date?: string };

const DATE = String.raw`(\d{4}-\d{2}-\d{2})`;
const CLOCK = String.raw`(\d{1,2}:\d{2})`;
// Cada marca con lo que la sigue; los espacios de delante no entran.
const MARKS = new RegExp(
  [
    String.raw`(📅️?\s*${DATE})`,
    String.raw`(🛫️?\s*${DATE})`,
    String.raw`(✅️?\s*${DATE})`,
    String.raw`(⏰️?\s*${CLOCK}(?:\s*[-–]\s*${CLOCK})?)`,
    String.raw`(🔺|⏫|🔼|🔽|⏬)️?`,
    String.raw`(🔁️?\s*(?:[^📅✅⏫🔼🔽⏬🔺🛫⏳➕⏰#\n]*[^📅✅⏫🔼🔽⏬🔺🛫⏳➕⏰#\s])?)`,
    String.raw`(?<=^|\s)(#[\p{L}\p{N}_-]+)`,
  ].join('|'),
  'gu',
);
const PRIO: Record<string, [number, string]> = {
  '🔺': [3, 'Prioridad alta'],
  '⏫': [3, 'Prioridad alta'],
  '🔼': [2, 'Prioridad media'],
  '🔽': [1, 'Prioridad baja'],
  '⏬': [1, 'Prioridad baja'],
};

const short = (d: string) => dueLabel(d);

function chipsIn(text: string, at: number, done: boolean): Chip[] {
  const out: Chip[] = [];
  for (const m of text.matchAll(MARKS)) {
    // El espacio de delante va con la ficha: así no queda una raya suelta
    // entre fichas cuando la tarea está hecha (y tachada).
    const pad = /\s*$/.exec(text.slice(0, m.index!))![0].length;
    const from = at + m.index! - pad;
    const to = at + m.index! + m[0].length;
    if (m[1]) {
      const n = daysUntil(m[2]);
      out.push({ from, to, at: at + m.index!, kind: 'due', date: m[2], label: short(m[2]), tone: done ? undefined : n < 0 ? 'late' : n === 0 ? 'today' : undefined });
    } else if (m[3]) out.push({ from, to, at: at + m.index!, kind: 'start', label: t('desde {fecha}', { fecha: short(m[4]) }) });
    else if (m[5]) out.push({ from, to, at: at + m.index!, kind: 'done', label: short(m[6]) });
    else if (m[7]) out.push({ from, to, at: at + m.index!, kind: 'time', label: m[9] ? `${m[8]}–${m[9]}` : m[8] });
    else if (m[10]) {
      const [p, name] = PRIO[m[10]];
      out.push({ from, to, at: at + m.index!, kind: 'prio', label: t(name), tone: `p${p}` });
    } else if (m[11]) {
      const rule = m[11].replace(/^🔁️?\s*/u, '');
      out.push({ from, to, at: at + m.index!, kind: 'repeat', label: rule ? repeatLabel(rule) : t('Se repite') });
    } else if (m[12]) out.push({ from, to, at: at + m.index!, kind: 'tag', label: m[12].slice(1) });
  }
  return out;
}

function build(doc: PMNode, state: EditorState, editing: boolean): DecorationSet {
  const decos: Decoration[] = [];
  const { from: selFrom, to: selTo } = state.selection;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return true;
    const para = node.firstChild;
    if (para?.type.name !== 'paragraph') return true;
    let prio = 0;
    para.forEach((child, offset) => {
      if (!child.isText || !child.text || child.marks.some((m) => m.type.name === 'code')) return;
      const start = pos + 2 + offset;
      for (const c of chipsIn(child.text, start, !!node.attrs.checked)) {
        if (c.kind === 'prio') prio = Number(c.tone!.slice(1));
        // Con el cursor dentro (o justo al lado), se escribe sobre el texto tal cual.
        if (editing && selFrom <= c.to && selTo >= c.from) continue;
        decos.push(
          Decoration.inline(
            c.from,
            c.to,
            {
              class: `tk-chip tk-${c.kind}${c.tone ? ` is-${c.tone}` : ''}`,
              'data-label': c.kind === 'prio' ? '' : c.label,
              title: c.kind === 'due' ? t('{fecha} · pulsa para cambiarla', { fecha: c.label }) : c.label,
            },
            { chip: c },
          ),
        );
      }
    });
    if (prio) decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-prio': String(prio) }));
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export const DUE_EVENT = 'canvian:task-due';
export type DueRequest = { date: string; set: (date: string | null) => void };

type ChipState = { decos: DecorationSet; focused: boolean };
const key = new PluginKey<ChipState>('taskChips');

export const TaskChips = Extension.create({
  name: 'taskChips',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<ChipState>({
        key,
        state: {
          init: (_, state) => ({ decos: build(state.doc, state, false), focused: false }),
          apply: (tr, old, _prev, state) => {
            // Sin el cursor en el editor, todas las fichas se ven.
            const meta = tr.getMeta(key) as boolean | undefined;
            const focused = meta ?? old.focused;
            if (!tr.docChanged && !tr.selectionSet && meta === undefined) return old;
            return { decos: build(state.doc, state, focused && editor.isEditable), focused };
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decos,
          // Pulsar la fecha abre el calendario (lo pinta <DueChipPicker>, fuera del editor).
          handleDOMEvents: {
            mousedown: (view, e) => {
              const el = (e.target as HTMLElement).closest?.('.tk-due');
              if (!el || !view.editable || e.button !== 0) return false;
              const pos = view.posAtDOM(el, 0);
              const deco = key.getState(view.state)?.decos.find(pos, pos + 1).find((d) => (d.spec as { chip?: Chip }).chip?.kind === 'due');
              const chip = (deco?.spec as { chip?: Chip } | undefined)?.chip;
              if (!chip?.date) return false;
              e.preventDefault();
              const from = chip.at;
              const to = chip.to;
              window.dispatchEvent(
                new CustomEvent<DueRequest>(DUE_EVENT, {
                  detail: {
                    date: chip.date,
                    set: (date) => {
                      const { state } = view;
                      // Mismo sitio y mismo texto que al pulsar: si no, no se toca nada.
                      if (!/^📅/u.test(state.doc.textBetween(from, to))) return;
                      view.dispatch(date ? state.tr.insertText(`📅 ${date}`, from, to) : state.tr.delete(chip.from, to));
                    },
                  },
                }),
              );
              return true;
            },
            focus: (view) => {
              view.dispatch(view.state.tr.setMeta(key, true));
              return false;
            },
            blur: (view) => {
              view.dispatch(view.state.tr.setMeta(key, false));
              return false;
            },
          },
        },
      }),
    ];
  },
});
