/* ---------------------------------------------------------------------------
   DOM builders. Plain functions returning elements — no framework, no vdom,
   no templating. Build a tree, hand it to a container, replaceChildren().

   The pattern throughout: build → append → return, so calls compose:
     const c = card('Revenue', 'What this measures');
     chart(chartDiv(c), …);
     view.appendChild(c);
--------------------------------------------------------------------------- */
import * as C from './charts.js';

/** el('div', 'cls', 'text') — the workhorse. */
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * The ? affordance. Explanation lives in a tooltip so the card surface stays
 * clean — resist the urge to write a subtitle under every heading.
 */
export function infoBtn(title, body, cls = 'c-info') {
  const q = el('button', cls, '?');
  q.setAttribute('aria-label', 'What is this?');
  const show = (ev) => C.tipShow((tt) => {
    C.ttTitle(tt, title);
    tt.appendChild(el('div', 'tt-body', body));
  }, ev.clientX, ev.clientY);
  q.addEventListener('pointerenter', show);
  q.addEventListener('click', (ev) => { ev.stopPropagation(); show(ev); });
  q.addEventListener('pointerleave', C.tipHide);
  return q;
}

/**
 * card(title, info, visibleSub) — the standard container.
 * `info` becomes a ? tooltip; `visibleSub` is for genuinely dynamic text that
 * must stay on the surface (a live count, a warning), not for explanations.
 */
export function card(title, info, visibleSub) {
  const c = el('div', 'card');
  if (title) {
    const h = el('h3');
    h.appendChild(el('span', null, title));
    if (info) h.appendChild(infoBtn(title, info));
    c.appendChild(h);
  }
  if (visibleSub) c.appendChild(el('div', 'sub', visibleSub));
  return c;
}

/** A chart mount inside a card. Charts measure this element's width. */
export function chartDiv(c) { const d = el('div', 'chart'); c.appendChild(d); return d; }

/** Segmented control. options: [{value, label, dotColor?, badge?}] */
export function seg(options, active, onPick) {
  const s = el('div', 'seg');
  for (const o of options) {
    const b = el('button', o.value === active ? 'active' : '');
    if (o.dotColor) { const d = el('span', 'dot'); d.style.background = o.dotColor; b.appendChild(d); }
    b.appendChild(el('span', null, o.label));
    if (o.badge) b.appendChild(el('span', 'badge', o.badge));
    b.addEventListener('click', () => onPick(o.value));
    s.appendChild(b);
  }
  return s;
}

/** Float a segmented control into a card's header row (metric switchers). */
export function headerSeg(cardEl, options, active, onPick) {
  const s = seg(options, active, onPick);
  cardEl.insertBefore(s, cardEl.firstChild);
  s.style.cssText = 'float:right;margin-top:-2px';
  return s;
}

/**
 * Stat tile. Values centre themselves unless there's a delta line; a sparkline
 * pins flush to the bottom edge and the value centres above it.
 *   tile('Revenue', '$41.2k', { spark: series, sparkColor, info, delta, hero })
 */
export function tile(label, value, { hero, delta, spark, sparkColor, info } = {}) {
  const hasSpark = spark && spark.length > 1;
  const t = el('div', 'tile' + (!delta ? ' t-center' : '') + (hasSpark ? ' t-spark' : ''));
  t.appendChild(el('div', 't-label', label));
  t.appendChild(el('div', 't-value' + (hero ? ' hero' : ''), value));
  if (delta) {
    const d = el('div', 't-delta');
    if (typeof delta === 'string') d.textContent = delta; else d.appendChild(delta);
    t.appendChild(d);
  }
  if (hasSpark) C.sparkline(t, { values: spark, color: sparkColor || C.css('--s1'), stretch: true });
  if (info) t.appendChild(infoBtn(label, info, 't-info'));
  return t;
}

/** A row of tiles. tiles([...], 4) → .tiles (4-up, 2-up on narrow screens) */
export function tiles(list, cols = 4) {
  const row = el('div', 'tiles' + (cols === 3 ? ' t3' : cols === 2 ? ' t2' : ''));
  for (const t of list) row.appendChild(t);
  return row;
}

/** Circle-masked image, or an initial on the entity's accent colour. */
export function avatar({ name, color, src }, size = 20) {
  if (src) {
    const img = el('img', 'avatar');
    img.src = src;
    img.alt = '';
    img.style.width = img.style.height = size + 'px';
    return img;
  }
  const initial = ((name || '?').split(/[\s·]+/).filter(Boolean).pop() || '?')[0].toUpperCase();
  const d = el('span', 'avatar av-fallback', initial);
  d.style.width = d.style.height = d.style.lineHeight = size + 'px';
  d.style.background = color || C.css('--s1');
  d.style.fontSize = Math.round(size * 0.48) + 'px';
  return d;
}

