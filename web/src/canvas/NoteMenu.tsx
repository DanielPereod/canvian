import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { NavIcon, useContextMenu } from './Biblioteca';
import { promptLink } from './editor';
import { editLink, embedLink, embedOf, prettyHref, saveLink, unlink, type LinkHit } from './links';
import { splitWiki } from './obsidian';
import { KINDS, canTurnAll, deleteBlocks, duplicateBlocks, ensureBlockId, liveBlocks, moveBlocks, selectedBlocks, turnBlocks, type Block } from './blocks';
import { TOUCH } from './touch';
import { t } from '../i18n';

// El menú del clic derecho dentro del texto de una nota (en el móvil, al
// mantener pulsado): cortar, copiar y pegar, dar formato a lo seleccionado,
// convertir o mover el bloque y, sobre todo, copiar un enlace a ese punto
// exacto para pegarlo en otra nota.

// `stay`: no cierra el menú (abre otra lista dentro de él).
export type MenuItem = { label: string; icon?: string; keys?: string; danger?: boolean; stay?: boolean; run: () => void } | null;

// El enlace que hay donde se pulsó: el menú lo enseña arriba, con lo que se
// puede hacer con él. `edit`: abrir ya en el cuadro de editarlo (con Ctrl K).
export type LinkCtx = { hit: LinkHit; open: () => void; edit?: boolean };

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
  // El enlace que hay debajo (abrir, editar…), si lo hay.
  link?: LinkCtx | null;
  note: { id: string; title: string };
  onNotice?: (text: string) => void;
  onClose: () => void;
};

