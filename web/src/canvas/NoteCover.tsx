import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useContextMenu } from './Biblioteca';
import { GRADIENTS, imageCover, okImageUrl, parseCover } from './cover';
import { t } from '../i18n';

type Props = {
  cover: string | null | undefined;
  onChange: (cover: string | null) => void;
  onError: (e: unknown) => void;
};

// La portada arriba de la nota, a todo el ancho. Al pasar por encima salen sus
// botones: cambiarla, moverla (si es una imagen) y quitarla.
export function NoteCover({ cover, onChange, onError }: Props) {
  const c = parseCover(cover);
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null);
  // Recolocando: la altura que se ve mientras se arrastra, aún sin guardar.
  const [moving, setMoving] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => setMoving(null), [cover]);

  if (!c) return null;

  const upload = (f: File | undefined) => {
    if (!f) return;
    if (!/^image\//.test(f.type) || f.type === 'image/svg+xml') return onError(new Error(t('La portada tiene que ser una imagen')));
    setUploading(true);
    api
      .uploadMedia(f)
      .then(({ url }) => onChange(imageCover(url)))
      .catch(onError)
      .finally(() => setUploading(false));
  };

  // Arrastrar hacia abajo enseña más de arriba de la imagen, como en Notion.
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = img.current;
    if (moving === null || !el || e.button !== 0) return;
    e.preventDefault();
    const box = el.getBoundingClientRect();
    const spare = el.naturalWidth ? (box.width * el.naturalHeight) / el.naturalWidth - box.height : 0;
    if (spare <= 0) return;
    const from = e.clientY;
    const start = moving;
    const move = (ev: PointerEvent) => setMoving(Math.min(100, Math.max(0, start - ((ev.clientY - from) / spare) * 100)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const y = moving ?? (c.kind === 'image' ? c.y : 50);
  return (
    <div className={`note-cover${moving !== null ? ' is-moving' : ''}`} onPointerDown={drag}>
      {c.kind === 'image' ? (
        <img ref={img} src={c.src} alt="" draggable={false} style={{ objectPosition: `50% ${y}%` }} />
      ) : (
        <div className="note-cover-fill" style={{ background: c.css }} />
      )}
      {moving !== null && <span className="note-cover-hint">{t('Arrastra la imagen para colocarla')}</span>}
      <div className="note-cover-tools">
        {moving !== null && c.kind === 'image' ? (
          <>
            <button onClick={() => onChange(imageCover(c.src, moving))}>{t('Guardar posición')}</button>
            <button onClick={() => setMoving(null)}>{t('Cancelar')}</button>
          </>
        ) : (
          <>
            <button
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setPick({ x: box.right - 320, y: box.bottom + 6 });
              }}
              aria-haspopup="menu"
            >
              {uploading ? t('Subiendo…') : t('Cambiar portada')}
            </button>
            {c.kind === 'image' && <button onClick={() => setMoving(c.y)}>{t('Recolocar')}</button>}
            <button onClick={() => onChange(null)}>{t('Quitar')}</button>
          </>
        )}
      </div>
      {/* Fuera del menú: al abrir el selector de archivos la ventana pierde el foco y el menú se cierra. */}
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        hidden
        onChange={(e) => {
          upload(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {pick &&
        createPortal(
        <CoverPicker
          x={pick.x}
          y={pick.y}
          current={cover ?? null}
          onPick={(v) => {
            setPick(null);
            onChange(v);
          }}
          onUpload={() => {
            setPick(null);
            file.current?.click();
          }}
          onClose={() => setPick(null)}
        />,
        document.body,
      )}
    </div>
  );
}

function CoverPicker({ x, y, current, onPick, onUpload, onClose }: { x: number; y: number; current: string | null; onPick: (v: string) => void; onUpload: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const spot = useContextMenu(ref, x, y, onClose);
  const [url, setUrl] = useState('');
  const ok = okImageUrl(url);
  return (
    <div className="bib-menu cover-pick" ref={ref} role="menu" aria-label={t('Portada')} style={{ left: spot.x, top: spot.y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="bib-menu-head">{t('Colores')}</div>
      <div className="cover-pick-grid">
        {GRADIENTS.map((g) => (
          <button
            key={g.id}
            className={`cover-pick-swatch${current === `grad:${g.id}` ? ' is-on' : ''}`}
            style={{ background: g.css }}
            onClick={() => onPick(`grad:${g.id}`)}
            aria-label={g.id}
            title={g.id}
          />
        ))}
      </div>
      <div className="bib-menu-sep" />
      <button className="bib-menu-it" onClick={onUpload}>
        {t('Subir una imagen…')}
      </button>
      <form
        className="cover-pick-url"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onPick(imageCover(url.trim()));
        }}
      >
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t('O pega el enlace de una imagen')} aria-label={t('Enlace de la imagen')} />
        <button type="submit" className="cover-pick-go" disabled={!ok}>
          {t('Usar')}
        </button>
      </form>
    </div>
  );
}
