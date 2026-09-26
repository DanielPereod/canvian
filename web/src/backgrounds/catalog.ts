import type { BackgroundKind } from '../api';

export const BACKGROUNDS: { id: BackgroundKind; name: string; hint: string }[] = [
  { id: 'plain', name: 'Liso', hint: 'Solo la noche y su luz' },
  { id: 'stars', name: 'Estrellas', hint: 'Cielo que deriva despacio' },
  { id: 'fireflies', name: 'Luciérnagas', hint: 'Luces que flotan despacio' },
  { id: 'aurora', name: 'Aurora', hint: 'Velos de color que respiran' },
];
