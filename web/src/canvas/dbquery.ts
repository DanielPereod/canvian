import { Node, nodeInputRule } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { DbResult } from '../api';
import { locale, t, tn } from '../i18n';
import { onDbChange } from './dbEvents';
import { hueOf } from './Inspector';

// Un bloque ```db``` en una nota: una consulta (SELECT de solo lectura) a las
// bases de datos que se ve como su resultado, siempre al día. La consulta la
// hace quien abre la nota: dentro de la app, la API con sesión; en una nota
// pública, el enlace compartido (que solo deja hacer las consultas que hay en
// lo compartido).

export type DbSource = {
  run: (query: string) => Promise<DbResult>;
  // Ponerse al día solo con los cambios (no en las notas públicas).
  live: boolean;
  noteTitle?: (id: string) => string | null;
  onOpenNote?: (id: string) => void;
  onOpenTable?: (tableId: string) => void;
};

let source: DbSource | null = null;
const waiting = new Set<() => void>();
export function setDbSource(next: DbSource | null) {
  source = next;
  for (const w of waiting) w();
}

// La fuente de ahora (para las mini apps, que consultan a través de la nota).
export const dbSource = () => source;

export const DB_TEMPLATE = 'SELECT * FROM ';

let editNext = false;
export const editNextDb = () => {
  editNext = true;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const chip = (label: string, colored = false) => {
  const c = el('span', 'note-db-chip', label);
  if (colored) c.style.setProperty('--chip', hueOf(label));
  return c;
};

function cell(v: unknown, type: string): globalThis.Node | string {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) {
    const f = document.createDocumentFragment();
    v.forEach((x) => f.append(chip(String(x), true)));
    return f;
  }
  switch (type) {
    case 'number':
      return typeof v === 'number' ? v.toLocaleString(locale(), { maximumFractionDigits: 4 }) : String(v);
    case 'checkbox':
      return v ? '✓' : '';
    case 'date': {
      const s = String(v);
      const d = new Date(s.length === 10 ? `${s}T12:00:00` : s);
      return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric', ...(s.length > 10 ? { hour: '2-digit', minute: '2-digit' } : {}) });
    }
    case 'select':
      return chip(String(v), true);
    case 'url': {
      const s = String(v);
      if (!/^https?:\/\//i.test(s)) return s;
      const a = el('a', '', s.replace(/^https?:\/\/(www\.)?/, ''));
      a.href = s;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      return a;
    }
    case 'image': {
      const s = String(v);
      if (!/^(https?:\/\/|\/api\/)/.test(s)) return s;
      const img = el('img', 'dbv-img');
      img.src = s;
      img.alt = '';
      img.loading = 'lazy';
      return img;
    }
    case 'note': {
      const id = String(v);
      const title = source?.noteTitle?.(id);
      if (!title || !source?.onOpenNote) return title ?? '';
      const a = el('a', 'wikilink', title);
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        source?.onOpenNote?.(id);
      });
      return a;
    }
    default:
      return String(v);
  }
}

// El resultado: un número grande si es un solo valor agregado; si no, una tabla.
export function renderResult(box: HTMLElement, r: DbResult) {
  box.replaceChildren();
  if (!r.ids && r.rows.length === 1 && r.columns.length === 1) {
    const v = r.rows[0][0];
    box.append(el('div', 'note-db-big', typeof v === 'number' ? v.toLocaleString(locale(), { maximumFractionDigits: 2 }) : String(v ?? '—')), el('div', 'note-db-big-label', r.columns[0].name));
    return;
  }
  if (!r.rows.length) {
    box.append(el('div', 'note-db-empty', t('Ninguna fila cumple la consulta')));
  } else {
    const scroll = el('div', 'note-db-scroll');
    const table = el('table', 'note-db-table');
    const head = el('tr');
    r.columns.forEach((c) => head.append(el('th', c.type === 'number' ? 'is-number' : '', c.name)));
    table.append(el('thead'), el('tbody'));
    table.tHead!.append(head);
    for (const row of r.rows) {
      const tr = el('tr');
      row.forEach((v, i) => {
        const td = el('td', r.columns[i].type === 'number' ? 'is-number' : '');
        td.append(cell(v, r.columns[i].type));
        tr.append(td);
      });
      table.tBodies[0].append(tr);
    }
    scroll.append(table);
    box.append(scroll);
  }
  const foot = el('div', 'note-db-foot');
  foot.append(el('span', '', tn(r.rows.length, '{n} fila', '{n} filas') + (r.more ? ` · ${t('hay más: usa LIMIT')}` : '')));
  if (source?.onOpenTable) {
    const open = el('button', '', t('Abrir «{table}»', { table: r.table.name }));
    open.type = 'button';
    open.addEventListener('mousedown', (e) => e.preventDefault());
    open.addEventListener('click', (e) => {
      e.preventDefault();
      source?.onOpenTable?.(r.table.id);
    });
    foot.append(open);
  }
  box.append(foot);
}

