import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import { decodeTime } from 'ulidx';
import type { NoteRow } from '../api';
import { bodyToHtml, editingExtensions, extensions, parseBody, splitTitle } from './editor';
import { MediaUpload, YouTubePaste } from './media';
import { FormatBar, MobileBar, SlashMenu } from './EditorMenus';
import { WikiSuggest, splitWiki, type WikiQuery } from './obsidian';
import { WikiMenu, type WikiItem } from './WikiMenu';
import { SlashSuggest, type SlashQuery } from './slash';
import { TOUCH } from './touch';
import { keysBlocked } from '../keys';
import { locale, t } from '../i18n';

// El Diario: un feed como el de Twitter para apuntar el día a día. Arriba se
// escribe, debajo las entradas, lo nuevo primero. Cada entrada es una nota más
// dentro de la nota «Diario» (se busca, se enlaza y se abre como las demás), y
// su título es el momento en que se escribió.

// Título de una entrada: «AAAA-MM-DD HH:MM», como las notas diarias de Obsidian.
export const ENTRY_TITLE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const pad = (n: number) => String(n).padStart(2, '0');
export const entryTitle = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Cuándo se escribió: por su id (lleva la hora de creación).
const bornAt = (id: string) => {
  try {
    return decodeTime(id);
  } catch {
    return 0;
  }
};

const dayStart = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

