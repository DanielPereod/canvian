import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { api, ApiError, type PublicPage, type PublicShare } from './api';
import { AuthScreen } from './AuthCard';
import { Glyph } from './Wordmark';
import { extensions, parseBody, splitTitle, bodyToHtml } from './canvas/editor';
import { setNoteSource } from './canvas/embeds';
import { splitWiki } from './canvas/obsidian';
import { parseCover } from './canvas/cover';
import { previewTheme } from './theme';
import { previewTypography } from './typography';
import { locale, t } from './i18n';

// Una nota pública, en /p/<enlace>: se lee sin entrar en Canvian. Si tiene
// contraseña, primero se pide. Si se compartieron también sus hijas, salen a
// un lado (en el móvil, en un desplegable arriba) y se puede ir de una a otra.

type State = { kind: 'loading' } | { kind: 'locked' } | { kind: 'gone' } | { kind: 'offline' } | { kind: 'ready'; share: PublicShare };

export const publicSlug = () => /^\/p\/([A-Za-z0-9_-]{8,64})\/?$/.exec(location.pathname)?.[1] ?? null;

const pageFromHash = () => /^#n=([A-Za-z0-9]{10,40})$/.exec(location.hash)?.[1] ?? null;
const titleOf = (p: PublicPage) => p.title?.trim() || (p.kind === 'canvas' ? t('Canvas sin título') : t('Nota sin título'));
const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

