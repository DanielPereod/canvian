import { EN_APP } from './en/app';
import { EN_CANVAS } from './en/canvas';
import { EN_EDITOR } from './en/editor';
import { EN_LIBRARY } from './en/library';
import { EN_NOTE } from './en/note';
import { EN_TASKS } from './en/tasks';

// Inglés. Cada parte de la app tiene su diccionario; aquí se juntan.
export const EN: Record<string, string> = { ...EN_APP, ...EN_CANVAS, ...EN_EDITOR, ...EN_LIBRARY, ...EN_NOTE, ...EN_TASKS };
