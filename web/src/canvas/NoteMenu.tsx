import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { useContextMenu } from './Biblioteca';
import { promptLink } from './editor';
import { KINDS, blockAt, canTurn, deleteBlock, duplicateBlock, ensureBlockId, moveBlock, turnBlock, type Block } from './blocks';
import { TOUCH } from './touch';
import { t } from '../i18n';

// El menú del clic derecho dentro del texto de una nota (en el móvil, al
// mantener pulsado): cortar, copiar y pegar, dar formato a lo seleccionado,
// convertir o mover el bloque y, sobre todo, copiar un enlace a ese punto
// exacto para pegarlo en otra nota.

// `stay`: no cierra el menú (abre otra lista dentro de él).
export type MenuItem = { label: string; keys?: string; danger?: boolean; stay?: boolean; run: () => void } | null;

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? '⌘' : 'Ctrl';

// Copiar sin pedir permiso: también vale sin https (la web en casa por su IP),
// donde el portapapeles moderno no existe.
export function copyRich(text: string, html?: string) {
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    e.clipboardData?.setData('text/plain', text);
    if (html) e.clipboardData?.setData('text/html', html);
  };
  window.addEventListener('copy', onCopy, true);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    window.removeEventListener('copy', onCopy, true);
  }
  if (!ok) void navigator.clipboard?.writeText(text).catch(() => {});
}

const canPaste = () => typeof navigator !== 'undefined' && !!navigator.clipboard && (typeof navigator.clipboard.read === 'function' || typeof navigator.clipboard.readText === 'function');

// Pegar desde el menú: con formato si lo trae; si es texto en Markdown, como al
// pegar con el teclado.
async function pasteInto(view: EditorView) {
  view.focus();
  try {
    if (typeof navigator.clipboard.read === 'function') {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) {
          view.pasteHTML(await (await item.getType('text/html')).text());
          return;
        }
      }
    }
  } catch {
    // Sin permiso para leer con formato: se prueba con el texto.
  }
  const text = await navigator.clipboard.readText();
  if (!text) return;
  const data = new DataTransfer();
  data.setData('text/plain', text);
  view.pasteText(text, new ClipboardEvent('paste', { clipboardData: data }));
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// [[Nota#^abc123]]: en Markdown para pegarlo en cualquier sitio y como
// enlace ya hecho (con el id de la nota) para pegarlo en otra nota de aquí.
export function copyBlockLink(view: EditorView, block: Block, note: { id: string; title: string }) {
  const id = ensureBlockId(view, block);
  if (!id) return false;
  const name = note.title.trim() || t('Nota sin título');
  const target = `${name}#^${id}`;
  copyRich(`[[${target}]]`, `<a data-wikilink="" data-id="${escapeHtml(note.id)}" data-target="${escapeHtml(target)}">${escapeHtml(name)}</a>`);
  return true;
}

type Props = {
  editor: Editor;
  x: number;
  y: number;
  // Lo del enlace que hay debajo (abrir, editar…), si lo hay.
  linkItems: MenuItem[];
  note: { id: string; title: string };
  onNotice?: (text: string) => void;
  onClose: () => void;
};

