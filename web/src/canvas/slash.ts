import { Extension } from '@tiptap/react';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';

// El menú «/», como en Notion: al escribir «/» al principio de una línea (o
// tras un espacio) sale la lista de bloques, y lo que se escribe después la
// filtra. Esc lo cierra hasta el siguiente «/».

export type SlashQuery = { from: number; to: number; query: string; left: number; top: number; bottom: number };

type SlashState = { dismissed: number | null };
const slashKey = new PluginKey<SlashState>('slash');

function findQuery(state: EditorState): { from: number; to: number; query: string } | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$from;
  if ($pos.parent.type.spec.code || !$pos.parent.isTextblock) return null;
  const before = $pos.parent.textBetween(Math.max(0, $pos.parentOffset - 40), $pos.parentOffset, undefined, '￼');
  // Hasta un par de palabras («/enc 2»); con dos espacios seguidos ya no.
  const m = /(?:^|\s)\/((?:[^\s/￼]+ ?){0,3})$/.exec(before);
  if (!m || /\s\s/.test(m[1])) return null;
  return { from: $pos.pos - m[1].length - 1, to: $pos.pos, query: m[1] };
}

export type SlashOptions = {
  onChange: (q: SlashQuery | null) => void;
  // Flechas, Enter y Tab mientras la lista está abierta. true si los usó.
  onKey: (e: KeyboardEvent) => boolean;
};

export const SlashSuggest = Extension.create<SlashOptions>({
  name: 'slashSuggest',
  priority: 1000,
  addOptions: () => ({ onChange: () => {}, onKey: () => false }),
  addProseMirrorPlugins() {
    const options = this.options;
    const active = (state: EditorState) => {
      const hit = findQuery(state);
      return hit && hit.from !== slashKey.getState(state)?.dismissed ? hit : null;
    };
    let last = '';
    return [
      new Plugin<SlashState>({
        key: slashKey,
        state: {
          init: () => ({ dismissed: null }),
          apply: (tr, v) => {
            const meta = tr.getMeta(slashKey) as SlashState | undefined;
            if (meta) return meta;
            return v.dismissed === null || !tr.docChanged ? v : { dismissed: tr.mapping.map(v.dismissed) };
          },
        },
        view: () => ({
          update: (view) => {
            const hit = view.hasFocus() || last ? active(view.state) : null;
            const key = hit ? `${hit.from}:${hit.query}` : '';
            if (key === last) return;
            last = key;
            if (!hit) return options.onChange(null);
            const at = view.coordsAtPos(hit.from);
            options.onChange({ ...hit, left: at.left, top: at.top, bottom: at.bottom });
          },
          destroy: () => {
            if (last) options.onChange(null);
          },
        }),
        props: {
          handleKeyDown: (view, event) => {
            const hit = active(view.state);
            if (!hit) return false;
            if (event.key === 'Escape') {
              view.dispatch(view.state.tr.setMeta(slashKey, { dismissed: hit.from }));
              return true;
            }
            return options.onKey(event);
          },
        },
      }),
    ];
  },
});

// Cierra el menú abierto sin tocar el texto (al pulsar fuera, por ejemplo).
export const dismissSlash = (state: EditorState) => {
  const hit = findQuery(state);
  return hit ? state.tr.setMeta(slashKey, { dismissed: hit.from }) : null;
};