export function NoteMenu({ editor, x, y, link, note, onNotice, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [turning, setTurning] = useState(false);
  const [editing, setEditing] = useState(!!link?.edit);
  const spot = useContextMenu(ref, x, y, onClose, editing || turning);
  const { view, state } = editor;
  const sel = state.selection;
  const text = sel instanceof TextSelection && !sel.empty;
  // Si lo seleccionado abarca varios bloques, lo de bloque va con todos.
  const blocks = selectedBlocks(state);
  const block = blocks.length === 1 ? blocks[0] : null;
  const keys = (k: string) => (TOUCH ? undefined : k);

  // Los bloques de cuando se abrió, si siguen ahí.
  const withBlocks = (fn: (bs: Block[]) => unknown) => () => {
    const bs = liveBlocks(editor.state.doc, blocks);
    if (bs) fn(bs);
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

  const hit = link?.hit;
  const web = hit?.kind === 'web';
  const linkItems: MenuItem[] = hit
    ? [
        { label: web ? t('Abrir enlace') : t('Abrir nota'), icon: 'open', run: link!.open },
        { label: t('Editar enlace…'), icon: 'rename', keys: keys(`${MOD} K`), stay: true, run: () => setEditing(true) },
        ...(web ? [{ label: t('Copiar enlace'), icon: 'copy', run: () => (copyRich(hit.href), onNotice?.(t('Enlace copiado'))) }] : []),
        ...(embedOf(state, hit) ? [{ label: t('Ver incrustado'), icon: 'embed', run: () => embedLink(view, hit) }] : []),
        { label: t('Quitar enlace'), icon: 'unlink', run: () => unlink(view, hit) },
      ]
    : [];
  const items: MenuItem[] = [
    ...(linkItems.length ? [...linkItems, null] : []),
    ...(text ? [{ label: t('Cortar'), keys: keys(`${MOD} X`), run: clip('cut') }, { label: t('Copiar'), keys: keys(`${MOD} C`), run: clip('copy') }] : []),
    ...(canPaste() ? [{ label: t('Pegar'), keys: keys(`${MOD} V`), run: () => void pasteInto(view).catch(() => onNotice?.(t('No se pudo leer el portapapeles: pega con {keys}', { keys: `${MOD} V` }))) }] : []),
    null,
    ...(linkable
      ? [
          {
            label: t('Copiar enlace a este bloque'),
            run: withBlocks(([b]) => {
              if (copyBlockLink(view, b, note)) onNotice?.(t('Enlace al bloque copiado: pégalo en otra nota'));
            }),
          },
        ]
      : []),
    ...(blocks.length && canTurnAll(blocks) ? [{ label: t('Convertir en'), keys: '›', stay: true, run: () => setTurning(true) }] : []),
    ...(blocks.length
      ? [
          { label: blocks.length > 1 ? t('Duplicar {n} bloques', { n: blocks.length }) : t('Duplicar'), keys: keys(`${MOD} D`), run: withBlocks((bs) => duplicateBlocks(view, bs)) },
          { label: t('Mover arriba'), keys: keys(`${MOD} ⇧ ↑`), run: withBlocks((bs) => moveBlocks(view, bs, -1)) },
          { label: t('Mover abajo'), keys: keys(`${MOD} ⇧ ↓`), run: withBlocks((bs) => moveBlocks(view, bs, 1)) },
          { label: blocks.length > 1 ? t('Eliminar {n} bloques', { n: blocks.length }) : t('Eliminar'), danger: true, run: withBlocks((bs) => deleteBlocks(view, bs)) },
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

  // Con el enlace, todas las opciones dejan el hueco del icono para ir alineadas.
  const icons = linkItems.length > 0;

  return createPortal(
    <div
      ref={ref}
      className={`bib-menu nmenu${editing && hit ? ' is-editing' : ''}`}
      role={editing && hit ? 'dialog' : 'menu'}
      aria-label={editing && hit ? t('Editar enlace') : t('Menú del texto')}
      style={{ left: spot.x, top: spot.y }}
      onContextMenu={(e) => e.preventDefault()}
      // Sin quitarle el cursor al texto, salvo en los campos del cuadro del enlace.
      onMouseDown={(e) => !(e.target as Element).closest('input') && e.preventDefault()}
    >
      {editing && hit ? (
        <LinkForm
          hit={hit}
          onBack={link?.edit ? undefined : () => setEditing(false)}
          onCancel={onClose}
          onSave={(next) => {
            onClose();
            saveLink(view, hit, next);
          }}
          onUnlink={() => {
            onClose();
            unlink(view, hit);
          }}
          onRaw={() => {
            onClose();
            editLink(view, hit);
          }}
        />
      ) : turning && blocks.length ? (
        <>
          <button className="bib-menu-it nmenu-back" onClick={() => setTurning(false)}>
            ‹ {t('Convertir en')}
          </button>
          <div className="bib-menu-sep" role="separator" />
          {KINDS.map((k) => (
            <button key={k.kind} role="menuitem" className="bib-menu-it" onClick={run(withBlocks((bs) => turnBlocks(editor, bs, k.kind)))}>
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
          {hit && <LinkCard hit={hit} onOpen={run(link!.open)} />}
          {shown.map((it, i) =>
            it ? (
              <button key={it.label} role="menuitem" className={`bib-menu-it${it.danger ? ' is-danger' : ''}`} onClick={it.stay ? it.run : run(it.run)} aria-haspopup={it.stay ? 'menu' : undefined}>
                {it.icon ? <NavIcon name={it.icon} /> : icons && <span className="bib-it-ic" aria-hidden="true" />}
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

// Arriba del menú, el enlace: qué texto tiene y adónde lleva. Pulsarlo lo abre.
function LinkCard({ hit, onOpen }: { hit: LinkHit; onOpen: () => void }) {
  const web = hit.kind === 'web';
  const note = splitWiki(hit.href);
  const title = web ? hit.text.trim() || prettyHref(hit.href) : hit.text.trim() || note.note || hit.href;
  const where = web ? prettyHref(hit.href) : note.section ? `${note.note} › ${note.section.replace(/^\^/, '')}` : t('Nota de tu biblioteca');
  return (
    <>
      <button className="lmenu-card" onClick={onOpen} title={web ? hit.href : undefined} aria-label={`${web ? t('Abrir enlace') : t('Abrir nota')}: ${title}`}>
        <span className={`lmenu-ic${web ? '' : ' is-note'}`} aria-hidden="true">
          <NavIcon name={web ? 'globe' : 'page'} />
        </span>
        <span className="lmenu-txt">
          <span className="lmenu-title">{title}</span>
          <span className="lmenu-url">{where}</span>
        </span>
      </button>
      <div className="bib-menu-sep" role="separator" />
    </>
  );
}

// El cuadro de editar un enlace: el texto que se ve y adónde lleva (una
// dirección web o, en un [[enlace]], el nombre de la nota). Intro guarda y Esc
// cierra sin tocar nada.
function LinkForm({ hit, onBack, onCancel, onSave, onUnlink, onRaw }: { hit: LinkHit; onBack?: () => void; onCancel: () => void; onSave: (next: { text: string; href: string }) => void; onUnlink: () => void; onRaw: () => void }) {
  const web = hit.kind === 'web';
  const [text, setText] = useState(hit.text);
  const [href, setHref] = useState(hit.href);
  const hrefBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Lo que más se cambia es adónde lleva: el cursor empieza ahí, con todo elegido.
    const box = hrefBox.current;
    if (!box) return;
    box.focus();
    box.select();
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!web && !href.trim()) return;
    onSave({ text, href });
  };
  const changed = text !== hit.text || href !== hit.href;
  return (
    <form className="lmenu-form" onSubmit={submit}>
      <div className="lmenu-form-head">
        {onBack ? (
          <button type="button" className="lmenu-back" onClick={onBack} aria-label={t('Volver')}>
            ‹
          </button>
        ) : (
          <span className="lmenu-ic" aria-hidden="true">
            <NavIcon name={web ? 'link' : 'page'} />
          </span>
        )}
        <span>{web ? t('Editar enlace') : t('Editar enlace a nota')}</span>
        <button type="button" className="lmenu-raw" onClick={onRaw} title={t('Editar como Markdown en el texto')}>
          Markdown
        </button>
      </div>
      <label className="lmenu-field">
        <span>{web ? t('Dirección') : t('Nota')}</span>
        <input
          ref={hrefBox}
          className="field"
          value={href}
          onChange={(e) => setHref(e.target.value)}
          placeholder={web ? 'https://…' : t('Nombre de la nota')}
          inputMode={web ? 'url' : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      <label className="lmenu-field">
        <span>{t('Texto')}</span>
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder={web ? prettyHref(href) || t('Texto del enlace') : splitWiki(href).note || t('Texto del enlace')} />
      </label>
      <div className="lmenu-actions">
        <button type="button" className="lmenu-unlink" onClick={onUnlink}>
          <NavIcon name="unlink" />
          {t('Quitar')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          {t('Cancelar')}
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!changed || (!web && !href.trim())}>
          {t('Guardar')}
        </button>
      </div>
    </form>
  );
}
