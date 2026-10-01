import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ulid } from 'ulidx';
import { api, whenIdle, writesSoFar, parseProps, type Lens, type NoteInput, type NoteKind, type NoteRow, type Profile, type PropertyDef } from '../api';
import type { NoteContent } from './NoteSheet';
import { CommandPalette } from './CommandPalette';
import { onLive } from '../live';
import { NodeView, LOOSE, type MapAction } from './NodeView';
import { bounds, parentMap, rectOf, visibleRows, type Rect } from './sections';
import { Lantern, nextMode, type LensMode } from './Lantern';
import { parseLens } from './lanternMatch';
import { NoteSheet } from './NoteSheet';
import { SectionName } from './SectionName';
import { SectionPicker } from './SectionPicker';
import { docText, docToMarkdown, markdownToDoc } from './markdown';
import { parseBody } from './editor';
import { hasMedia, uploadMedia } from './media';
import { emptyBoard, parseBoard } from './board/board';
import { Inspector } from './Inspector';
import { INBOX, TasksView } from './TasksView';
import { addTaskItem, allTasks, changeTask, contentOf, newTaskItem, removeTask, takeTask, type Task, type TaskChange } from './tasks';
import { mergeTags, splitTags } from './tags';
import { OrganizeView, OPEN_ORGANIZE, type Move } from './OrganizeView';
import { actionFor, keyParts, keysBlocked, setView, useKeymap } from '../keys';
import { useSideWidth } from './Resizer';
import { BibBar, BibMenu, BibSidebar, Library, type MenuAction, titleOf as bibTitle, useBibFolded, useBibLayout, useFamily, type BibView } from './Biblioteca';
import { getLang, t } from '../i18n';

// La vista de Canvian: la biblioteca. Aquí viven las notas, los enlaces y todo
// lo que se guarda; la barra lateral, la colección, los nodos y el lector solo
// dibujan y avisan.

export type Link = { id: string; source: string; target: string };

const NOTE_W = 240;
const now = () => new Date().toISOString();

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

// Un sitio dentro de una nota madre: la posición solo sirve al exportar a
// JSON Canvas, para que cada cosa quede cerca de sus hermanas.
const spotIn = (r: Rect) => ({ x: r.x + 40 + Math.random() * Math.max(0, r.w - NOTE_W - 80), y: r.y + 90 + Math.random() * Math.max(0, r.h - 160) });

// Dónde estás (la nota abierta, la vista, el centro de los nodos) se recuerda
// en este navegador y por perfil: al recargar vuelves al mismo sitio.
type Place = { note: string | null; center: string | null; tasks: boolean; organize: boolean };
const placeKey = (profileId: string) => `canvian.place.${profileId}`;
function readPlace(profileId: string): Partial<Place> {
  try {
    return JSON.parse(localStorage.getItem(placeKey(profileId)) ?? '{}') as Partial<Place>;
  } catch {
    return {};
  }
}

// Lo que la barra lateral abre y vive fuera del canvas.
export type Shell = { onProfiles: () => void; onSettings: () => void; onCommands: () => void };

