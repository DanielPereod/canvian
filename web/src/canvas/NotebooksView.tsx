import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, type Mastery, type NbCard, type NbFull, type NbMessage, type NbReview, type NbSource, type NbTopic, type NbTopicFull, type Notebook, type SearchHit } from '../api';
import { onLive } from '../live';
import { t, tn } from '../i18n';
import { bodyToHtml } from './editor';
import { markdownToDoc } from './markdown';
import './notebooks.css';

// Cuadernos: la IA te enseña una materia desde cero. Cada cuaderno tiene su
// temario (temas con lo que depende de qué), una sesión guiada por tema
// (pregunta de entrada, bloques cortos con comprobación, problemas con pistas,
// interrogatorio socrático y, al final, tu nota), sus fuentes (las elige la
// IA y las cambias tú), el repaso espaciado (FSRS) y un mapa que se colorea
// con lo que dominas según tus repasos. Tus notas viven en la biblioteca.

type Place =
  | { kind: 'home' }
  | { kind: 'new' }
  | { kind: 'review'; notebookId?: string }
  | { kind: 'nb'; id: string; tab: 'temas' | 'repaso' | 'mapa' | 'fuentes' }
  | { kind: 'topic'; nbId: string; topicId: string; tab: 'sesion' | 'fuentes' | 'leccion' | 'tarjetas' | 'nota' };

const PLACE_KEY = 'canvian.nbPlace';
const readPlace = (): Place => {
  try {
    const v = JSON.parse(localStorage.getItem(PLACE_KEY) ?? 'null');
    return v && typeof v.kind === 'string' ? v : { kind: 'home' };
  } catch {
    return { kind: 'home' };
  }
};
const writePlace = (p: Place) => {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(p));
  } catch {
    // Sin almacenamiento local se empieza desde la portada.
  }
};

export type NotebooksTarget = { notebookId: string; topicId?: string } | null;

type Props = {
  profileId: string;
  /** Abrir un tema concreto (desde el enlace de vuelta de una nota). */
  target: NotebooksTarget;
  onOpenNote: (id: string) => void;
  onSettings: () => void;
  onError: (e: unknown) => void;
  onClose: () => void;
};

const MASTERY: Record<Mastery, string> = { dominado: 'Lo dominas', fragil: 'Frágil', fallas: 'Fallas', 'sin-tocar': 'Por estudiar' };

// ── Piezas pequeñas ──────────────────────────────────────────────────

function Md({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    try {
      return bodyToHtml(JSON.stringify(markdownToDoc(text, false).doc));
    } catch {
      return '';
    }
  }, [text]);
  return html ? <div className={`prose nbv-md ${className}`} dangerouslySetInnerHTML={{ __html: html }} /> : <div className={`nbv-md ${className}`}>{text}</div>;
}

function Thinking({ label }: { label: string }) {
  return (
    <div className="nbv-thinking" role="status">
      <span className="nbv-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label}
    </div>
  );
}

/** Los errores de la IA, con lo que hay que hacer para arreglarlos. */
function AiProblem({ error, onSettings, onRetry }: { error: { message: string; code?: string } | null; onSettings: () => void; onRetry?: () => void }) {
  if (!error) return null;
  const connect = error.code === 'auth' || error.code === 'off';
  return (
    <div className={`nbv-problem${connect ? ' is-connect' : ''}`} role="alert">
      <span>{error.message}</span>
      <span className="nbv-problem-actions">
        {connect && (
          <button className="btn btn-primary btn-sm" onClick={onSettings}>
            {error.code === 'auth' ? t('Volver a conectar Claude') : t('Conectar Claude')}
          </button>
        )}
        {onRetry && (
          <button className="btn btn-ghost btn-sm" onClick={onRetry}>
            {t('Reintentar')}
          </button>
        )}
      </span>
    </div>
  );
}

const errOf = (e: unknown) => (e instanceof ApiError ? { message: e.message, code: e.code } : { message: e instanceof Error ? e.message : String(e) });

function useAi() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errOf(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, setError, run };
}

