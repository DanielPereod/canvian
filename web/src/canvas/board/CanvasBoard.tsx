import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { isMedia, uploadMedia } from '../media';
import { boardText, parseBoard, type Board, type BoardNode } from './board';
import './board.css';

// El lienzo de una nota de tipo canvas: tarjetas de texto, notas enlazadas,
// imágenes y grupos que se colocan libremente y se unen con flechas, como un
// canvas de Obsidian. Guarda en formato JSON Canvas.

type Data = {
  text?: string;
  label?: string;
  noteId?: string;
  file?: string;
  editing?: boolean;
};

type Ctx = {
  rows: Map<string, NoteRow>;
  onOpenNote: (id: string) => void;
  setData: (id: string, data: Partial<Data>) => void;
};

const SIZE = { text: { w: 260, h: 120 }, note: { w: 280, h: 140 }, file: { w: 320, h: 220 }, group: { w: 560, h: 380 } };

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
          placeholder="Escribe…"
          onBlur={(e) => ctx.setData(id, { text: e.target.value, editing: false })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <div className="board-text-body">{data.text?.trim() ? data.text : <span className="faint">Doble clic para escribir</span>}</div>
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
      <span className="board-note-kind meta">{row?.kind === 'task' ? 'Tarea' : row?.kind === 'canvas' ? 'Canvas' : 'Nota'}</span>
      <strong className="board-note-title">{row ? row.title || 'Nota sin título' : 'Nota borrada'}</strong>
      {body && <p className="board-note-body">{body}</p>}
      {row && <span className="board-note-open meta">Doble clic para abrir</span>}
    </div>
  );
}

function FileCard({ data, selected }: NodeProps<Node<Data>>) {
  const src = data.file ?? '';
  const kind = /\.(mp4|webm|mov)$/i.test(src) ? 'video' : /\.(mp3|ogg|wav|weba|m4a|aac|flac)$/i.test(src) ? 'audio' : 'image';
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
        placeholder="Grupo"
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
    data: n.type === 'text' ? { text: n.text } : n.type === 'note' ? { noteId: n.noteId } : n.type === 'file' ? { file: n.file } : { label: n.label },
  }));
  const edges: Edge[] = b.edges.map((e) => ({ id: e.id, source: e.fromNode, target: e.toNode, type: 'arrow', markerEnd: e.toEnd === 'none' ? undefined : ARROW }));
  return { nodes, edges };
};

const fromFlow = (nodes: Node<Data>[], edges: Edge[]): Board => ({
  type: 'canvas',
  nodes: nodes.map((n): BoardNode => {
    const base = { id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y), width: Math.round(n.width ?? n.measured?.width ?? 200), height: Math.round(n.height ?? n.measured?.height ?? 100) };
    if (n.type === 'note') return { ...base, type: 'note', noteId: n.data.noteId! };
    if (n.type === 'file') return { ...base, type: 'file', file: n.data.file! };
    if (n.type === 'group') return { ...base, type: 'group', label: n.data.label ?? '' };
    return { ...base, type: 'text', text: n.data.text ?? '' };
  }),
  edges: edges.map((e) => ({ id: e.id, fromNode: e.source, toNode: e.target, ...(e.markerEnd ? {} : { toEnd: 'none' as const }) })),
});

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
  const initial = useMemo(() => toFlow(parseBoard(note.bodyJson)), [note.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes] = useState<Node<Data>[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const flow = useReactFlow();
  const host = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // Guardar al rato de dejar de tocar; lo que se está escribiendo no cuenta.
  const first = useRef(true);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // Al cerrar la hoja se guarda lo que quedara pendiente.
  const pending = useRef<(() => void) | null>(null);
  const flush = () => {
    pending.current?.();
    pending.current = null;
  };
  useEffect(() => flush, []);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const board = fromFlow(nodes, edges);
    pending.current = () => onSaveRef.current({ bodyJson: JSON.stringify(board), bodyText: boardText(board, byId) });
    const t = setTimeout(flush, 450);
    return () => clearTimeout(t);
    // Solo el contenido: posiciones, tamaños, textos y flechas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(fromFlow(nodes, edges))]);

  const setData = useCallback((id: string, data: Partial<Data>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)));
  }, []);

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

  const add = (type: keyof typeof SIZE, at: { x: number; y: number }, data: Data = {}) => {
    const { w, h } = SIZE[type];
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
      .then((made) => made.forEach((m, i) => add('file', { x: at.x + i * 40, y: at.y + i * 40 }, { file: String(m.attrs.src) })))
      .catch(onError);

  // Pegar imágenes, vídeo o audio en el lienzo.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(isMedia);
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
      className="board"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files].filter(isMedia);
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
          // Doble clic en el vacío: tarjeta nueva, ya escribiendo.
          if (e.detail === 2) add('text', flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), { editing: true });
        }}
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
      </ReactFlow>
      {!nodes.length && (
        <p className="board-empty">
          Doble clic para una <em>tarjeta</em>, o pega una imagen
        </p>
      )}
      <nav className="board-tools surface-2" aria-label="Añadir al lienzo">
        <button onClick={() => add('text', center(), { editing: true })}>Tarjeta</button>
        <button onClick={() => onPickNote((id) => add('note', center(), { noteId: id }))}>Nota</button>
        <button onClick={() => add('group', center(), { label: '' })}>Grupo</button>
        <label className="board-tools-file">
          Imagen
          <input
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].filter(isMedia);
              e.target.value = '';
              if (files.length) void addMedia(files, center());
            }}
          />
        </label>
        <span className="board-tools-sep" />
        <button onClick={() => flow.fitView({ padding: 0.25, maxZoom: 1, duration: 500 })}>Encuadrar</button>
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

