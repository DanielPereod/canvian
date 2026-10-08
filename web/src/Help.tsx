import { useEffect } from 'react';
import { ACTIONS, FIXED, comboOf, matches, useKeymap, useView, type Ctx, type View } from './keys';
import { Keys } from './Kbd';
import { t } from './i18n';

const PLACE: Record<Ctx, string> = { list: 'Notas y nodos', note: 'Nota abierta', tasks: 'Tareas', global: 'En todas partes' };

// La lista de atajos, en un panel que se abre con «?» (o lo que elijas).
// Primero lo que sirve donde estás, luego lo de siempre y luego el resto.
export function Help({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const keymap = useKeymap();
  const view = useView();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  const shown = ACTIONS.filter((a) => keymap[a.id]);

  return (
    <div className="overlay" onMouseDown={onClose} data-keys-modal>
      <div className="surface-3 popover help" role="dialog" aria-label={t('Atajos de teclado')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span className="label">{t('Atajos')}</span>
          <button className="sheet-back meta" onClick={onSettings}>
            {t('Cambiarlos')}
          </button>
        </div>
        <div className="help-cols">
          {order.map((c, i) => {
            const acts = shown.filter((a) => home(a.ctx) === c);
            const fixed = FIXED.filter((f) => f.ctx === c);
            if (!acts.length && !fixed.length) return null;
            return (
              <section key={c}>
                <h3 className="settings-subheading">{i === 0 ? t('Aquí · {place}', { place: t(PLACE[c]) }) : t(PLACE[c])}</h3>
                {acts.map((a) => (
                  <div key={a.id} className="help-row">
                    <Keys combo={keymap[a.id]} />
                    <span>{a.label}</span>
                  </div>
                ))}
                {fixed.map((f) => (
                  <div key={f.label} className="help-row">
                    <span className="keys">
                      {f.keys.map((k) => (
                        <Keys key={k} combo={k} />
                      ))}
                    </span>
                    <span>{f.label}</span>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
