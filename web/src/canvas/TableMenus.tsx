import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Selection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { t } from '../i18n';
import { TOUCH } from './touch';

// Las tablas como en Notion: al pasar por una celda salen un asa encima de su
// columna y otra a la izquierda de su fila. Pulsadas abren su menú (insertar,
// mover, duplicar, ordenar, encabezado, borrar); arrastradas, la llevan a otro
// sitio. Los «+» del borde derecho y de abajo añaden columna y fila. En el
// móvil, las asas salen en la celda donde está el cursor.

// ── La tabla como una rejilla de celdas ───────────────────────────────
type Grid = { pos: number; node: PMNode; rows: PMNode[][]; merged: boolean; headRow: boolean; headCol: boolean };

function tableAround(state: EditorState, pos: number): { pos: number; node: PMNode } | null {
  const $p = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'table') return { pos: $p.before(d), node: $p.node(d) };
  const after = $p.nodeAfter;
  return after?.type.name === 'table' ? { pos: $p.pos, node: after } : null;
}

function gridOf(state: EditorState, tablePos: number): Grid | null {
  const node = state.doc.nodeAt(tablePos);
  if (!node || node.type.name !== 'table') return null;
  const rows: PMNode[][] = [];
  let merged = false;
  node.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((cell) => {
      if (cell.attrs.colspan > 1 || cell.attrs.rowspan > 1) merged = true;
      cells.push(cell);
    });
    rows.push(cells);
  });
  const isHead = (c: PMNode | undefined) => c?.type.name === 'tableHeader';
  const headRow = rows[0]?.length > 0 && rows[0].every(isHead);
  const headCol = rows.length > 1 && rows.every((r) => isHead(r[0]));
  return { pos: tablePos, node, rows, merged, headRow, headCol };
}

// Rehace la tabla con las celdas en su sitio nuevo. La fila y la columna de
// encabezado siguen siendo la primera (como en Notion), venga de donde venga.
function rebuild(view: EditorView, g: Grid, rows: PMNode[][], focus: [number, number]) {
  const { schema } = view.state;
  const head = schema.nodes.tableHeader;
  const cell = schema.nodes.tableCell;
  const rowType = schema.nodes.tableRow;
  if (!rows.length || !rows[0].length) {
    const tr = view.state.tr.delete(g.pos, g.pos + g.node.nodeSize);
    view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(g.pos, tr.doc.content.size)))));
    view.focus();
    return;
  }
  const table = g.node.type.create(
    g.node.attrs,
    rows.map((cells, r) =>
      rowType.create(
        null,
        cells.map((c, i) => {
          const type = (g.headRow && r === 0) || (g.headCol && i === 0) ? head : cell;
          return c.type === type ? c : type.create(c.attrs, c.content, c.marks);
        }),
      ),
    ),
  );
  const tr = view.state.tr.replaceWith(g.pos, g.pos + g.node.nodeSize, table);
  // El cursor, en la celda que se movió o se creó.
  const [fr, fc] = [Math.max(0, Math.min(focus[0], rows.length - 1)), Math.max(0, Math.min(focus[1], rows[0].length - 1))];
  let at = g.pos + 1;
  for (let r = 0; r < fr; r++) at += table.child(r).nodeSize;
  at += 1;
  for (let c = 0; c < fc; c++) at += table.child(fr).child(c).nodeSize;
  view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(at + 1))).scrollIntoView());
  view.focus();
}

