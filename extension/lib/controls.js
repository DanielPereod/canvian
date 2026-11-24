// Los controles de Canvian (fecha, prioridad y elegir nota), con las mismas
// clases que la web: con la hoja de estilos de tu Canvian cargada se ven
// igual que allí; sin ella, lib/theme.css les da un aspecto parecido.
//
// Las ventanitas se colocan con position: fixed medidas desde abajo a la
// derecha, porque en Outlook el panel es un iframe anclado ahí que crece
// hacia arriba y a la izquierda cuando una ventanita no cabe (onLayout avisa).

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const svgNS = 'http://www.w3.org/2000/svg';
function caret() {
  const s = document.createElementNS(svgNS, 'svg');
  s.setAttribute('class', 'cv-combo-caret');
  s.setAttribute('viewBox', '0 0 10 10');
  s.setAttribute('width', '10');
  s.setAttribute('height', '10');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svgNS, 'path');
  p.setAttribute('d', 'M2.5 4l2.5 2.5L7.5 4');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.3');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}
function flag() {
  const s = document.createElementNS(svgNS, 'svg');
  s.setAttribute('viewBox', '0 0 12 12');
  s.setAttribute('width', '12');
  s.setAttribute('height', '12');
  s.setAttribute('aria-hidden', 'true');
  const a = document.createElementNS(svgNS, 'path');
  a.setAttribute('d', 'M2.5 1.5v9.5');
  a.setAttribute('stroke', 'currentColor');
  a.setAttribute('stroke-width', '1.3');
  a.setAttribute('stroke-linecap', 'round');
  const b = document.createElementNS(svgNS, 'path');
  b.setAttribute('d', 'M3 1.8h6.6l-1.6 2.6 1.6 2.6H3z');
  b.setAttribute('fill', 'currentColor');
  s.append(a, b);
  return s;
}

// Sin mayúsculas ni tildes.
export const fold = (s) => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// ── Fechas ───────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (iso, n) => {
  const d = dateOf(iso);
  return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
const nextMonday = (iso) => addDays(iso, (1 - dateOf(iso).getDay() + 7) % 7 || 7);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (opts) => new Intl.DateTimeFormat('es-ES', opts);
const todayIso = () => isoOf(new Date());

// Como dueLabel() de la web: Hoy, Mañana, Ayer o «mar 2 dic».
export function dueLabel(iso) {
  const n = Math.round((dateOf(iso) - dateOf(todayIso())) / 86_400_000);
  if (n === 0) return 'Hoy';
  if (n === 1) return 'Mañana';
  if (n === -1) return 'Ayer';
  return fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(dateOf(iso)).replace(/[.,]/g, '');
}

// ── Ventanitas ───────────────────────────────────────────────────────

let openPop = null;
export const popOpen = () => !!openPop;

function closePop(refocus) {
  if (!openPop) return;
  const { node, anchor, onClose } = openPop;
  openPop = null;
  node.remove();
  anchor.classList.remove('is-open');
  anchor.setAttribute('aria-expanded', 'false');
  if (refocus) anchor.focus();
  onClose?.();
}

// Coloca `node` junto a `anchor`: encima si `up` (o si abajo no cabe).
function place(node, anchor, { up, width }) {
  const a = anchor.getBoundingClientRect();
  const w = Math.max(width ?? 0, node.offsetWidth);
  const h = node.offsetHeight;
  const roomBelow = innerHeight - a.bottom - 8;
  const above = up || (h > roomBelow && a.top > roomBelow);
  const top = above ? a.top - 4 - h : a.bottom + 4;
  const left = Math.max(8, Math.min(a.left, innerWidth - w - 8));
  node.style.right = `${innerWidth - left - w}px`;
  node.style.bottom = `${innerHeight - top - h}px`;
  node.style.left = 'auto';
  node.style.top = 'auto';
  node.style.visibility = '';
}

function showPop(anchor, node, opts) {
  closePop(false);
  node.classList.add('cx-pop');
  node.style.position = 'fixed';
  node.style.visibility = 'hidden';
  node.style.left = '-9999px';
  node.style.top = '0';
  if (opts.width) node.style.width = `${opts.width}px`;
  (opts.mount ?? document.body).append(node);
  openPop = { node, anchor, onClose: opts.onLayout };
  anchor.classList.add('is-open');
  anchor.setAttribute('aria-expanded', 'true');
  const relayout = () => {
    if (openPop?.node !== node) return;
    place(node, anchor, opts);
    opts.onLayout?.();
  };
  relayout();
  new ResizeObserver(relayout).observe(node);
  return relayout;
}

