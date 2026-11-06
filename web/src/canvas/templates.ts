import type { JSONContent } from '@tiptap/react';
import { markdownToDoc } from './markdown';
import { joinTitle, titleBlock } from './editor';
import { t } from '../i18n';
import { contentOf } from './tasks';

// Plantillas para empezar una nota con su forma ya puesta, como en Notion.
// Se escriben en Markdown (con las casillas y fechas de las tareas) y el
// título lleva la fecha de hoy cuando tiene sentido.

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inDays = (n: number) => iso(new Date(Date.now() + n * 864e5));
const today = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long' });

export type Template = { id: string; name: string; icon: string; title: () => string; body: () => string };

export const TEMPLATES: Template[] = [
  {
    id: 'meeting',
    name: 'Reunión',
    icon: 'people',
    title: () => `${t('Reunión')} · ${today()}`,
    body: () =>
      [`## ${t('Asistentes')}`, '- ', '', `## ${t('Temas')}`, '1. ', '', `## ${t('Acuerdos')}`, '- ', '', `## ${t('Próximos pasos')}`, `- [ ] 📅 ${inDays(7)}`].join('\n'),
  },
  {
    id: 'project',
    name: 'Proyecto',
    icon: 'flag',
    title: () => t('Proyecto nuevo'),
    body: () =>
      [
        `**${t('Objetivo')}:** ${t('Qué quieres conseguir y para cuándo.')}`,
        '',
        `## ${t('Tareas')}`,
        `- [ ] ${t('Primer paso')} ⏫ 📅 ${inDays(3)}`,
        `- [ ] ${t('Segundo paso')} 📅 ${inDays(10)}`,
        '',
        `## ${t('Notas')}`,
        '',
      ].join('\n'),
  },
  {
    id: 'weekly',
    name: 'Plan de la semana',
    icon: 'diary',
    title: () => `${t('Semana del {fecha}', { fecha: today() })}`,
    body: () =>
      [`## ${t('Lo importante')}`, '- [ ] ⏫', '', `## ${t('Por hacer')}`, '- [ ] ', '', `## ${t('Para el finde')}`, '- [ ] '].join('\n'),
  },
  {
    id: 'reading',
    name: 'Notas de lectura',
    icon: 'book',
    title: () => t('Libro'),
    body: () =>
      [`**${t('Autor')}:** `, '', `## ${t('Ideas principales')}`, '- ', '', `## ${t('Citas')}`, '> ', '', `## ${t('Qué me llevo')}`, ''].join('\n'),
  },
];

/** El contenido de una nota nueva hecha con la plantilla. */
export function fromTemplate(tpl: Template) {
  const body = markdownToDoc(tpl.body(), false).doc as JSONContent;
  return contentOf(joinTitle(titleBlock(tpl.title(), null), body));
}