const emptyCell = (view: EditorView, like: PMNode) => {
  const { tableCell } = view.state.schema.nodes;
  return tableCell.createAndFill(like.attrs.colwidth ? { colwidth: like.attrs.colwidth } : null)!;
};
const copy = (rows: PMNode[][]) => rows.map((r) => [...r]);
const textOf = (c: PMNode) => c.textContent.trim();
const collator = () => new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const ops = {
  insertCol(view: EditorView, g: Grid, col: number) {
    rebuild(view, g, g.rows.map((r) => [...r.slice(0, col), emptyCell(view, r[Math.min(col, r.length - 1)]), ...r.slice(col)]), [g.headRow ? 1 : 0, col]);
  },
  insertRow(view: EditorView, g: Grid, row: number) {
    const like = g.rows[Math.min(row, g.rows.length - 1)];
    const rows = copy(g.rows);
    rows.splice(row, 0, like.map((c) => emptyCell(view, c)));
    rebuild(view, g, rows, [row, 0]);
  },
  moveCol(view: EditorView, g: Grid, from: number, to: number) {
    if (from === to) return;
    rebuild(
      view,
      g,
      g.rows.map((r) => {
        const out = [...r];
        const [c] = out.splice(from, 1);
        out.splice(to, 0, c);
        return out;
      }),
      [g.headRow ? 1 : 0, to],
    );
  },
  moveRow(view: EditorView, g: Grid, from: number, to: number) {
    if (from === to) return;
    const rows = copy(g.rows);
    const [r] = rows.splice(from, 1);
    rows.splice(to, 0, r);
    rebuild(view, g, rows, [to, 0]);
  },
  dupCol(view: EditorView, g: Grid, col: number) {
    rebuild(view, g, g.rows.map((r) => [...r.slice(0, col + 1), r[col].copy(r[col].content), ...r.slice(col + 1)]), [g.headRow ? 1 : 0, col + 1]);
  },
  dupRow(view: EditorView, g: Grid, row: number) {
    const rows = copy(g.rows);
    rows.splice(row + 1, 0, g.rows[row].map((c) => c.copy(c.content)));
    rebuild(view, g, rows, [row + 1, 0]);
  },
  deleteCol(view: EditorView, g: Grid, col: number) {
    rebuild(view, g, g.rows.map((r) => r.filter((_, i) => i !== col)), [g.headRow ? 1 : 0, Math.max(0, col - 1)]);
  },
  deleteRow(view: EditorView, g: Grid, row: number) {
    rebuild(view, g, g.rows.filter((_, i) => i !== row), [Math.max(0, row - 1), 0]);
  },
  // Ordena las filas por esta columna (la de encabezado se queda arriba).
  sort(view: EditorView, g: Grid, col: number, dir: 1 | -1) {
    const head = g.headRow ? g.rows.slice(0, 1) : [];
    const body = g.rows.slice(head.length);
    const cmp = collator();
    body.sort((a, b) => {
      const x = textOf(a[col]);
      const y = textOf(b[col]);
      // Las vacías, siempre al final.
      if (!x || !y) return x ? -1 : y ? 1 : 0;
      return cmp.compare(x, y) * dir;
    });
    rebuild(view, g, [...head, ...body], [head.length, col]);
  },
  headRow(view: EditorView, g: Grid) {
    rebuild(view, { ...g, headRow: !g.headRow }, g.rows, [0, 0]);
  },
  headCol(view: EditorView, g: Grid) {
    rebuild(view, { ...g, headCol: !g.headCol }, g.rows, [0, 0]);
  },
};

// ── Dónde está el puntero (o el cursor, en el móvil) ─────────────────
type Spot = { table: HTMLTableElement; row: number; col: number };

function spotOfCell(el: Element | null, root: HTMLElement): Spot | null {
  const cell = el?.closest('td, th') as HTMLTableCellElement | null;
  if (!cell || !root.contains(cell)) return null;
  const table = cell.closest('table');
  const tr = cell.parentElement as HTMLTableRowElement | null;
  if (!table || !tr) return null;
  return { table, row: tr.rowIndex, col: cell.cellIndex };
}

const tablePosOf = (view: EditorView, table: HTMLTableElement) => {
  try {
    const t = tableAround(view.state, view.posAtDOM(table, 0));
    return t?.pos ?? null;
  } catch {
    return null;
  }
};

const keep = (e: { preventDefault: () => void }) => e.preventDefault();

type Menu = { kind: 'col' | 'row'; index: number; tablePos: number; x: number; y: number };
type Drag = { kind: 'col' | 'row'; from: number; to: number; tablePos: number; table: HTMLTableElement };