export function NoteMenu({ editor, x, y, linkItems, note, onNotice, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [turning, setTurning] = useState(false);
  const spot = useContextMenu(ref, x, y, onClose);
  const { view, state } = editor;
  const sel = state.selection;
  const text = sel instanceof TextSelection && !sel.empty;
  const block = blockAt(state.doc, sel.from);
  const keys = (k: string) => (TOUCH ? undefined : k);

  // El bloque de cuando se abrió, si sigue ahí.
  const live = (): Block | null => {
    if (!block) return null;
    const b = blockAt(editor.state.doc, block.pos);
    return b && b.pos === block.pos && b.node.type === block.node.type ? b : null;
  };
  const withBlock = (fn: (b: Block) => unknown) => () => {
    const b = live();
    if (b) fn(b);
  };
  const run = (fn: () => unknown) => () => {
    onClose();
    fn();
  };
  const clip = (cmd: 'cut' | 'copy') => () => {
    view.focus();
    document.execCommand(cmd);
  };
  const linkable = !!block && 'blockId' in block.node.attrs;

  const items: MenuItem[] = [
    ...(linkItems.length ? [...linkItems, null] : []),
    ...(text ? [{ label: t('Cortar'), keys: keys(`${MOD} X`), run: clip('cut') }, { label: t('Copiar'), keys: keys(`${MOD} C`), run: clip('copy') }] : []),
    ...(canPaste() ? [{ label: t('Pegar'), keys: keys(`${MOD} V`), run: () => void pasteInto(view).catch(() => onNotice?.(t('No se pudo leer el portapapeles: pega con {keys}', { keys: `${MOD} V` }))) }] : []),
    null,
    ...(linkable
      ? [
          {
            label: t('Copiar enlace a este bloque'),
            run: withBlock((b) => {
              if (copyBlockLink(view, b, note)) onNotice?.(t('Enlace al bloque copiado: pégalo en otra nota'));
            }),
          },
        ]
      : []),
    ...(block && canTurn(block) ? [{ label: t('Convertir en'), keys: '›', stay: true, run: () => setTurning(true) }] : []),
    ...(block
      ? [
          { label: t('Duplicar'), keys: keys(`${MOD} D`), run: withBlock((b) => duplicateBlock(view, b)) },
          { label: t('Mover arriba'), keys: keys(`${MOD} ⇧ ↑`), run: withBlock((b) => moveBlock(view, b, -1)) },
          { label: t('Mover abajo'), keys: keys(`${MOD} ⇧ ↓`), run: withBlock((b) => moveBlock(view, b, 1)) },
          { label: t('Eliminar'), danger: true, run: withBlock((b) => deleteBlock(view, b)) },
        ]
      : []),
  ];
  // Sin separadores de sobra (al principio, al final o dos seguidos).
  const shown = items.filter((it, i, all) => it || (i > 0 && i < all.length - 1 && all[i - 1] && all.slice(i + 1).some(Boolean)));

  const fmt = (name: string, label: string, glyph: ReactNode, toggle: () => unknown) => (
    <button key={name} className={`fmt-btn${editor.isActive(name) ? ' is-on' : ''}`} title={label} aria-label={label} aria-pressed={editor.isActive(name)} onClick={run(toggle)}>
      {glyph}
    </button>
  );
  const c = () => editor.chain().focus();

  return createPortal(
    <div ref={ref} className="bib-menu nmenu" role="menu" aria-label={t('Menú del texto')} style={{ left: spot.x, top: spot.y }} onContextMenu={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
      {turning && block ? (
        <>
          <button className="bib-menu-it nmenu-back" onClick={() => setTurning(false)}>
            ‹ {t('Convertir en')}
          </button>
          <div className="bib-menu-sep" role="separator" />
          {KINDS.map((k) => (
            <button key={k.kind} role="menuitem" className="bib-menu-it" onClick={run(withBlock((b) => turnBlock(editor, b, k.kind)))}>
              <span className="blk-kind-i" aria-hidden="true">
                {k.icon}
              </span>
              {t(k.label)}
            </button>
          ))}
        </>
      ) : (
        <>
          {text && !sel.$from.parent.type.spec.code && (
            <>
              <div className="nmenu-fmt" role="group" aria-label={t('Formato')}>
                {fmt('bold', t('Negrita'), <b>B</b>, () => c().toggleBold().run())}
                {fmt('italic', t('Cursiva'), <i>I</i>, () => c().toggleItalic().run())}
                {fmt('underline', t('Subrayado'), <u>U</u>, () => c().toggleUnderline().run())}
                {fmt('strike', t('Tachado'), <s>S</s>, () => c().toggleStrike().run())}
                {fmt('highlight', t('Resaltar'), <mark>H</mark>, () => c().toggleMark('highlight').run())}
                {fmt('code', t('Código'), <code>{'</>'}</code>, () => c().toggleCode().run())}
                {fmt('link', t('Enlace'), '🔗', () => promptLink(editor))}
              </div>
              <div className="bib-menu-sep" role="separator" />
            </>
          )}
          {shown.map((it, i) =>
            it ? (
              <button key={it.label} role="menuitem" className={`bib-menu-it${it.danger ? ' is-danger' : ''}`} onClick={it.stay ? it.run : run(it.run)} aria-haspopup={it.stay ? 'menu' : undefined}>
                {it.label}
                {it.keys && <span className="bib-menu-k">{it.keys}</span>}
              </button>
            ) : (
              <div key={`s${i}`} className="bib-menu-sep" role="separator" />
            ),
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
