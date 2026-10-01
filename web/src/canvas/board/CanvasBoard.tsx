import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Handle,
  MarkerType,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  useInternalNode,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { ulid } from 'ulidx';
import type { NoteRow } from '../../api';
import { fileExt, fileSize, openFile, uploadMedia } from '../media';
import { boardText, parseBoard, type Board, type BoardNode } from './board';
import { constrain, fontSize, tidy, translate, type DrawColor, type DrawSize, type Drawing, type ShapeKind, type Tool } from './draw';
import { DrawBar, DrawLayer, type Typing } from './Draw';
import { t } from '../../i18n';
import './board.css';

// El lienzo de una nota de tipo canvas: tarjetas de texto, notas enlazadas,
// archivos (imágenes, PDF, documentos…) y grupos que se colocan libremente y se unen con flechas, como un
// canvas de Obsidian, y encima se puede dibujar a mano (ver draw.ts). Guarda en
// formato JSON Canvas.

type Data = {
  text?: string;
  label?: string;
  noteId?: string;
  file?: string;
  // Nombre original de un archivo que no es imagen, vídeo ni audio.
  name?: string;
  editing?: boolean;
};

type Ctx = {
  rows: Map<string, NoteRow>;
  onOpenNote: (id: string) => void;
  setData: (id: string, data: Partial<Data>) => void;
};

const SIZE = { text: { w: 260, h: 120 }, note: { w: 280, h: 140 }, file: { w: 320, h: 220 }, group: { w: 560, h: 380 } };
// Un PDF o un documento no se ve dentro: basta con su ficha.
const DOC_SIZE = { w: 280, h: 72 };

// ── Tarjetas ─────────────────────────────────────────────────────────

const handles = (
  <>
    {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((p) => (
      <Handle key={p} id={p} type="source" position={p} className="board-handle" />
    ))}
  </>
);

