import type { BackgroundKind } from '../api';
import { Fireflies } from '../Fireflies';
import { StarField } from './StarField';

// Capa ambiental detrás del lienzo. Puntos y cuadrícula no van aquí: se
// dibujan dentro del canvas para moverse con él.
export function Ambient({ kind }: { kind: BackgroundKind }) {
  return (
    <div key={kind} className="ambient-layer">
      {kind === 'stars' && <StarField />}
      {kind === 'fireflies' && <Fireflies count={28} />}
      {kind === 'aurora' && (
        <div className="ambient aurora" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