function dayLabel(ms: number) {
  const today = dayStart(Date.now());
  const days = Math.round((today - dayStart(ms)) / 86_400_000);
  if (days === 0) return t('Hoy');
  if (days === 1) return t('Ayer');
  const d = new Date(ms);
  return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

const timeLabel = (ms: number) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

// El texto de la entrada, sin su título si es el de la hora.
function entryHtml(row: NoteRow) {
  const split = splitTitle(parseBody(row.bodyJson));
  if (!ENTRY_TITLE.test(split.title)) return bodyToHtml(row.bodyJson);
  return bodyToHtml(JSON.stringify(split.body));
}

type Props = {
  rows: NoteRow[];
  // La nota «Diario» del perfil (null: aún no hay ninguna entrada).
  diaryId: string | null;
  paused: boolean;
  onPost: (body: JSONContent, text: string) => void;
  onOpen: (id: string) => void;
  // Un [[enlace]] a una nota que aún no existe: se crea y devuelve su id.
  onCreateLinked: (title: string) => string;
  onError: (e: unknown) => void;
  onClose: () => void;
};

// La nota de un [[enlace]]: por su id o, escrito a mano, por su nombre.
const sameTitle = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
function linkTarget(el: HTMLElement, rows: NoteRow[]) {
  if (el.dataset.id && rows.some((r) => r.id === el.dataset.id)) return el.dataset.id;
  const name = splitWiki(el.dataset.target ?? '').note;
  return name ? rows.find((r) => sameTitle(r.title ?? '', name))?.id : undefined;
}

export function DiaryView(p: Props) {
  const [empty, setEmpty] = useState(true);
  const post = useRef<() => void>(() => {});
  // Como en las notas: [[ busca notas para enlazar y / abre el menú de bloques.
  const [query, setQuery] = useState<WikiQuery | null>(null);
  const menuKeys = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const [suggest] = useState(() => WikiSuggest.configure({ onChange: setQuery, onKey: (e) => menuKeys.current(e) }));
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const slashKeys = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const [slashExt] = useState(() => SlashSuggest.configure({ onChange: setSlash, onKey: (e) => slashKeys.current(e) }));
  const rowsRef = useRef(p.rows);
  rowsRef.current = p.rows;
  const editor = useEditor({
    extensions: [...extensions, ...editingExtensions, MediaUpload.configure({ onError: p.onError }), YouTubePaste, suggest, slashExt],
    content: '',
    onCreate: ({ editor }) => {
      if (!TOUCH) editor.commands.focus();
    },
    onUpdate: ({ editor }) => setEmpty(editor.isEmpty),
    editorProps: {
      attributes: { class: 'note-body prose diary-input', 'aria-label': t('¿Qué tal el día?') },
      // Clic en un [[enlace]] abre esa nota.
      handleClick: (_view, _pos, e) => {
        const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('a[data-wikilink]');
        const id = el && linkTarget(el, rowsRef.current);
        if (!id) return false;
        e.preventDefault();
        p.onOpen(id);
        return true;
      },
      // Ctrl/⌘ Intro publica; Esc deja de escribir.
      handleKeyDown: (view, e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          post.current();
          return true;
        }
        if (e.key === 'Escape') {
          (view.dom as HTMLElement).blur();
          return true;
        }
        return false;
      },
    },
  });

  post.current = () => {
    if (!editor || editor.isEmpty) return;
    p.onPost(editor.getJSON(), editor.getText({ blockSeparator: '\n' }).trim());
    editor.commands.clearContent(true);
    setEmpty(true);
    if (!TOUCH) editor.commands.focus();
  };

  const pick = (item: WikiItem) => {
    if (!editor || !query) return;
    const { section, alias } = splitWiki(query.query);
    const title = item.kind === 'note' ? item.row.title || 'Nota sin título' : item.title;
    const id = item.kind === 'note' ? item.row.id : p.onCreateLinked(item.title);
    // Si ya estaban los «]]» de cierre, también se los lleva.
    const { doc } = editor.state;
    const to = doc.textBetween(query.to, Math.min(query.to + 2, doc.content.size), '') === ']]' ? query.to + 2 : query.to;
    editor
      .chain()
      .focus()
      .insertContentAt({ from: query.from, to }, { type: 'wikilink', attrs: { id, target: section ? `${title}#${section}` : title, alias } })
      .run();
  };

  // Las entradas: lo que cuelga de «Diario», lo nuevo primero, agrupado por días.
  const days = useMemo(() => {
    if (!p.diaryId) return [];
    const entries = p.rows
      .filter((r) => r.zoneId === p.diaryId && r.kind !== 'canvas')
      .map((r) => ({ row: r, at: bornAt(r.id) }))
      .sort((a, b) => b.at - a.at);
    const out: { day: number; entries: typeof entries }[] = [];
    for (const e of entries) {
      const day = dayStart(e.at);
      if (out.at(-1)?.day === day) out.at(-1)!.entries.push(e);
      else out.push({ day, entries: [e] });
    }
    return out;
  }, [p.rows, p.diaryId]);

  // Esc (sin estar escribiendo) cierra el Diario.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (p.paused || keysBlocked() || e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="tasks-view diary-view">
      <div className="diary-col">
        <div
          className={`diary-compose${empty ? ' is-blank' : ''}`}
          style={{ '--diary-ph': JSON.stringify(t('¿Qué tal el día?')) } as CSSProperties}
          onClick={(e) => e.target === e.currentTarget && editor?.commands.focus()}
        >
          <EditorContent editor={editor} />
          {query && <WikiMenu query={query} rows={p.rows} exclude={p.diaryId ?? ''} onPick={pick} keys={menuKeys} />}
          {slash && editor && <SlashMenu query={slash} editor={editor} onError={p.onError} keys={slashKeys} />}
          {editor && <FormatBar editor={editor} />}
          {editor && <MobileBar editor={editor} />}
          <div className="diary-compose-foot">
            <span className="meta diary-hint">{TOUCH ? '' : t('Ctrl Intro para publicar')}</span>
            <button className="btn btn-primary btn-sm diary-post" disabled={empty} onClick={() => post.current()}>
              {t('Publicar')}
            </button>
          </div>
        </div>

        {!days.length && <p className="diary-empty">{t('Aún no hay nada. Lo primero que escribas aparecerá aquí.')}</p>}

        {days.map((d) => (
          <section key={d.day} className="diary-day">
            <h2 className="label diary-day-title">{dayLabel(d.day)}</h2>
            {d.entries.map(({ row, at }) => (
              <article
                key={row.id}
                className="diary-entry"
                tabIndex={0}
                onClick={(e) => {
                  // Un [[enlace]] abre su nota.
                  const wiki = (e.target as HTMLElement).closest<HTMLElement>('a[data-wikilink]');
                  const linked = wiki && linkTarget(wiki, p.rows);
                  if (linked) {
                    e.preventDefault();
                    p.onOpen(linked);
                    return;
                  }
                  // Los enlaces web se abren aparte; lo demás abre la entrada para editarla.
                  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
                  if (a && /^https?:/i.test(a.href)) {
                    e.preventDefault();
                    window.open(a.href, '_blank', 'noopener');
                    return;
                  }
                  e.preventDefault();
                  p.onOpen(row.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') p.onOpen(row.id);
                }}
                title={t('Abrir para editar')}
              >
                <time className="diary-time meta" dateTime={new Date(at).toISOString()}>
                  {timeLabel(at)}
                </time>
                <div className="prose diary-body" dangerouslySetInnerHTML={{ __html: entryHtml(row) }} />
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