export const DbQuery = Node.create({
  name: 'dbQuery',
  // Antes que los bloques de código, para que «```db» sea esto y no código.
  priority: 1000,
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ query: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-db-query]', getAttrs: (e) => ({ query: e.dataset.query ?? '' }) }],
  // Fuera del editor (vistas previas) se ve la consulta.
  renderHTML: ({ node }) => ['div', { 'data-db-query': '', 'data-query': String(node.attrs.query ?? ''), class: 'note-db' }, ['pre', { class: 'note-db-static' }, String(node.attrs.query ?? '')]],
  renderText: () => '',
  // «```db» y espacio (o Intro) al principio de una línea: un bloque nuevo.
  addInputRules() {
    return [
      nodeInputRule({
        find: /^```db[\s\n]$/,
        type: this.type,
        getAttributes: () => {
          editNext = true;
          return { query: DB_TEMPLATE };
        },
      }),
    ];
  },
  addNodeView() {
    return ({ node: first, getPos, editor }) => {
      let node: PMNode = first;
      const dom = el('div', 'note-db');
      dom.dataset.dbQuery = '';
      const out = el('div', 'note-db-out');
      let seq = 0;
      const run = () => {
        const q = String(node.attrs.query ?? '').trim();
        const mine = ++seq;
        if (!q) {
          out.replaceChildren(el('div', 'note-db-empty', t('Escribe una consulta: SELECT … FROM …')));
          return;
        }
        if (!source) return;
        if (!stop && source.live) stop = onDbChange(run);
        source.run(q).then(
          (r) => mine === seq && renderResult(out, r),
          (e: Error) => mine === seq && out.replaceChildren(el('div', 'note-db-error', e.message)),
        );
      };
      const onSource = () => run();
      waiting.add(onSource);
      let stop: (() => void) | null = null;

      let panel: HTMLDivElement | null = null;
      let area: HTMLTextAreaElement | null = null;
      let editBtn: HTMLButtonElement | null = null;
      let timer = 0;
      const save = () => {
        clearTimeout(timer);
        const pos = getPos();
        if (!area || typeof pos !== 'number' || area.value === node.attrs.query) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, query: area.value }));
      };
      const close = () => {
        if (!panel) return;
        save();
        panel.remove();
        panel = area = null;
        dom.classList.remove('is-editing');
        if (editBtn) editBtn.textContent = t('Editar consulta');
      };
      const open = () => {
        if (panel) return;
        dom.classList.add('is-editing');
        if (editBtn) editBtn.textContent = t('Listo');
        panel = el('div', 'note-db-editor');
        panel.contentEditable = 'false';
        area = el('textarea', 'note-db-code');
        area.value = String(node.attrs.query ?? '');
        area.spellcheck = false;
        area.setAttribute('autocapitalize', 'off');
        area.setAttribute('autocomplete', 'off');
        area.setAttribute('autocorrect', 'off');
        area.setAttribute('aria-label', t('Consulta'));
        area.rows = Math.min(14, Math.max(3, area.value.split('\n').length + 1));
        area.addEventListener('input', () => {
          clearTimeout(timer);
          timer = window.setTimeout(save, 600);
        });
        area.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
            // Esc cierra la consulta, no la nota.
            e.preventDefault();
            e.stopPropagation();
            close();
            editor.commands.focus();
          }
        });
        area.addEventListener('blur', save);
        const hint = el('div', 'note-app-hint', t('SELECT columnas FROM tabla WHERE … ORDER BY … · las relaciones con punto: autor.nombre'));
        panel.append(area, hint);
        dom.prepend(panel);
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      };

      if (editor.isEditable) {
        const bar = el('div', 'note-youtube-bar');
        bar.contentEditable = 'false';
        const button = (label: string, act: () => void) => {
          const b = el('button', '', label);
          b.type = 'button';
          b.addEventListener('mousedown', (e) => e.preventDefault());
          b.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            act();
          });
          bar.append(b);
          return b;
        };
        editBtn = button(t('Editar consulta'), () => (panel ? close() : open()));
        button(t('Quitar'), () => {
          const pos = getPos();
          if (typeof pos !== 'number') return;
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
          editor.commands.focus();
        });
        dom.append(bar);
      }
      dom.append(out);
      run();
      if (editNext && editor.isEditable) {
        editNext = false;
        requestAnimationFrame(open);
      }

      return {
        dom,
        update: (next: PMNode) => {
          if (next.type !== node.type) return false;
          const changed = next.attrs.query !== node.attrs.query;
          node = next;
          if (changed) {
            run();
            if (area && document.activeElement !== area) area.value = String(next.attrs.query ?? '');
          }
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: (e: Event) => e.target instanceof HTMLElement && !!e.target.closest('.note-youtube-bar, .note-db-editor, .note-db-foot, a'),
        destroy: () => {
          clearTimeout(timer);
          waiting.delete(onSource);
          stop?.();
        },
      };
    };
  },
});