addEventListener(
  'pointerdown',
  (e) => {
    if (!openPop) return;
    if (openPop.node.contains(e.target) || openPop.anchor.contains(e.target)) return;
    closePop(false);
  },
  true,
);
addEventListener('blur', () => closePop(false));
addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && openPop) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePop(true);
    }
  },
  true,
);

// ── Fecha: el botón y el calendario de la web ────────────────────────

export function datePicker({ placeholder = 'Fecha', onChange, className = '', ...opts } = {}) {
  let value = null;
  let cursor = todayIso();
  const btn = el('button', `cv-select cv-date cx-date ${className}`.trim());
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  const paint = () => {
    btn.textContent = '';
    const late = value && value < todayIso();
    btn.classList.toggle('is-empty', !value);
    btn.classList.toggle('is-late', !!late);
    btn.append(value ? cap(dueLabel(value)) : el('span', 'dp-placeholder', placeholder));
    btn.title = value ? fmt({ dateStyle: 'full' }).format(dateOf(value)) : placeholder;
  };
  const set = (v, fire = true) => {
    value = v;
    paint();
    if (fire) onChange?.(v);
  };

  function render(pop, grid) {
    pop.textContent = '';
    const month = cursor.slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const head = el('div', 'dp-head');
    const prev = el('button', 'dp-nav', '‹');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Mes anterior');
    prev.addEventListener('click', () => ((cursor = isoOf(new Date(y, m - 2, Math.min(dateOf(cursor).getDate(), 28)))), render(pop, grid)));
    const next = el('button', 'dp-nav', '›');
    next.type = 'button';
    next.setAttribute('aria-label', 'Mes siguiente');
    next.addEventListener('click', () => ((cursor = isoOf(new Date(y, m, Math.min(dateOf(cursor).getDate(), 28)))), render(pop, grid)));
    head.append(prev, el('span', 'dp-month', cap(fmt({ month: 'long', year: 'numeric' }).format(dateOf(`${month}-01`)))), next);

    const first = new Date(y, m - 1, 1);
    const start = new Date(y, m - 1, 1 - ((first.getDay() + 6) % 7));
    const days = Array.from({ length: 42 }, (_, k) => isoOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k)));
    const weeks = days[35].slice(0, 7) === month ? 6 : 5;
    grid.textContent = '';
    grid.style.setProperty('--weeks', weeks);
    for (let k = 0; k < 7; k++) grid.append(el('span', 'dp-dow', fmt({ weekday: 'narrow' }).format(new Date(2024, 0, 1 + k))));
    const today = todayIso();
    for (const iso of days.slice(0, weeks * 7)) {
      const d = el('button', 'dp-day', String(Number(iso.slice(8))));
      d.type = 'button';
      d.tabIndex = -1;
      if (iso.slice(0, 7) !== month) d.classList.add('is-other');
      if (iso === today) d.classList.add('is-today');
      if (iso === value) d.classList.add('is-on');
      if (iso === cursor && iso !== value) d.classList.add('is-cursor');
      if (iso < today) d.classList.add('is-past');
      d.addEventListener('click', () => {
        set(iso);
        closePop(true);
      });
      grid.append(d);
    }
    const foot = el('div', 'dp-foot');
    const quick = (label, fn, cls = '') => {
      const b = el('button', `dp-quick ${cls}`.trim(), label);
      b.type = 'button';
      b.addEventListener('click', fn);
      foot.append(b);
    };
    const pick = (iso) => () => {
      set(iso);
      closePop(true);
    };
    quick('Hoy', pick(today));
    quick('Mañana', pick(addDays(today, 1)));
    quick('Próximo lunes', pick(nextMonday(today)));
    if (value)
      quick(
        'Quitar fecha',
        () => {
          set(null);
          closePop(true);
        },
        'dp-clear',
      );
    pop.append(head, grid, foot);
  }

  btn.addEventListener('click', () => {
    if (openPop?.anchor === btn) return closePop(false);
    cursor = value ?? todayIso();
    const pop = el('div', 'surface-3 popover dp-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', placeholder);
    const grid = el('div', 'dp-grid');
    grid.setAttribute('role', 'grid');
    grid.tabIndex = 0;
    grid.addEventListener('keydown', (e) => {
      const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (move) cursor = addDays(cursor, move);
      else if (e.key === 'Enter') {
        set(cursor);
        closePop(true);
      } else return;
      e.preventDefault();
      render(pop, grid);
      grid.focus();
    });
    render(pop, grid);
    showPop(btn, pop, { width: 280, ...opts });
    grid.focus();
  });
  paint();
  return {
    el: btn,
    get value() {
      return value;
    },
    set: (v) => set(v, false),
  };
}

