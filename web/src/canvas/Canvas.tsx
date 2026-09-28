import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ulid } from 'ulidx';
import { api, parseProps, type Lens, type NoteInput, type NoteKind, type NoteRow, type Profile, type PropertyDef, type TaskStatus } from '../api';
import type { NoteContent } from './NoteSheet';
import { CommandPalette } from './CommandPalette';
import { toggleExperiment, useExperiments } from '../lab/experiments';
import { SectionMap, type MapAction } from './SectionMap';
import { NodeView, LOOSE } from './NodeView';
import { buildTree, findPath, noteIdOf, parentMap, rectOf, visibleRows, type MapNode, type Rect } from './sections';
import { Lantern, nextMode, type LensMode } from './Lantern';
import { parseLens } from './lanternMatch';
import { NoteSheet } from './NoteSheet';
import { SectionName } from './SectionName';
import type { OpenFrom } from './fluid';
import { docText, docToMarkdown, markdownToDoc } from './markdown';
import { parseBody } from './editor';
import { hasMedia, isMedia, uploadMedia } from './media';
import { emptyBoard, kindChange, parseBoard } from './board/board';
import { Inspector } from './Inspector';
import { TasksView } from './TasksView';
import { mergeTags, splitTags, tagsOf } from './tags';
import { FocusHome } from './FocusHome';
import { OrganizeView, OPEN_ORGANIZE, type Move } from './OrganizeView';
import { actionFor, keysBlocked } from '../keys';

// La vista de Canvian: el mapa de secciones. Aquí viven las notas, los
// enlaces y todo lo que se guarda; SectionMap solo dibuja y avisa.

export type Link = { id: string; source: string; target: string };

const NOTE_W = 240;
// X avanza; una tarea bloqueada vuelve a pendiente al desbloquearla.
const NEXT: Record<TaskStatus, TaskStatus> = { todo: 'doing', doing: 'done', blocked: 'todo', done: 'todo' };
const now = () => new Date().toISOString();

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

// Un sitio dentro de una sección: la posición solo decide dónde queda cada
// cosa respecto a sus hermanas en el mapa.
const spotIn = (r: Rect) => ({ x: r.x + 40 + Math.random() * Math.max(0, r.w - NOTE_W - 80), y: r.y + 90 + Math.random() * Math.max(0, r.h - 160) });