/** Copy-to-clipboard button with its own confirmation state. */
export function copyBtn(getText, label = 'Copy') {
  const b = el('button', 'copy-btn', label);
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(typeof getText === 'function' ? getText() : getText);
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = label; }, 1200);
    } catch { b.textContent = 'Copy failed'; setTimeout(() => { b.textContent = label; }, 1200); }
  });
  return b;
}

/**
 * Data table.
 *   cols: [{ key, label, align?: 'left'|'right', fmt?, bar?: colorFn, cls? }]
 *   rows: array of objects; each may carry _color for the leading dot.
 * `bar` draws a magnitude bar behind the number — cheaper than a second chart.
 */
export function table(cols, rows, { compact, onRowClick, sortKey, onSort } = {}) {
  const t = el('table', 'dtable' + (compact ? ' compact' : '') + (onRowClick ? ' rows-clickable' : ''));
  const thead = el('thead'), tr = el('tr');
  for (const c of cols) {
    const th = el('th', [c.align === 'right' || c.num ? 'num' : '', onSort ? 'sortable' : '', c.key === sortKey ? 'hl' : ''].filter(Boolean).join(' '), c.label);
    if (onSort) th.addEventListener('click', () => onSort(c.key));
    tr.appendChild(th);
  }
  thead.appendChild(tr); t.appendChild(thead);
  const tb = el('tbody');
  const maxes = {};
  for (const c of cols) if (c.bar) maxes[c.key] = Math.max(...rows.map((r) => Number(r[c.key]) || 0), 1e-9);
  for (const r of rows) {
    const row = el('tr');
    for (const c of cols) {
      const td = el('td', [c.align === 'right' || c.num ? 'num' : '', c.key === sortKey ? 'hl' : '', c.bar ? 'bar-cell' : ''].filter(Boolean).join(' '));
      if (c.bar) {
        const bar = el('span', 'mini-bar');
        bar.style.width = (100 * (Number(r[c.key]) || 0) / maxes[c.key]) + '%';
        bar.style.background = typeof c.bar === 'function' ? c.bar(r) : c.bar;
        td.appendChild(bar);
      }
      const v = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
      if (v instanceof Node) td.appendChild(v); else td.appendChild(el('span', null, v == null ? '—' : String(v)));
      row.appendChild(td);
    }
    if (onRowClick) row.addEventListener('click', () => onRowClick(r));
    tb.appendChild(row);
  }
  t.appendChild(tb);
  return t;
}

/** Name cell with a colour dot — pairs with table(). */
export function entityCell(name, color, extra) {
  const s = el('span', 'u');
  if (color) { const d = el('span', 'dot'); d.style.background = color; s.appendChild(d); }
  s.appendChild(el('span', null, name));
  if (extra) s.appendChild(el('span', 'badge', extra));
  return s;
}

/** Empty state. */
export function empty(text) { return el('div', 'empty', text); }

/** One-line finding with an accent mark: insight('Peak spend', 'on Tuesdays') */
export function insight(strong, rest, mark = '▸') {
  const row = el('div', 'insight');
  row.appendChild(el('span', 'i-mark', mark));
  const body = el('span');
  body.appendChild(el('b', null, strong));
  if (rest) body.append(' ' + rest);
  row.appendChild(body);
  return row;
}

// ---------- sidebar filter primitives ----------
/** A labelled group in the sidebar. */
export function filterGroup(parent, label) {
  const g = el('div', 'fgroup');
  if (label) g.appendChild(el('div', 'flabel', label));
  parent.appendChild(g);
  return g;
}

/**
 * A clickable filter row. Leading mark, in precedence order:
 *   lead (any Node — an icon, a swatch) → avatar ({name,color,src}) → dotColor
 */
export function filterRow(group, { label, active, dotColor, avatar: av, lead, badge, onPick }) {
  const b = el('button', 'frow' + (active ? ' active' : ''));
  if (lead) b.appendChild(lead);
  else if (av) b.appendChild(avatar(av, 18));
  else if (dotColor) { const d = el('span', 'dot'); d.style.background = dotColor; b.appendChild(d); }
  b.appendChild(el('span', null, label));
  if (badge) b.appendChild(el('span', 'badge', badge));
  b.addEventListener('click', onPick);
  group.appendChild(b);
  return b;
}

/** A select control. options: [{value, label}] */
export function select(options, value, onChange, cls = 'ctl') {
  const s = el('select', cls);
  for (const o of options) {
    const opt = el('option', null, o.label);
    opt.value = o.value;
    s.appendChild(opt);
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