function TextCard({ id, data, selected, ctx }: NodeProps<Node<Data>> & { ctx: Ctx }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const editing = !!data.editing;
  useEffect(() => {
    if (editing) {
      const el = ref.current!;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);
  return (
    <div className={`board-card board-text${selected ? ' is-selected' : ''}`} onDoubleClick={() => ctx.setData(id, { editing: true })}>
      <NodeResizer isVisible={selected} minWidth={120} minHeight={48} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
      {handles}
      {editing ? (
        <textarea
          ref={ref}
          className="board-textarea nodrag nowheel"
          defaultValue={data.text ?? ''}
          placeholder={t('Escribe…')}
          onBlur={(e) => ctx.setData(id, { text: e.target.value, editing: false })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <div className="board-text-body">{data.text?.trim() ? data.text : <span className="faint">{t('Doble clic para escribir')}</span>}</div>
      )}
    </div>
  );
}

function NoteCard({ data, selected, ctx }: NodeProps<Node<Data>> & { ctx: Ctx }) {
  const row = data.noteId ? ctx.rows.get(data.noteId) : undefined;
  const body = row?.bodyText?.split('\n').slice(row.kind === 'canvas' ? 0 : 1).join(' ').trim();
  return (
    <div className={`board-card board-note${selected ? ' is-selected' : ''}${row ? '' : ' is-missing'}`} onDoubleClick={() => row && ctx.onOpenNote(row.id)}>
      <NodeResizer isVisible={selected} minWidth={160} minHeight={60} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
      {handles}
      <span className="board-note-kind meta">{row?.kind === 'canvas' ? t('Canvas') : t('Nota')}</span>
      <strong className="board-note-title">{row ? row.title || t('Nota sin título') : t('Nota borrada')}</strong>
      {body && <p className="board-note-body">{body}</p>}
      {row && <span className="board-note-open meta">{t('Doble clic para abrir')}</span>}
    </div>
  );
}

function FileCard({ data, selected }: NodeProps<Node<Data>>) {
  const src = data.file ?? '';
  const kind = /\.(mp4|webm|mov)$/i.test(src)
    ? 'video'
    : /\.(mp3|ogg|wav|weba|m4a|aac|flac)$/i.test(src)
      ? 'audio'
      : /\.(png|jpe?g|gif|webp|avif)$/i.test(src)
        ? 'image'
        : 'doc';
  if (kind === 'doc') {
    const name = data.name || src.split('/').pop() || t('Archivo');
    return (
      <div className={`board-card board-doc${selected ? ' is-selected' : ''}`} onDoubleClick={() => openFile(src, name)} title={t('Doble clic para abrir')}>
        <NodeResizer isVisible={selected} minWidth={160} minHeight={56} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
        {handles}
        <span className="note-file-ext">{fileExt(name)}</span>
        <span className="board-doc-name">{name}</span>
      </div>
    );
  }
  return (
    <div className={`board-card board-file${selected ? ' is-selected' : ''}`}>
      <NodeResizer isVisible={selected} minWidth={80} minHeight={48} keepAspectRatio={kind === 'image'} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
      {handles}
      {kind === 'image' ? (
        <img src={src} alt="" draggable={false} />
      ) : kind === 'video' ? (
        <video src={src} controls preload="metadata" className="nodrag" />
      ) : (
        <audio src={src} controls preload="metadata" className="nodrag" />
      )}
    </div>
  );
}

function GroupCard({ id, data, selected, ctx }: NodeProps<Node<Data>> & { ctx: Ctx }) {
  return (
    <div className={`board-group${selected ? ' is-selected' : ''}`}>
      <NodeResizer isVisible={selected} minWidth={160} minHeight={100} lineClassName="board-resize-line" handleClassName="board-resize-handle" />
      <input
        className="board-group-label nodrag"
        value={data.label ?? ''}
        placeholder={t('Grupo')}
        onChange={(e) => ctx.setData(id, { label: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

// ── Flechas: salen del borde más cercano de cada tarjeta ─────────────

function box(n: InternalNode) {
  const { x, y } = n.internals.positionAbsolute;
  const w = n.measured.width ?? 0;
  const h = n.measured.height ?? 0;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function borderPoint(from: InternalNode, to: InternalNode) {
  const a = box(from);
  const b = box(to);
  const w2 = a.w / 2;
  const h2 = a.h / 2;
  const xx1 = (b.cx - a.cx) / (2 * w2) - (b.cy - a.cy) / (2 * h2);
  const yy1 = (b.cx - a.cx) / (2 * w2) + (b.cy - a.cy) / (2 * h2);
  const k = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const x = w2 * (k * xx1 + k * yy1) + a.cx;
  const y = h2 * (-k * xx1 + k * yy1) + a.cy;
  const side = x <= a.x + 1 ? Position.Left : x >= a.x + a.w - 1 ? Position.Right : y <= a.y + 1 ? Position.Top : Position.Bottom;
  return { x, y, side };
}

function FloatingArrow({ id, source, target, markerEnd, selected }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const a = borderPoint(s, t);
  const b = borderPoint(t, s);
  const [path] = getBezierPath({ sourceX: a.x, sourceY: a.y, sourcePosition: a.side, targetX: b.x, targetY: b.y, targetPosition: b.side });
  return (
    <>
      <path id={id} className={`board-edge${selected ? ' is-selected' : ''}`} d={path} markerEnd={markerEnd} />
      <path className="react-flow__edge-interaction" d={path} fill="none" strokeOpacity={0} strokeWidth={18} />
    </>
  );
}

// ── Conversión con el formato guardado ───────────────────────────────

const toFlow = (b: Board) => {
  const nodes: Node<Data>[] = b.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    width: n.width,
    height: n.height,
    // Los grupos, detrás de todo.
    zIndex: n.type === 'group' ? -1 : 0,
    data: n.type === 'text' ? { text: n.text } : n.type === 'note' ? { noteId: n.noteId } : n.type === 'file' ? { file: n.file, name: n.name } : { label: n.label },
  }));
  const edges: Edge[] = b.edges.map((e) => ({ id: e.id, source: e.fromNode, target: e.toNode, type: 'arrow', markerEnd: e.toEnd === 'none' ? undefined : ARROW }));
  return { nodes, edges };
};

const fromFlow = (nodes: Node<Data>[], edges: Edge[], drawings: Drawing[]): Board => ({
  type: 'canvas',
  nodes: nodes.map((n): BoardNode => {
    const base = { id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y), width: Math.round(n.width ?? n.measured?.width ?? 200), height: Math.round(n.height ?? n.measured?.height ?? 100) };
    if (n.type === 'note') return { ...base, type: 'note', noteId: n.data.noteId! };
    if (n.type === 'file') return { ...base, type: 'file', file: n.data.file!, ...(n.data.name ? { name: n.data.name } : {}) };
    if (n.type === 'group') return { ...base, type: 'group', label: n.data.label ?? '' };
    return { ...base, type: 'text', text: n.data.text ?? '' };
  }),
  edges: edges.map((e) => ({ id: e.id, fromNode: e.source, toNode: e.target, ...(e.markerEnd ? {} : { toEnd: 'none' as const }) })),
  ...(drawings.length ? { drawings } : {}),
});

// Color y grosor con los que se dibuja, recordados en este navegador.
const STYLE_KEY = 'canvian:draw';
function loadStyle(): { color: DrawColor; size: DrawSize } {
  try {
    const v = JSON.parse(localStorage.getItem(STYLE_KEY) ?? 'null');
    if (v && typeof v.color === 'string' && [1, 2, 3].includes(v.size)) return v;
  } catch {
    // Sin almacenamiento local se empieza con tinta y trazo medio.
  }
  return { color: 'ink', size: 2 };
}

const isTyping = (el: EventTarget | null) => {
  const n = el as HTMLElement | null;
  return !!n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
};

const ARROW = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--board-edge)' };

// ── El lienzo ────────────────────────────────────────────────────────

type Props = {
  note: NoteRow;
  rows: NoteRow[];
  onSave: (content: { bodyJson: string; bodyText: string }) => void;
  onOpenNote: (id: string) => void;
  onPickNote: (then: (id: string) => void) => void;
  onError: (e: unknown) => void;
};

function Inner({ note, rows, onSave, onOpenNote, onPickNote, onError }: Props) {
  const initialBoard = useMemo(() => parseBoard(note.bodyJson), [note.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const initial = useMemo(() => toFlow(initialBoard), [initialBoard]);
  const [nodes, setNodes] = useState<Node<Data>[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const [drawings, setDrawings] = useState<Drawing[]>(initialBoard.drawings ?? []);
  const flow = useReactFlow();
  const host = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // Guardar al rato de dejar de tocar; lo que se está escribiendo no cuenta.
  const first = useRef(true);
  const lastDrawn = useRef(JSON.stringify(initialBoard.drawings ?? []));
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // Al cerrar la hoja se guarda lo que quedara pendiente.
  const pending = useRef<(() => void) | null>(null);
  const flush = () => {
    pending.current?.();
    pending.current = null;
  };
  useEffect(() => flush, []);
  const boardJson = JSON.stringify(fromFlow(nodes, edges, drawings));
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const json = boardJson;
    const board = JSON.parse(json) as Board;
    // Cada trazo es un paso de deshacer al momento; lo demás (arrastrar
    // tarjetas, escribir) cuenta al dejar de tocar.
    const drawn = JSON.stringify(board.drawings ?? []);
    if (drawn !== lastDrawn.current && gesture.current?.kind !== 'move') record(json);
    lastDrawn.current = drawn;
    pending.current = () => {
      record(json);
      onSaveRef.current({ bodyJson: json, bodyText: boardText(board, byId) });
    };
    const t = setTimeout(flush, 450);
    return () => clearTimeout(t);
    // Solo el contenido: posiciones, tamaños, textos, flechas y dibujos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardJson]);

  // ── Deshacer y rehacer: cada estado guardado del lienzo es un paso ──
  const hist = useRef({ stack: [JSON.stringify(fromFlow(initial.nodes, initial.edges, initialBoard.drawings ?? []))], at: 0 });
  const [, setHistTick] = useState(0);
  function record(json: string) {
    const h = hist.current;
    if (h.stack[h.at] === json) return;
    h.stack = h.stack.slice(Math.max(0, h.at - 199), h.at + 1);
    h.stack.push(json);
    h.at = h.stack.length - 1;
    setHistTick((n) => n + 1);
  }
  const restore = (json: string) => {
    const b = parseBoard(json);
    const f = toFlow(b);
    setNodes(f.nodes);
    setEdges(f.edges);
    setDrawings(b.drawings ?? []);
    setSel(null);
    setHistTick((n) => n + 1);
  };
  const current = () => JSON.stringify(fromFlow(flow.getNodes() as Node<Data>[], flow.getEdges(), drawingsRef.current));
  const undo = () => {
    commitTyping();
    record(current());
    const h = hist.current;
    if (h.at > 0) restore(h.stack[--h.at]);
  };
  const redo = () => {
    const h = hist.current;
    if (h.stack[h.at] !== current()) return;
    if (h.at < h.stack.length - 1) restore(h.stack[++h.at]);
  };

  const setData = useCallback((id: string, data: Partial<Data>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)));
  }, []);

  // ── Dibujo ─────────────────────────────────────────────────────────
  const [tool, setTool] = useState<Tool>('select');
  const [style, setStyleState] = useState(loadStyle);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [erasing, setErasing] = useState<Set<string>>(new Set());
  const [typing, setTypingState] = useState<Typing | null>(null);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const typingRef = useRef<Typing | null>(null);
  const gesture = useRef<{ pointer: number; kind: 'draw' | 'erase' | 'move'; start: { x: number; y: number }; client: { x: number; y: number }; orig?: Drawing } | null>(null);
  const draftRef = useRef<Drawing | null>(null);
  const erasingRef = useRef<Set<string>>(new Set());
  // Dedos (o punteros) apoyados ahora, para mover y acercar con dos.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ vp: { x: number; y: number; zoom: number }; mid: { x: number; y: number }; dist: number } | null>(null);
  // Arrastrar con el botón central del ratón mueve el lienzo.
  const pan = useRef<{ pointer: number; vp: { x: number; y: number; zoom: number }; x: number; y: number } | null>(null);
  const drawing = tool !== 'select';

  const setStyle = (next: Partial<{ color: DrawColor; size: DrawSize }>) => {
    const s = { ...style, ...next };
    setStyleState(s);
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(s));
    } catch {
      // Se recordará solo mientras esté abierto.
    }
    // Con una forma elegida, el color y el grosor van a ella.
    if (sel) setDrawings((ds) => ds.map((d) => (d.id === sel ? { ...d, ...next } : d)));
  };

  const setTyping = (v: Typing | null) => {
    typingRef.current = v;
    setTypingState(v);
  };
  function commitTyping() {
    const cur = typingRef.current;
    if (!cur) return;
    setTyping(null);
    const text = cur.text.replace(/\s+$/, '');
    setDrawings((ds) => {
      const rest = ds.filter((d) => d.id !== cur.id);
      if (!text.trim()) return rest;
      const at = ds.findIndex((d) => d.id === cur.id);
      const d: Drawing = tidy({ id: cur.id, kind: 'text', x: cur.x, y: cur.y, text, color: cur.color, size: cur.size });
      return at < 0 ? [...rest, d] : ds.map((x) => (x.id === cur.id ? d : x));
    });
  }
  const editText = (d: Drawing) => {
    if (d.kind !== 'text') return;
    commitTyping();
    setSel(null);
    setTyping({ id: d.id, x: d.x, y: d.y, text: d.text, color: d.color, size: d.size });
  };

  const deselectNodes = () => setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => (n.selected ? { ...n, selected: false } : n)) : ns));
  const pickTool = (next: Tool) => {
    commitTyping();
    setSel(null);
    setTool(next);
    if (next !== 'select') deselectNodes();
  };

  const toFlowPoint = (e: { clientX: number; clientY: number }) => flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });

  // La goma borra lo que toca: se marca al pasar y se quita al soltar.
  const eraseAt = (x: number, y: number) => {
    for (const el of document.elementsFromPoint(x, y)) {
      const id = (el as HTMLElement).dataset?.drawId;
      if (id && !erasingRef.current.has(id)) {
        erasingRef.current = new Set(erasingRef.current).add(id);
        setErasing(erasingRef.current);
      }
    }
  };

  const cancelGesture = () => {
    gesture.current = null;
    draftRef.current = null;
    setDraft(null);
    erasingRef.current = new Set();
    setErasing(erasingRef.current);
  };

  const onDrawDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    const target = e.target as HTMLElement;
    if (target.closest('.draw-ui, .board-tools, .draw-textarea')) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === 'mouse' && e.button === 1) {
      pan.current = { pointer: e.pointerId, vp: flow.getViewport(), x: e.clientX, y: e.clientY };
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Dos dedos: se mueve y se acerca el lienzo, no se dibuja. Lo empezado con
    // el primero se descarta.
    if (pointers.current.size > 1) {
      cancelGesture();
      if (typingRef.current && !typingRef.current.text) setTyping(null);
      const [a, b] = [...pointers.current.values()];
      pinch.current = { vp: flow.getViewport(), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
      return;
    }
    if (pinch.current) return;
    const p = toFlowPoint(e);
    const base = { pointer: e.pointerId, start: p, client: { x: e.clientX, y: e.clientY } };
    if (tool === 'text') {
      const hit = document.elementsFromPoint(e.clientX, e.clientY).map((el) => (el as HTMLElement).dataset?.drawId).find(Boolean);
      const old = hit && drawingsRef.current.find((d) => d.id === hit && d.kind === 'text');
      if (old) return editText(old);
      commitTyping();
      const fs = fontSize(style.size);
      setTyping({ id: ulid(), x: p.x, y: p.y - fs * 0.6, text: '', ...style });
      return;
    }
    if (tool === 'eraser') {
      gesture.current = { ...base, kind: 'erase' };
      eraseAt(e.clientX, e.clientY);
      return;
    }
    commitTyping();
    gesture.current = { ...base, kind: 'draw' };
    const d: Drawing =
      tool === 'pen'
        ? { id: ulid(), kind: 'pen', pts: [p.x, p.y, e.pointerType === 'pen' ? e.pressure : 0.5], ...(e.pointerType === 'pen' ? { pr: 1 as const } : {}), ...style }
        : { id: ulid(), kind: tool as ShapeKind, x1: p.x, y1: p.y, x2: p.x, y2: p.y, seed: Math.floor(Math.random() * 2 ** 31), ...style };
    draftRef.current = d;
    setDraft(d);
  };

  // Elegir y arrastrar un dibujo con la flecha de seleccionar.
  const onShapeDown = (e: ReactPointerEvent, id: string) => {
    if (drawing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const orig = drawingsRef.current.find((d) => d.id === id);
    if (!orig) return;
    e.stopPropagation();
    setSel(id);
    deselectNodes();
    host.current!.setPointerCapture(e.pointerId);
    gesture.current = { pointer: e.pointerId, kind: 'move', start: toFlowPoint(e), client: { x: e.clientX, y: e.clientY }, orig };
  };

  const onDrawMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointer === e.pointerId) {
      const { vp, x, y } = pan.current;
      flow.setViewport({ x: vp.x + e.clientX - x, y: vp.y + e.clientY - y, zoom: vp.zoom });
      return;
    }
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pz = pinch.current;
    if (pz) {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const r = host.current!.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoom = Math.min(3, Math.max(0.1, (pz.vp.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pz.dist));
      // El punto del lienzo que había bajo los dedos sigue bajo ellos.
      const fx = (pz.mid.x - r.left - pz.vp.x) / pz.vp.zoom;
      const fy = (pz.mid.y - r.top - pz.vp.y) / pz.vp.zoom;
      flow.setViewport({ x: mid.x - r.left - fx * zoom, y: mid.y - r.top - fy * zoom, zoom });
      return;
    }
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    if (g.kind === 'move') {
      const p = toFlowPoint(e);
      const moved = translate(g.orig!, p.x - g.start.x, p.y - g.start.y);
      setDrawings((ds) => ds.map((d) => (d.id === moved.id ? moved : d)));
      return;
    }
    if (g.kind === 'erase') {
      // Entre dos movimientos rápidos, se repasa el camino a saltitos.
      const { x, y } = g.client;
      const steps = Math.ceil(Math.hypot(e.clientX - x, e.clientY - y) / 6);
      for (let i = 1; i <= steps; i++) eraseAt(x + ((e.clientX - x) * i) / steps, y + ((e.clientY - y) * i) / steps);
      g.client = { x: e.clientX, y: e.clientY };
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    let next: Drawing;
    if (d.kind === 'pen') {
      const zoom = flow.getZoom();
      const pts = d.pts.slice();
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const ev of events.length ? events : [e.nativeEvent]) {
        const p = toFlowPoint(ev);
        if (Math.hypot(p.x - pts[pts.length - 3], p.y - pts[pts.length - 2]) < 1.2 / zoom) continue;
        pts.push(p.x, p.y, d.pr ? ev.pressure : 0.5);
      }
      next = { ...d, pts };
    } else if (d.kind !== 'text') {
      const p = toFlowPoint(e);
      next = { ...d, x2: p.x, y2: p.y, ...(e.shiftKey ? constrain(d.kind, d.x1, d.y1, p.x, p.y) : {}) };
    } else return;
    draftRef.current = next;
    setDraft(next);
  };

  const onDrawUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointer === e.pointerId) pan.current = null;
    pointers.current.delete(e.pointerId);
    // Hasta levantar todos los dedos no se vuelve a dibujar.
    if (pinch.current && !pointers.current.size) pinch.current = null;
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    gesture.current = null;
    if (g.kind === 'erase') {
      const gone = erasingRef.current;
      if (gone.size) setDrawings((ds) => ds.filter((d) => !gone.has(d.id)));
      erasingRef.current = new Set();
      setErasing(erasingRef.current);
      return;
    }
    if (g.kind === 'move') return;
    const d = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!d || e.type === 'pointercancel') return;
    // Un toque sin arrastrar no deja una forma de tamaño cero (un punto con el lápiz, sí).
    if (d.kind !== 'pen' && d.kind !== 'text' && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) * flow.getZoom() < 4) return;
    setDrawings((ds) => [...ds, tidy(d)]);
  };

  // Teclas del lienzo: deshacer, rehacer, Esc y borrar lo dibujado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('.inspector, .overlay')) return;
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      if (mod && e.code === 'KeyZ') e.shiftKey ? redo() : undo();
      else if (mod && !e.shiftKey && e.code === 'KeyY') redo();
      else if (e.key === 'Escape' && (sel || tool !== 'select')) sel ? setSel(null) : pickTool('select');
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        setDrawings((ds) => ds.filter((d) => d.id !== sel));
        setSel(null);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const ctx: Ctx = { rows: byId, onOpenNote, setData };
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const nodeTypes = useMemo(
    () => ({
      text: (p: NodeProps<Node<Data>>) => <TextCard {...p} ctx={ctxRef.current} />,
      note: (p: NodeProps<Node<Data>>) => <NoteCard {...p} ctx={ctxRef.current} />,
      file: FileCard,
      group: (p: NodeProps<Node<Data>>) => <GroupCard {...p} ctx={ctxRef.current} />,
    }),
    [],
  );
  const edgeTypes = useMemo(() => ({ arrow: FloatingArrow }), []);

  // Centro de lo que se ve, para lo que se añade desde la barra.
  const center = () => {
    const r = host.current!.getBoundingClientRect();
    return flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };

  const add = (type: keyof typeof SIZE, at: { x: number; y: number }, data: Data = {}, size = SIZE[type]) => {
    const { w, h } = size;
    // Lo que cae encima de otra tarjeta se corre un poco en diagonal.
    const busy = (x: number, y: number) => flow.getNodes().some((o) => o.type !== 'group' && Math.abs(o.position.x - (x - w / 2)) < 24 && Math.abs(o.position.y - (y - h / 2)) < 24);
    at = { ...at };
    for (let i = 0; i < 20 && type !== 'group' && busy(at.x, at.y); i++) at = { x: at.x + 32, y: at.y + 32 };
    const n: Node<Data> = { id: ulid(), type, position: { x: at.x - w / 2, y: at.y - h / 2 }, width: w, height: h, zIndex: type === 'group' ? -1 : 0, selected: true, data };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), n]);
    return n.id;
  };

  const addMedia = (files: File[], at: { x: number; y: number }) =>
    uploadMedia(files)
      .then((made) =>
        made.forEach((m, i) => {
          // Las fichas, una debajo de otra; lo que se ve, en diagonal.
          if (m.type === 'file') add('file', { x: at.x, y: at.y + i * (DOC_SIZE.h + 16) }, { file: String(m.attrs.src), name: files[i].name }, DOC_SIZE);
          else add('file', { x: at.x + i * 40, y: at.y + i * 40 }, { file: String(m.attrs.src) });
        }),
      )
      .catch(onError);

  // Pegar archivos (imágenes, PDF, documentos…) en el lienzo.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void addMedia(files, center());
      } else {
        const text = e.clipboardData?.getData('text/plain')?.trim();
        if (text) {
          e.preventDefault();
          add('text', center(), { text });
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  return (
    <div
      ref={host}
      className={`board${drawing ? ' is-drawing' : ''}`}
      data-tool={tool}
      // La hoja deja el Esc al lienzo mientras haya herramienta o dibujo elegido.
      data-esc={drawing || sel ? '' : undefined}
      onPointerDownCapture={onDrawDown}
      onPointerMove={onDrawMove}
      onPointerUp={onDrawUp}
      onPointerCancel={onDrawUp}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void addMedia(files, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(c: NodeChange<Node<Data>>[]) => setNodes((ns) => applyNodeChanges(c, ns))}
        onEdgesChange={(c: EdgeChange[]) => setEdges((es) => applyEdgeChanges(c, es))}
        onConnect={(c: Connection) =>
          c.source !== c.target &&
          setEdges((es) => (es.some((e) => e.source === c.source && e.target === c.target) ? es : [...es, { id: ulid(), source: c.source, target: c.target, type: 'arrow', markerEnd: ARROW }]))
        }
        onPaneClick={(e) => {
          setSel(null);
          // Doble clic en el vacío: tarjeta nueva, ya escribiendo.
          if (e.detail === 2) add('text', flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), { editing: true });
        }}
        onNodeClick={() => setSel(null)}
        // Dibujando, las tarjetas se quedan quietas y un dedo solo dibuja; el
        // lienzo se mueve con la rueda, con dos dedos o con el botón central
        // (eso lo lleva la capa de dibujo, no React Flow).
        nodesDraggable={!drawing}
        nodesConnectable={!drawing}
        elementsSelectable={!drawing}
        panOnDrag={!drawing}
        connectionMode={ConnectionMode.Loose}
        defaultEdgeOptions={{ type: 'arrow', markerEnd: ARROW }}
        connectionLineStyle={{ stroke: 'var(--board-edge)', strokeWidth: 1.5 }}
        zoomOnDoubleClick={false}
        deleteKeyCode={['Delete', 'Backspace']}
        minZoom={0.1}
        maxZoom={3}
        fitView={nodes.length > 0}
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} className="board-dots" />
        <ViewportPortal>
          <DrawLayer
            drawings={drawings}
            draft={draft}
            selected={sel}
            erasing={erasing}
            typing={typing}
            onShapeDown={onShapeDown}
            onTextEdit={editText}
            onTyping={(text) => typingRef.current && setTyping({ ...typingRef.current, text })}
            onTypingDone={commitTyping}
          />
        </ViewportPortal>
      </ReactFlow>
      <DrawBar
        tool={tool}
        color={sel ? (drawings.find((d) => d.id === sel)?.color ?? style.color) : style.color}
        size={sel ? (drawings.find((d) => d.id === sel)?.size ?? style.size) : style.size}
        showStyle={(drawing && tool !== 'eraser') || !!sel}
        canUndo={hist.current.at > 0 || hist.current.stack[hist.current.at] !== boardJson}
        canRedo={hist.current.at < hist.current.stack.length - 1 && hist.current.stack[hist.current.at] === boardJson}
        onTool={pickTool}
        onColor={(color) => setStyle({ color })}
        onSize={(size) => setStyle({ size })}
        onUndo={undo}
        onRedo={redo}
      />
      {!nodes.length && !drawings.length && !drawing && (
        <p className="board-empty">
          {t('Doble clic para una')} <em>{t('tarjeta')}</em>{t(', o pega o suelta un archivo')}
        </p>
      )}
      <nav className="board-tools surface-2" aria-label={t('Añadir al lienzo')}>
        <button onClick={() => add('text', center(), { editing: true })}>{t('Tarjeta')}</button>
        <button onClick={() => onPickNote((id) => add('note', center(), { noteId: id }))}>{t('Nota')}</button>
        <button onClick={() => add('group', center(), { label: '' })}>{t('Grupo')}</button>
        <label className="board-tools-file">
          {t('Archivo')}
          <input
            type="file"
            multiple
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) void addMedia(files, center());
            }}
          />
        </label>
        <span className="board-tools-sep" />
        <button onClick={() => flow.fitView({ padding: 0.25, maxZoom: 1, duration: 500 })}>{t('Encuadrar')}</button>
      </nav>
    </div>
  );
}

export function CanvasBoard(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner key={props.note.id} {...props} />
    </ReactFlowProvider>
  );
}