export function Canvas({ profile }: { profile: Profile }) {
  const [allRows, setRows] = useState<NoteRow[]>([]);
  // Las archivadas (y lo que cuelga de ellas) no se ven salvo que se pidan.
  const [showArchived, setShowArchived] = useState(false);
  // Las tareas rápidas viven solo en la vista de tareas: fuera del mapa y de todo lo demás.
  const quick = useMemo(() => allRows.filter((r) => r.kind === 'quick'), [allRows]);
  const rows = useMemo(() => {
    const notes = allRows.filter((r) => r.kind !== 'quick');
    return showArchived ? notes : visibleRows(notes);
  }, [allRows, showArchived]);
  const [links, setLinks] = useState<Link[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState<false | 'open' | 'link' | 'card'>(false);
  // Qué hacer con la nota elegida cuando el buscador se abre desde un canvas.
  const pickCard = useRef<((id: string) => void) | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lamp, setLamp] = useState<string | null>(null);
  const [lampOpen, setLampOpen] = useState(false);
  const [mode, setMode] = useState<LensMode>('dim');
  const [lenses, setLenses] = useState<Lens[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  // La celda desde la que se abrió la nota, para que la hoja salga de ella.
  const [openFrom, setOpenFrom] = useState<OpenFrom | null>(null);
  // La otra vista: todas las tareas activas en una lista.
  const [tasksOpen, setTasksOpen] = useState(false);
  // Y la de ordenar: el árbol de secciones y sus notas, para mover en bloque.
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [defs, setDefs] = useState<PropertyDef[]>([]);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [dropping, setDropping] = useState(false);
  const { memoria, foco, celdas } = useExperiments();
  // Con «Foco», la lista es un menú que se abre con Ctrl P sobre los nodos,
  // que se alejan tras un velo; al cerrarse, se funde antes de desaparecer.
  const [listPhase, setListPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const showFocus = foco && listPhase === 'open';
  const openList = () => setListPhase('open');
  const closeList = useCallback(() => {
    setListPhase((p) => (p === 'open' ? 'closing' : p));
    setTimeout(() => setListPhase((p) => (p === 'closing' ? 'closed' : p)), 320);
  }, []);
  // Nota del centro en la vista de nodos (null: la raíz).
  const [center, setCenter] = useState<string | null>(null);

  const rowsRef = useRef(allRows);
  rowsRef.current = allRows;
  const pending = useRef(new Map<string, NoteContent>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const deleted = useRef(new Set<string>());
  // Promesas de creación: nada que dependa de una nota nueva se envía antes de que exista.
  const created = useRef(new Map<string, Promise<unknown>>());
  const ready = (...ids: string[]) => Promise.all(ids.map((id) => created.current.get(id)));
  // Dónde está el mapa (ids desde la raíz), para crear e importar ahí.
  const mapPath = useRef<string[]>([]);

  // La linterna: qué notas quedan con luz.
  const notes = rows;
  const lens = useMemo(() => (lamp ? parseLens(lamp, { defs, notes: rows, links }) : null), [lamp, rows, links, defs]);
  const litKey = useMemo(() => (lens?.test ? notes.filter((r) => lens.test!(r)).map((r) => r.id).join(' ') : null), [lens, notes]);
  const lit = useMemo(() => (litKey === null ? null : new Set(litKey.split(' ').filter(Boolean))), [litKey]);

  const report = useCallback((err: unknown) => {
    console.error(err);
    setProblem('No se pudo guardar el último cambio. Revisa que el servidor sigue en marcha.');
  }, []);

  // Avisos breves (archivar, mostrar archivadas).
  const [notice, setNoticeText] = useState<string | null>(null);
  const [noticeKey, setNoticeKey] = useState(0);
  const setNotice = useCallback((text: string) => {
    setNoticeText(text);
    setNoticeKey((k) => k + 1);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNoticeText(null), 2600);
    return () => clearTimeout(t);
  }, [notice, noticeKey]);

  useEffect(() => {
    if (!problem) return;
    const t = setTimeout(() => setProblem(null), 5000);
    return () => clearTimeout(t);
  }, [problem]);

  const patchRow = useCallback((id: string, patch: Partial<NoteRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r))), []);

  // Carga del perfil: notas, enlaces, propiedades y lentes guardadas.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.canvas(profile.id), api.properties(profile.id), api.lenses(profile.id)]).then(([canvas, properties, saved]) => {
      if (cancelled) return;
      setDefs(properties);
      setLenses(saved);
      setRows(canvas.notes);
      setLinks(canvas.edges.map((e) => ({ id: e.id, source: e.fromId, target: e.toId })));
      setLoaded(true);
    }, report);
    return () => {
      cancelled = true;
    };
  }, [profile.id, report]);

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

  const saveContent = useCallback(
    (id: string, content: NoteContent) => {
      patchRow(id, { ...content, updatedAt: now() });
      pending.current.set(id, content);
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => flush(id), 600),
      );
    },
    [patchRow, flush],
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
      setLinks((ls) => ls.filter((l) => !gone.has(l.source) && !gone.has(l.target)));
      // Lo que había dentro de una sección borrada pasa a su sección madre
      // (el servidor hace lo mismo).
      setRows((rs) => {
        const parentOf = new Map(rs.filter((r) => gone.has(r.id)).map((r) => [r.id, r.zoneId]));
        const up = (z: string | null): string | null => (z && gone.has(z) ? up(parentOf.get(z) ?? null) : z);
        return rs.filter((r) => !gone.has(r.id)).map((r) => (r.zoneId && gone.has(r.zoneId) ? { ...r, zoneId: up(r.zoneId) } : r));
      });
    },
    [report],
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
        zoneId: null,
        status: null,
        priority: null,
        dueAt: null,
        doneAt: null,
        props: '{}',
        updatedAt: now(),
        ...extra,
      };
      setRows((rs) => [...rs, row]);
      const request = api.createNote(profile.id, { ...row, props: parseProps(row.props) }).catch(report);
      created.current.set(row.id, request);
      void request.then(() => created.current.delete(row.id));
      return row;
    },
    [profile.id, report],
  );

  // Cambia campos de una nota: al momento en pantalla y después en el servidor.
  const updateNote = useCallback(
    (id: string, change: NoteInput) => {
      const { props, ...rest } = change;
      patchRow(id, { ...rest, ...(props ? { props: JSON.stringify(props) } : {}), updatedAt: now() });
      ready(id)
        .then(() => api.patchNote(id, change))
        .catch(report);
    },
    [patchRow, report],
  );

  const toggleTask = (row: NoteRow) => updateNote(row.id, kindChange(row, row.kind === 'task' ? 'text' : 'task'));
  const cycleStatus = (id: string) => {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row || (row.kind !== 'task' && row.kind !== 'quick')) return;
    const status = NEXT[row.status ?? 'todo'];
    updateNote(id, { status, doneAt: status === 'done' ? now() : null });
  };

  const toggleBlocked = (id: string) => {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row || (row.kind !== 'task' && row.kind !== 'quick')) return;
    updateNote(id, { status: row.status === 'blocked' ? 'todo' : 'blocked', doneAt: null });
  };

  const connect = (source: string, target: string) => {
    if (source === target || links.some((l) => (l.source === source && l.target === target) || (l.source === target && l.target === source))) return;
    const id = ulid();
    setLinks((ls) => [...ls, { id, source, target }]);
    ready(source, target)
      .then(() => api.createEdge(profile.id, { id, fromId: source, toId: target }))
      .catch(report);
  };

  const unlink = (a: string, b: string) => {
    const link = links.find((l) => (l.source === a && l.target === b) || (l.source === b && l.target === a));
    if (!link) return;
    setLinks((ls) => ls.filter((l) => l !== link));
    api.deleteEdge(link.id).catch(report);
  };

  // ── El árbol del mapa y lo que se hace desde él ─────────────────────
  const tree = useMemo(() => buildTree(rows, links), [rows, links]);

  // La nota madre en la que estás (o null en la raíz).
  const currentZone = (): NoteRow | null => {
    if (!celdas) return center && center !== LOOSE ? (rowsRef.current.find((r) => r.id === center) ?? null) : null;
    const path = findPath(tree, mapPath.current.at(-1) ?? 'root') ?? [tree];
    const zoneId = [...path].reverse().find((n) => n.kind === 'zone')?.id;
    return zoneId ? (rowsRef.current.find((r) => r.id === zoneId) ?? null) : null;
  };

  // Hueco para algo nuevo dentro de una nota madre: junto a ella o, en la
  // raíz, a un lado de todo lo demás.
  const spotFor = (zoneId: string | null) => {
    const zone = zoneId ? rowsRef.current.find((r) => r.id === zoneId) : null;
    if (zone) return spotIn(rectOf(zone));
    const r = tree.rect;
    return { x: r.x + r.w + 120 + Math.random() * 200, y: r.y + Math.random() * Math.max(0, r.h - 100) };
  };

  const openNote = (id: string, from: OpenFrom | null = null) => {
    setOpenFrom(from);
    setFocusId(id);
  };

  // La propiedad de etiquetas del perfil; si aún no hay ninguna, se crea «Etiquetas».
  const defsRef = useRef(defs);
  defsRef.current = defs;
  const tagsDef = (): PropertyDef => {
    const found = defsRef.current.find((d) => d.type === 'tags');
    if (found) return found;
    const def: PropertyDef = { id: ulid(), profileId: profile.id, name: 'Etiquetas', type: 'tags', options: [], position: defsRef.current.length };
    defsRef.current = [...defsRef.current, def];
    setDefs(defsRef.current);
    api.createProperty(profile.id, { id: def.id, name: def.name, type: 'tags' }).catch(report);
    return def;
  };
  // Props de una nota con estas etiquetas añadidas (y recordadas como sugerencias).
  const withTags = (props: string | null | undefined, tags: string[]) => {
    const def = tagsDef();
    const known = mergeTags(def.options, tags);
    if (known.length !== def.options.length) {
      defsRef.current = defsRef.current.map((d) => (d.id === def.id ? { ...d, options: known } : d));
      setDefs(defsRef.current);
      api.updateProperty(def.id, { options: known }).catch(report);
    }
    const all = parseProps(props);
    const had = Array.isArray(all[def.id]) ? (all[def.id] as string[]) : [];
    return { ...all, [def.id]: mergeTags(had, tags) };
  };

  const newNote = (zoneId: string | null, raw?: string) => {
    const { text, tags } = splitTags(raw ?? '');
    const row = createNote(spotFor(zoneId), 'text', { zoneId, ...(tags.length ? { props: JSON.stringify(withTags(null, tags)) } : {}) });
    if (text) {
      const bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
      saveContent(row.id, { bodyJson, bodyText: text, title: text.slice(0, 120) });
    }
    openNote(row.id);
  };

  // Tarea rápida desde la vista de tareas: solo un título, sin sitio en el mapa.
  const newQuick = (raw: string, extra: { dueAt?: string } = {}) => {
    const { text, tags } = splitTags(raw);
    if (!text && !tags.length) return;
    createNote({ x: 0, y: 0 }, 'quick', { title: text || null, status: 'todo', ...extra, ...(tags.length ? { props: JSON.stringify(withTags(null, tags)) } : {}) });
  };
  // Tarea con nota, dentro de `zoneId`, sin abrirla (desde la vista de tareas).
  const newTaskIn = (raw: string, zoneId: string) => {
    const { text, tags } = splitTags(raw);
    if (!text) return;
    const row = createNote(spotFor(zoneId), 'task', { zoneId, status: 'todo', ...(tags.length ? { props: JSON.stringify(withTags(null, tags)) } : {}) });
    const bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
    saveContent(row.id, { bodyJson, bodyText: text, title: text.slice(0, 120) });
  };
  // Cambia las etiquetas de una nota (las de su propiedad de etiquetas).
  const setTags = (row: NoteRow, tags: string[]) => {
    const def = tagsDef();
    const props = withTags(row.props, tags);
    updateNote(row.id, { props: { ...props, [def.id]: tags } });
  };
  const editQuick = (id: string, raw: string) => {
    const { text, tags } = splitTags(raw);
    const row = rowsRef.current.find((r) => r.id === id);
    updateNote(id, { title: text || row?.title || null, ...(tags.length ? { props: withTags(row?.props, tags) } : {}) });
  };

  const newCanvas = (zoneId: string | null) => {
    const row = createNote(spotFor(zoneId), 'canvas', { zoneId, bodyJson: JSON.stringify(emptyBoard()) });
    openNote(row.id);
  };

  // Desde Foco, «Padre>Hijo>Nota»: crea las secciones que falten y la nota dentro.
  const newAtPath = (zoneId: string | null, sections: string[], title: string, tags: string[] = []) => {
    let parent = zoneId;
    for (const name of sections) parent = titled(parent, name).id;
    if (title) newNote(parent, [title, ...tags.map((t) => `#${t}`)].join(' '));
  };

  // Nota con solo un título, en negrita como primera línea (las madres que se crean por el camino).
  const titled = (zoneId: string | null, title: string) => {
    const row = createNote(spotFor(zoneId), 'text', { zoneId });
    const bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: title }] }] });
    saveContent(row.id, { bodyJson, bodyText: title, title: title.slice(0, 120) });
    return row;
  };

  // Nota nueva con nombre dentro de otra (vista de ordenar).
  const newSection = (zoneId: string | null) => {
    const row = createNote(spotFor(zoneId), 'text', { zoneId });
    setRenaming({ id: row.id, title: '' });
  };

  // El título de una nota es su primera línea: renombrar cambia esa línea.
  const rename = (id: string, title: string) => {
    const row = rowsRef.current.find((r) => r.id === id);
    const t = title.trim();
    if (!row) return;
    if (row.kind === 'canvas') return updateNote(id, { title: t || null });
    const doc = parseBody(row.bodyJson) ?? { type: 'doc', content: [] };
    const content = [...(doc.content ?? [])];
    const first = content[0];
    const marks = first?.content?.[0]?.marks;
    const line = t ? [{ type: 'text', text: t, ...(marks ? { marks } : {}) }] : [];
    if (first && (first.type === 'paragraph' || first.type === 'heading')) content[0] = { ...first, content: line };
    else content.unshift({ type: 'paragraph', content: line });
    const rest = (row.bodyText ?? '').split('\n').slice(row.title ? 1 : 0);
    saveContent(id, { bodyJson: JSON.stringify({ ...doc, content }), bodyText: [t, ...rest].join('\n').trim(), title: t ? t.slice(0, 120) : null });
  };

  // Mover a otra sección: cambia su madre y su sitio dentro de ella.
  const moveTo = (id: string, zoneId: string | null) => {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row || row.zoneId === zoneId || id === zoneId) return;
    // Una sección no puede ir dentro de sí misma ni de sus subsecciones.
    for (let z = zoneId; z; z = rowsRef.current.find((r) => r.id === z)?.zoneId ?? null) if (z === id) return;
    updateNote(id, { zoneId, ...spotFor(zoneId) });
  };

  // Mover varias de golpe (vista de ordenar): una sola petición al servidor.
  const moveMany = (moves: Move[]) => {
    const byId = new Map(rowsRef.current.map((r) => [r.id, r]));
    const inside = (zoneId: string | null, id: string) => {
      for (let z = zoneId; z; z = byId.get(z)?.zoneId ?? null) if (z === id) return true;
      return false;
    };
    const items = moves
      .filter((m) => byId.has(m.id) && !deleted.current.has(m.id) && !inside(m.zoneId, m.id))
      .map((m) => ({ id: m.id, zoneId: m.zoneId, ...spotFor(m.zoneId) }));
    if (!items.length) return;
    const change = new Map(items.map((it) => [it.id, it]));
    const at = now();
    setRows((rs) => rs.map((r) => (change.has(r.id) ? { ...r, ...change.get(r.id)!, updatedAt: at } : r)));
    ready(...items.map((it) => it.id))
      .then(() => api.saveLayout(items))
      .catch(report);
  };

  // Modo nodo: cierra la nota y la pone en el centro de la vista de nodos.
  // Es un interruptor: se recuerda de dónde se vino para volver con Ctrl G.
  const nodesFrom = useRef<'note' | 'foco' | null>(null);
  const focoCursor = useRef<string | null>(null);
  const onFocoCursor = useCallback((id: string | null) => {
    focoCursor.current = id;
  }, []);
  const toNodes = (id: string | null, from: 'note' | 'foco' = 'note') => {
    nodesFrom.current = from;
    if (id) flush(id);
    setFocusId(null);
    setTasksOpen(false);
    setOrganizeOpen(false);
    setCenter(id);
    closeList();
    if (celdas) toggleExperiment('celdas');
  };

  // Ctrl G desde cualquier sitio: una nota abierta o la lista van a los nodos;
  // en los nodos, se vuelve a donde se estaba (a la nota del centro, si se vino de una).
  const toggleNodes = () => {
    if (focusId) return toNodes(focusId);
    if (showFocus) return toNodes(focoCursor.current, 'foco');
    const here = center && center !== LOOSE ? center : null;
    const from = nodesFrom.current;
    nodesFrom.current = null;
    if (from === 'foco') openList();
    else if (here) openNote(here);
  };

  const onAction = (action: MapAction, node: MapNode) => act(action, node.note ? noteIdOf(node) : null, node.zoneId);

  // Lo que se pide desde el mapa o los nodos sobre una nota (o, para crear, dentro de `zoneId`).
  const act = (action: MapAction, noteId: string | null, zoneId: string | null) => {
    const row = noteId ? rowsRef.current.find((r) => r.id === noteId) : undefined;
    if (action === 'create') newNote(zoneId);
    else if (action === 'createCanvas') newCanvas(zoneId);
    // Nota nueva dentro de la señalada (o de donde estás).
    else if (action === 'section') newNote(row ? row.id : zoneId);
    else if (!row) return;
    // Un canvas solo cambia de tipo desde Propiedades: T aplanaría su lienzo.
    else if (action === 'task' && row.kind !== 'canvas') toggleTask(row);
    else if (action === 'status') cycleStatus(row.id);
    else if (action === 'block') toggleBlocked(row.id);
    else if (action === 'props') setInspectId(row.id);
    else if (action === 'delete') removeNotes([row.id]);
    else if (action === 'rename') setRenaming({ id: row.id, title: row.title ?? '' });
    else if (action === 'archive') toggleArchive(row);
  };

  // Archivar oculta la nota con todo lo que cuelga de ella; desarchivar la devuelve.
  const toggleArchive = (row: NoteRow) => {
    const archiving = !row.archivedAt;
    if (archiving && focusId === row.id) {
      flush(row.id);
      setFocusId(null);
    }
    if (archiving && center === row.id) setCenter(row.zoneId);
    updateNote(row.id, { archivedAt: archiving ? now() : null });
    setNotice(archiving ? 'Archivada · Ctrl Mayús H muestra las archivadas' : 'Desarchivada');
  };

  // Desde Configuración también se llega a la vista de ordenar.
  useEffect(() => {
    const open = () => {
      setTasksOpen(false);
      setOrganizeOpen(true);
    };
    window.addEventListener(OPEN_ORGANIZE, open);
    return () => window.removeEventListener(OPEN_ORGANIZE, open);
  }, []);

  // ── Teclado de la vista (el mapa tiene el suyo) ─────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keysBlocked()) return;
      // Las combinaciones con Ctrl/⌘ o Alt valen también escribiendo.
      const action = actionFor(e, ['exportCanvas', 'search', 'tasks', 'organize', 'lantern', 'nodes', 'archive', 'showArchived']);
      const chord = e.metaKey || e.ctrlKey || e.altKey;
      if (action === 'exportCanvas' && (chord || !isTyping(e.target))) {
        e.preventDefault();
        exportCanvas();
        return;
      }
      if (action === 'showArchived' && (chord || !isTyping(e.target))) {
        e.preventDefault();
        setShowArchived((v) => !v);
        setNotice(showArchived ? 'Archivadas ocultas' : 'Mostrando las archivadas');
        return;
      }
      if (action === 'archive' && (chord || !isTyping(e.target))) {
        // La nota abierta, la señalada en Foco o la del centro de los nodos.
        const id = focusId ?? (showFocus ? focoCursor.current : center && center !== LOOSE ? center : null);
        const row = id ? rowsRef.current.find((r) => r.id === id) : undefined;
        if (!row) return;
        e.preventDefault();
        toggleArchive(row);
        return;
      }
      if (action === 'nodes' && (chord || !isTyping(e.target))) {
        e.preventDefault();
        toggleNodes();
        return;
      }
      if (action === 'search' && (chord || !isTyping(e.target))) {
        e.preventDefault();
        // Con Foco, Ctrl P abre y cierra la lista; sin él, el buscador.
        if (foco && !paletteOpen) {
          if (showFocus) closeList();
          else {
            setFocusId(null);
            setTasksOpen(false);
            setOrganizeOpen(false);
            openList();
          }
        } else setPaletteOpen((o) => (o ? false : 'open'));
        return;
      }
      if (e.key === 'Escape' && inspectId) {
        setInspectId(null);
        return;
      }
      if (isTyping(e.target) || paletteOpen || focusId || tasksOpen || organizeOpen) return;
      if (action === 'organize') {
        e.preventDefault();
        setOrganizeOpen(true);
        return;
      }
      if (action === 'tasks') {
        e.preventDefault();
        setTasksOpen(true);
        return;
      }
      // ⇧1…⇧9 abren las lentes guardadas.
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (e.shiftKey && !chord && digit) {
        const saved = lenses.find((l) => l.slot === Number(digit[1]));
        if (saved) {
          e.preventDefault();
          applyLens(saved);
        }
        return;
      }
      if (e.key === 'Tab' && lamp !== null) {
        e.preventDefault();
        setMode(nextMode(mode));
      } else if (e.key === 'Escape' && lamp !== null) clearLamp();
      else if (action === 'lantern') {
        e.preventDefault();
        setLamp((q) => q ?? '');
        setLampOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Lentes ─────────────────────────────────────────────────────────
  const applyLens = (l: Lens) => {
    setLamp(l.query);
    // Las lentes antiguas en columnas se ven atenuadas.
    setMode(l.mode === 'hide' ? 'hide' : 'dim');
    setLampOpen(false);
  };

  const saveLens = async () => {
    if (!lamp?.trim()) return null;
    const lensRow = { id: ulid(), name: lamp.trim(), query: lamp.trim(), mode };
    try {
      const made = await api.createLens(profile.id, lensRow);
      setLenses((ls) => [...ls.map((l) => (l.slot === made.slot ? { ...l, slot: null } : l)), made].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99)));
      return made;
    } catch (err) {
      report(err);
      return null;
    }
  };

  const clearLamp = () => {
    setLamp(null);
    setLampOpen(false);
    setMode('dim');
  };

  // ── Importar Markdown (arrastrando archivos) y exportar a JSON Canvas ──
  const importMarkdown = async (files: File[]) => {
    const docs = await Promise.all(files.map(async (f) => ({ name: f.name.replace(/\.(md|markdown|txt)$/i, ''), ...markdownToDoc(await f.text()) })));
    // Lo importado entra en la sección en la que estás.
    const zoneId = currentZone()?.id ?? null;
    // El nombre del archivo es el título: va como primera línea, salvo que el
    // documento ya empiece con ese mismo encabezado.
    const withTitle = (d: (typeof docs)[number]) => {
      const first = d.doc.content?.[0];
      const same = first?.type === 'heading' && docText({ type: 'doc', content: [first] }).trim().toLowerCase() === d.name.trim().toLowerCase();
      if (same || !d.name.trim()) return d.doc;
      return { ...d.doc, content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: d.name.trim() }] }, ...(d.doc.content ?? [])] };
    };
    const made = docs.map((d) => {
      const doc = withTitle(d);
      return createNote(spotFor(zoneId), 'text', { zoneId, title: d.name.trim() || d.heading, bodyJson: JSON.stringify(doc), bodyText: docText(doc) });
    });
    // [[Enlaces]] entre notas: por nombre de archivo o por título, sin importar mayúsculas.
    const byName = new Map<string, string>();
    for (const r of rowsRef.current) if (r.title) byName.set(r.title.toLowerCase(), r.id);
    made.forEach((r, i) => {
      byName.set(docs[i].name.toLowerCase(), r.id);
      if (r.title) byName.set(r.title.toLowerCase(), r.id);
    });
    const seen = new Set<string>();
    made.forEach((r, i) => {
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

  // Imágenes, vídeo o audio soltados en el mapa: una nota nueva que los lleva.
  const importMedia = async (files: File[]) => {
    const content = await uploadMedia(files);
    const zoneId = currentZone()?.id ?? null;
    const bodyJson = JSON.stringify({ type: 'doc', content: [...content, { type: 'paragraph' }] });
    const row = createNote(spotFor(zoneId), 'text', { zoneId, bodyJson });
    openNote(row.id);
  };

  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    // Con una nota abierta, lo que se suelta es para su editor.
    if (focusId) return;
    const md = [...e.dataTransfer.files].filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    const media = [...e.dataTransfer.files].filter(isMedia);
    if (!md.length && !media.length) return;
    e.preventDefault();
    if (md.length) void importMarkdown(md);
    if (media.length) importMedia(media).catch(report);
  };

  const exportCanvas = () => {
    const out = {
      nodes: rowsRef.current.filter((r) => r.kind !== 'quick').map((r) => {
        const { x, y, w, h } = rectOf(r);
        const base = { id: r.id, x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
        const md = (r.kind === 'canvas' ? '' : docToMarkdown(parseBody(r.bodyJson))) || (r.bodyText ?? '');
        const box = r.kind === 'task' ? `- [${r.status === 'done' ? 'x' : ' '}] ` : '';
        return { ...base, type: 'text', text: box + md };
      }),
      edges: links.map((l) => ({ id: l.id, fromNode: l.source, toNode: l.target })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${profile.name}.canvas`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const focused = focusId ? (allRows.find((r) => r.id === focusId) ?? null) : null;
  const focusNeighbors = useMemo(() => {
    if (!focusId) return [];
    const ids = new Set(links.flatMap((l) => (l.source === focusId ? [l.target] : l.target === focusId ? [l.source] : [])));
    return rows.filter((r) => ids.has(r.id));
  }, [focusId, links, rows]);
  // Todas las notas con su ruta («Casa › Cocina»), como madres posibles al mover.
  const sectionOptions = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parent = parentMap(rows);
    const pathOf = (r: NoteRow) => {
      const names: string[] = [];
      for (let z: NoteRow | undefined = r; z; z = byId.get(parent.get(z.id) ?? '')) names.unshift(z.title || 'Nota sin título');
      return names.join(' › ');
    };
    const all = rows.map((z) => ({ id: z.id as string | null, path: pathOf(z) }));
    all.sort((a, b) => a.path.localeCompare(b.path, 'es'));
    return [{ id: null, path: 'Arriba del todo' }, ...all];
  }, [rows]);
  const inspected = inspectId ? (allRows.find((r) => r.id === inspectId) ?? null) : null;

  return (
    <div
      className="canvas"
      onDragOver={(e) => {
        if (focusId || ![...e.dataTransfer.types].includes('Files')) return;
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
          <span className="meta">Archivos .md, imágenes, vídeo o audio · entran en la nota en la que estás</span>
        </div>
      )}
      {loaded && foco && listPhase !== 'closed' && !tasksOpen && !organizeOpen && (
        <FocusHome
          rows={rows}
          leaving={listPhase === 'closing'}
          paused={listPhase !== 'open' || !!focusId || !!paletteOpen || !!renaming || !!inspectId}
          onOpen={(id) => {
            // La nota se abre y, detrás, los nodos se quedan en ella.
            if (!celdas) setCenter(id);
            closeList();
            openNote(id);
          }}
          onSection={(id) => {
            mapPath.current = (findPath(tree, id) ?? []).slice(1).map((n) => n.id);
            setCenter(id);
            closeList();
          }}
          onCreate={(text) => {
            closeList();
            newNote(null, text);
          }}
          onCreatePath={(zoneId, sections, title, tags) => {
            closeList();
            newAtPath(zoneId, sections, title, tags);
          }}
          onCursor={onFocoCursor}
          onMap={closeList}
        />
      )}
      <div className={`home-layer${showFocus ? ' is-veiled' : ''}`}>
      {loaded && !celdas && (
        <NodeView
          rows={rows}
          links={links}
          center={center}
          paused={showFocus || !!focusId || !!paletteOpen || !!renaming || tasksOpen || organizeOpen}
          onCenter={setCenter}
          onOpen={(id) => openNote(id)}
          onAction={act}
          onMove={moveTo}
          lit={lit}
          hide={mode === 'hide'}
        />
      )}
      {loaded && celdas && (
        <SectionMap
          tree={tree}
          paused={showFocus || !!focusId || !!paletteOpen || !!renaming || tasksOpen || organizeOpen}
          start={mapPath.current}
          onPath={(ids) => (mapPath.current = ids)}
          onOpen={openNote}
          onAction={onAction}
          onMove={moveTo}
          lit={lit}
          hide={mode === 'hide'}
          memoria={memoria}
        />
      )}
      {loaded && celdas && rows.length === 0 && (
        <div className="empty-state">
          <div>
            <p className="display">
              Un lienzo en <em>calma</em>
            </p>
            <span className="meta">N para la primera nota</span>
          </div>
        </div>
      )}
      </div>
      {renaming && (
        <SectionName
          initial={renaming.title}
          onDone={(title) => {
            const row = rowsRef.current.find((r) => r.id === renaming.id);
            // Una nota nueva sin nombre no se queda.
            if (!title.trim() && row && !row.title) removeNotes([row.id]);
            else if (title.trim() !== (row?.title ?? '')) rename(renaming.id, title);
            setRenaming(null);
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          profileId={profile.id}
          placeholder={paletteOpen === 'link' ? 'Enlazar con…' : paletteOpen === 'card' ? 'Añadir al canvas…' : undefined}
          exclude={paletteOpen === 'open' ? undefined : focused?.id}
          rows={rows}
          onCreatePath={
            paletteOpen === 'open'
              ? (zoneId, sections, title) => {
                  setPaletteOpen(false);
                  newAtPath(zoneId, sections, title);
                }
              : undefined
          }
          onPick={(id) => {
            setPaletteOpen(false);
            if (paletteOpen === 'card') pickCard.current?.(id);
            else if (paletteOpen === 'link' && focused) connect(focused.id, id);
            else openNote(id);
          }}
          onCreate={(text) => {
            setPaletteOpen(false);
            if (paletteOpen === 'card' && focused) {
              const row = createNote(spotFor(focused.zoneId), 'text', { zoneId: focused.zoneId });
              const bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
              saveContent(row.id, { bodyJson, bodyText: text, title: text.slice(0, 120) });
              pickCard.current?.(row.id);
            } else if (paletteOpen === 'link' && focused) {
              // Enlazar con una nota que aún no existe: se crea junto a esta.
              const row = createNote(spotFor(focused.zoneId), 'text', { zoneId: focused.zoneId });
              const bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
              saveContent(row.id, { bodyJson, bodyText: text, title: text.slice(0, 120) });
              connect(focused.id, row.id);
            } else newNote(currentZone()?.id ?? null, text);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {loaded && !tasksOpen && !organizeOpen && (
        <div className="chrome-top-right">
          <button className="surface-2 pill tasks-pill" onClick={() => setTasksOpen(true)} title="Todas las tareas activas">
            <span className="pill-name">Tareas</span>
            <span className="meta">{[...rows, ...quick].filter((r) => (r.kind === 'task' || r.kind === 'quick') && r.status !== 'done').length}</span>
          </button>
        </div>
      )}
      {organizeOpen && (
        <OrganizeView
          rows={rows}
          sections={sectionOptions}
          paused={!!focusId || !!inspectId || !!paletteOpen || !!renaming}
          onOpen={(id) => openNote(id)}
          onMove={moveMany}
          onNewSection={newSection}
          onClose={() => setOrganizeOpen(false)}
          back={showFocus ? 'Lista' : 'Mapa'}
        />
      )}
      {tasksOpen && (
        <TasksView
          rows={rows}
          paused={!!focusId || !!inspectId || !!paletteOpen}
          onOpen={(id) => openNote(id)}
          onCycle={cycleStatus}
          onBlock={toggleBlocked}
          quick={quick}
          onAddQuick={newQuick}
          onAddTask={newTaskIn}
          onPatch={updateNote}
          onRename={rename}
          onSetTags={setTags}
          onEditQuick={editQuick}
          tagsOf={(r) => tagsOf(r, defs)}
          onDeleteQuick={(id) => removeNotes([id])}
          onClose={() => setTasksOpen(false)}
          back={showFocus ? 'Lista' : 'Mapa'}
        />
      )}
      {focused && (
        <NoteSheet
          from={openFrom}
          note={focused}
          neighbors={focusNeighbors}
          defs={defs}
          onNavigate={(id) => {
            flush(focused.id);
            setFocusId(id);
          }}
          onSave={saveContent}
          onError={report}
          sections={sectionOptions}
          onMove={(zoneId) => moveTo(focused.id, zoneId)}
          onCycle={cycleStatus}
          onProps={(id) => setInspectId(id)}
          onTask={() => toggleTask(focused)}
          rows={rows}
          onRename={(title) => updateNote(focused.id, { title: title || null })}
          onPickNote={(then) => {
            pickCard.current = then;
            setPaletteOpen('card');
          }}
          onBlock={() => toggleBlocked(focused.id)}
          onNodes={() => toNodes(focused.id)}
          onArchive={() => toggleArchive(focused)}
          onLink={() => setPaletteOpen('link')}
          onUnlink={(id) => unlink(focused.id, id)}
          onDelete={(id) => {
            flush(id);
            setFocusId(null);
            removeNotes([id]);
          }}
          onClose={() => {
            const id = focused.id;
            flush(id);
            setFocusId(null);
            // Una nota nueva que se queda vacía no se guarda.
            if ((focused.kind === 'canvas' ? !focused.title?.trim() && !parseBoard(focused.bodyJson).nodes.length : !focused.bodyText?.trim() && !hasMedia(focused.bodyJson)) && !links.some((l) => l.source === id || l.target === id)) removeNotes([id]);
          }}
        />
      )}
      {inspectId && (
        <Inspector
          note={inspected}
          defs={defs}
          onChange={updateNote}
          onDefsChange={setDefs}
          profileId={profile.id}
          onError={report}
          onClose={() => setInspectId(null)}
        />
      )}
      {lamp !== null && (
        <Lantern
          open={lampOpen}
          query={lamp}
          count={lit?.size ?? 0}
          tokens={lens?.tokens ?? []}
          mode={mode}
          lenses={lenses}
          onOpen={() => setLampOpen(true)}
          onFold={() => setLampOpen(false)}
          onChange={setLamp}
          onMode={setMode}
          onSave={saveLens}
          onApply={applyLens}
          onDelete={(l) => {
            setLenses((ls) => ls.filter((x) => x.id !== l.id));
            api.deleteLens(l.id).catch(report);
          }}
          onClear={clearLamp}
        />
      )}
      {notice && (
        <div key={notice + noticeKey} className="surface-3 toast" role="status">
          {notice}
        </div>
      )}
      {problem && (
        <div className="surface-3 toast toast-danger" role="status">
          {problem}
        </div>
      )}
    </div>
  );
}
