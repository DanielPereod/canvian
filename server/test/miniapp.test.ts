import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc } from '../src/doc/markdown.js';

describe('mini apps', () => {
  it('reads and writes ```app blocks', () => {
    const md = '```app\n<button id="b">Sumar</button>\n<script>\n  b.onclick = () => alert(1 + 1);\n</script>\n```';
    const { doc } = markdownToDoc(md, false);
    expect(doc.content![0]).toEqual({ type: 'miniApp', attrs: { code: '<button id="b">Sumar</button>\n<script>\n  b.onclick = () => alert(1 + 1);\n</script>' } });
    expect(docToMarkdown(doc)).toBe(md);
  });

  it('keeps other fenced code as code', () => {
    const { doc } = markdownToDoc('```html\n<b>hola</b>\n```', false);
    expect(doc.content![0].type).toBe('codeBlock');
  });

  it('uses a longer fence when the code has one', () => {
    const doc = { type: 'doc', content: [{ type: 'miniApp', attrs: { code: '<pre>```</pre>' } }] };
    const md = docToMarkdown(doc);
    expect(md).toBe('````app\n<pre>```</pre>\n````');
    expect(markdownToDoc(md, false).doc.content![0]).toEqual(doc.content[0]);
  });
});
