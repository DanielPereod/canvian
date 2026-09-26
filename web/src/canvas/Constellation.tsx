import { useEffect } from 'react';
import { useStore } from '@xyflow/react';
import { useExperiments } from '../lab/experiments';

export const CONSTELLATION_ZOOM = 0.45;
// Más lejos aún, solo se leen los nombres de las notas con más enlaces.
const DEEP_ZOOM = 0.24;
// Zoom semántico: por debajo de esto las notas muestran solo su título, más grande.
export const TITLES_ZOOM = 0.7;

// Publica el zoom como variable CSS y activa el zoom semántico y el modo
// constelación al alejarte.
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
    el.classList.toggle('titles', zoom < TITLES_ZOOM);
  }, [zoom, constelacion]);
  return null;
}
