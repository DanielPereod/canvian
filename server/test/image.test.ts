import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc } from '../src/doc/markdown.js';

describe('image size and crop', () => {
  it('reads and writes width and crop', () => {
    const md = '![Gato|320](/api/media/abc.png#crop=0.1,0.2,0.5,0.4,1.5)';
    const { doc } = markdownToDoc(md, false);
    expect(doc.content![0]).toMatchObject({ type: 'image', attrs: { src: '/api/media/abc.png', alt: 'Gato', width: 320, crop: '0.1,0.2,0.5,0.4,1.5' } });
    expect(docToMarkdown(doc)).toBe(md);
  });

  it('accepts Obsidian sizes and plain images', () => {
    const { doc } = markdownToDoc('![|300x200](https://x.org/a.jpg)\n\n![](https://x.org/b.webp#crop=1,2)', false);
    expect(doc.content![0].attrs).toMatchObject({ src: 'https://x.org/a.jpg', width: 300 });
    expect(doc.content![1].attrs).toEqual({ src: 'https://x.org/b.webp', alt: null });
    expect(docToMarkdown({ type: 'doc', content: [{ type: 'image', attrs: { src: '/api/media/z.png', alt: null } }] })).toBe('![](/api/media/z.png)');
  });
});
