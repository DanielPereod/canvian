import { useRef, useState } from 'react';
import { t } from '../i18n';

// Nombre de una sección: aparece bajo las migas al crearla o renombrarla.
// Enter guarda, Esc deja el nombre como estaba.
export function SectionName({ initial, onDone }: { initial: string; onDone: (title: string) => void }) {
  const [title, setTitle] = useState(initial);
  const done = useRef(false);
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <div className="section-name surface-3">
      <input
        className="field field-bare"
        autoFocus
        value={title}
        placeholder={t('Nombre de la nota')}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(title);
          else if (e.key === 'Escape') finish(initial);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onBlur={() => finish(title)}
      />
      <span className="meta">{t('Enter para guardar · Esc para dejarlo')}</span>
    </div>
  );
}
