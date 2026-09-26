import { useEffect, useRef } from 'react';
import { useStore } from '@xyflow/react';
import { useExperiments } from '../lab/experiments';

export const CONSTELLATION_ZOOM = 0.45;
// Más lejos aún, solo se leen los nombres de las notas con más enlaces.
export const DEEP_ZOOM = 0.24;
// Zoom semántico: por debajo de esto las notas muestran solo su título, más grande.
export const TITLES_ZOOM = 0.7;

// En modo constelación los títulos de zona mantienen su tamaño en pantalla. La
// regla se declara sobre ellos (y no como variable en .canvas, que obligaría a
// recalcular el estilo de todo el lienzo en cada paso del zoom). Las clases del
// zoom las pone Canvas y las estrellas las dibuja StarLayer.
export function Constellation() {
  const zoom = useStore((s) => s.transform[2]);
  const { constelacion } = useExperiments();
  const sheet = useRef<HTMLStyleElement | null>(null);
  useEffect(() => {
    const el = document.createElement('style');
    document.head.appendChild(el);
    sheet.current = el;
    return () => el.remove();
  }, []);
  useEffect(() => {
    if (!constelacion || zoom >= CONSTELLATION_ZOOM || !sheet.current) return;
    const rule = `.constellation .zone-title { font-size: ${(18 / zoom).toFixed(1)}px; }`;
    if (sheet.current.textContent !== rule) sheet.current.textContent = rule;
  }, [zoom, constelacion]);
  return null;
}
