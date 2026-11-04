import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type NoteRow, type Share, type ShareScope } from '../api';
import { copyRich } from './NoteMenu';
import { locale, t, tn } from '../i18n';

// Compartir una nota por un enlace, como «Publicar en la web» de Notion: quien
// lo tenga la lee sin entrar en Canvian. Se le puede poner contraseña. Si la
// nota tiene hijas, se elige qué se ve con ella: solo esta nota, todas sus
// hijas (también las que se creen después) o solo las que se marquen.

type Props = {
  note: NoteRow;
  rows: NoteRow[];
  share: Share | null;
  onChange: (share: Share | null) => void;
  onNotice?: (text: string) => void;
  onError: (e: unknown) => void;
  onClose: () => void;
};

type Kid = { row: NoteRow; depth: number; parent: string };

const titleOf = (r: NoteRow) => r.title?.trim() || (r.kind === 'canvas' ? t('Canvas sin título') : t('Nota sin título'));

export function ShareDialog({ note, rows, share, onChange, onNotice, onError, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState(location.origin);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Con la dirección pública, si se puso (Configuración › Asistentes IA): la de
  // casa (192.168…) no sirve fuera.
  useEffect(() => {
    api
      .mcpStatus()
      .then((s) => s.publicUrl && setBase(s.publicUrl))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Todo lo que cuelga de ella, en orden de árbol (madres primero, por nombre).
  const kids = useMemo(() => {
    const live = rows.filter((r) => !r.archivedAt);
    const by = new Map<string, NoteRow[]>();
    for (const r of live) if (r.zoneId) by.set(r.zoneId, [...(by.get(r.zoneId) ?? []), r]);
    const out: Kid[] = [];
    const walk = (id: string, depth: number) => {
      const list = (by.get(id) ?? []).sort((a, b) => titleOf(a).localeCompare(titleOf(b), locale(), { numeric: true }));
      for (const r of list) {
        if (out.length > 2000) return;
        out.push({ row: r, depth, parent: id });
        walk(r.id, depth + 1);
      }
    };
    walk(note.id, 0);
    return out;
  }, [rows, note.id]);
  const direct = kids.filter((k) => k.depth === 0).length;

  // Lo elegido se ve al momento; si el servidor no lo guarda, vuelve lo de antes.
  const seq = useRef(0);
  const save = async (body: { scope: ShareScope; childIds: string[]; password?: string | null }) => {
    const n = ++seq.current;
    const before = share;
    if (share) onChange({ ...share, scope: body.scope, childIds: body.childIds });
    const pw = body.password !== undefined || !share;
    if (pw) setBusy(true);
    try {
      const next = await api.saveShare(note.id, body);
      if (n === seq.current) onChange(next);
      return next;
    } catch (e) {
      if (n === seq.current) onChange(before);
      onError(e);
      return null;
    } finally {
      if (pw) setBusy(false);
    }
  };

  const turn = async (on: boolean) => {
    if (on) {
      const next = await save({ scope: 'note', childIds: [] });
      if (next) copy(next);
      return;
    }
    setBusy(true);
    try {
      await api.deleteShare(note.id);
      onChange(null);
      setAsking(false);
      setPassword('');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const url = share ? `${base}/p/${share.id}` : '';
  const copy = (s: Share) => {
    copyRich(`${base}/p/${s.id}`);
    onNotice?.(t('Enlace copiado'));
  };

  const setScope = (scope: ShareScope) => {
    if (!share || scope === share.scope) return;
    // Al pasar a elegir, empiezan marcadas sus hijas directas.
    const childIds = scope === 'some' ? (share.childIds.length ? share.childIds : kids.filter((k) => k.depth === 0).map((k) => k.row.id)) : [];
    void save({ scope, childIds });
  };

  const picked = useMemo(() => new Set(share?.childIds ?? []), [share]);
  const parentOf = useMemo(() => new Map(kids.map((k) => [k.row.id, k.parent])), [kids]);
  const flip = (id: string) => {
    if (!share) return;
    const next = new Set(picked);
    if (next.has(id)) {
      // Quitar una quita también lo que cuelga de ella.
      const drop = new Set([id]);
      for (const k of kids) if (drop.has(k.parent)) drop.add(k.row.id);
      for (const d of drop) next.delete(d);
    } else {
      // Marcar una marca también sus madres, que si no no se llega a ella.
      for (let at: string | undefined = id; at && at !== note.id; at = parentOf.get(at)) next.add(at);
    }
    void save({ scope: 'some', childIds: kids.map((k) => k.row.id).filter((k) => next.has(k)) });
  };
  const pickAll = (on: boolean) => share && void save({ scope: 'some', childIds: on ? kids.map((k) => k.row.id) : [] });

  const setPw = async (e: FormEvent) => {
    e.preventDefault();
    if (!share) return;
    if (password.length < 4) return setPwError(t('Al menos 4 caracteres'));
    setPwError(null);
    const next = await save({ scope: share.scope, childIds: share.childIds, password });
    if (next) {
      setPassword('');
      setAsking(false);
      onNotice?.(share.hasPassword ? t('Contraseña cambiada') : t('Ahora pide contraseña'));
    }
  };
  const dropPw = () => {
    if (!share) return;
    setAsking(false);
    setPassword('');
    setPwError(null);
    if (share.hasPassword) void save({ scope: share.scope, childIds: share.childIds, password: null });
  };
  const wantsPw = !!share && (share.hasPassword || asking);
  const shownCount = !share ? 0 : share.scope === 'all' ? kids.length : share.scope === 'some' ? share.childIds.length : 0;

  const local = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/]*\.local(:|\/|$))/.test(base);

  // En el cuerpo de la página: dentro de la hoja quedaría debajo de la barra de arriba.
  return createPortal(
    <div className="overlay share-overlay" onMouseDown={onClose}>
      <div ref={box} className="surface-3 dialog share-dlg" role="dialog" aria-modal="true" aria-labelledby="share-h" onMouseDown={(e) => e.stopPropagation()}>
        <div className="share-head">
          <h2 id="share-h" className="share-h">
            {t('Compartir')}
          </h2>
          <button className="share-x" onClick={onClose} aria-label={t('Cerrar')}>
            ×
          </button>
        </div>
        <p className="share-name">{titleOf(note)}</p>

        <button className="share-row" role="switch" aria-checked={!!share} disabled={busy} onClick={() => void turn(!share)}>
          <span className="share-row-text">
            <span className="share-row-h">{t('Pública en la web')}</span>
            <span className="share-hint">{share ? t('Cualquiera con el enlace puede leerla, sin poder cambiar nada.') : t('Crea un enlace para que otros la lean sin entrar en Canvian.')}</span>
          </span>
          <span className="switch" aria-hidden="true" />
        </button>

        {share && (
          <>
            <div className="share-link">
              <input className="field share-url" readOnly value={url} aria-label={t('Enlace de la nota')} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn btn-primary btn-sm" onClick={() => copy(share)}>
                {t('Copiar')}
              </button>
              <a className="btn btn-ghost btn-sm" href={url} target="_blank" rel="noopener noreferrer">
                {t('Abrir')}
              </a>
            </div>
            {/* Los bloques ```db``` enseñan datos de las tablas a quien tenga el enlace. */}
            {[note, ...kids.map((k) => k.row).filter((r) => share.scope === 'all' || (share.scope === 'some' && share.childIds.includes(r.id)))].some((r) => r.bodyJson?.includes('"dbQuery"')) && (
              <p className="share-hint share-warn">{t('Esta nota consulta tus bases de datos: quien tenga el enlace verá el resultado de esas consultas (y solo de esas).')}</p>
            )}
            {local && <p className="share-hint share-warn">{t('Esta dirección solo funciona en tu red. Para compartir fuera, pon tu dirección pública (https://…) en Configuración › Asistentes IA.')}</p>}

            <div className="share-sep" />

            <button className="share-row" role="switch" aria-checked={wantsPw} disabled={busy} onClick={() => (wantsPw ? dropPw() : setAsking(true))}>
              <span className="share-row-text">
                <span className="share-row-h">{t('Pedir contraseña')}</span>
                <span className="share-hint">{share.hasPassword ? t('Hay que escribirla antes de ver la nota.') : t('Sin ella, basta con el enlace.')}</span>
              </span>
              <span className="switch" aria-hidden="true" />
            </button>
            {wantsPw && (
              <form className="share-pw" onSubmit={setPw}>
                <input
                  className="field"
                  type="password"
                  autoFocus={asking}
                  autoComplete="new-password"
                  placeholder={share.hasPassword ? t('Escribe otra para cambiarla') : t('Contraseña (al menos 4 caracteres)')}
                  aria-label={t('Contraseña de la nota')}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPwError(null);
                  }}
                />
                <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !password}>
                  {share.hasPassword ? t('Cambiar') : t('Poner')}
                </button>
                {pwError && <p className="share-hint share-err">{pwError}</p>}
              </form>
            )}

            {kids.length > 0 && (
              <>
                <div className="share-sep" />
                <div className="share-kids-h">
                  <span className="share-row-h">{t('Notas de dentro')}</span>
                  <span className="share-hint">{tn(direct, 'Tiene {n} hija', 'Tiene {n} hijas')}{kids.length > direct ? ` · ${tn(kids.length, '{n} en total', '{n} en total')}` : ''}</span>
                </div>
                <div className="set-segmented share-scope" role="radiogroup" aria-label={t('Qué notas de dentro se comparten')}>
                  {(
                    [
                      ['note', t('Solo esta')],
                      ['all', t('Todas')],
                      ['some', t('Elegir')],
                    ] as const
                  ).map(([id, name]) => (
                    <button key={id} role="radio" aria-checked={share.scope === id} className={share.scope === id ? 'is-on' : ''} disabled={busy} onClick={() => setScope(id)}>
                      {name}
                    </button>
                  ))}
                </div>
                <p className="share-hint">
                  {share.scope === 'note'
                    ? t('Solo se ve esta nota; lo que tiene dentro sigue siendo privado.')
                    : share.scope === 'all'
                      ? t('Se ve con todo lo que tiene dentro, también lo que añadas después.')
                      : t('Se ven solo las que marques ({n}).', { n: shownCount })}
                </p>
                {share.scope === 'some' && (
                  <>
                    <div className="share-pick-tools">
                      <button onClick={() => pickAll(true)} disabled={busy}>
                        {t('Marcar todas')}
                      </button>
                      <button onClick={() => pickAll(false)} disabled={busy}>
                        {t('Ninguna')}
                      </button>
                    </div>
                    <ul className="share-pick" aria-label={t('Notas de dentro')}>
                      {kids.map((k) => (
                        <li key={k.row.id}>
                          <label className="share-pick-it" style={{ '--depth': k.depth } as CSSProperties}>
                            <input type="checkbox" checked={picked.has(k.row.id)} disabled={busy} onChange={() => flip(k.row.id)} />
                            <span className="share-pick-t">{titleOf(k.row)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