export function PublicNote({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = () =>
    api
      .publicShare(slug)
      .then((share) => setState({ kind: 'ready', share }))
      .catch((e) => setState({ kind: e instanceof ApiError ? (e.status === 401 ? 'locked' : 'gone') : 'offline' }));

  useEffect(() => {
    // Que los buscadores no guarden lo que se comparte.
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    document.head.append(robots);
    void load();
    return () => robots.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (state.kind === 'loading') return <div className="backdrop" />;
  if (state.kind === 'offline') return <AuthScreen title={t('Sin conexión')} hint={t('No se pudo abrir la nota. Comprueba tu conexión y recarga la página.')} />;
  if (state.kind === 'gone') return <AuthScreen title={t('Esta nota no está')} hint={t('El enlace no existe o ya no se comparte. Pide a quien te lo pasó que te mande uno nuevo.')} />;
  if (state.kind === 'locked') return <Unlock slug={slug} onDone={load} />;
  return <Reader share={state.share} />;
}

function Unlock({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.unlockShare(slug, password);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('No se pudo conectar con el servidor'));
      setBusy(false);
    }
  };
  return (
    <AuthScreen title={t('Nota protegida')} hint={t('Quien la compartió le puso contraseña. Escríbela para leerla.')}>
      <form className="auth-form" onSubmit={submit}>
        <input
          className="auth-field"
          type="password"
          autoFocus
          aria-label={t('Contraseña')}
          autoComplete="current-password"
          placeholder={t('Contraseña')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="auth-button" type="submit" disabled={busy || !password}>
          {t('Leer la nota')}
        </button>
        <p className="auth-error" role="alert">
          {error}
        </p>
      </form>
    </AuthScreen>
  );
}

function Reader({ share }: { share: PublicShare }) {
  const pages = share.notes;
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const kids = useMemo(() => {
    const m = new Map<string, PublicPage[]>();
    for (const p of pages) {
      if (!p.parentId) continue;
      m.set(p.parentId, [...(m.get(p.parentId) ?? []), p]);
    }
    for (const list of m.values()) list.sort((a, b) => titleOf(a).localeCompare(titleOf(b), locale(), { numeric: true }));
    return m;
  }, [pages]);
  const [at, setAt] = useState(() => {
    const h = pageFromHash();
    return h && byId.has(h) ? h : share.rootId;
  });
  const [navOpen, setNavOpen] = useState(false);
  const page = byId.get(at) ?? byId.get(share.rootId)!;
  const main = useRef<HTMLDivElement>(null);

  // Con el aspecto de quien la compartió (sin tocar el de este navegador).
  useEffect(() => {
    previewTheme(share.look.appearance);
    previewTypography(share.look.type);
    if (share.look.accent) document.documentElement.style.setProperty('--accent', share.look.accent);
  }, [share.look]);

  useEffect(() => {
    document.title = `${titleOf(page)} · Canvian`;
  }, [page]);

  // Atrás y adelante del navegador van de una nota a otra.
  useEffect(() => {
    const onHash = () => {
      const h = pageFromHash();
      setAt(h && byId.has(h) ? h : share.rootId);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [byId, share.rootId]);

  const go = (id: string) => {
    setNavOpen(false);
    if (id === at) return;
    if (id === share.rootId) history.pushState(null, '', location.pathname);
    else location.hash = `n=${id}`;
    setAt(id);
    main.current?.scrollTo({ top: 0 });
  };

  // Las notas que se incrustan (![[Nota]]) solo si también se comparten.
  const find = (id: string | null, target: string) => {
    const name = norm(splitWiki(target).note);
    return (id && byId.get(id)) || pages.find((p) => norm(p.title ?? '') === name) || null;
  };
  useEffect(() => {
    setNoteSource({
      find: (id, target) => {
        const p = find(id, target);
        return p ? { id: p.id, title: p.title ?? '', bodyJson: p.bodyJson } : null;
      },
      open: (id) => go(id),
      html: (bodyJson) => bodyToHtml(JSON.stringify(splitTitle(parseBody(bodyJson)).body)),
    });
    return () => setNoteSource(null);
  });

  const path: PublicPage[] = [];
  for (let p: PublicPage | undefined = page; p && path.length < 30; p = p.parentId ? byId.get(p.parentId) : undefined) path.unshift(p);
  const inside = kids.get(page.id) ?? [];
  const many = pages.length > 1;
  const cover = parseCover(page.cover);
  const edited = new Date(page.updatedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });

  const tree = (id: string, depth: number): React.ReactNode => {
    const p = byId.get(id);
    if (!p) return null;
    const sub = kids.get(id) ?? [];
    return (
      <li key={id}>
        <button className={`pub-nav-it${id === page.id ? ' is-on' : ''}`} style={{ '--depth': depth } as React.CSSProperties} onClick={() => go(id)} aria-current={id === page.id ? 'page' : undefined}>
          <span className="pub-nav-g" aria-hidden="true">
            {sub.length ? '▸' : '·'}
          </span>
          <span className="pub-nav-t">{titleOf(p)}</span>
        </button>
        {sub.length > 0 && <ul>{sub.map((k) => tree(k.id, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <div className={`pub${many ? ' has-nav' : ''}${navOpen ? ' is-nav-open' : ''}`}>
      <header className="pub-bar">
        <span className="pub-brand">
          <Glyph className="pub-glyph" />
          <span>Canvian</span>
        </span>
        <span className="pub-badge">{t('Nota pública')}</span>
        {many && (
          <button className="pub-nav-btn" onClick={() => setNavOpen((o) => !o)} aria-expanded={navOpen} aria-controls="pub-nav">
            {t('{n} notas', { n: pages.length })}
            <span aria-hidden="true">{navOpen ? '▴' : '▾'}</span>
          </button>
        )}
      </header>
      <div className="pub-wrap">
        {many && (
          <nav id="pub-nav" className="pub-nav" aria-label={t('Notas compartidas')}>
            <ul>{tree(share.rootId, 0)}</ul>
          </nav>
        )}
        <div className="sheet is-reader pub-sheet">
          <div className="reader-main" ref={main}>
            {cover && (
              <div className="note-cover">
                {cover.kind === 'image' ? <img src={cover.src} alt="" style={{ objectPosition: `50% ${cover.y}%` }} /> : <div className="note-cover-fill" style={{ background: cover.css }} />}
              </div>
            )}
            <article className={`reader-body${cover ? ' has-cover' : ''}`} key={page.id}>
              {path.length > 1 && (
                <nav className="pub-crumbs" aria-label={t('Ruta')}>
                  {path.slice(0, -1).map((p) => (
                    <span key={p.id}>
                      <button onClick={() => go(p.id)}>{titleOf(p)}</button>
                      <span aria-hidden="true"> › </span>
                    </span>
                  ))}
                </nav>
              )}
              <span className="reader-meta">{t('editada el {date}', { date: edited })}</span>
              <h1 className="sheet-title">{titleOf(page)}</h1>
              {page.kind === 'canvas' ? (
                <p className="pub-empty">{t('Los canvas todavía no se pueden ver en una nota pública.')}</p>
              ) : (
                <Body page={page} find={find} onOpen={go} />
              )}
              {inside.length > 0 && (
                <section className="pub-inside" aria-label={t('Dentro')}>
                  <span className="reader-side-h">{t('Dentro')}</span>
                  <div className="pub-inside-list">
                    {inside.map((k) => (
                      <button key={k.id} className="pub-inside-it" onClick={() => go(k.id)}>
                        <span className="pub-nav-g" aria-hidden="true">
                          {kids.get(k.id)?.length ? '▸' : '·'}
                        </span>
                        {titleOf(k)}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}

// El texto, solo para leer. Los [[enlaces]] a otras notas compartidas llevan a
// ellas; los que van a notas que no se compartieron se quedan como texto.
function Body({ page, find, onOpen }: { page: PublicPage; find: (id: string | null, target: string) => PublicPage | null; onOpen: (id: string) => void }) {
  const content = useMemo(() => splitTitle(parseBody(page.bodyJson)).body, [page.bodyJson]);
  const editor = useEditor(
    {
      extensions,
      editable: false,
      content: content.content?.length ? content : '',
      editorProps: {
        attributes: { class: 'note-body prose sheet-prose' },
        handleClick: (_view, _pos, e) => {
          const a = (e.target as HTMLElement | null)?.closest<HTMLElement>('a.wikilink');
          if (!a) return false;
          e.preventDefault();
          const hit = find(a.dataset.id ?? null, a.dataset.target ?? '');
          if (hit) onOpen(hit.id);
          return true;
        },
      },
    },
    [page.id, page.bodyJson],
  );
  const box = useRef<HTMLDivElement>(null);
  // Marcar los enlaces que no llevan a nada que se vea.
  useEffect(() => {
    const el = box.current;
    if (!el || !editor) return;
    for (const a of el.querySelectorAll<HTMLElement>('a.wikilink')) a.classList.toggle('is-private', !find(a.dataset.id ?? null, a.dataset.target ?? ''));
  });
  // Los enlaces web se abren en otra pestaña con un clic, que aquí no se escribe.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]:not(.wikilink)');
      if (!a || a.closest('.note-bookmark')) return;
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener,noreferrer');
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);
  if (!content.content?.length) return <p className="pub-empty">{t('Esta nota está vacía.')}</p>;
  return (
    <div ref={box}>
      <EditorContent editor={editor} className="sheet-editor pub-editor" />
    </div>
  );
}