export function TableControls({ editor }: { editor: Editor }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const spotRef = useRef(spot);
  spotRef.current = spot;
  const busy = useRef(false);
  busy.current = !!menu || !!drag;

  // Ordenador: la celda bajo el ratón. Al salir de la tabla hacia sus asas o
  // sus «+», sigue la misma.
  useEffect(() => {
    if (TOUCH) return;
    const move = (e: MouseEvent) => {
      if (busy.current) return;
      const root = editor.view.dom;
      const hit = spotOfCell(e.target as Element, root);
      if (hit) {
        const now = spotRef.current;
        if (!now || now.table !== hit.table || now.row !== hit.row || now.col !== hit.col) setSpot(hit);
        return;
      }
      if ((e.target as Element | null)?.closest?.('.tbl-ui')) return;
      const now = spotRef.current;
      if (!now) return;
      const r = now.table.getBoundingClientRect();
      const pad = 30;
      if (!now.table.isConnected || e.clientX < r.left - pad || e.clientX > r.right + pad || e.clientY < r.top - pad || e.clientY > r.bottom + pad) setSpot(null);
    };
    window.addEventListener('mousemove', move, { passive: true });
    return () => window.removeEventListener('mousemove', move);
  }, [editor]);

  // Móvil: la celda donde está el cursor.
  useEffect(() => {
    if (!TOUCH) return;
    const update = () => {
      if (busy.current) return;
      const { view } = editor;
      const { from } = view.state.selection;
      let el: Element | null = null;
      try {
        const dom = view.domAtPos(from).node;
        el = dom instanceof Element ? dom : dom.parentElement;
      } catch {
        el = null;
      }
      setSpot(editor.isFocused ? spotOfCell(el, view.dom) : null);
    };
    editor.on('selectionUpdate', update);
    editor.on('focus', update);
    editor.on('blur', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('focus', update);
      editor.off('blur', update);
    };
  }, [editor]);

  // Si la nota cambia o se desplaza, las asas se recolocan.
  useEffect(() => {
    const on = () => repaint();
    editor.on('transaction', on);
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => {
      editor.off('transaction', on);
      window.removeEventListener('scroll', on, true);
      window.removeEventListener('resize', on);
    };
  }, [editor]);

  const menuEl = menu && <TableMenu editor={editor} menu={menu} onClose={() => setMenu(null)} />;
  if (!spot || !spot.table.isConnected || !editor.isEditable) return menuEl;
  const { table, row, col } = spot;
  const rowEl = table.rows[row];
  const cellEl = rowEl?.cells[col];
  if (!rowEl || !cellEl) return menuEl;
  const tr = table.getBoundingClientRect();
  const rr = rowEl.getBoundingClientRect();
  const cr = cellEl.getBoundingClientRect();
  const view = editor.view;

  // Empezar a arrastrar un asa; si no se mueve, es un toque y abre el menú.
  const grab = (kind: 'col' | 'row', index: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const tablePos = tablePosOf(view, table);
    if (tablePos === null) return;
    const btn = e.currentTarget;
    btn.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    let to = index;
    const g = gridOf(view.state, tablePos);
    const canMove = !!g && !g.merged;
    const over = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      if (!canMove) return;
      moved = true;
      // La columna (o fila) sobre la que está el puntero.
      if (kind === 'col') {
        const cells = [...table.rows[0].cells];
        to = Math.max(0, cells.findIndex((c) => ev.clientX < c.getBoundingClientRect().right));
        if (ev.clientX >= cells[cells.length - 1].getBoundingClientRect().right) to = cells.length - 1;
        if (to < 0) to = cells.length - 1;
      } else {
        const rows = [...table.rows];
        to = rows.findIndex((r) => ev.clientY < r.getBoundingClientRect().bottom);
        if (to < 0) to = rows.length - 1;
      }
      setDrag({ kind, from: index, to, tablePos, table });
    };
    const up = () => {
      btn.removeEventListener('pointermove', over);
      btn.removeEventListener('pointerup', up);
      btn.removeEventListener('pointercancel', up);
      setDrag(null);
      const grid = gridOf(view.state, tablePos);
      if (!grid) return;
      if (moved) {
        if (kind === 'col') ops.moveCol(view, grid, index, to);
        else ops.moveRow(view, grid, index, to);
        setSpot((s) => (s ? { ...s, [kind]: to } : s));
        return;
      }
      const r = btn.getBoundingClientRect();
      setMenu({ kind, index, tablePos, x: kind === 'col' ? r.left : r.right + 4, y: kind === 'col' ? r.bottom + 4 : r.top });
    };
    btn.addEventListener('pointermove', over);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
  };

  const addAt = (kind: 'col' | 'row') => () => {
    const tablePos = tablePosOf(view, table);
    const g = tablePos === null ? null : gridOf(view.state, tablePos);
    if (!g) return;
    // Con celdas combinadas, lo hace el editor junto a la celda del cursor.
    if (g.merged) {
      if (kind === 'col') editor.chain().focus().addColumnAfter().run();
      else editor.chain().focus().addRowAfter().run();
      return;
    }
    if (kind === 'col') ops.insertCol(view, g, g.rows[0].length);
    else ops.insertRow(view, g, g.rows.length);
  };

  // La raya de dónde caerá lo arrastrado.
  let line: CSSProperties | null = null;
  if (drag && drag.table === table) {
    if (drag.kind === 'col') {
      const target = table.rows[0]?.cells[drag.to]?.getBoundingClientRect();
      if (target) line = { left: (drag.to > drag.from ? target.right : target.left) - 1.5, top: tr.top, width: 3, height: tr.height };
    } else {
      const target = table.rows[drag.to]?.getBoundingClientRect();
      if (target) line = { top: (drag.to > drag.from ? target.bottom : target.top) - 1.5, left: tr.left, height: 3, width: tr.width };
    }
  }
  const visible = (x: number) => x >= 0 && x <= window.innerWidth;

  return createPortal(
    <div className="tbl-ui">
      {visible(cr.left + cr.width / 2) && (
        <button
          className={`tbl-grip is-col${drag?.kind === 'col' ? ' is-dragging' : ''}`}
          style={{ left: cr.left + cr.width / 2 - 14, top: tr.top - 11 }}
          onPointerDown={grab('col', col)}
          onMouseDown={keep}
          aria-label={t('Columna: arrastra para mover, pulsa para el menú')}
          title={t('Columna: arrastra para mover, pulsa para el menú')}
        >
          <Dots horizontal />
        </button>
      )}
      <button
        className={`tbl-grip is-row${drag?.kind === 'row' ? ' is-dragging' : ''}`}
        style={{ left: tr.left - 11, top: rr.top + rr.height / 2 - 14 }}
        onPointerDown={grab('row', row)}
        onMouseDown={keep}
        aria-label={t('Fila: arrastra para mover, pulsa para el menú')}
        title={t('Fila: arrastra para mover, pulsa para el menú')}
      >
        <Dots />
      </button>
      {!drag && (
        <>
          <button className="tbl-add is-col" style={{ left: Math.min(tr.right + 4, window.innerWidth - 22), top: tr.top, height: tr.height }} onMouseDown={keep} onClick={addAt('col')} aria-label={t('Añadir columna')} title={t('Añadir columna')}>
            +
          </button>
          <button className="tbl-add is-row" style={{ left: tr.left, top: tr.bottom + 4, width: Math.min(tr.width, window.innerWidth - tr.left - 8) }} onMouseDown={keep} onClick={addAt('row')} aria-label={t('Añadir fila')} title={t('Añadir fila')}>
            +
          </button>
        </>
      )}
      {line && <div className="tbl-line" style={line} />}
      {menuEl}
    </div>,
    document.body,
  );
}