const whenText = (iso: string) => {
  const mins = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h`;
  const days = Math.round(mins / 1440);
  return days < 45 ? `${days} d` : `${Math.round(days / 30)} m`;
};

// ── La vista ─────────────────────────────────────────────────────────

export function NotebooksView(p: Props) {
  const [list, setList] = useState<Notebook[] | null>(null);
  const [place, setPlaceState] = useState<Place>(readPlace);
  const setPlace = useCallback((next: Place) => {
    setPlaceState(next);
    writePlace(next);
  }, []);
  const [dueAll, setDueAll] = useState(0);

  const load = useCallback(() => {
    api.notebooks(p.profileId).then((rows) => {
      setList(rows);
      setDueAll(rows.reduce((s, n) => s + n.due, 0));
    }, p.onError);
  }, [p.profileId, p.onError]);
  useEffect(load, [load]);
  useEffect(() => onLive((scope) => scope === 'nb' && load()), [load]);

  useEffect(() => {
    if (p.target) setPlace(p.target.topicId ? { kind: 'topic', nbId: p.target.notebookId, topicId: p.target.topicId, tab: 'sesion' } : { kind: 'nb', id: p.target.notebookId, tab: 'temas' });
  }, [p.target, setPlace]);

  // Un cuaderno que ya no existe (borrado en otro sitio): a la portada.
  useEffect(() => {
    if (!list) return;
    const id = place.kind === 'nb' ? place.id : place.kind === 'topic' ? place.nbId : null;
    if (id && !list.some((n) => n.id === id)) setPlace({ kind: 'home' });
  }, [list, place, setPlace]);

  // Esc vuelve atrás; en la portada, cierra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (place.kind === 'topic') setPlace({ kind: 'nb', id: place.nbId, tab: 'temas' });
      else if (place.kind !== 'home') setPlace({ kind: 'home' });
      else p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const current = place.kind === 'nb' ? place.id : place.kind === 'topic' ? place.nbId : null;

  return (
    <div className="tasks-view tv nbv">
      <nav className="tv-side" aria-label={t('Cuadernos')}>
        <div className="tv-side-title">{t('Cuadernos')}</div>
        <button className={`tv-nav-item${place.kind === 'home' ? ' is-on' : ''}`} onClick={() => setPlace({ kind: 'home' })}>
          <span className="tv-nav-icon" aria-hidden="true">
            ▦
          </span>
          <span className="tv-nav-name">{t('Estantería')}</span>
        </button>
        <button className={`tv-nav-item${place.kind === 'review' && !place.notebookId ? ' is-on' : ''}`} onClick={() => setPlace({ kind: 'review' })}>
          <span className="tv-nav-icon" aria-hidden="true">
            ↻
          </span>
          <span className="tv-nav-name">{t('Repasar hoy')}</span>
          <span className="tv-nav-n">{dueAll || ''}</span>
        </button>
        <div className="tv-side-sep" />
        {(list ?? []).map((nb) => (
          <button key={nb.id} className={`tv-nav-item${current === nb.id ? ' is-on' : ''}`} onClick={() => setPlace({ kind: 'nb', id: nb.id, tab: 'temas' })}>
            <span className="nbv-dot" style={{ background: nb.color ?? 'var(--accent)' }} aria-hidden="true" />
            <span className="tv-nav-name">{nb.title}</span>
            <span className="tv-nav-n">{nb.due || ''}</span>
          </button>
        ))}
        <button className={`tv-nav-item nbv-add${place.kind === 'new' ? ' is-on' : ''}`} onClick={() => setPlace({ kind: 'new' })}>
          <span className="tv-nav-icon" aria-hidden="true">
            +
          </span>
          <span className="tv-nav-name">{t('Nuevo cuaderno')}</span>
        </button>
      </nav>

      <main className="tv-main nbv-main">
        {list === null ? null : place.kind === 'home' ? (
          <Shelf list={list} due={dueAll} onOpen={(id) => setPlace({ kind: 'nb', id, tab: 'temas' })} onNew={() => setPlace({ kind: 'new' })} onReview={() => setPlace({ kind: 'review' })} />
        ) : place.kind === 'new' ? (
          <NewNotebook
            profileId={p.profileId}
            onError={p.onError}
            onCreated={(nb) => {
              // Ya en la lista, para que no se tome por uno borrado mientras se recarga.
              setList((l) => [...(l ?? []), nb]);
              load();
              setPlace({ kind: 'nb', id: nb.id, tab: 'temas' });
            }}
          />
        ) : place.kind === 'review' ? (
          <ReviewPanel profileId={p.profileId} notebookId={place.notebookId} onDone={load} onError={p.onError} />
        ) : place.kind === 'nb' ? (
          <NotebookPage
            key={place.id}
            id={place.id}
            profileId={p.profileId}
            tab={place.tab}
            onTab={(tab) => setPlace({ ...place, tab })}
            onTopic={(topicId) => setPlace({ kind: 'topic', nbId: place.id, topicId, tab: 'sesion' })}
            onChanged={load}
            onDeleted={() => {
              load();
              setPlace({ kind: 'home' });
            }}
            onSettings={p.onSettings}
            onError={p.onError}
          />
        ) : (
          <TopicPage
            key={place.topicId}
            nbId={place.nbId}
            topicId={place.topicId}
            profileId={p.profileId}
            tab={place.tab}
            onTab={(tab) => setPlace({ ...place, tab })}
            onBack={() => setPlace({ kind: 'nb', id: place.nbId, tab: 'temas' })}
            onTopic={(topicId) => setPlace({ kind: 'topic', nbId: place.nbId, topicId, tab: 'sesion' })}
            onOpenNote={p.onOpenNote}
            onChanged={load}
            onSettings={p.onSettings}
            onError={p.onError}
          />
        )}
      </main>
    </div>
  );
}

// ── Estantería ───────────────────────────────────────────────────────

function Shelf({ list, due, onOpen, onNew, onReview }: { list: Notebook[]; due: number; onOpen: (id: string) => void; onNew: () => void; onReview: () => void }) {
  return (
    <div className="nbv-page">
      <header className="tv-head">
        <h1 className="tv-title">{t('Cuadernos')}</h1>
        {due > 0 && (
          <div className="tv-head-tools">
            <button className="btn btn-primary btn-sm" onClick={onReview}>
              {t('Repasar hoy')} · {due}
            </button>
          </div>
        )}
      </header>
      {!list.length && (
        <p className="nbv-intro">
          {t('Aprende una materia desde cero con Claude como tutor: te pregunta antes de explicar, te explica en bloques cortos, te pone a prueba y te hace escribir tu propia nota. Lo que aprendas vuelve en el repaso justo antes de que lo olvides.')}
        </p>
      )}
      <div className="nbv-covers">
        {list.map((nb) => (
          <button key={nb.id} className="nbv-cover" style={{ ['--spine' as string]: nb.color ?? 'var(--accent)' }} onClick={() => onOpen(nb.id)}>
            <span className="nbv-cover-top">
              <span className="nbv-cover-title">{nb.title}</span>
              {nb.goal && <span className="nbv-cover-sub">{nb.goal}</span>}
            </span>
            <span className="nbv-cover-bottom">
              <span className="nbv-cover-sub">
                {nb.status === 'diagnostico' ? t('Diagnóstico pendiente') : nb.topics ? t('{done} de {n} temas', { done: nb.done, n: nb.topics }) + (nb.next ? ` · ${nb.next}` : '') : t('Sin temario')}
              </span>
              <span className="nbv-meter" aria-hidden="true">
                <i style={{ width: `${nb.topics ? Math.max(3, (nb.done / nb.topics) * 100) : 2}%` }} />
              </span>
              {nb.due > 0 && <span className="nbv-pill is-accent">{tn(nb.due, '{n} por repasar', '{n} por repasar')}</span>}
            </span>
          </button>
        ))}
        <button className="nbv-cover is-new" onClick={onNew}>
          <span>＋ {t('Nuevo cuaderno')}</span>
          <span className="nbv-cover-sub">{t('«Quiero aprender…»')}</span>
        </button>
      </div>
    </div>
  );
}

function NewNotebook({ profileId, onCreated, onError }: { profileId: string; onCreated: (nb: Notebook) => void; onError: (e: unknown) => void }) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [saving, setSaving] = useState(false);
  const create = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      onCreated(await api.createNotebook(profileId, { title: title.trim(), goal: goal.trim() || null }));
    } catch (e) {
      onError(e);
      setSaving(false);
    }
  };
  return (
    <div className="nbv-page nbv-narrow">
      <header className="tv-head">
        <h1 className="tv-title">{t('Nuevo cuaderno')}</h1>
      </header>
      <label className="nbv-label" htmlFor="nb-title">
        {t('¿Qué quieres aprender?')}
      </label>
      <input id="nb-title" className="field nbv-input" autoFocus value={title} placeholder={t('Cálculo, japonés, historia del arte…')} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
      <label className="nbv-label" htmlFor="nb-goal">
        {t('¿Para qué? (opcional)')}
      </label>
      <textarea id="nb-goal" className="field nbv-input" rows={3} value={goal} placeholder={t('Por ejemplo: entender las derivadas para un curso de física')} onChange={(e) => setGoal(e.target.value)} />
      <p className="nbv-hint">{t('Después Claude te hará unas preguntas para saber de dónde partes y te propondrá un temario que puedes cambiar.')}</p>
      <div>
        <button className="btn btn-primary" onClick={create} disabled={!title.trim() || saving}>
          {t('Crear cuaderno')}
        </button>
      </div>
    </div>
  );
}

// ── Un cuaderno ──────────────────────────────────────────────────────

function NotebookPage(p: {
  id: string;
  profileId: string;
  tab: 'temas' | 'repaso' | 'mapa' | 'fuentes';
  onTab: (tab: 'temas' | 'repaso' | 'mapa' | 'fuentes') => void;
  onTopic: (id: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
  onSettings: () => void;
  onError: (e: unknown) => void;
}) {
  const [data, setData] = useState<NbFull | null>(null);
  const ai = useAi();
  const reload = useCallback(() => api.notebook(p.id).then(setData, p.onError), [p.id, p.onError]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => onLive((scope) => scope === 'nb' && void reload()), [reload]);
  const set = (d: NbFull | null) => {
    if (d) {
      setData(d);
      p.onChanged();
    }
  };

  // Al crear el cuaderno: las preguntas del diagnóstico salen solas.
  const asked = useRef(false);
  useEffect(() => {
    if (!data || asked.current) return;
    if (data.notebook.status === 'diagnostico' && !data.notebook.diagnosis.length && !data.topics.length) {
      asked.current = true;
      void ai.run(t('Claude está preparando unas preguntas…'), () => api.nbDiagnosis(p.id)).then(set);
    }
  });

  if (!data) return null;
  const nb = data.notebook;
  const remove = () => {
    if (!window.confirm(t('Se borran el cuaderno, sus temas y sus tarjetas. Tus notas se quedan en la biblioteca. ¿Borrar «{title}»?', { title: nb.title }))) return;
    api.deleteNotebook(nb.id).then(p.onDeleted, p.onError);
  };

  return (
    <div className="nbv-page">
      <header className="tv-head nbv-head">
        <div className="nbv-head-text">
          <h1 className="tv-title">
            <span className="nbv-dot is-big" style={{ background: nb.color ?? 'var(--accent)' }} aria-hidden="true" />
            {nb.title}
          </h1>
          {(nb.goal || nb.level) && <p className="nbv-sub">{[nb.goal, nb.level && `${t('Punto de partida')}: ${nb.level}`].filter(Boolean).join(' · ')}</p>}
        </div>
        <div className="tv-head-tools">
          <button className="btn btn-ghost btn-sm" onClick={remove}>
            {t('Borrar')}
          </button>
        </div>
      </header>

      {nb.status === 'diagnostico' && !data.topics.length ? (
        <>
          <AiProblem error={ai.error} onSettings={p.onSettings} onRetry={() => void ai.run(t('Claude está preparando unas preguntas…'), () => api.nbDiagnosis(p.id)).then(set)} />
          {ai.busy ? <Thinking label={ai.busy} /> : nb.diagnosis.length ? <Diagnosis nb={nb} onPlan={(answers) => void ai.run(t('Claude está preparando tu temario…'), () => api.nbPlan(nb.id, answers)).then(set)} /> : null}
        </>
      ) : (
        <>
          <div className="nbv-tabs" role="tablist">
            {(
              [
                ['temas', t('Temas')],
                ['repaso', t('Repaso')],
                ['mapa', t('Mapa')],
                ['fuentes', t('Fuentes')],
              ] as const
            ).map(([id, name]) => (
              <button key={id} role="tab" aria-selected={p.tab === id} className={p.tab === id ? 'is-on' : ''} onClick={() => p.onTab(id)}>
                {name}
                {id === 'repaso' && nb.due > 0 && <span className="nbv-tab-n">{nb.due}</span>}
              </button>
            ))}
          </div>
          {p.tab === 'temas' && <TopicList data={data} onTopic={p.onTopic} onData={set} onError={p.onError} />}
          {p.tab === 'repaso' && (
            <>
              <ReviewPanel profileId={p.profileId} notebookId={nb.id} onDone={() => void reload()} onError={p.onError} />
              <Calibration data={data.calibration} />
            </>
          )}
          {p.tab === 'mapa' && <DomainMap topics={data.topics} next={data.next} onTopic={p.onTopic} />}
          {p.tab === 'fuentes' && (
            <SourcesPanel
              profileId={p.profileId}
              sources={data.sources}
              mode={nb.sourceMode}
              hint={t('Las fuentes del cuaderno entero valen para todos sus temas. Cada tema tiene además las suyas.')}
              onMode={(m) => api.patchNotebook(nb.id, { sourceMode: m }).then(set, p.onError)}
              onAdd={(body) => api.nbAddNotebookSource(nb.id, body).then(set, p.onError)}
              onPatch={(id, patch) => api.nbPatchSource(id, patch).then(() => reload(), p.onError)}
            />
          )}
        </>
      )}
    </div>
  );
}

function Diagnosis({ nb, onPlan }: { nb: Notebook; onPlan: (answers: { q: string; a: string }[]) => void }) {
  const [answers, setAnswers] = useState(() => nb.diagnosis.map((d) => d.a));
  return (
    <div className="nbv-narrow nbv-diag">
      <p className="nbv-intro">{t('Antes de empezar, Claude quiere saber de dónde partes. Responde lo que sepas; si no sabes algo, dilo: también sirve.')}</p>
      {nb.diagnosis.map((d, i) => (
        <div key={i} className="nbv-diag-q">
          <label className="nbv-label" htmlFor={`nb-diag-${i}`}>
            {d.q}
          </label>
          <textarea id={`nb-diag-${i}`} className="field nbv-input" rows={2} value={answers[i] ?? ''} onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
        </div>
      ))}
      <div>
        <button className="btn btn-primary" onClick={() => onPlan(nb.diagnosis.map((d, i) => ({ q: d.q, a: answers[i] ?? '' })))}>
          {t('Preparar mi temario')}
        </button>
      </div>
    </div>
  );
}

function TopicList({ data, onTopic, onData, onError }: { data: NbFull; onTopic: (id: string) => void; onData: (d: NbFull) => void; onError: (e: unknown) => void }) {
  const [adding, setAdding] = useState('');
  const byId = new Map(data.topics.map((x) => [x.id, x]));
  const weak = (x: NbTopic) => x.dependsOn.map((d) => byId.get(d)).filter((d): d is NbTopic => !!d && d.status !== 'hecho' && d.mastery?.level !== 'dominado' && d.mastery?.level !== 'fragil');
  return (
    <div className="nbv-topics">
      {data.topics.map((x, i) => {
        const level = x.mastery?.level ?? 'sin-tocar';
        const before = weak(x);
        return (
          <div key={x.id} className={`nbv-topic is-${level}`}>
            <button className="nbv-topic-main" onClick={() => onTopic(x.id)}>
              <span className="nbv-topic-n">{i + 1}</span>
              <span className="nbv-topic-text">
                <span className="nbv-topic-title">
                  {x.title}
                  {data.next === x.id && <span className="nbv-pill is-accent">{t('Siguiente')}</span>}
                </span>
                {x.summary && <span className="nbv-topic-sum">{x.summary}</span>}
                {before.length > 0 && x.status !== 'hecho' && <span className="nbv-topic-warn">{t('Antes conviene: {topics}', { topics: before.map((b) => b.title).join(', ') })}</span>}
              </span>
              <span className="nbv-topic-state">
                <span className={`nbv-pill is-${x.status}`}>{x.status === 'hecho' ? t('Terminado') : x.status === 'estudiando' ? t('Estudiando') : t('Pendiente')}</span>
                {x.mastery && x.mastery.cards > 0 && <span className={`nbv-mastery is-${level}`}>{t(MASTERY[level])}</span>}
              </span>
            </button>
            <span className="nbv-topic-tools">
              <button className="nbv-icon" aria-label={t('Subir')} title={t('Subir')} disabled={i === 0} onClick={() => api.nbPatchTopic(x.id, { position: i - 1 }).then(onData, onError)}>
                ↑
              </button>
              <button
                className="nbv-icon"
                aria-label={t('Quitar el tema')}
                title={t('Quitar el tema')}
                onClick={() => window.confirm(t('¿Quitar «{title}» del temario? Sus tarjetas se quedan en el repaso.', { title: x.title })) && api.nbDeleteTopic(x.id).then(onData, onError)}
              >
                ×
              </button>
            </span>
          </div>
        );
      })}
      <div className="tv-add nbv-add-topic">
        <span className="tv-add-plus" aria-hidden="true">
          +
        </span>
        <input
          value={adding}
          placeholder={t('Añadir un tema al temario')}
          aria-label={t('Añadir un tema al temario')}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && adding.trim()) {
              api.nbAddTopic(data.notebook.id, adding.trim()).then(onData, onError);
              setAdding('');
            }
          }}
        />
      </div>
    </div>
  );
}

// ── Mapa de dominio ──────────────────────────────────────────────────

function DomainMap({ topics, next, onTopic }: { topics: NbTopic[]; next: string | null; onTopic: (id: string) => void }) {
  const layout = useMemo(() => {
    const byId = new Map(topics.map((x) => [x.id, x]));
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const deps = byId.get(id)?.dependsOn.filter((d) => byId.has(d)) ?? [];
      const d = deps.length ? 1 + Math.max(...deps.map((x) => depthOf(x, seen))) : 0;
      depth.set(id, d);
      return d;
    };
    topics.forEach((x) => depthOf(x.id));
    const cols = new Map<number, NbTopic[]>();
    for (const x of topics) cols.set(depth.get(x.id)!, [...(cols.get(depth.get(x.id)!) ?? []), x]);
    const W = 168;
    const H = 46;
    const GX = 56;
    const GY = 22;
    const pos = new Map<string, { x: number; y: number }>();
    let rows = 0;
    for (const [d, xs] of cols) {
      xs.forEach((x, i) => pos.set(x.id, { x: 20 + d * (W + GX), y: 20 + i * (H + GY) }));
      rows = Math.max(rows, xs.length);
    }
    const width = 40 + Math.max(1, cols.size) * (W + GX) - GX;
    const height = 40 + Math.max(1, rows) * (H + GY) - GY + 34;
    return { pos, W, H, width, height };
  }, [topics]);

  if (!topics.length) return <p className="tv-empty">{t('El mapa aparece cuando hay temario.')}</p>;
  const { pos, W, H, width, height } = layout;
  const counts = topics.reduce<Record<string, number>>((acc, x) => ((acc[x.mastery?.level ?? 'sin-tocar'] = (acc[x.mastery?.level ?? 'sin-tocar'] ?? 0) + 1), acc), {});
  return (
    <div className="nbv-map-wrap">
      <p className="nbv-hint">{t('El color sale de tus repasos, no de lo que has leído. Toca un tema para estudiarlo.')}</p>
      <div className="nbv-map-scroll">
        <svg className="nbv-map" viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ maxWidth: width }} role="img" aria-label={t('Mapa de dominio')}>
          {topics.flatMap((x) =>
            x.dependsOn
              .filter((d) => pos.has(d))
              .map((d) => {
                const a = pos.get(d)!;
                const b = pos.get(x.id)!;
                const x1 = a.x + W;
                const y1 = a.y + H / 2;
                const x2 = b.x;
                const y2 = b.y + H / 2;
                return <path key={`${d}-${x.id}`} className="nbv-map-edge" d={`M${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}`} />;
              }),
          )}
          {topics.map((x) => {
            const at = pos.get(x.id)!;
            const level = x.mastery?.level ?? 'sin-tocar';
            return (
              <g key={x.id} className={`nbv-map-node is-${level}${next === x.id ? ' is-next' : ''}`} transform={`translate(${at.x} ${at.y})`} onClick={() => onTopic(x.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onTopic(x.id)}>
                <rect width={W} height={H} rx="9" />
                <text x={W / 2} y={H / 2 + 4} textAnchor="middle">
                  {x.title.length > 22 ? `${x.title.slice(0, 21)}…` : x.title}
                </text>
                <title>{`${x.title} · ${t(MASTERY[level])}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="nbv-legend">
        {(['dominado', 'fragil', 'fallas', 'sin-tocar'] as Mastery[]).map((l) => (
          <span key={l} className={`nbv-legend-item is-${l}`}>
            <i aria-hidden="true" />
            {t(MASTERY[l])} · {counts[l] ?? 0}
          </span>
        ))}
      </div>
    </div>
  );
}