// ── Prioridad: las banderas de la web ────────────────────────────────

const PRIOS = [
  [1, 'low', 'Prioridad baja'],
  [2, 'medium', 'Prioridad media'],
  [3, 'high', 'Prioridad alta'],
];
export function priorityPicker({ onChange } = {}) {
  let value = 'none';
  const box = el('div', 'tv-prio cx-prio');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', 'Prioridad');
  const buttons = PRIOS.map(([n, id, label]) => {
    const b = el('button', `prio-${n}`);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(flag());
    b.addEventListener('click', () => {
      value = value === id ? 'none' : id;
      paint();
      onChange?.(value);
    });
    box.append(b);
    return [b, id];
  });
  const paint = () => {
    for (const [b, id] of buttons) {
      b.classList.toggle('is-on', id === value);
      b.setAttribute('aria-checked', String(id === value));
    }
  };
  paint();
  return {
    el: box,
    get value() {
      return value;
    },
    set: (v) => {
      value = v || 'none';
      paint();
    },
  };
}

// ── Elegir nota: con el buscador de Canvian ─────────────────────────
// `search(q)` devuelve { hits: [{ id, title, path, where }] }. La primera
// opción es la de por defecto (id null, con `defaultLabel`).

export function notePicker({ search, defaultLabel, placeholder = 'Buscar notas…', onChange, className = '', ...opts }) {
  let value = null; // { id, title, where } o null = por defecto
  const btn = el('button', `cv-select cv-combo cx-combo ${className}`.trim());
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const paint = () => {
    btn.textContent = '';
    const label = el('span', 'bib-ellipsis');
    if (value) {
      label.append(value.title || 'Nota sin título');
      if (value.where) label.append(el('span', 'cx-combo-where', ` · ${value.where.split(' > ').join(' › ')}`));
    } else label.append(defaultLabel());
    btn.append(label, caret());
    btn.title = value ? [value.where, value.title].filter(Boolean).join(' › ').replaceAll(' > ', ' › ') : defaultLabel();
  };
  const set = (v, fire = true) => {
    value = v;
    paint();
    if (fire) onChange?.(v);
  };

  btn.addEventListener('click', () => {
    if (openPop?.anchor === btn) return closePop(false);
    const pop = el('div', 'surface-3 popover cx-search-pop');
    const input = el('input', 'field field-bare');
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    input.autocomplete = 'off';
    input.spellcheck = false;
    const list = el('ul', 'list');
    list.setAttribute('role', 'listbox');
    pop.append(input, el('div', 'popover-divider'), list);
    let items = [];
    let hi = 0;
    let seq = 0;
    const words = () => fold(input.value).split(/\s+/).filter(Boolean);
    // El trozo buscado, resaltado (como en el buscador de la web).
    const marked = (text) => {
      const frag = document.createDocumentFragment();
      const ws = words();
      if (!ws.length) {
        frag.append(text);
        return frag;
      }
      const f = fold(text);
      let at = 0;
      const marks = [];
      for (const w of ws) {
        const i = f.indexOf(w);
        if (i >= 0) marks.push([i, i + w.length]);
      }
      marks.sort((a, b) => a[0] - b[0]);
      for (const [s, e] of marks) {
        if (s < at) continue;
        frag.append(text.slice(at, s), el('mark', '', text.slice(s, e)));
        at = e;
      }
      frag.append(text.slice(at));
      return frag;
    };
    const renderList = () => {
      list.textContent = '';
      items.forEach((it, i) => {
        const li = el('li', 'list-item');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === hi));
        li.style.setProperty('--i', Math.min(i, 10));
        const hit = el('div', 'hit');
        const title = el('span', 'hit-title');
        if (it.id === null) {
          title.append(defaultLabel());
          title.append(el('span', 'hit-path', 'por defecto'));
        } else {
          title.append(marked(it.title || 'Nota sin título'));
          if (it.where) title.append(el('span', 'hit-path', it.where.split(' > ').join(' › ')));
        }
        hit.append(title);
        li.append(hit);
        if ((it.id ?? null) === (value?.id ?? null)) li.classList.add('is-current');
        li.addEventListener('mouseenter', () => {
          hi = i;
          for (const [k, n] of [...list.children].entries()) n.setAttribute('aria-selected', String(k === hi));
        });
        li.addEventListener('click', () => choose(it));
        list.append(li);
      });
      if (!items.length) list.append(el('li', 'list-item static', 'Ninguna nota con eso.'));
    };
    const choose = (it) => {
      set(it.id === null ? null : { id: it.id, title: it.title, where: it.where });
      closePop(true);
    };
    const run = async () => {
      const mine = ++seq;
      const q = input.value.trim();
      let hits = [];
      try {
        hits = (await search(q)).hits;
      } catch {
        hits = [];
      }
      if (mine !== seq) return;
      // Sin buscar: la de por defecto, la elegida y las últimas tocadas.
      items = q ? hits : [{ id: null }, ...(value ? [value] : []), ...hits.filter((h) => h.id !== value?.id)];
      hi = !q && value ? 1 : 0;
      renderList();
    };
    let timer = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    });
    input.addEventListener('keydown', (e) => {
      const n = items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!n) return;
        hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        renderList();
        list.children[hi]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[hi]) choose(items[hi]);
      } else if (e.key === 'Tab') closePop(false);
    });
    showPop(btn, pop, { width: Math.max(260, btn.getBoundingClientRect().width), ...opts });
    input.focus();
    run();
  });
  paint();
  return {
    el: btn,
    get value() {
      return value;
    },
    set: (v) => set(v, false),
    repaint: paint,
  };
}

