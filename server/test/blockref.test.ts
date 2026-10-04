import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc } from '../src/doc/markdown.js';
import { sectionOf } from '../src/doc/json.js';

describe('block ids', () => {
  it('reads and writes « ^id» like Obsidian', () => {
    const md = ['# Título ^h1', '', 'Un párrafo ^p1', '', '- uno ^li1', '- dos', '', '- [ ] tarea ^t1', '', '> [!note] 💡', '> dentro', '^c1', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '^tb1'].join('\n');
    const { doc } = markdownToDoc(md, false);
    const [h, p, ul, tl, call, table] = doc.content!;
    expect(h.attrs?.blockId).toBe('h1');
    expect(h.content).toEqual([{ type: 'text', text: 'Título' }]);
    expect(p.attrs?.blockId).toBe('p1');
    expect(ul.content![0].attrs?.blockId).toBe('li1');
    expect(ul.content![0].content![0].attrs).toBeUndefined();
    expect(tl.content![0].attrs).toMatchObject({ checked: false, blockId: 't1' });
    expect(call.attrs?.blockId).toBe('c1');
    expect(table.attrs?.blockId).toBe('tb1');
    expect(docToMarkdown(doc)).toBe(md);
    expect(sectionOf(doc, '^li1')?.[0].type).toBe('listItem');
    expect(sectionOf(doc, 'título')?.length).toBe(6);
    expect(sectionOf(doc, '^zz')).toBeNull();
  });

  it('a lone ^id line under a paragraph joins it', () => {
    const { doc } = markdownToDoc('Hola\n^abc', false);
    expect(doc.content![0]).toMatchObject({ type: 'paragraph', attrs: { blockId: 'abc' }, content: [{ text: 'Hola' }] });
  });
});