export function Canvas({ profile, shell }: { profile: Profile; shell: Shell }) {
  const [allRows, setRows] = useState<NoteRow[]>([]);
  // Las archivadas (y lo que cuelga de ellas) no se ven salvo que se pidan.
  const [showArchived, setShowArchived] = useState(false);
  const keymap = useKeymap();
  const rows = useMemo(() => (showArchived ? allRows : visibleRows(allRows)), [allRows, showArchived]);
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
  // La otra vista: las tareas (las casillas de todas las notas) en una lista.
  const [tasksOpen, setTasksOpen] = useState(false);
  // Y la de ordenar: el árbol de secciones y sus notas, para mover en bloque.
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [defs, setDefs] = useState<PropertyDef[]>([]);
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [bibLayout, setBibLayout] = useBibLayout();
  const [bibFolded, toggleBibFolded] = useBibFolded();
  const bibWidth = useSideWidth('canvian.bibWidth', 240, 180, 440);
  // Menú con clic derecho sobre una nota, y «Mover a…» desde él.
  const [bibMenu, setBibMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // En el móvil, la barra lateral abierta como cajón.
  const [drawer, setDrawer] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  // Nota abierta en grande sobre la vista de tareas, sin salir de ella.
  const [peek, setPeek] = useState(false);
  // Modo zen: con una nota abierta, sin barra lateral ni nada más; solo el texto.
  const [zen, setZen] = useState(false);
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

  // La linterna: qué notas quedan con luz.
  const notes = rows;
  // Las etiquetas de los chips van en el idioma de la interfaz.
  const lang = getLang();
  const lens = useMemo(() => (lamp ? parseLens(lamp, { defs, notes: rows, links }) : null), [lamp, rows, links, defs, lang]);
  const litKey = useMemo(() => (lens?.test ? notes.filter((r) => lens.test!(r)).map((r) => r.id).join(' ') : null), [lens, notes]);
  const lit = useMemo(() => (litKey === null ? null : new Set(litKey.split(' ').filter(Boolean))), [litKey]);

  const report = useCallback((err: unknown) => {
    console.error(err);
    setProblem(t('No se pudo guardar el último cambio. Revisa que el servidor sigue en marcha.'));
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

  useEffect(() => {
    if (!loaded) return;
    const place: Place = { note: focusId, center, tasks: tasksOpen, organize: organizeOpen };
    try {
      localStorage.setItem(placeKey(profile.id), JSON.stringify(place));
    } catch {
      // Sin almacenamiento local, al recargar se empieza desde el principio.
    }
  }, [loaded, profile.id, focusId, center, tasksOpen, organizeOpen]);

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
      const place = readPlace(profile.id);
      const exists = (id: string | null | undefined) => !!id && canvas.notes.some((r) => r.id === id);
      if (place.center === LOOSE || exists(place.center)) setCenter(place.center!);
      if (exists(place.note)) setFocusId(place.note!);
      else if (place.tasks) setTasksOpen(true);
      else if (place.organize) setOrganizeOpen(true);
      setLoaded(true);
    }, report);
    return () => {
      cancelled = true;
    };
  }, [profile.id, report]);

  // Tiempo real: si otro dispositivo cambia algo, se vuelve a pedir el perfil.
  // Espera a que salgan las escrituras de aquí, y lo que se esté escribiendo
  // (sin guardar aún) o creando se queda como está en esta pantalla.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    const pull = async () => {
      if (running) return void (again = true);
      running = true;
      try {
        await whenIdle();
        const before = writesSoFar();
        const [canvas, properties, saved] = await Promise.all([api.canvas(profile.id), api.properties(profile.id), api.lenses(profile.id)]);
        if (cancelled) return;
        // Si algo se escribió mientras llegaba, puede venir viejo: otra vuelta.
        if (writesSoFar() !== before) {
          again = true;
          return;
        }
        setDefs(properties);
        setLenses(saved);
        setRows((local) => {
          const mine = new Map(local.map((r) => [r.id, r]));
          const merged = canvas.notes
            .filter((r) => !deleted.current.has(r.id))
            .map((r) => {
              const draft = pending.current.get(r.id);
              return draft ? { ...r, ...draft } : r;
            });
          const there = new Set(merged.map((r) => r.id));
          for (const [id, r] of mine) if (!there.has(id) && created.current.has(id)) merged.push(r);
          return merged;
        });
        setLinks(canvas.edges.map((e) => ({ id: e.id, source: e.fromId, target: e.toId })));
      } catch {
        // Sin conexión: el siguiente aviso (o la reconexión) lo intenta de nuevo.
      } finally {
        running = false;
        if (again && !cancelled) {
          again = false;
          timer = setTimeout(pull, 400);
        }
      }
    };
    const stop = onLive((scope) => {
      if (scope !== 'canvas') return;
      clearTimeout(timer);
      // Varios cambios seguidos (escribir, arrastrar) se recogen de una vez.
      timer = setTimeout(pull, 250);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop();
    };
  }, [profile.id]);

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

  // ── Lo que se hace desde la biblioteca y los nodos ──────────────────
  // La nota madre en la que estás (o null en la raíz).
  const currentZone = (): NoteRow | null => (center && center !== LOOSE ? (rowsRef.current.find((r) => r.id === center) ?? null) : null);

  // Hueco para algo nuevo dentro de una nota madre: junto a ella o, en la
  // raíz, a un lado de todo lo demás.
  const spotFor = (zoneId: string | null) => {
    const zone = zoneId ? rowsRef.current.find((r) => r.id === zoneId) : null;
    if (zone) return spotIn(rectOf(zone));
    const r = bounds(rows.map(rectOf));
    return { x: r.x + r.w + 120 + Math.random() * 200, y: r.y + Math.random() * Math.max(0, r.h - 100) };
  };

  const openNote = (id: string) => setFocusId(id);

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

  // ── Tareas: las casillas de las notas ───────────────────────────────
  // La nota tal y como está ahora, con lo escrito que aún no ha salido al servidor.
  const rowNow = (id: string): NoteRow | undefined => {
    const row = rowsRef.current.find((r) => r.id === id);
    const draft = pending.current.get(id);
    return row && draft ? { ...row, ...draft } : row;
  };
  const saveDoc = (id: string, doc: Parameters<typeof contentOf>[0]) => saveContent(id, contentOf(doc));
  const changeTaskIn = (task: Task, change: TaskChange) => {
    const row = rowNow(task.noteId);
    const doc = row && changeTask(row, task, change);
    if (doc) saveDoc(row.id, doc);
  };
  const deleteTask = (task: Task) => {
    const row = rowNow(task.noteId);
    const doc = row && removeTask(row, task);
    if (doc) saveDoc(row.id, doc);
  };
  // Lo que se apunta sin decir en qué nota va a «Tareas», arriba del todo (se crea si no está).
  const inbox = () => rowsRef.current.find((r) => !r.zoneId && r.kind !== 'canvas' && !r.archivedAt && r.title?.trim().toLocaleLowerCase('es') === INBOX.toLocaleLowerCase('es'));
  const addTask = (source: string, noteId: string | null, extra: { dueAt?: string } = {}, under?: Task) => {
    if (!source.trim()) return;
    const item = newTaskItem(source, extra);
    const row = noteId ? rowNow(noteId) : inbox() && rowNow(inbox()!.id);
    if (row) return saveDoc(row.id, addTaskItem(row, item, under));
    const made = createNote(spotFor(null), 'text', { zoneId: null });
    const title = { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: INBOX }] };
    saveDoc(made.id, { type: 'doc', content: [title, { type: 'taskList', content: [item] }] });
  };
  // Llevar una tarea (con sus subtareas) al final de otra nota.
  const moveTask = (task: Task, noteId: string) => {
    if (noteId === task.noteId) return;
    const from = rowNow(task.noteId);
    const to = rowNow(noteId);
    const taken = from && to && takeTask(from, task);
    if (!taken) return;
    saveDoc(from.id, taken.doc);
    saveDoc(to!.id, addTaskItem(to!, taken.item));
  };
  // Abre la nota de la tarea encima de la vista y la señala en el texto.
  const openTask = (task: Task) => {
    setPeek(true);
    openNote(task.noteId);
    setTimeout(() => {
      const li = document.querySelectorAll<HTMLElement>('.sheet-editor li[data-type="taskItem"]')[task.n];
      if (!li) return;
      li.scrollIntoView({ block: 'center' });
      li.classList.remove('is-flash');
      void li.offsetWidth;
      li.classList.add('is-flash');
    }, 280);
  };

  const newCanvas = (zoneId: string | null) => {
    const row = createNote(spotFor(zoneId), 'canvas', { zoneId, bodyJson: JSON.stringify(emptyBoard()) });
    openNote(row.id);
  };

  // Desde el buscador, «Padre>Hijo>Nota»: crea las madres que falten y la nota dentro.
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
  const toNodes = (id: string) => {
    flush(id);
    setFocusId(null);
    setTasksOpen(false);
    setOrganizeOpen(false);
    setCenter(id);
    setBibLayout('nodos');
  };

  // Ctrl G: una nota abierta va a los nodos; sin nota abierta, se abre la del centro.
  const toggleNodes = () => {
    if (focusId) return toNodes(focusId);
    if (center && center !== LOOSE) openNote(center);
  };

  // Lo que se pide desde la biblioteca o los nodos sobre una nota (o, para crear, dentro de `zoneId`).
  const act = (action: MapAction, noteId: string | null, zoneId: string | null) => {
    const row = noteId ? rowsRef.current.find((r) => r.id === noteId) : undefined;
    if (action === 'create') newNote(zoneId);
    else if (action === 'createCanvas') newCanvas(zoneId);
    // Nota nueva dentro de la señalada (o de donde estás).
    else if (action === 'section') newNote(row ? row.id : zoneId);
    else if (!row) return;
    else if (action === 'props') setInspectId(row.id);
    else if (action === 'delete') removeNotes([row.id]);
    else if (action === 'rename') setRenaming({ id: row.id, title: row.title ?? '' });
    else if (action === 'archive') toggleArchive(row);
    else if (action === 'move') setMovingId(row.id);
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
    setNotice(archiving ? t('Archivada · {how} las muestra', { how: keymap.showArchived ? keyParts(keymap.showArchived).join(' ') : t('«Archivadas» en la barra') }) : t('Desarchivada'));
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

  // La paleta y la ayuda enseñan primero lo que sirve en esta vista.
  useEffect(() => setView(focusId ? 'note' : tasksOpen ? 'tasks' : organizeOpen ? 'organize' : 'list'), [focusId, tasksOpen, organizeOpen]);

  // ── Teclado de la vista (el mapa tiene el suyo) ─────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keysBlocked()) return;
      // Las combinaciones con Ctrl/⌘ o Alt valen también escribiendo.
      const action = actionFor(e, ['exportCanvas', 'search', 'tasks', 'organize', 'lantern', 'nodes', 'archive', 'showArchived', 'sidebar', 'zen', 'wideNote']);
      const chord = e.metaKey || e.ctrlKey || e.altKey;
      // Con una nota abierta los atiende ella; aquí solo llegan sin nota.
      if ((action === 'zen' || action === 'wideNote') && (chord || !isTyping(e.target))) {
        e.preventDefault();
        setNotice(action === 'zen' ? t('Abre una nota para escribir en modo zen') : t('Abre una nota para verla en modo ancho'));
        return;
      }
      if (action === 'sidebar' && (chord || !isTyping(e.target))) {
        e.preventDefault();
        toggleBibFolded();
        return;
      }
      if (action === 'exportCanvas' && (chord || !isTyping(e.target))) {
        e.preventDefault();
        exportCanvas();
        return;
      }
      if (action === 'showArchived' && (chord || !isTyping(e.target))) {
        e.preventDefault();
        setShowArchived((v) => !v);
        setNotice(showArchived ? t('Archivadas ocultas') : t('Mostrando las archivadas'));
        return;
      }
      if (action === 'archive' && (chord || !isTyping(e.target))) {
        // La nota abierta o la del centro.
        const id = focusId ?? (center && center !== LOOSE ? center : null);
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
        setPaletteOpen((o) => (o ? false : 'open'));
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

  // Imágenes, vídeo, audio o cualquier otro archivo soltados en el mapa: una
  // nota nueva que los lleva.
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
    const isMd = (f: File) => /\.(md|markdown|txt)$/i.test(f.name);
    const md = [...e.dataTransfer.files].filter(isMd);
    const media = [...e.dataTransfer.files].filter((f) => !isMd(f));
    if (!md.length && !media.length) return;
    e.preventDefault();
    if (md.length) void importMarkdown(md);
    if (media.length) importMedia(media).catch(report);
  };

  const exportCanvas = () => {
    const out = {
      nodes: rowsRef.current.map((r) => {
        const { x, y, w, h } = rectOf(r);
        const base = { id: r.id, x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
        const md = (r.kind === 'canvas' ? '' : docToMarkdown(parseBody(r.bodyJson))) || (r.bodyText ?? '');
        return { ...base, type: 'text', text: md };
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
  const zenOn = zen && !peek && !!focused && focused.kind !== 'canvas';
  // Al cerrar la nota se sale del modo zen.
  useEffect(() => {
    if (!focusId) setZen(false);
  }, [focusId]);
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
      for (let z: NoteRow | undefined = r; z; z = byId.get(parent.get(z.id) ?? '')) names.unshift(z.title || t('Nota sin título'));
      return names.join(' › ');
    };
    const all = rows.map((z) => ({ id: z.id as string | null, path: pathOf(z) }));
    all.sort((a, b) => a.path.localeCompare(b.path, 'es'));
    return [{ id: null, path: t('Arriba del todo') }, ...all];
  }, [rows, lang]);
  const inspected = inspectId ? (allRows.find((r) => r.id === inspectId) ?? null) : null;

  // Abrir desde la barra lateral: la nota, con su colección detrás.
  const bibOpen = (id: string) => {
    setTasksOpen(false);
    setOrganizeOpen(false);
    if (focused) flush(focused.id);
    setCenter(family.parent.get(id) ?? null);
    openNote(id);
  };

  // Una nota con todo lo que cuelga de ella (no puede moverse ahí dentro).
  const descendants = (id: string) => {
    const out = new Set([id]);
    for (const x of out) for (const k of family.kids.get(x) ?? []) out.add(k.id);
    return out;
  };

  const bibPick = (a: MenuAction, id: string) => {
    if (a === 'open') bibOpen(id);
    else if (a === 'library') {
      goLibrary(id);
      if (bibLayout === 'nodos') setBibLayout('lista');
    } else if (a === 'nodes') toNodes(id);
    else if (a === 'child') act('section', id, null);
    else if (a === 'move') setMovingId(id);
    else act(a, id, null);
  };

  // En grande, en el centro, con un botón para ir a la nota de verdad.
  const wrapPeek = (sheet: ReactNode) =>
    peek && focused ? (
      <div className="note-popup-layer">
        <div className="note-popup-back" onClick={closeFocused} />
        <div className="note-popup" role="dialog" aria-label={focused.title || t('Nota')}>
          <div className="note-popup-bar">
            <button
              className="note-popup-btn"
              onClick={() => {
                flush(focused.id);
                setPeek(false);
                setTasksOpen(false);
              }}
              title={t('Ir a la nota')}
              aria-label={t('Ir a la nota')}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
              </svg>
              {t('Ir a la nota')}
            </button>
            <button className="note-popup-btn" onClick={closeFocused} title={t('Cerrar (Esc)')} aria-label={t('Cerrar')}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          {sheet}
        </div>
      </div>
    ) : (
      sheet
    );

  const closeFocused = () => {
    setPeek(false);
    if (!focused) return;
    const id = focused.id;
    flush(id);
    setFocusId(null);
    // Una nota nueva que se queda vacía no se guarda.
    if ((focused.kind === 'canvas' ? !focused.title?.trim() && !parseBoard(focused.bodyJson).nodes.length : !focused.bodyText?.trim() && !hasMedia(focused.bodyJson)) && !links.some((l) => l.source === id || l.target === id)) removeNotes([id]);
  };

  // ── Barra lateral, ruta y la colección ──────────────────────────────
  const family = useFamily(rows);
  const bibView: BibView = focused && !peek ? 'note' : tasksOpen ? 'tasks' : organizeOpen ? 'organize' : 'library';
  const goLibrary = (id: string | null) => {
    if (focused) closeFocused();
    setTasksOpen(false);
    setOrganizeOpen(false);
    setCenter(id);
  };
  const bibCrumbs: { id: string | null; title: string }[] =
    bibView === 'tasks'
      ? [{ id: null, title: t('Tareas') }]
      : bibView === 'organize'
        ? [{ id: null, title: t('Ordenar') }]
        : [
            { id: null, title: t('Todas las notas') },
            ...(center === LOOSE && !focused ? [{ id: LOOSE as string | null, title: t('Sueltas') }] : []),
            ...family.pathTo(focused ? focused.id : center === LOOSE ? null : center).map((r) => ({ id: r.id as string | null, title: bibTitle(r) })),
          ];
  const bibUp =
    bibView === 'note'
      ? () => {
          const up = family.parent.get(focused!.id) ?? null;
          closeFocused();
          setCenter(up);
        }
      : bibView === 'tasks'
        ? () => setTasksOpen(false)
        : bibView === 'organize'
          ? () => setOrganizeOpen(false)
          : center !== null
            ? () => setCenter(center === LOOSE ? null : (family.parent.get(center) ?? null))
            : null;
  const openTasksCount = useMemo(() => allTasks(rows).filter((t) => t.status !== 'done').length, [rows]);

  return (
    <div
      className={`canvas is-bib${bibFolded ? ' is-bib-folded' : ''}${zenOn ? ' is-zen' : ''}`}
      style={{ '--bib-side-w': `${bibWidth.width}px` } as CSSProperties}
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
            {t('Suelta tus')} <em>{t('notas')}</em>
          </p>
          <span className="meta">{t('Archivos .md, o cualquier otro (imágenes, PDF, documentos…) en una nota nueva · entran en la nota en la que estás')}</span>
        </div>
      )}
      {loaded && (
        <>
          <BibSidebar
            profileName={profile.name}
            family={family}
            view={bibView}
            here={bibView === 'tasks' || bibView === 'organize' ? undefined : focused ? focused.id : center}
            tasks={openTasksCount}
            showArchived={showArchived}
            folded={bibFolded}
            width={bibWidth}
            drawer={drawer}
            onDrawer={setDrawer}
            onFold={toggleBibFolded}
            onProfiles={shell.onProfiles}
            onCommands={shell.onCommands}
            onLantern={() => {
              if (focused) closeFocused();
              setTasksOpen(false);
              setOrganizeOpen(false);
              setLamp((q) => q ?? '');
              setLampOpen(true);
            }}
            onSettings={shell.onSettings}
            onLibrary={goLibrary}
            onOpen={bibOpen}
            onMove={moveTo}
            onMenu={(id, x, y) => setBibMenu({ id, x, y })}
            onTasks={() => {
              if (focused) closeFocused();
              setOrganizeOpen(false);
              setTasksOpen(true);
            }}
            onOrganize={() => {
              if (focused) closeFocused();
              setTasksOpen(false);
              setOrganizeOpen(true);
            }}
            onArchived={() => setShowArchived((v) => !v)}
            onNewNote={() => {
              if (focused) closeFocused();
              setTasksOpen(false);
              setOrganizeOpen(false);
              setCenter(null);
              newNote(null);
            }}
          />
          <BibBar
            crumbs={bibCrumbs}
            view={bibView}
            layout={bibLayout}
            onCrumb={(id) => (bibView === 'tasks' || bibView === 'organize' ? undefined : goLibrary(id))}
            onUp={bibUp}
            onSearch={() => setPaletteOpen('open')}
            onLayout={setBibLayout}
            folded={bibFolded}
            onFold={toggleBibFolded}
            onDrawer={() => setDrawer(true)}
          />
          {/* Sin teclado no hay N: un botón para la nota nueva (solo en el móvil). */}
          {bibView === 'library' && (
            <button className="bib-fab" onClick={() => act('create', null, center && center !== LOOSE ? center : null)} aria-label={t('Nota nueva')} title={t('Nota nueva')}>
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </>
      )}
      <div className="home-layer">
      {loaded && bibLayout !== 'nodos' && (
        <Library
          rows={rows}
          family={family}
          links={links}
          center={center}
          layout={bibLayout}
          paused={!!focusId || !!paletteOpen || !!renaming || tasksOpen || organizeOpen || !!inspectId}
          lit={lit}
          hide={mode === 'hide'}
          onCenter={setCenter}
          onOpen={(id) => openNote(id)}
          onAction={act}
          onMenu={(id, x, y) => setBibMenu({ id, x, y })}
        />
      )}
      {loaded && bibLayout === 'nodos' && (
        <NodeView
          rows={rows}
          links={links}
          center={center}
          paused={!!focusId || !!paletteOpen || !!renaming || tasksOpen || organizeOpen}
          onCenter={setCenter}
          onOpen={(id) => openNote(id)}
          onAction={act}
          onMove={moveTo}
          lit={lit}
          hide={mode === 'hide'}
        />
      )}
      </div>
      {bibMenu && family.byId.get(bibMenu.id) && (
        <BibMenu row={family.byId.get(bibMenu.id)!} kids={family.count(bibMenu.id)} x={bibMenu.x} y={bibMenu.y} onPick={(a) => bibPick(a, bibMenu.id)} onClose={() => setBibMenu(null)} />
      )}
      {movingId && (
        <SectionPicker
          options={sectionOptions}
          current={family.parent.get(movingId) ?? null}
          exclude={descendants(movingId)}
          onPick={(zoneId) => {
            moveTo(movingId, zoneId);
            setMovingId(null);
          }}
          onClose={() => setMovingId(null)}
        />
      )}
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
          placeholder={paletteOpen === 'link' ? t('Enlazar con…') : paletteOpen === 'card' ? t('Añadir al canvas…') : undefined}
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
      {organizeOpen && (
        <OrganizeView
          rows={rows}
          sections={sectionOptions}
          paused={!!focusId || !!inspectId || !!paletteOpen || !!renaming}
          onOpen={(id) => openNote(id)}
          onMove={moveMany}
          onNewSection={newSection}
          onClose={() => setOrganizeOpen(false)}
        />
      )}
      {tasksOpen && (
        <TasksView
          rows={rows}
          paused={!!focusId || !!inspectId || !!paletteOpen}
          onOpen={openTask}
          onChange={changeTaskIn}
          onAdd={addTask}
          sections={sectionOptions}
          onMoveTask={moveTask}
          onDelete={deleteTask}
          onClose={() => setTasksOpen(false)}
        />
      )}
      {focused && wrapPeek(
        <NoteSheet
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
          onProps={(id) => setInspectId(id)}
          rows={rows}
          onRename={(title) => updateNote(focused.id, { title: title || null })}
          onPickNote={(then) => {
            pickCard.current = then;
            setPaletteOpen('card');
          }}
          onNodes={() => toNodes(focused.id)}
          onArchive={() => toggleArchive(focused)}
          onLink={() => setPaletteOpen('link')}
          onConnect={(id) => connect(focused.id, id)}
          onCreateLinked={(title) => {
            // Un [[enlace]] a una nota que aún no existe: se crea junto a esta.
            const bodyJson = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] });
            return createNote(spotFor(focused.zoneId), 'text', { zoneId: focused.zoneId, title: title.slice(0, 120), bodyJson, bodyText: title }).id;
          }}
          onUnlink={(id) => unlink(focused.id, id)}
          zen={zenOn}
          onZen={(on) => {
            // Desde la vista previa, primero se va a la nota de verdad.
            if (on && peek) {
              flush(focused.id);
              setPeek(false);
              setTasksOpen(false);
            }
            setZen(on);
          }}
          onDelete={(id) => {
            flush(id);
            setFocusId(null);
            removeNotes([id]);
          }}
          onClose={closeFocused}
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