function Calibration({ data }: { data: NbFull['calibration'] }) {
  const rows = data.filter((d) => d.answers > 0);
  if (!rows.length) return null;
  const names: Record<number, string> = { 25: 'Adivino', 50: 'Dudo', 75: 'Bastante', 95: 'Seguro' };
  return (
    <div className="nbv-calib">
      <div className="nbv-label">{t('Tu calibración')}</div>
      {rows.map((d) => (
        <div key={d.confidence} className="nbv-calib-row">
          <span>{t(names[d.confidence])}</span>
          <span className="nbv-calib-bar" aria-hidden="true">
            <i style={{ width: `${d.right ?? 0}%` }} />
            <b style={{ left: `${d.confidence}%` }} />
          </span>
          <span className="nbv-calib-v">{d.right}%</span>
        </div>
      ))}
      <p className="nbv-hint">{t('La barra es lo que aciertas; la raya, lo que creías. Si la barra se queda corta, te sobrestimas: repasa antes de dar algo por sabido.')}</p>
    </div>
  );
}

// ── Repaso ───────────────────────────────────────────────────────────

const CONF = [
  { v: 25, name: 'Adivino' },
  { v: 50, name: 'Dudo' },
  { v: 75, name: 'Bastante' },
  { v: 95, name: 'Seguro' },
];
const GRADES = [
  { v: 1, name: 'Otra vez' },
  { v: 2, name: 'Difícil' },
  { v: 3, name: 'Bien' },
  { v: 4, name: 'Fácil' },
];
const KIND: Record<string, string> = { dato: 'Dato', explica: 'Explica', problema: 'Problema' };

