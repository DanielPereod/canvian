// Se inyecta en la página que se recorta (después de vendor/Readability.js,
// vendor/turndown.js y vendor/turndown-plugin-gfm.js) y deja a mano
// `__canvianClip(mode)`, que devuelve la página en Markdown:
//  · 'page': el artículo (lo que Readability ve como contenido principal);
//  · 'selection': solo lo seleccionado;
//  · 'link': nada de texto, solo el enlace y sus datos.

(() => {
  const meta = (...names) => {
    for (const n of names) {
      const el = document.querySelector(`meta[name="${n}"], meta[property="${n}"], meta[itemprop="${n}"]`);
      const v = el?.getAttribute('content')?.trim();
      if (v) return v;
    }
    return null;
  };

  // Enlaces e imágenes con su dirección completa, para que funcionen en la nota.
  const absolutize = (root) => {
    for (const a of root.querySelectorAll('a[href]')) a.setAttribute('href', new URL(a.getAttribute('href'), location.href).href);
    for (const img of root.querySelectorAll('img')) {
      const src = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src');
      if (src) img.setAttribute('src', new URL(src, location.href).href);
      img.removeAttribute('srcset');
    }
    return root;
  };

  const turndown = () => {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', hr: '---' });
    td.use(turndownPluginGfm.gfm);
    // «- texto» (Turndown pone «-   texto»).
    td.addRule('listItem', {
      filter: 'li',
      replacement: (content, node) => {
        const parent = node.parentNode;
        let prefix = '- ';
        if (parent.nodeName === 'OL') {
          const start = Number(parent.getAttribute('start') || 1);
          prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
        }
        content = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
        return prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '');
      },
    });
    td.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'svg']);
    // <mark> → ==resaltado== (como en Obsidian y en Canvian).
    td.addRule('mark', { filter: 'mark', replacement: (c) => (c.trim() ? `==${c}==` : c) });
    // Imágenes sin datos URI enormes.
    td.addRule('img', {
      filter: 'img',
      replacement: (_c, node) => {
        const src = node.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) return '';
        const alt = (node.getAttribute('alt') || '').replace(/[\[\]\n]/g, ' ').trim();
        return `![${alt}](${src})`;
      },
    });
    return td;
  };

  const tidy = (md) => md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

  const selectionHtml = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const box = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
    return box.textContent.trim() ? absolutize(box) : null;
  };

  window.__canvianClip = (mode) => {
    const base = {
      url: location.href.replace(/#.*$/, ''),
      title: (meta('og:title', 'twitter:title') || document.title || location.hostname).trim(),
      site: meta('og:site_name', 'application-name') || location.hostname.replace(/^www\./, ''),
      author: meta('author', 'article:author', 'parsely-author', 'dc.creator'),
      published: (meta('article:published_time', 'datePublished', 'date', 'dc.date', 'parsely-pub-date') || '').slice(0, 10) || null,
      description: meta('og:description', 'description', 'twitter:description'),
      image: meta('og:image', 'twitter:image'),
      hasSelection: !!selectionHtml(),
    };
    if (mode === 'link') return { ...base, mode, markdown: base.description ? `> ${base.description}` : '' };

    if (mode === 'selection') {
      const box = selectionHtml();
      if (box) return { ...base, mode, markdown: tidy(turndown().turndown(box)) };
      mode = 'page';
    }

    let html = null;
    try {
      const article = new Readability(absolutize(document.cloneNode(true)), { charThreshold: 300 }).parse();
      if (article?.content) {
        html = article.content;
        if (article.title) base.title = article.title.trim();
        if (article.byline && !base.author) base.author = article.byline.trim();
      }
    } catch {
      // Una página que Readability no entiende: se coge el <main> o el cuerpo.
    }
    if (!html) html = absolutize((document.querySelector('main, article, [role="main"]') || document.body).cloneNode(true)).innerHTML;
    return { ...base, mode: 'page', markdown: tidy(turndown().turndown(html)) };
  };
})();
