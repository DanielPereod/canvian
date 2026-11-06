import { useEffect, useState } from 'react';
import { ACTIONS, FIXED, comboOf, matches, useKeymap, useView, type Ctx, type View } from './keys';
import { Keys } from './Kbd';
import { t } from './i18n';

const PLACE: Record<Ctx, string> = { list: 'Notas y nodos', note: 'Nota abierta', tasks: 'Tareas', global: 'En todas partes' };

// La lista de atajos, en un panel que se abre con «?» (o lo que elijas).
// Primero lo que sirve donde estás, luego lo de siempre y luego el resto.
export function Help({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const keymap = useKeymap();
  const view = useView();
  // Como en Linear: se escribe y quedan solo los atajos que lo dicen.
  const [q, setQ] = useState('');
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const fits = (label: string) => !q.trim() || norm(label).includes(norm(q.trim())) || norm(t(label)).includes(norm(q.trim()));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Mientras se escribe en el buscador, «?» es una letra más.
      const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT' && e.key !== 'Escape' && comboOf(e) !== 'mod+h';
      if (typing) return;
      if (e.key === 'Escape' || matches(e, 'help') || comboOf(e) === 'mod+h') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const others = (['list', 'note', 'tasks'] as View[]).filter((v) => v !== view);
  const order: Ctx[] = [view, 'global', ...others];
  // Cada comando sale una vez: en la primera sección donde sirve.
  const home = (ctx: Ctx[]) => order.find((c) => ctx.includes(c))!;
  const shown = ACTIONS.filter((a) => keymap[a.id] && fits(a.label));
  let found = 0;

  return (
    <div className="overlay" onMouseDown={onClose} data-keys-modal>
      <div className="surface-3 popover help" role="dialog" aria-label={t('Atajos de teclado')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <h2 className="help-title">{t('Atajos de teclado')}</h2>
          <button className="sheet-back meta" onClick={onSettings}>
            {t('Cambiarlos')}
          </button>
        </div>
        <input
          className="field help-search"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('Buscar un atajo…')}
          aria-label={t('Buscar un atajo…')}
        />
        <div className="help-cols">
          {order.map((c, i) => {
            const acts = shown.filter((a) => home(a.ctx) === c);
            const fixed = FIXED.filter((f) => f.ctx === c && fits(f.label));
            if (!acts.length && !fixed.length) return null;
            found += acts.length + fixed.length;
            return (
              <section key={c}>
                <h3 className="settings-subheading">{i === 0 ? t('Aquí · {place}', { place: t(PLACE[c]) }) : t(PLACE[c])}</h3>
                {acts.map((a) => (
                  <div key={a.id} className="help-row">
                    <span>{a.label}</span>
                    <Keys combo={keymap[a.id]} />
                  </div>
                ))}
                {fixed.map((f) => (
                  <div key={f.label} className="help-row">
                    <span>{f.label}</span>
                    <span className="keys">
                      {f.keys.map((k) => (
                        <Keys key={k} combo={k} />
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            );
          })}
          {!found && <p className="meta help-none">{t('Ningún atajo dice «{q}»', { q: q.trim() })}</p>}
        </div>
      </div>
    </div>
  );
}