function Dots({ horizontal }: { horizontal?: boolean }) {
  const pts = [-5, 0, 5].flatMap((a) => [-2.5, 2.5].map((b) => (horizontal ? [a, b] : [b, a])));
  return (
    <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
      {pts.map(([x, y]) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r="1.25" fill="currentColor" />
      ))}
    </svg>
  );
}

// ── El menú de una columna o una fila ────────────────────────────────
function TableMenu({ editor, menu, onClose }: { editor: Editor; menu: Menu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ left: menu.x, top: menu.y, visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const bottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);
    setPos({ left: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(menu.y, bottom - r.height - 8)) });
  }, [menu.x, menu.y]);
  useEffect(() => {
    const down = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      editor.commands.focus();
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [editor, onClose]);

  const { view } = editor;
  const g = gridOf(view.state, menu.tablePos);
  if (!g) return null;
  const i = menu.index;
  const n = menu.kind === 'col' ? g.rows[0].length : g.rows.length;
  // Con celdas combinadas, solo lo que sabe hacer el editor por su cuenta.
  const simple = !g.merged;
  const act = (fn: (grid: Grid) => unknown) => () => {
    const now = gridOf(view.state, menu.tablePos);
    onClose();
    if (now) fn(now);
  };
  const item = (label: string, run: () => void, opts: { disabled?: boolean; danger?: boolean; on?: boolean } = {}) => (
    <button role={opts.on === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={opts.on} className={`bib-menu-it${opts.danger ? ' is-danger' : ''}`} disabled={opts.disabled} onClick={run}>
      {label}
      {opts.on !== undefined && <span className="tbl-check">{opts.on ? '✓' : ''}</span>}
    </button>
  );
  const sep = <div className="bib-menu-sep" role="separator" />;
  const items: ReactNode =
    menu.kind === 'col' ? (
      <>
        <div className="bib-menu-head">{t('Columna')}</div>
        {item(t('Insertar a la izquierda'), act((gr) => ops.insertCol(view, gr, i)), { disabled: !simple })}
        {item(t('Insertar a la derecha'), act((gr) => ops.insertCol(view, gr, i + 1)), { disabled: !simple })}
        {item(t('Mover a la izquierda'), act((gr) => ops.moveCol(view, gr, i, i - 1)), { disabled: !simple || i === 0 })}
        {item(t('Mover a la derecha'), act((gr) => ops.moveCol(view, gr, i, i + 1)), { disabled: !simple || i === n - 1 })}
        {item(t('Duplicar'), act((gr) => ops.dupCol(view, gr, i)), { disabled: !simple })}
        {sep}
        {item(t('Ordenar de la A a la Z'), act((gr) => ops.sort(view, gr, i, 1)), { disabled: !simple })}
        {item(t('Ordenar de la Z a la A'), act((gr) => ops.sort(view, gr, i, -1)), { disabled: !simple })}
        {sep}
        {item(t('Columna de encabezado'), act((gr) => ops.headCol(view, gr)), { disabled: !simple, on: g.headCol })}
        {sep}
        {item(n > 1 ? t('Eliminar columna') : t('Eliminar tabla'), act((gr) => ops.deleteCol(view, gr, i)), { danger: true, disabled: !simple })}
      </>
    ) : (
      <>
        <div className="bib-menu-head">{t('Fila')}</div>
        {item(t('Insertar arriba'), act((gr) => ops.insertRow(view, gr, i)), { disabled: !simple })}
        {item(t('Insertar abajo'), act((gr) => ops.insertRow(view, gr, i + 1)), { disabled: !simple })}
        {item(t('Mover arriba'), act((gr) => ops.moveRow(view, gr, i, i - 1)), { disabled: !simple || i === 0 })}
        {item(t('Mover abajo'), act((gr) => ops.moveRow(view, gr, i, i + 1)), { disabled: !simple || i === n - 1 })}
        {item(t('Duplicar'), act((gr) => ops.dupRow(view, gr, i)), { disabled: !simple })}
        {sep}
        {item(t('Fila de encabezado'), act((gr) => ops.headRow(view, gr)), { disabled: !simple, on: g.headRow })}
        {sep}
        {item(n > 1 ? t('Eliminar fila') : t('Eliminar tabla'), act((gr) => ops.deleteRow(view, gr, i)), { danger: true, disabled: !simple })}
      </>
    );
  return createPortal(
    <div ref={ref} className="bib-menu tbl-menu tbl-ui" style={pos} role="menu" aria-label={menu.kind === 'col' ? t('Columna') : t('Fila')} onMouseDown={keep}>
      {items}
    </div>,
    document.body,
  );
}
