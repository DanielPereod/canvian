import type { BackgroundKind } from '../api';

export const BACKGROUNDS: { id: BackgroundKind; name: string; hint: string }[] = [
  { id: 'plain', name: 'Liso', hint: 'Solo la noche y su luz' },
  { id: 'dots', name: 'Puntos', hint: 'Retícula que se mueve con el lienzo' },
  { id: 'grid', name: 'Cuadrícula', hint: 'Líneas finas para ordenar' },
  { id: 'stars', name: 'Estrellas', hint: 'Cielo con profundidad al moverte' },
  { id: 'fireflies', name: 'Luciérnagas', hint: 'Luces que flotan despacio' },
  { id: 'aurora', name: 'Aurora', hint: 'Velos de color que respiran' },
];