// ── Desplegable de opciones (como el Combo de la web) ───────────────
// items: [{ id, label }]. Con 8 o más, lleva buscador.

export function combo({ items = [], value = null, placeholder = 'Elige…', label, onChange, className = '', ...opts } = {}) {
  let list = items;
  let current = value;
  const btn = el('button', `cv-select cv-combo cx-combo ${className}`.trim());
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (label) btn.setAttribute('aria-label', label);
  const paint = () => {
    const it = list.find((i) => i.id === current);
    btn.textContent = '';
    btn.classList.toggle('is-empty', !it);
    btn.append(el('span', 'bib-ellipsis', it?.label ?? placeholder), caret());
    btn.title = it?.label ?? placeholder;
  };
  btn.addEventListener('click', () => {
    if (openPop?.anchor === btn) return closePop(false);
    const pop = el('div', 'surface-3 popover cx-list-pop');
    const searchable = list.length >= 8;
    const input = searchable ? el('input', 'field field-bare') : null;
    const ul = el('ul', 'list');
    ul.setAttribute('role', 'listbox');
    ul.tabIndex = -1;
    if (input) {
      input.placeholder = 'Buscar…';
      input.setAttribute('aria-label', 'Buscar…');
      pop.append(input, el('div', 'popover-divider'));
    }
    pop.append(ul);
    let shown = list;
    let hi = Math.max(0, list.findIndex((i) => i.id === current));
    const render = () => {
      ul.textContent = '';
      shown.forEach((it, i) => {
        const li = el('li', 'list-item', it.label);
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === hi));
        if (it.id === current) li.classList.add('is-current');
        li.addEventListener('mouseenter', () => {
          hi = i;
          for (const [k, n] of [...ul.children].entries()) n.setAttribute('aria-selected', String(k === hi));
        });
        li.addEventListener('click', () => choose(it));
        ul.append(li);
      });
      if (!shown.length) ul.append(el('li', 'list-item static', 'Nada con eso.'));
    };
    const choose = (it) => {
      const changed = it.id !== current;
      current = it.id;
      paint();
      closePop(true);
      if (changed) onChange?.(it.id);
    };
    const keys = (e) => {
      const n = shown.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!n) return;
        hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        render();
        ul.children[hi]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (shown[hi]) choose(shown[hi]);
      } else if (e.key === 'Tab') closePop(false);
    };
    pop.addEventListener('keydown', keys);
    input?.addEventListener('input', () => {
      const q = fold(input.value.trim());
      shown = list.filter((i) => fold(i.label).includes(q));
      hi = 0;
      render();
    });
    render();
    showPop(btn, pop, { width: btn.getBoundingClientRect().width, ...opts });
    (input ?? ul).focus();
  });
  paint();
  return {
    el: btn,
    get value() {
      return current;
    },
    set: (v) => {
      current = v;
      paint();
    },
    setItems: (next) => {
      list = next;
      paint();
    },
  };
}
