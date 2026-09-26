import { useEffect } from 'react';
import { useStore } from '@xyflow/react';
import { useExperiments } from '../lab/experiments';

export const CONSTELLATION_ZOOM = 0.45;
// Más lejos aún, solo se leen los nombres de las notas con más enlaces.
const DEEP_ZOOM = 0.24;

// Publica el zoom como variable CSS y activa el modo constelación al alejarte.
// Toca el DOM directamente para no volver a pintar el canvas en cada paso del zoom.
export function Constellation() {
  const zoom = useStore((s) => s.transform[2]);
  const { constelacion } = useExperiments();
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.canvas');
    if (!el) return;
    el.style.setProperty('--zoom', String(zoom));
    el.classList.toggle('constellation', constelacion && zoom < CONSTELLATION_ZOOM);
    el.classList.toggle('deep', constelacion && zoom < DEEP_ZOOM);
  }, [zoom, constelacion]);
  return null;
}