function ReviewPanel({ profileId, notebookId, onDone, onError }: { profileId: string; notebookId?: string; onDone: () => void; onError: (e: unknown) => void }) {
  const [queue, setQueue] = useState<NbCard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState(false);
  const [conf, setConf] = useState<number | null>(null);
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    api.nbReview(profileId, notebookId).then((q) => {
      setQueue(q);
      setTotal(q.length);
    }, onError);
  }, [profileId, notebookId, onError]);

  if (!queue) return null;
  const card = queue[0];
  if (!card)
    return (
      <div className="nbv-review-done">
        <p className="nbv-intro">{total ? t('Hecho por hoy. Lo que has repasado volverá justo cuando estés a punto de olvidarlo.') : t('No hay nada que repasar ahora. Las tarjetas salen de los temas que estudias.')}</p>
        {note && <p className="nbv-hint">{note}</p>}
      </div>
    );
  const rate = (v: number) => {
    const next = card.next?.[v - 1];
    api.nbGrade(card.id, { rating: v, confidence: conf, answer: answer.trim() || null }).then(() => {
      setNote(next ? t('Vuelve dentro de {when}.', { when: whenText(next) }) : null);
      setQueue((q) => {
        const rest = (q ?? []).slice(1);
        // «Otra vez» vuelve al final de la cola de hoy.
        return v === 1 ? [...rest, card] : rest;
      });
      setShown(false);
      setConf(null);
      setAnswer('');
      if (queue.length <= 1 && v !== 1) onDone();
    }, onError);
  };
  const done = total - queue.length;
  return (
    <div className="nbv-review">
      <div className="nbv-review-top">
        <span className="nbv-pill is-accent">{t('Quedan {n}', { n: queue.length })}</span>
        <span className="nbv-meter is-wide" aria-hidden="true">
          <i style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </span>
      </div>
      <div className="nbv-card">
        <div className="nbv-card-meta">
          <span className="nbv-pill">{t(KIND[card.kind] ?? 'Dato')}</span>
          {card.topic && <span className="nbv-pill">{card.topic}</span>}
          {!notebookId && <span className="nbv-pill">{card.notebook}</span>}
        </div>
        <Md text={card.front} className="nbv-card-q" />
        {!shown && (
          <>
            <textarea className="field nbv-input" rows={2} value={answer} placeholder={t('Escríbelo antes de mirar (opcional)')} aria-label={t('Tu respuesta')} onChange={(e) => setAnswer(e.target.value)} />
            <div className="nbv-conf" role="group" aria-label={t('¿Cuánto confías en tu respuesta?')}>
              <span className="nbv-hint">{t('¿Cuánto confías?')}</span>
              {CONF.map((c) => (
                <button key={c.v} className={`nbv-chip${conf === c.v ? ' is-on' : ''}`} aria-pressed={conf === c.v} onClick={() => setConf(conf === c.v ? null : c.v)}>
                  {t(c.name)}
                </button>
              ))}
            </div>
            <div>
              <button className="btn btn-primary btn-sm" onClick={() => setShown(true)}>
                {t('Mostrar respuesta')}
              </button>
            </div>
          </>
        )}
        {shown && (
          <>
            <Md text={card.back} className="nbv-card-a" />
            {conf !== null && conf >= 75 && <p className="nbv-hint">{t('Si has fallado estando seguro, apúntalo como «Otra vez»: esos errores son los que mejor se corrigen.')}</p>}
            <div className="nbv-grades">
              {GRADES.map((g) => (
                <button key={g.v} className="btn btn-ghost nbv-grade" onClick={() => rate(g.v)}>
                  {t(g.name)}
                  {card.next?.[g.v - 1] && <small>{whenText(card.next[g.v - 1])}</small>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {note && <p className="nbv-hint">{note}</p>}
    </div>
  );
}

// ── Fuentes ──────────────────────────────────────────────────────────

const SOURCE_ICON: Record<string, string> = { web: '↗', video: '▶', libro: '📘', pdf: '📄', nota: '¶' };

function SourcesPanel(p: {
  profileId: string;
  sources: NbSource[];
  mode: 'auto' | 'manual';
  hint: string;
  busy?: string | null;
  onMode: (m: 'auto' | 'manual') => void;
  onAdd: (body: { url?: string; noteId?: string }) => void;
  onPatch: (id: string, patch: { pinned?: boolean; removed?: boolean }) => void;
  onAuto?: () => void;
  onOpenNote?: (id: string) => void;
  extra?: ReactNode;
}) {
  const [input, setInput] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const isUrl = /^https?:\/\/\S+$/i.test(input.trim());
  useEffect(() => {
    const q = input.trim();
    if (!q || /^https?:/i.test(q)) {
      setHits([]);
      return;
    }
    const id = setTimeout(() => api.search(p.profileId, q).then((r) => setHits(r.slice(0, 6)), () => setHits([])), 200);
    return () => clearTimeout(id);
  }, [input, p.profileId]);
  const add = (body: { url?: string; noteId?: string }) => {
    p.onAdd(body);
    setInput('');
    setHits([]);
  };
  return (
    <div className="nbv-sources">
      <div className="nbv-sources-head">
        <p className="nbv-hint">{p.hint}</p>
        <div className="tv-group-by" role="group" aria-label={t('Cómo se eligen las fuentes')}>
          <button className={p.mode === 'auto' ? 'is-on' : ''} onClick={() => p.onMode('auto')}>
            {t('Automático')}
          </button>
          <button className={p.mode === 'manual' ? 'is-on' : ''} onClick={() => p.onMode('manual')}>
            {t('Solo las mías')}
          </button>
        </div>
      </div>
      <p className="nbv-hint">
        {p.mode === 'auto' ? t('Claude busca fuentes buenas y elige las notas de tu biblioteca que sirven. Si quitas una, no vuelve a proponerla.') : t('Claude enseña solo con lo que añadas tú, y avisa si algo del tema no está cubierto.')}
      </p>
      {p.sources.length ? (
        <ul className="nbv-source-list">
          {p.sources.map((s) => (
            <li key={s.id} className={`nbv-source${s.pinned ? ' is-pinned' : ''}`}>
              <span className="nbv-source-icon" aria-hidden="true">
                {SOURCE_ICON[s.kind] ?? '↗'}
              </span>
              <span className="nbv-source-text">
                {s.noteId && p.onOpenNote ? (
                  <button className="nbv-link" onClick={() => p.onOpenNote!(s.noteId!)}>
                    {s.title}
                  </button>
                ) : s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                ) : (
                  <span>{s.title}</span>
                )}
                <span className="nbv-source-meta">
                  <span className={`nbv-pill${s.origin === 'ia' ? ' is-accent' : ''}`}>{s.kind === 'nota' ? t('De tu biblioteca') : s.origin === 'ia' ? t('Elegida por Claude') : t('Añadida por ti')}</span>
                  {s.topicId === null && <span className="nbv-pill">{t('De todo el cuaderno')}</span>}
                  {s.why && s.kind !== 'nota' && <span className="nbv-source-why">{s.why}</span>}
                </span>
              </span>
              <span className="nbv-source-tools">
                <button className={`nbv-icon${s.pinned ? ' is-on' : ''}`} aria-pressed={!!s.pinned} title={s.pinned ? t('Dejar de fijar') : t('Fijar: usarla siempre')} aria-label={t('Fijar')} onClick={() => p.onPatch(s.id, { pinned: !s.pinned })}>
                  📌
                </button>
                <button className="nbv-icon" title={t('Quitar')} aria-label={t('Quitar')} onClick={() => p.onPatch(s.id, { removed: true })}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tv-empty">{t('Aún no hay fuentes.')}</p>
      )}
      <div className="nbv-source-add">
        <input
          className="field"
          value={input}
          placeholder={t('Pega un enlace o busca una nota tuya')}
          aria-label={t('Añadir fuente')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && isUrl && add({ url: input.trim() })}
        />
        <button className="btn btn-primary btn-sm" disabled={!isUrl} onClick={() => add({ url: input.trim() })}>
          {t('Añadir')}
        </button>
        {p.onAuto && (
          <button className="btn btn-ghost btn-sm" disabled={!!p.busy} onClick={p.onAuto}>
            {p.mode === 'auto' ? t('Buscar fuentes') : t('Volver a leer las fuentes')}
          </button>
        )}
      </div>
      {hits.length > 0 && (
        <ul className="nbv-hits">
          {hits.map((h) => (
            <li key={h.id}>
              <button onClick={() => add({ noteId: h.id })}>¶ {h.title || t('Sin título')}</button>
            </li>
          ))}
        </ul>
      )}
      {p.extra}
    </div>
  );
}

// ── Un tema ──────────────────────────────────────────────────────────

const TRAIL: { id: string; name: string; stages: string[] }[] = [
  { id: 'entrada', name: 'Pregunta de entrada', stages: ['entrada'] },
  { id: 'leccion', name: 'Ideas, ejemplos y comprobación', stages: ['idea', 'ejemplo', 'comprueba'] },
  { id: 'intenta', name: 'Inténtalo tú', stages: ['intenta'] },
  { id: 'socratico', name: 'Interrogatorio', stages: ['socratico'] },
  { id: 'nota', name: 'Escribe tu nota', stages: ['nota'] },
  { id: 'fin', name: 'Terminado', stages: ['fin'] },
];

function TopicPage(p: {
  nbId: string;
  topicId: string;
  profileId: string;
  tab: 'sesion' | 'fuentes' | 'leccion' | 'tarjetas' | 'nota';
  onTab: (tab: 'sesion' | 'fuentes' | 'leccion' | 'tarjetas' | 'nota') => void;
  onBack: () => void;
  onTopic: (id: string) => void;
  onOpenNote: (id: string) => void;
  onChanged: () => void;
  onSettings: () => void;
  onError: (e: unknown) => void;
}) {
  const [data, setData] = useState<NbTopicFull | null>(null);
  const [nb, setNb] = useState<NbFull | null>(null);
  const tutor = useAi();
  // El editor de la nota, en un panel al lado: se abre solo al llegar a «Escribe tu nota».
  const [writing, setWriting] = useState(false);
  const offered = useRef(false);
  const sources = useAi();
  const reload = useCallback(() => api.nbTopic(p.topicId).then(setData, p.onError), [p.topicId, p.onError]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    void api.notebook(p.nbId).then(setNb, p.onError);
  }, [p.nbId, p.onError]);
  const got = (d: NbTopicFull | null) => {
    if (d) {
      setData((old) => ({ ...d, review: d.review ?? old?.review, reviewError: d.reviewError }));
      p.onChanged();
    }
    return d;
  };

  const say = (text?: string) => tutor.run(t('Claude está pensando…'), () => api.nbTurn(p.topicId, text)).then(got);
  const findSources = () => sources.run(t('Claude está buscando y leyendo fuentes…'), () => api.nbAutoSources(p.topicId)).then(got);

  // Al abrir un tema nuevo: empieza la sesión y, a la vez, se buscan sus fuentes.
  const started = useRef(false);
  useEffect(() => {
    if (!data || !nb || started.current) return;
    started.current = true;
    if (!data.messages.length && data.topic.status !== 'hecho') void say();
    if (!data.sources.length && !data.topic.brief && (nb.notebook.sourceMode === 'auto' || nb.sources.length)) void findSources();
  });
  useEffect(() => {
    if (!data || offered.current || data.note || data.topic.stage !== 'nota') return;
    offered.current = true;
    setWriting(true);
  }, [data]);

  if (!data || !nb) return null;
  const topic = data.topic;
  const i = nb.topics.findIndex((x) => x.id === topic.id);
  const nextTopic = nb.topics.slice(i + 1).find((x) => x.status !== 'hecho');
  const tabs = [
    ['sesion', t('Sesión')],
    ['nota', t('Tu nota')],
    ['fuentes', t('Fuentes')],
    ['leccion', t('Lección')],
    ['tarjetas', t('Tarjetas')],
  ] as const;

  return (
    <div className="nbv-page nbv-topic-page">
      <header className="tv-head nbv-head">
        <div className="nbv-head-text">
          <button className="nbv-back" onClick={p.onBack}>
            ← {nb.notebook.title}
          </button>
          <h1 className="tv-title">{topic.title}</h1>
          {topic.summary && <p className="nbv-sub">{topic.summary}</p>}
        </div>
        <div className="tv-head-tools">
          {topic.status === 'hecho' && nextTopic && (
            <button className="btn btn-primary btn-sm" onClick={() => p.onTopic(nextTopic.id)}>
              {t('Siguiente: {title}', { title: nextTopic.title })}
            </button>
          )}
        </div>
      </header>
      <div className="nbv-tabs" role="tablist">
        {tabs.map(([id, name]) => (
          <button key={id} role="tab" aria-selected={p.tab === id} className={p.tab === id ? 'is-on' : ''} onClick={() => p.onTab(id)}>
            {name}
            {id === 'fuentes' && (sources.busy ? <span className="nbv-tab-n">…</span> : data.sources.length > 0 && <span className="nbv-tab-n">{data.sources.length}</span>)}
            {id === 'tarjetas' && data.cards.length > 0 && <span className="nbv-tab-n">{data.cards.length}</span>}
            {id === 'nota' && data.note && <span className="nbv-tab-n">✓</span>}
          </button>
        ))}
      </div>

      {p.tab === 'sesion' && <Session data={data} busy={tutor.busy} error={tutor.error} onSay={say} onSettings={p.onSettings} onWrite={() => setWriting(true)} />}
      {p.tab === 'nota' && <NoteWriter data={data} nb={nb} profileId={p.profileId} onSaved={got} onOpenNote={p.onOpenNote} onSettings={p.onSettings} onError={p.onError} onDone={p.onBack} />}
      {writing && p.tab !== 'nota' && (
        <NotePanel onClose={() => setWriting(false)}>
          <NoteWriter
            data={data}
            nb={nb}
            profileId={p.profileId}
            onSaved={got}
            onOpenNote={(id) => {
              // El editor de la nota se abre encima de la página: el panel se aparta y vuelve con «Revisar mi nota».
              setWriting(false);
              p.onOpenNote(id);
            }}
            onSettings={p.onSettings}
            onError={p.onError}
            onDone={() => {
              setWriting(false);
              p.onBack();
            }}
          />
        </NotePanel>
      )}
      {p.tab === 'fuentes' && (
        <>
          <AiProblem error={sources.error} onSettings={p.onSettings} onRetry={() => void findSources()} />
          {sources.busy && <Thinking label={sources.busy} />}
          <SourcesPanel
            profileId={p.profileId}
            sources={data.sources}
            mode={nb.notebook.sourceMode}
            busy={sources.busy}
            hint={t('En lo que se apoya la lección. Las elige Claude y tú decides: quita, añade o fija las que quieras.')}
            onMode={(m) => api.patchNotebook(p.nbId, { sourceMode: m }).then(setNb, p.onError)}
            onAdd={(body) => api.nbAddSource(p.topicId, body).then(got, p.onError)}
            onPatch={(id, patch) => api.nbPatchSource(id, patch).then(() => reload(), p.onError)}
            onAuto={() => void findSources()}
            onOpenNote={p.onOpenNote}
            extra={
              topic.brief ? (
                <details className="nbv-brief">
                  <summary>{t('Apuntes que Claude ha sacado de las fuentes')}</summary>
                  <Md text={topic.brief} />
                </details>
              ) : null
            }
          />
        </>
      )}
      {p.tab === 'leccion' && (topic.lesson ? <Md text={topic.lesson} className="nbv-lesson" /> : <p className="tv-empty">{t('La página de la lección se escribe al terminar el tema, cuando guardas tu nota. Hasta entonces, está la sesión.')}</p>)}
      {p.tab === 'tarjetas' && <CardList cards={data.cards} onChange={() => void reload()} onError={p.onError} />}
    </div>
  );
}

function Session({ data, busy, error, onSay, onSettings, onWrite }: { data: NbTopicFull; busy: string | null; error: { message: string; code?: string } | null; onSay: (text?: string) => void; onSettings: () => void; onWrite: () => void }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const stage = data.topic.stage ?? 'entrada';
  const at = Math.max(0, TRAIL.findIndex((s) => s.stages.includes(stage)));
  useEffect(() => {
    // Sin devolver nada: en Chrome, scrollIntoView ya devuelve una promesa.
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [data.messages.length, busy]);
  const send = () => {
    const v = text.trim();
    if (!v || busy) return;
    setText('');
    onSay(v);
  };
  // Lo que se escribió y no tuvo respuesta (la IA falló): se reintenta sin volver a mandarlo.
  const last: NbMessage | undefined = data.messages[data.messages.length - 1];
  const unanswered = last?.role === 'yo';
  return (
    <div className="nbv-session">
      <aside className="nbv-trail" aria-label={t('Etapas')}>
        {TRAIL.map((s, i) => (
          <span key={s.id} className={`nbv-trail-step${i < at || data.topic.status === 'hecho' ? ' is-done' : i === at ? ' is-now' : ''}`}>
            <i aria-hidden="true">{i < at || data.topic.status === 'hecho' ? '✓' : i === at ? '●' : '○'}</i>
            {t(s.name)}
          </span>
        ))}
        {(data.topic.gaps.length > 0 || data.topic.solid.length > 0) && (
          <div className="nbv-trail-notes">
            {data.topic.gaps.length > 0 && <span className="nbv-label">{t('Huecos')}</span>}
            {data.topic.gaps.map((g) => (
              <span key={g} className="nbv-pill is-fallas">
                {g}
              </span>
            ))}
            {data.topic.solid.length > 0 && <span className="nbv-label">{t('Ya claro')}</span>}
            {data.topic.solid.map((g) => (
              <span key={g} className="nbv-pill is-dominado">
                {g}
              </span>
            ))}
          </div>
        )}
      </aside>
      <div className="nbv-chat">
        <div className="nbv-messages">
          {data.messages.map((m) => (
            <div key={m.id} className={`nbv-msg is-${m.role}`}>
              <span className="nbv-who">{m.role === 'tutor' ? 'Claude' : t('Tú')}</span>
              <Md text={m.body} />
            </div>
          ))}
          {busy && <Thinking label={busy} />}
          <AiProblem error={error} onSettings={onSettings} onRetry={() => onSay()} />
          {!busy && unanswered && !error && (
            <button className="btn btn-ghost btn-sm" onClick={() => onSay()}>
              {t('Pedir respuesta a Claude')}
            </button>
          )}
          <div ref={end} className="nbv-end" />
        </div>
        {(stage === 'nota' || stage === 'fin') && data.topic.status !== 'hecho' ? (
          <div className="nbv-callout">
            <span>{data.note ? t('Cuando acabes de escribir tu nota, pide a Claude que la revise.') : t('Ahora escribe tu nota con lo que has aprendido, sin mirar la sesión. Se abre al lado, y eliges dónde guardarla.')}</span>
            <button className="btn btn-primary btn-sm" onClick={onWrite}>
              {data.note ? t('Revisar mi nota') : t('Escribir mi nota')}
            </button>
          </div>
        ) : null}
        <div className="nbv-compose" onClick={(e) => e.currentTarget.querySelector('textarea')?.focus()}>
          <textarea
            className="nbv-compose-input"
            rows={1}
            value={text}
            placeholder={data.topic.status === 'hecho' ? t('Pregunta lo que quieras sobre el tema') : t('Responde…')}
            aria-label={t('Responder al tutor')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="nbv-compose-foot">
            <span className="nbv-compose-hint">{t('Intro para enviar, Mayús+Intro para otra línea. ¿Algo no te cuadra? Díselo: lo revisará con sus fuentes.')}</span>
            <button className="btn btn-primary btn-sm" onClick={send} disabled={!text.trim() || !!busy}>
              {t('Enviar')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type Where = { kind: 'cuaderno' } | { kind: 'raiz' } | { kind: 'nota'; id: string; title: string };

/** Dónde se guarda la nota: en la carpeta del cuaderno, arriba del todo o dentro de otra nota (con buscador). */
function WherePicker({ profileId, folder, value, onChange }: { profileId: string; folder: string; value: Where; onChange: (w: Where) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const v = q.trim();
    if (!v) {
      setHits([]);
      return;
    }
    const id = setTimeout(() => api.search(profileId, v).then((r) => setHits(r.slice(0, 8)), () => setHits([])), 180);
    return () => clearTimeout(id);
  }, [q, profileId]);
  return (
    <div className="nbv-where-pick">
      <div className="nbv-label">{t('¿Dónde la guardo?')}</div>
      <div className="nbv-where-opts" role="radiogroup" aria-label={t('¿Dónde la guardo?')}>
        <button role="radio" aria-checked={value.kind === 'cuaderno'} className={`nbv-chip${value.kind === 'cuaderno' ? ' is-on' : ''}`} onClick={() => onChange({ kind: 'cuaderno' })}>
          {t('En «{folder}»', { folder })}
        </button>
        <button role="radio" aria-checked={value.kind === 'raiz'} className={`nbv-chip${value.kind === 'raiz' ? ' is-on' : ''}`} onClick={() => onChange({ kind: 'raiz' })}>
          {t('Arriba del todo')}
        </button>
        {value.kind === 'nota' ? (
          <button role="radio" aria-checked className="nbv-chip is-on" onClick={() => setSearching(true)}>
            {t('Dentro de «{title}»', { title: value.title })}
          </button>
        ) : (
          <button role="radio" aria-checked={false} className={`nbv-chip${searching ? ' is-on' : ''}`} onClick={() => setSearching(true)}>
            {t('Dentro de otra nota…')}
          </button>
        )}
      </div>
      {searching && (
        <div className="nbv-where-search">
          <input className="field" autoFocus value={q} placeholder={t('Busca la nota donde guardarla')} aria-label={t('Busca la nota donde guardarla')} onChange={(e) => setQ(e.target.value)} />
          {hits.length > 0 && (
            <ul className="nbv-hits">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    onClick={() => {
                      onChange({ kind: 'nota', id: h.id, title: h.title || t('Sin título') });
                      setSearching(false);
                      setQ('');
                    }}
                  >
                    ¶ {h.title || t('Sin título')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Panel al lado de la sesión para escribir la nota (tapa la sesión: se escribe sin mirar). */
function NotePanel({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  // Fuera de la vista (que lleva una animación con transform): si no, «fixed» no cubre la pantalla.
  return createPortal(
    <div
      className="nbv-drawer-layer"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="nbv-drawer-back" onClick={onClose} />
      <aside className="nbv-drawer" role="dialog" aria-label={t('Tu nota')}>
        <header className="nbv-drawer-head">
          <span className="nbv-drawer-title">{t('Tu nota')}</span>
          <button className="nbv-icon" aria-label={t('Cerrar')} title={t('Cerrar')} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="nbv-drawer-body">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

function NoteWriter({ data, nb, profileId, onSaved, onOpenNote, onSettings, onError, onDone }: { data: NbTopicFull; nb: NbFull; profileId: string; onSaved: (d: NbTopicFull | null) => NbTopicFull | null; onOpenNote: (id: string) => void; onSettings: () => void; onError: (e: unknown) => void; onDone: () => void }) {
  const [title, setTitle] = useState(data.note?.title ?? data.topic.title);
  const [where, setWhere] = useState<Where>({ kind: 'cuaderno' });
  const ai = useAi();
  const review: NbReview | null | undefined = data.review;
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  useEffect(() => setChosen(new Set(review?.cards.map((_, i) => i) ?? [])), [review]);
  const [linked, setLinked] = useState<Set<string>>(new Set());

  // La nota se escribe en el editor de siempre: primero se crea vacía donde
  // diga la persona y se abre; luego Claude lee lo que haya escrito.
  const create = () =>
    ai
      .run(t('Creando tu nota…'), () => api.nbSaveNote(data.topic.id, { title: title.trim() || undefined, ...(where.kind === 'raiz' ? { parentId: null } : where.kind === 'nota' ? { parentId: where.id } : {}) }))
      .then((d) => {
        onSaved(d);
        if (d?.note) onOpenNote(d.note.id);
      });
  const review_ = () => ai.run(t('Claude está leyendo tu nota…'), () => api.nbSaveNote(data.topic.id, {})).then(onSaved);
  const finish = () => {
    const cards = review?.cards.filter((_, i) => chosen.has(i)) ?? [];
    api.nbAddCards(data.topic.id, cards, true).then((d) => {
      onSaved(d);
      onDone();
    }, onError);
  };
  const folder = nb.notebook.title;

  return (
    <div className="nbv-note">
      <p className="nbv-intro">{t('Escribe con tus palabras lo que has entendido, sin mirar la sesión. Recordarlo y explicarlo es lo que lo fija. Es una nota normal de tu biblioteca, con el editor de siempre. Claude no te la reescribe: te dice qué falta.')}</p>
      {data.note ? (
        <div className="nbv-note-card">
          <span className="nbv-note-card-icon" aria-hidden="true">
            ¶
          </span>
          <span className="nbv-note-card-text">
            <span className="nbv-note-card-title">{data.note.title}</span>
            <span className="nbv-hint">{t('Escríbela en el editor y, cuando acabes, pide a Claude que la revise.')}</span>
          </span>
          <span className="nbv-note-card-tools">
            <button className="btn btn-ghost btn-sm" onClick={() => onOpenNote(data.note!.id)}>
              {t('Abrir y escribir')}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void review_()} disabled={!!ai.busy}>
              {review ? t('Revisar otra vez') : t('Ya está: que Claude la revise')}
            </button>
          </span>
        </div>
      ) : (
        <>
          <WherePicker profileId={profileId} folder={folder} value={where} onChange={setWhere} />
          <label className="nbv-label" htmlFor="nb-note-title">
            {t('Título')}
          </label>
          <input id="nb-note-title" className="field nbv-input nbv-note-title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !ai.busy && void create()} />
          <div className="nbv-note-bar">
            <span />
            <button className="btn btn-primary btn-sm" onClick={() => void create()} disabled={!!ai.busy}>
              {t('Crear la nota y escribirla')}
            </button>
          </div>
        </>
      )}
      {ai.busy && <Thinking label={ai.busy} />}
      <AiProblem error={ai.error ?? (data.reviewError ? { message: data.reviewError } : null)} onSettings={onSettings} onRetry={() => void (data.note ? review_() : create())} />

      {review && (
        <div className="nbv-review-note">
          <div className="nbv-label">{t('Ideas del tema en tu nota')}</div>
          <ul className="nbv-check">
            {review.covered.map((c) => (
              <li key={c.idea} className={c.ok ? 'is-ok' : 'is-miss'}>
                {c.idea}
              </li>
            ))}
          </ul>
          {review.question && (
            <div className="nbv-callout is-question">
              <span className="nbv-who">Claude</span>
              <Md text={review.question} />
            </div>
          )}
          {review.links.length > 0 && (
            <div className="nbv-links">
              <span className="nbv-label">{t('Conecta con')}</span>
              {review.links.map((l) =>
                l.id ? (
                  <button
                    key={l.title}
                    className={`nbv-chip${linked.has(l.id) ? ' is-on' : ''}`}
                    disabled={linked.has(l.id)}
                    onClick={() =>
                      api.nbLink(data.topic.id, l.id!).then((d) => {
                        setLinked((s) => new Set(s).add(l.id!));
                        onSaved(d);
                      }, onError)
                    }
                  >
                    {linked.has(l.id) ? '✓ ' : '+ '}[[{l.title}]]
                  </button>
                ) : null,
              )}
            </div>
          )}
          {review.cards.length > 0 && (
            <>
              <div className="nbv-label">{t('Tarjetas para el repaso')}</div>
              <ul className="nbv-proposed">
                {review.cards.map((c, i) => (
                  <li key={i}>
                    <label>
                      <input type="checkbox" checked={chosen.has(i)} onChange={() => setChosen((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set(s).add(i)))} />
                      <span>
                        <span className="nbv-pill">{t(KIND[c.kind] ?? 'Dato')}</span> {c.front}
                        <span className="nbv-proposed-a">{c.back}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div>
            <button className="btn btn-primary" onClick={finish}>
              {chosen.size ? tn(chosen.size, 'Guardar {n} tarjeta y terminar el tema', 'Guardar {n} tarjetas y terminar el tema') : t('Terminar el tema')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CardList({ cards, onChange, onError }: { cards: NbCard[]; onChange: () => void; onError: (e: unknown) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  if (!cards.length) return <p className="tv-empty">{t('Las tarjetas salen de los huecos de la sesión cuando guardas tu nota.')}</p>;
  return (
    <ul className="nbv-cards">
      {cards.map((c) =>
        editing === c.id ? (
          <li key={c.id} className="nbv-card-row is-editing">
            <textarea className="field" rows={2} value={front} aria-label={t('Pregunta')} onChange={(e) => setFront(e.target.value)} />
            <textarea className="field" rows={2} value={back} aria-label={t('Respuesta')} onChange={(e) => setBack(e.target.value)} />
            <span className="nbv-card-tools">
              <button
                className="btn btn-primary btn-sm"
                onClick={() =>
                  api.nbPatchCard(c.id, { front, back }).then(() => {
                    setEditing(null);
                    onChange();
                  }, onError)
                }
              >
                {t('Guardar')}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                {t('Cancelar')}
              </button>
            </span>
          </li>
        ) : (
          <li key={c.id} className="nbv-card-row">
            <span className="nbv-pill">{t(KIND[c.kind] ?? 'Dato')}</span>
            <span className="nbv-card-text">
              <span>{c.front}</span>
              <span className="nbv-proposed-a">{c.back}</span>
            </span>
            <span className="nbv-card-when">{c.reps ? t('Vuelve en {when}', { when: whenText(c.due) }) : t('Nueva')}</span>
            <span className="nbv-card-tools">
              <button
                className="nbv-icon"
                aria-label={t('Editar')}
                title={t('Editar')}
                onClick={() => {
                  setEditing(c.id);
                  setFront(c.front);
                  setBack(c.back);
                }}
              >
                ✎
              </button>
              <button className="nbv-icon" aria-label={t('Borrar')} title={t('Borrar')} onClick={() => window.confirm(t('¿Borrar esta tarjeta?')) && api.nbDeleteCard(c.id).then(onChange, onError)}>
                ×
              </button>
            </span>
          </li>
        ),
      )}
    </ul>
  );
}
