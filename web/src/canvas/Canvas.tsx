import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createDegreeStore, DegreeContext } from './degrees';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeTypes,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react';
import { ulid } from 'ulidx';
import {
  api,
  parseProps,
  type BackgroundKind,
  type EdgeRow,
  type LayoutItem,
  type NoteInput,
  type NoteKind,
  type NoteRow,
  type Profile,
  type Lens,
  type PropertyDef,
  type TaskStatus,
} from '../api';
import { CanvasContext, type CanvasActions, type NoteContent, type NoteData } from './context';
import { NoteNode } from './NoteNode';
import { ZoneNode } from './ZoneNode';
import { CommandPalette } from './CommandPalette';
import { FloatingEdge } from './FloatingEdge';
import { Constellation, CONSTELLATION_ZOOM, DEEP_ZOOM, TITLES_ZOOM } from './Constellation';
import { useExperiments } from '../lab/experiments';
import { StarLayer } from './StarLayer';
import { SectionMap } from './SectionMap';
import { buildTree, type MapNode } from './sections';
import { Lantern, nextMode, type LensMode } from './Lantern';
import { parseLens } from './lanternMatch';
import { ColumnNode } from './ColumnNode';
import { FocusView } from './FocusView';
import { docText, docToMarkdown, markdownToDoc } from './markdown';
import { parseBody } from './editor';
import { COL_GAP, COL_W, columnsFor, dropChange, groupOptions, layout } from './arrange';
import { Inspector } from './Inspector';

type AppNode = Node<NoteData>;

const NOTE_WIDTH = 240;
const ZONE_SIZE = { w: 480, h: 320 };
const ZONE_PADDING = 40;
const nodeTypes: NodeTypes = { note: NoteNode, zone: ZoneNode, column: ColumnNode };
const edgeTypes: EdgeTypes = { floating: FloatingEdge };

function toNode(row: NoteRow): AppNode {
  const zone = row.kind === 'zone';
  return {
    id: row.id,
    type: zone ? 'zone' : 'note',
    position: { x: row.x, y: row.y },
    width: row.w ?? (zone ? ZONE_SIZE.w : NOTE_WIDTH),
    height: row.h ?? (zone ? ZONE_SIZE.h : undefined),
    zIndex: zone ? 0 : 10,
    dragHandle: zone ? '.zone-header' : undefined,
    data: row as NoteData,
  };
}

function toEdge(row: EdgeRow): Edge {
  return { id: row.id, source: row.fromId, target: row.toId, label: row.label ?? undefined, type: 'floating' };
}

const size = (n: AppNode) => ({
  w: n.measured?.width ?? n.width ?? NOTE_WIDTH,
  h: n.measured?.height ?? n.height ?? 80,
});

const center = (n: AppNode) => {
  const { w, h } = size(n);
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
};

function inside(zone: AppNode, p: { x: number; y: number }) {
  const { w, h } = size(zone);
  return p.x >= zone.position.x && p.x <= zone.position.x + w && p.y >= zone.position.y && p.y <= zone.position.y + h;
}

// La zona más pequeña que contiene el punto (así las zonas anidadas funcionan).
function zoneAt(nodes: AppNode[], p: { x: number; y: number }): string | null {
  let best: { id: string; area: number } | null = null;
  for (const n of nodes) {
    if (n.type !== 'zone') continue;
    const { w, h } = size(n);
    const inside = p.x >= n.position.x && p.x <= n.position.x + w && p.y >= n.position.y && p.y <= n.position.y + h;
    if (inside && (!best || w * h < best.area)) best = { id: n.id, area: w * h };
  }
  return best?.id ?? null;
}

