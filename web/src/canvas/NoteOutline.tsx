import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { t } from '../i18n';

// El índice de una nota larga, como en Notion: unas rayas a la derecha del
// texto (una por encabezado, la de donde estás más marcada) que al pasar por
// encima se abren con los títulos. Pulsar uno lleva hasta él. Solo sale con
// tres encabezados o más.

type Head = { pos: number; level: number; text: string };

export function NoteOutline({ editorRef, noteId }: { editorRef: MutableRefObject<Editor | null>; noteId: string }) {
  const [heads, setHeads] = useState<Head[]>([]);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let ed: Editor | null = null;
    let raf = 0;
    const read = () => {
      if (!ed) return;
      const out: Head[] = [];
      ed.state.doc.forEach((node, pos, i) => {
        // El título de la nota (su primer encabezado grande) no cuenta.
        if (node.type.name !== 'heading' || !node.textContent.trim() || (i === 0 && node.attrs.level === 1)) return;
        out.push({ pos, level: node.attrs.level as number, text: node.textContent.trim() });
      });
      setHeads(out);
    };
    const wait = () => {
      ed = editorRef.current;
      if (!ed) {
        raf = requestAnimationFrame(wait);
        return;
      }
      read();
      ed.on('update', read);
    };
    wait();
    return () => {
      cancelAnimationFrame(raf);
      ed?.off('update', read);
    };
  }, [editorRef, noteId]);

  // El encabezado en el que estás: el último que ya ha pasado por arriba.
  useEffect(() => {
    const scroller = box.current?.closest('.reader-main');
    const ed = editorRef.current;
    if (!scroller || !ed || heads.length < 3) return;
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top + 120;
      let at = 0;
      heads.forEach((h, i) => {
        const el = ed.view.nodeDOM(h.pos) as HTMLElement | null;
        if (el && el.getBoundingClientRect().top <= top) at = i;
      });
      setActive(at);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [heads, editorRef]);

  if (heads.length < 3) return <div ref={box} className="reader-outline is-empty" aria-hidden="true" />;
  const minLevel = Math.min(...heads.map((h) => h.level));
  const go = (h: Head) => {
    const el = editorRef.current?.view.nodeDOM(h.pos) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div ref={box} className="reader-outline">
      <nav className="reader-outline-in" aria-label={t('Índice de la nota')}>
        {heads.map((h, i) => (
          <button
            key={h.pos}
            className={`reader-outline-it${i === active ? ' is-on' : ''}`}
            style={{ '--lvl': h.level - minLevel } as CSSProperties}
            onClick={() => go(h)}
          >
            <span className="reader-outline-bar" aria-hidden="true" />
            <span className="reader-outline-tx">{h.text}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