const NEXT: Record<TaskStatus, TaskStatus> = { todo: 'doing', doing: 'done', done: 'todo' };
const now = () => new Date().toISOString();

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function Canvas({ profile, background }: { profile: Profile; background: BackgroundKind }) {
  const flow = useReactFlow<AppNode>();
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lamp, setLamp] = useState<string | null>(null);
  const [lampOpen, setLampOpen] = useState(false);
  const [mode, setMode] = useState<LensMode>('dim');
  const [groupBy, setGroupBy] = useState('status');
  const [lenses, setLenses] = useState<Lens[]>([]);
  // Mientras hay columnas: dónde están, posiciones de arrastre y la vista a la que volver.
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [dragPos, setDragPos] = useState(new Map<string, { x: number; y: number }>());
  const [hoverCol, setHoverCol] = useState<string | null>(null);
  const [colSize, setColSize] = useState(new Map<string, { width: number; height: number }>());
  const [settling, setSettling] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const savedView = useRef<Viewport | null>(null);
  const [defs, setDefs] = useState<PropertyDef[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const [degrees] = useState(createDegreeStore);
  useLayoutEffect(() => degrees.set(edges), [degrees, edges]);
  // Las notas entran con animación al abrir el lienzo; después solo las nuevas
  // (si no, al moverte se animarían todas las que van apareciendo).
  const [settled, setSettled] = useState(false);

  // Zoom semántico y constelación: solo repinta al cruzar un umbral.
  const { constelacion, secciones } = useExperiments();
  const zoomClass = useStore((s) => {
    const z = s.transform[2];
    return `${z < TITLES_ZOOM ? ' titles' : ''}${constelacion && z < CONSTELLATION_ZOOM ? ' constellation' : ''}${constelacion && z < DEEP_ZOOM ? ' deep' : ''}`;
  });

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const pending = useRef(new Map<string, NoteContent>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const deleted = useRef(new Set<string>());
  // Promesas de creación: nada que dependa de una nota nueva se envía antes de que exista.
  const created = useRef(new Map<string, Promise<unknown>>());
  const ready = (...ids: string[]) => Promise.all(ids.map((id) => created.current.get(id)));
  const zoneDrag = useRef(new Map<string, { start: { x: number; y: number }; children: { id: string; x: number; y: number }[] }>());
  const viewportTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const arrangementRef = useRef<unknown>(null);
  const columnAtRef = useRef<(x: number) => string | null>(() => null);
  const dropRef = useRef<(dragged: AppNode[]) => void>(() => {});

  // La linterna: qué notas quedan con luz. La clave en texto evita recalcular
  // el conjunto (y repintar todas las notas) mientras arrastras.
  // Los datos de las notas solo cambian al editarlas; arrastrar o seleccionar
  // crea nodos nuevos con los mismos datos, y así la lente no se recalcula.
  const rowsRef = useRef<NoteRow[]>([]);
  const rows = useMemo(() => {
    const prev = rowsRef.current;
    if (prev.length === nodes.length && nodes.every((n, i) => n.data === prev[i])) return prev;
    return (rowsRef.current = nodes.map((n) => n.data));
  }, [nodes]);
  const lens = useMemo(() => (lamp ? parseLens(lamp, { defs, notes: rows, links: edges }) : null), [lamp, rows, edges, defs]);
  const litKey = useMemo(
    () => (lens?.test ? rows.filter((r) => lens.test!(r)).map((r) => r.id).join(' ') : null),
    [lens, rows],
  );
  const lit = useMemo(() => (litKey === null ? null : new Set(litKey.split(' ').filter(Boolean))), [litKey]);

  const report = useCallback((err: unknown) => {
    console.error(err);
    setProblem('No se pudo guardar el último cambio. Revisa que el servidor sigue en marcha.');
  }, []);

  useEffect(() => {
    if (!problem) return;
    const t = setTimeout(() => setProblem(null), 5000);
    return () => clearTimeout(t);
  }, [problem]);

  const patchData = useCallback(
    (id: string, patch: Partial<NoteRow>) =>
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))),
    [setNodes],
  );

  // Carga inicial del perfil: notas, enlaces y dónde dejaste la vista.
  useEffect(() => {
    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    Promise.all([api.canvas(profile.id), api.getViewport(profile.id), api.properties(profile.id), api.lenses(profile.id)]).then(([canvas, viewport, properties, saved]) => {
      if (cancelled) return;
      setDefs(properties);
      setLenses(saved);
      setSettled(false);
      setNodes(canvas.notes.map(toNode));
      setEdges(canvas.edges.map(toEdge));
      flow.setViewport(viewport);
      settleTimer = setTimeout(() => setSettled(true), 1500);
    }, report);
    return () => {
      cancelled = true;
      clearTimeout(settleTimer);
    };
  }, [profile.id, flow, setNodes, setEdges, report]);

  const flush = useCallback(
    (id: string) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      const content = pending.current.get(id);
      pending.current.delete(id);
      if (content && !deleted.current.has(id))
        ready(id)
          .then(() => api.patchNote(id, content))
          .catch(report);
    },
    [report],
  );

  // Si cambias de perfil con cambios sin guardar, se guardan al salir.
  useEffect(
    () => () => {
      for (const id of [...pending.current.keys()]) flush(id);
    },
    [flush],
  );

  const removeNotes = useCallback(
    (all: string[]) => {
      const ids = all.filter((id) => !deleted.current.has(id));
      if (!ids.length) return;
      const gone = new Set(ids);
      for (const id of ids) {
        deleted.current.add(id);
        clearTimeout(timers.current.get(id));
        pending.current.delete(id);
        ready(id)
          .then(() => api.deleteNote(id))
          .catch(report);
      }
      setEdges((es) => es.filter((e) => !gone.has(e.source) && !gone.has(e.target)));
      // Primero se desvanecen y luego desaparecen del canvas.
      setNodes((ns) =>
        ns.map((n) => (gone.has(n.id) ? { ...n, className: 'is-leaving', selectable: false, draggable: false } : n)),
      );
      setTimeout(
        () =>
          setNodes((ns) =>
            ns
              .filter((n) => !gone.has(n.id))
              .map((n) => (n.data.zoneId && gone.has(n.data.zoneId) ? { ...n, data: { ...n.data, zoneId: null } } : n)),
          ),
        170,
      );
    },
    [report, setNodes, setEdges],
  );

  const createNote = useCallback(
    (pos: { x: number; y: number }, kind: NoteKind = 'text', extra: Partial<NoteRow> = {}) => {
      const row: NoteRow = {
        id: ulid(),
        profileId: profile.id,
        kind,
        title: null,
        bodyJson: null,
        bodyText: null,
        x: pos.x,
        y: pos.y,
        w: null,
        h: null,
        z: 0,
        zoneId: kind === 'zone' ? null : zoneAt(nodesRef.current, pos),
        status: null,
        priority: null,
        dueAt: null,
        doneAt: null,
        props: '{}',
        updatedAt: now(),
        ...extra,
      };
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...toNode(row), selected: true, className: 'born' }]);
      const request = api.createNote(profile.id, { ...row, props: parseProps(row.props) }).catch(report);
      created.current.set(row.id, request);
      void request.then(() => created.current.delete(row.id));
      if (kind !== 'zone') setEditingId(row.id);
      return row;
    },
    [profile.id, report, setNodes],
  );

  // Cambia campos de una nota: al momento en pantalla y después en el servidor.
  const updateNote = useCallback(
    (id: string, change: NoteInput) => {
      const { props, ...rest } = change;
      patchData(id, { ...rest, ...(props ? { props: JSON.stringify(props) } : {}), updatedAt: now() });
      ready(id)
        .then(() => api.patchNote(id, change))
        .catch(report);
    },
    [patchData, report],
  );

  const patchNotes = (targets: AppNode[], patch: (n: AppNode) => NoteInput) => {
    for (const n of targets) updateNote(n.id, patch(n));
  };

  const setStatus = (targets: AppNode[], status: TaskStatus) =>
    patchNotes(targets, () => ({ status, doneAt: status === 'done' ? now() : null }));

  // T convierte las notas seleccionadas en tareas (o las devuelve a notas).
  const toggleTask = () => {
    const selected = nodesRef.current.filter((n) => n.selected && n.type === 'note');
    if (!selected.length) return;
    const toTask = selected.some((n) => n.data.kind !== 'task');
    patchNotes(selected, (n) =>
      toTask ? { kind: 'task', status: n.data.status ?? 'todo' } : { kind: 'text' },
    );
  };

  // X hace avanzar el estado: pendiente → en curso → hecha.
  const advanceTasks = () => {
    const selected = nodesRef.current.filter((n) => n.selected && n.data.kind === 'task');
    if (!selected.length) return;
    setStatus(selected, NEXT[selected[0].data.status ?? 'todo']);
  };

  const actions = useMemo<CanvasActions>(
    () => ({
      editingId,
      startEditing: (id) => setEditingId(id),
      finishEditing: (id) => {
        setEditingId((current) => (current === id ? null : current));
        const text = pending.current.get(id)?.bodyText ?? nodesRef.current.find((n) => n.id === id)?.data.bodyText;
        flush(id);
        // Una nota que se queda vacía al salir de ella no merece existir.
        if (!text?.trim()) removeNotes([id]);
      },
      saveContent: (id, content) => {
        patchData(id, { ...content, updatedAt: now() });
        pending.current.set(id, content);
        clearTimeout(timers.current.get(id));
        timers.current.set(id, setTimeout(() => flush(id), 600));
      },
      renameZone: (id, title) => {
        patchData(id, { title: title || null });
        ready(id)
          .then(() => api.patchNote(id, { title: title || null }))
          .catch(report);
      },
      resized: (id, rect) => {
        const node = nodesRef.current.find((n) => n.id === id);
        if (!node) return;
        const items: LayoutItem[] = [{ id, x: rect.x, y: rect.y, w: rect.width, h: rect.height }];
        if (node.type === 'zone') {
          // Al redimensionar una zona, entran las notas que ahora caen dentro y salen las que no.
          const updated = nodesRef.current.map((n) =>
            n.id === id ? { ...n, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height } : n,
          );
          for (const n of updated) {
            if (n.type === 'zone') continue;
            const zoneId = zoneAt(updated, center(n));
            if (zoneId !== n.data.zoneId) {
              items.push({ id: n.id, x: n.position.x, y: n.position.y, zoneId });
              patchData(n.id, { zoneId });
            }
          }
        }
        patchData(id, { w: rect.width, h: rect.height });
        ready(...items.map((i) => i.id))
          .then(() => api.saveLayout(items))
          .catch(report);
      },
      cycleStatus: (id) => {
        const node = nodesRef.current.find((n) => n.id === id);
        if (node) setStatus([node], NEXT[node.data.status ?? 'todo']);
      },
      lit,
      defs,
      updateNote,
      openInspector: (id) => {
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
        setInspectorOpen(true);
      },
    }),
    [editingId, flush, patchData, removeNotes, report, lit, defs, updateNote, setNodes],
  );

  const onPaneDoubleClick = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.react-flow__pane, .zone-body')) return;
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    createNote({ x: p.x - NOTE_WIDTH / 2, y: p.y - 20 });
  };

  const onNodeDragStart = (_: unknown, _node: AppNode, dragged: AppNode[]) => {
    zoneDrag.current.clear();
    if (mode === 'arrange' && lit) return;
    const draggedIds = new Set(dragged.map((n) => n.id));
    for (const zone of dragged.filter((n) => n.type === 'zone')) {
      zoneDrag.current.set(zone.id, {
        start: { ...zone.position },
        // Todo lo que cae dentro, también las subzonas y sus notas.
        children: nodesRef.current
          .filter((n) => !draggedIds.has(n.id) && (n.data.zoneId === zone.id || inside(zone, center(n))))
          .map((n) => ({ id: n.id, ...n.position })),
      });
    }
  };

  // Mover una zona arrastra su contenido.
  const onNodeDrag = (_: unknown, node: AppNode, dragged: AppNode[]) => {
    if (arrangementRef.current) {
      setHoverCol(columnAtRef.current(node.position.x + COL_W / 2));
      return;
    }
    if (!zoneDrag.current.size) return;
    const moves = new Map<string, { x: number; y: number }>();
    for (const zone of dragged) {
      const info = zoneDrag.current.get(zone.id);
      if (!info) continue;
      const dx = zone.position.x - info.start.x;
      const dy = zone.position.y - info.start.y;
      for (const c of info.children) moves.set(c.id, { x: c.x + dx, y: c.y + dy });
    }
    setNodes((ns) => ns.map((n) => (moves.has(n.id) ? { ...n, position: moves.get(n.id)! } : n)));
  };

  const onNodeDragStop = (_: unknown, _node: AppNode, dragged: AppNode[]) => {
    if (arrangementRef.current) return dropRef.current(dragged);
    const current = nodesRef.current;
    const items: LayoutItem[] = [];
    for (const n of dragged) {
      if (n.type === 'zone') {
        items.push({ id: n.id, x: n.position.x, y: n.position.y });
        for (const c of zoneDrag.current.get(n.id)?.children ?? []) {
          const moved = current.find((m) => m.id === c.id);
          if (moved) items.push({ id: c.id, x: moved.position.x, y: moved.position.y });
        }
      } else {
        const zoneId = zoneAt(current, center(n));
        items.push({ id: n.id, x: n.position.x, y: n.position.y, zoneId });
        if (zoneId !== n.data.zoneId) patchData(n.id, { zoneId });
      }
    }
    zoneDrag.current.clear();
    for (const i of items) patchData(i.id, { x: i.x, y: i.y, updatedAt: now() });
    if (items.length)
      ready(...items.map((i) => i.id))
        .then(() => api.saveLayout(items))
        .catch(report);
  };

  const isValidConnection = (c: Connection | Edge) =>
    c.source !== c.target &&
    !edges.some(
      (e) => (e.source === c.source && e.target === c.target) || (e.source === c.target && e.target === c.source),
    );

  const connect = (source: string, target: string) => {
    const id = ulid();
    setEdges((es) => [...es, { id, source, target, type: 'floating', className: 'born' }]);
    ready(source, target)
      .then(() => api.createEdge(profile.id, { id, fromId: source, toId: target }))
      .catch(report);
  };

  // Soltar una conexión en el vacío crea una nota nueva ya enlazada.
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode) return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    // Soltar sobre el cuerpo de otra nota (no solo sobre su asa) también enlaza.
    const over = document
      .elementFromPoint(point.clientX, point.clientY)
      ?.closest<HTMLElement>('.react-flow__node')?.dataset.id;
    if (over) {
      if (isValidConnection({ source: state.fromNode.id, target: over, sourceHandle: null, targetHandle: null }))
        connect(state.fromNode.id, over);
      return;
    }
    const p = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
    const row = createNote({ x: p.x - NOTE_WIDTH / 2, y: p.y - 20 });
    connect(state.fromNode.id, row.id);
  };

  const groupIntoZone = () => {
    const selected = nodesRef.current.filter((n) => n.selected && n.type === 'note');
    if (selected.length) {
      const xs = selected.flatMap((n) => [n.position.x, n.position.x + size(n).w]);
      const ys = selected.flatMap((n) => [n.position.y, n.position.y + size(n).h]);
      const x = Math.min(...xs) - ZONE_PADDING;
      const y = Math.min(...ys) - ZONE_PADDING - 24;
      const w = Math.max(...xs) - x + ZONE_PADDING;
      const h = Math.max(...ys) - y + ZONE_PADDING;
      const zone = createNote({ x, y }, 'zone', { w, h });
      const items = selected.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, zoneId: zone.id }));
      for (const n of selected) patchData(n.id, { zoneId: zone.id });
      ready(zone.id)
        .then(() => api.saveLayout(items))
        .catch(report);
    } else {
      const { x, y, zoom } = flow.getViewport();
      const box = document.querySelector('.react-flow')!.getBoundingClientRect();
      createNote(
        { x: (box.width / 2 - x) / zoom - ZONE_SIZE.w / 2, y: (box.height / 2 - y) / zoom - ZONE_SIZE.h / 2 },
        'zone',
        { ...ZONE_SIZE },
      );
    }
  };

  const focusNote = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      flow.fitView({ nodes: [{ id }], duration: 400, maxZoom: 1.2, padding: 0.6 });
    },
    [flow, setNodes],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        exportCanvas();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (isTyping(e.target) || mod || paletteOpen || focusId) return;
      // ⇧1…⇧9 abren las lentes guardadas.
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (e.shiftKey && digit) {
        const saved = lenses.find((l) => l.slot === Number(digit[1]));
        if (saved) {
          e.preventDefault();
          applyLens(saved);
        }
        return;
      }
      if (e.key === 'Tab' && lamp) {
        e.preventDefault();
        setMode(nextMode(mode));
        return;
      }
      if (e.key === 'Escape' && lamp && !inspectorOpen) {
        clearLamp();
        return;
      }
      if (e.key.toLowerCase() === 'g') {
        if (arranging) return;
        e.preventDefault();
        groupIntoZone();
      } else if (e.key === 'Enter') {
        // Enter abre el modo foco; el doble clic sigue editando en el sitio.
        const selected = nodesRef.current.filter((n) => n.selected);
        if (selected.length === 1 && selected[0].type === 'note') {
          e.preventDefault();
          setFocusId(selected[0].id);
        }
      } else if (e.key === '2') {
        const selected = nodesRef.current.filter((n) => n.selected);
        if (selected.length) void flow.fitView({ nodes: selected.map((n) => ({ id: n.id })), duration: 500, padding: 0.35, maxZoom: 1.4 });
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        toggleTask();
      } else if (e.key.toLowerCase() === 'x') {
        e.preventDefault();
        advanceTasks();
      } else if (e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setInspectorOpen((o) => !o);
      } else if (e.key === 'Escape' && inspectorOpen) {
        setInspectorOpen(false);
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setLamp((q) => q ?? '');
        setLampOpen(true);
      } else if (e.key === '1' && !arranging) {
        flow.fitView({ duration: 400, padding: 0.2 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Lentes: atenuar, ocultar o colocar en columnas ─────────────
  const arranging = mode === 'arrange' && !!lit;

  // Mapa de secciones (laboratorio): con el experimento encendido, el lienzo
  // se ve siempre como un mapa de secciones que fluyen.
  const mapTree = useMemo(
    () => (secciones ? buildTree(nodes.map((n) => ({ row: n.data, rect: { x: n.position.x, y: n.position.y, ...size(n) } })), edges) : null),
    [secciones, nodes, edges],
  );
  const mapPath = useRef<string[]>([]);
  const createFromMap = (zoneId: string | null, near: MapNode) => {
    const zone = zoneId ? nodesRef.current.find((n) => n.id === zoneId) : null;
    const r = zone ? { x: zone.position.x, y: zone.position.y, ...size(zone) } : near.rect;
    const pos = { x: r.x + 40 + Math.random() * Math.max(0, r.w - NOTE_WIDTH - 80), y: r.y + 90 + Math.random() * Math.max(0, r.h - 160) };
    const row = createNote(pos, 'text', { zoneId });
    // Se escribe en el modo foco, no en la nota del lienzo que queda debajo.
    setEditingId(null);
    setFocusId(row.id);
  };
  const groups = useMemo(() => groupOptions(defs), [defs]);
  const group = groups.some((g) => g.id === groupBy) ? groupBy : 'status';

  // Al entrar en columnas se guarda la vista para volver a ella al salir.
  useEffect(() => {
    if (arranging) {
      savedView.current = flow.getViewport();
      const box = document.querySelector('.react-flow')!.getBoundingClientRect();
      setOrigin(flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height * 0.2 }));
      return;
    }
    setOrigin(null);
    setDragPos(new Map());
    if (savedView.current) {
      void flow.setViewport(savedView.current, { duration: 600 });
      savedView.current = null;
      // Las notas vuelven a su sitio con transición; después se quita.
      setSettling(true);
      const t = setTimeout(() => setSettling(false), 700);
      return () => clearTimeout(t);
    }
  }, [arranging, flow]);

  const arrangement = useMemo(() => {
    if (!arranging || !origin || !lit) return null;
    const items = nodes
      .filter((n) => n.type === 'note' && lit.has(n.id))
      .map((n) => ({ row: n.data as NoteRow, height: n.measured?.height ?? 80 }));
    const { columns, keyOf } = columnsFor(group, defs, items.map((i) => i.row));
    return layout(items, columns, keyOf, origin, group === 'due');
  }, [arranging, origin, lit, nodes, group, defs]);

  // Encuadra las columnas cuando aparecen o cambia el criterio: a lo ancho y
  // empezando bajo la lente, a tamaño legible (las largas se recorren bajando).
  const arrangeCount = arrangement?.cols.length ?? 0;
  useEffect(() => {
    if (!arrangeCount || !origin) return;
    const box = document.querySelector('.react-flow')!.getBoundingClientRect();
    const width = arrangeCount * COL_W + (arrangeCount - 1) * COL_GAP + 60;
    const zoom = Math.min(1, (box.width - 48) / width);
    const top = lampOpen ? 230 : 96;
    void flow.setViewport({ x: box.width / 2 - origin.x * zoom, y: top - origin.y * zoom, zoom }, { duration: 650 });
    // Solo al cambiar el número de columnas o el sitio; no al abrir o cerrar la lente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrangeCount, origin, flow]);

  const columnAt = (x: number) => {
    if (!arrangement) return null;
    const i = Math.floor((x - arrangement.left + COL_GAP / 2) / (COL_W + COL_GAP));
    return arrangement.cols[Math.max(0, Math.min(arrangement.cols.length - 1, i))]?.key ?? null;
  };

  const displayNodes = useMemo(() => {
    if (!lit || mode === 'dim') return nodes;
    const out = (n: AppNode) => ({ ...n, className: `${n.className ?? ''} lens-out`.trim(), selectable: false, draggable: false });
    if (mode === 'hide' || !arrangement) return nodes.map((n) => (lit.has(n.id) ? n : out(n)));
    const tallest = Math.max(...arrangement.cols.map((c) => c.bottom - c.y), 200);
    const columns = arrangement.cols.map(
      (c) =>
        ({
          id: 'col:' + c.key,
          type: 'column',
          position: { x: c.x - 14, y: c.y },
          width: COL_W + 28,
          measured: colSize.get('col:' + c.key),
          zIndex: 1,
          selectable: false,
          draggable: false,
          data: { title: c.title, count: c.count, active: hoverCol === c.key, height: tallest + 24 },
        }) as unknown as AppNode,
    );
    return [
      ...columns,
      ...nodes.map((n) => {
        const pos = arrangement.positions.get(n.id);
        if (!pos) return out(n);
        return { ...n, position: dragPos.get(n.id) ?? pos, width: COL_W };
      }),
    ];
  }, [nodes, lit, mode, arrangement, dragPos, hoverCol, colSize]);

  // En columnas, mover una nota no toca su posición real en el canvas.
  const onDisplayNodesChange = (changes: NodeChange<AppNode>[]) => {
    if (!arrangement) return onNodesChange(changes);
    const rest: NodeChange<AppNode>[] = [];
    const moves = new Map(dragPos);
    const sizes = new Map(colSize);
    for (const c of changes) {
      if (c.type === 'position') {
        if (c.position) moves.set(c.id, c.position);
      } else if (c.type === 'dimensions' && c.id.startsWith('col:')) {
        if (c.dimensions) sizes.set(c.id, c.dimensions);
      } else if (c.type === 'dimensions' && c.dimensions && arrangement.positions.has(c.id)) {
        // El ancho es el de la columna; solo nos quedamos con la altura real.
        rest.push({ ...c, dimensions: { ...c.dimensions, width: nodesRef.current.find((n) => n.id === c.id)?.measured?.width ?? c.dimensions.width }, setAttributes: false });
      } else rest.push(c);
    }
    if (moves.size !== dragPos.size || changes.some((c) => c.type === 'position')) setDragPos(moves);
    if (sizes.size !== colSize.size || changes.some((c) => c.type === 'dimensions' && c.id.startsWith('col:'))) setColSize(sizes);
    if (rest.length) onNodesChange(rest);
  };

  const dropInColumn = (dragged: AppNode[]) => {
    for (const n of dragged) {
      const pos = dragPos.get(n.id) ?? n.position;
      const key = columnAt(pos.x + COL_W / 2);
      const row = nodesRef.current.find((m) => m.id === n.id)?.data;
      if (!key || !row) continue;
      const change = dropChange(group, key, defs, row);
      if (change) updateNote(n.id, change);
    }
    setDragPos(new Map());
    setHoverCol(null);
  };

  const applyLens = (l: Lens) => {
    const [m, g] = l.mode.split(':');
    setLamp(l.query);
    setMode((m as LensMode) || 'dim');
    if (g) setGroupBy(g);
    setLampOpen(false);
  };

  const saveLens = async () => {
    if (!lamp?.trim()) return null;
    const lensRow = { id: ulid(), name: lamp.trim(), query: lamp.trim(), mode: mode === 'arrange' ? `arrange:${group}` : mode };
    try {
      const created = await api.createLens(profile.id, lensRow);
      setLenses((ls) => [...ls.map((l) => (l.slot === created.slot ? { ...l, slot: null } : l)), created].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)));
      return created;
    } catch (err) {
      report(err);
      return null;
    }
  };

  arrangementRef.current = arrangement;
  columnAtRef.current = columnAt;
  dropRef.current = dropInColumn;

  const clearLamp = () => {
    setLamp(null);
    setLampOpen(false);
    setMode('dim');
  };

  // ── Importar Markdown (arrastrando archivos) y exportar a JSON Canvas ──
  const [dropping, setDropping] = useState(false);

  const importMarkdown = async (files: File[], at: { x: number; y: number }) => {
    const docs = await Promise.all(
      files.map(async (f) => ({ name: f.name.replace(/\.(md|markdown|txt)$/i, ''), ...markdownToDoc(await f.text()) })),
    );
    const COLS = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(docs.length))));
    const rows = docs.map((d, i): NoteRow => {
      const bodyText = docText(d.doc);
      return {
        id: ulid(),
        profileId: profile.id,
        kind: 'text',
        title: d.heading ?? d.name,
        bodyJson: JSON.stringify(d.doc),
        bodyText,
        x: at.x + (i % COLS) * (NOTE_WIDTH + 60),
        y: at.y + Math.floor(i / COLS) * 260,
        w: null,
        h: null,
        z: 0,
        zoneId: zoneAt(nodesRef.current, { x: at.x + (i % COLS) * (NOTE_WIDTH + 60), y: at.y + Math.floor(i / COLS) * 260 }),
        status: null,
        priority: null,
        dueAt: null,
        doneAt: null,
        props: '{}',
        updatedAt: now(),
      };
    });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...rows.map((r) => ({ ...toNode(r), selected: true, className: 'born' }))]);
    for (const row of rows) {
      const request = api.createNote(profile.id, { ...row, props: {} }).catch(report);
      created.current.set(row.id, request);
      void request.then(() => created.current.delete(row.id));
    }
    // [[Enlaces]] entre notas: por nombre de archivo o por título, sin importar mayúsculas.
    const byName = new Map<string, string>();
    for (const n of nodesRef.current) if (n.data.title) byName.set(n.data.title.toLowerCase(), n.id);
    rows.forEach((r, i) => {
      byName.set(docs[i].name.toLowerCase(), r.id);
      if (r.title) byName.set(r.title.toLowerCase(), r.id);
    });
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      for (const target of docs[i].links) {
        const to = byName.get(target.toLowerCase());
        const pair = [r.id, to].sort().join();
        if (to && to !== r.id && !seen.has(pair)) {
          seen.add(pair);
          connect(r.id, to);
        }
      }
    });
  };

  const onDrop = (e: React.DragEvent) => {
    const files = [...e.dataTransfer.files].filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    setDropping(false);
    if (!files.length) return;
    e.preventDefault();
    void importMarkdown(files, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const exportCanvas = () => {
    const out = {
      nodes: nodesRef.current.map((n) => {
        const { w, h } = size(n);
        const base = { id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y), width: Math.round(w), height: Math.round(h) };
        if (n.type === 'zone') return { ...base, type: 'group', label: n.data.title ?? '' };
        const md = docToMarkdown(parseBody(n.data.bodyJson)) || (n.data.bodyText ?? '');
        const box = n.data.kind === 'task' ? `- [${n.data.status === 'done' ? 'x' : ' '}] ` : '';
        return { ...base, type: 'text', text: box + md };
      }),
      edges: edges.map((e) => ({ id: e.id, fromNode: e.source, toNode: e.target, ...(e.label ? { label: String(e.label) } : {}) })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${profile.name}.canvas`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const focused = focusId ? (nodes.find((n) => n.id === focusId)?.data ?? null) : null;
  const focusNeighbors = useMemo(() => {
    if (!focusId) return [];
    const ids = new Set(edges.flatMap((e) => (e.source === focusId ? [e.target] : e.target === focusId ? [e.source] : [])));
    return nodes.filter((n) => ids.has(n.id)).map((n) => n.data);
  }, [focusId, edges, nodes]);

  const selectedNotes = nodes.filter((n) => n.selected && n.type === 'note');
  const selectedNote = selectedNotes.length === 1 ? selectedNotes[0].data : null;

  const onMoveEnd = (_: unknown, v: Viewport) => {
    if (savedView.current) return;
    clearTimeout(viewportTimer.current);
    viewportTimer.current = setTimeout(() => void api.saveViewport(profile.id, v), 400);
  };

  return (
    <CanvasContext.Provider value={actions}>
      <DegreeContext.Provider value={degrees}>
        <div
          className={`canvas${mapTree ? ' mapped' : ''}${zoomClass}${settled ? ' settled' : ''}${lit ? ` lamp-on lens-${mode}` : ''}${arranging || settling ? ' arranging' : ''}`}
          onDoubleClick={(e) => !arranging && onPaneDoubleClick(e)}
          onDragOver={(e) => {
            if (![...e.dataTransfer.types].includes('Files')) return;
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
          onDrop={onDrop}
        >
          {dropping && (
            <div className="drop-hint" aria-hidden="true">
              <p className="display">
                Suelta tus <em>notas</em>
              </p>
              <span className="meta">Archivos .md · los [[enlaces]] se convierten en tallos</span>
            </div>
          )}
          <div className="lamp-dark" aria-hidden="true" />
          <ReactFlow<AppNode>
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onDisplayNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onBeforeDelete={async ({ nodes: ns, edges: es }) => {
              // Las notas las borramos nosotros para poder animar su salida.
              if (ns.length) removeNotes(ns.map((n) => n.id));
              return { nodes: [], edges: es.filter((e) => !ns.some((n) => n.id === e.source || n.id === e.target)) };
            }}
            onEdgesDelete={(es) => {
              for (const e of es) if (!deleted.current.has(e.source) && !deleted.current.has(e.target)) api.deleteEdge(e.id).catch(report);
            }}
            onConnect={(c) => c.source && c.target && connect(c.source, c.target)}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            connectionMode={ConnectionMode.Loose}
            onMoveEnd={onMoveEnd}
            deleteKeyCode={['Backspace', 'Delete']}
            elevateNodesOnSelect={false}
            multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
            zoomOnDoubleClick={false}
            onlyRenderVisibleElements
            minZoom={0.1}
            maxZoom={3}
            defaultEdgeOptions={{ type: 'floating', zIndex: 5 }}
            proOptions={{ hideAttribution: true }}
          >
            <Constellation />
            <StarLayer />
            {background === 'dots' && (
              <Background variant={BackgroundVariant.Dots} gap={26} size={1.2} color="var(--dots)" />
            )}
            {background === 'grid' && (
              <Background variant={BackgroundVariant.Lines} gap={52} lineWidth={1} color="var(--grid)" />
            )}
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="empty-state">
              <div>
                <p className="display">
                  Un lienzo en <em>calma</em>
                </p>
                <span className="meta">Doble clic para plantar la primera nota</span>
              </div>
            </div>
          )}
        </div>
        {mapTree && (
          <SectionMap
            tree={mapTree}
            paused={!!focusId || paletteOpen}
            start={mapPath.current}
            onPath={(ids) => (mapPath.current = ids)}
            onOpen={setFocusId}
            onCreate={createFromMap}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            profileId={profile.id}
            onPick={(id) => {
              setPaletteOpen(false);
              if (secciones) setFocusId(id);
              else focusNote(id);
            }}
            onCreate={(text) => {
              setPaletteOpen(false);
              const { x, y, zoom } = flow.getViewport();
              const box = document.querySelector('.react-flow')!.getBoundingClientRect();
              const row = createNote({ x: (box.width / 2 - x) / zoom - NOTE_WIDTH / 2, y: (box.height / 2 - y) / zoom - 40 });
              const bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
              actions.saveContent(row.id, { bodyJson, bodyText: text, title: text.slice(0, 120) });
            }}
            onClose={() => setPaletteOpen(false)}
          />
        )}
        {focused && (
          <FocusView
            note={focused}
            neighbors={focusNeighbors}
            defs={defs}
            onNavigate={(id) => {
              flush(focused.id);
              setFocusId(id);
            }}
            onSave={actions.saveContent}
            onCycle={actions.cycleStatus}
            onProps={(id) => actions.openInspector(id)}
            onClose={() => {
              const id = focused.id;
              flush(id);
              setFocusId(null);
              if (!secciones) focusNote(id);
              // En el mapa, una nota nueva que se queda vacía no se guarda.
              else if (!focused.bodyText?.trim()) removeNotes([id]);
            }}
          />
        )}
        {inspectorOpen && (
          <Inspector
            note={selectedNote}
            defs={defs}
            onChange={updateNote}
            onDefsChange={setDefs}
            profileId={profile.id}
            onError={report}
            onClose={() => setInspectorOpen(false)}
          />
        )}
        {lamp !== null && (
          <Lantern
            open={lampOpen}
            query={lamp}
            count={lit?.size ?? 0}
            tokens={lens?.tokens ?? []}
            mode={mode}
            groupBy={group}
            groups={groups}
            lenses={lenses}
            onOpen={() => setLampOpen(true)}
            onFold={() => setLampOpen(false)}
            onChange={setLamp}
            onMode={setMode}
            onGroup={setGroupBy}
            onSave={saveLens}
            onApply={applyLens}
            onDelete={(l) => {
              setLenses((ls) => ls.filter((x) => x.id !== l.id));
              api.deleteLens(l.id).catch(report);
            }}
            onClear={clearLamp}
          />
        )}
        {problem && (
          <div className="surface-3 toast toast-danger" role="status">
            {problem}
          </div>
        )}
      </DegreeContext.Provider>
    </CanvasContext.Provider>
  );
}
