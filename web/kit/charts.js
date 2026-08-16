/* ---------------------------------------------------------------------------
   Chart primitives — hand-rolled SVG, no library, no build step.

   House marks: thin marks, 4px rounded data-ends, 2px surface gaps between
   stacked segments, hairline grids, crosshair + unified tooltip on timelines,
   per-mark tooltips elsewhere. Colours always come from CSS tokens via css(),
   so charts re-theme for free — but you MUST re-render on theme change,
   because the values are read at draw time (the shell does this for you).

   Every chart takes (container, options) and replaces the container's content.
--------------------------------------------------------------------------- */
const NS = 'http://www.w3.org/2000/svg';

/** Read a CSS custom property off :root — e.g. css('--s1'). */
export function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// ---------- tooltip singleton ----------
// Created on first use so a host page needs no tooltip markup of its own.
let tip = null;
function tipEl() {
  if (!tip) {
    tip = document.getElementById('tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'tooltip';
      tip.className = 'tooltip';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
  }
  return tip;
}

/** Show the shared tooltip at viewport coords, filled by build(node). */
export function tipShow(build, x, y) {
  const t = tipEl();
  t.replaceChildren();
  build(t);
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let tx = x + 14, ty = y + 12;
  if (tx + r.width > innerWidth - 8) tx = x - r.width - 14;
  if (ty + r.height > innerHeight - 8) ty = y - r.height - 12;
  t.style.left = tx + 'px'; t.style.top = ty + 'px';
}
export function tipHide() { tipEl().hidden = true; }

export function ttTitle(parent, text) {
  const d = document.createElement('div');
  d.className = 'tt-title'; d.textContent = text; parent.appendChild(d);
}
export function ttRow(parent, { color, label, value }) {
  const row = document.createElement('div'); row.className = 'tt-row';
  if (color) { const k = document.createElement('span'); k.className = 'tt-key'; k.style.background = color; row.appendChild(k); }
  const l = document.createElement('span'); l.className = 'tt-lbl'; l.textContent = label; row.appendChild(l);
  const v = document.createElement('span'); v.className = 'tt-val'; v.textContent = value; row.appendChild(v);
  parent.appendChild(row);
}

// ---------- scales & colour ----------
/** Round an axis maximum up to a human number (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × 10ⁿ). */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function hexLerp(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/** The categorical ramp, in order. seriesColors(3) → ['#…s1','#…s2','#…s3'] */
export function seriesColors(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(css('--s' + ((i % 8) + 1)));
  return out;
}

// ---------- legend ----------
export function legend(container, series, kind = 'sw') {
  if (series.length < 2) return;
  const lg = document.createElement('div'); lg.className = 'legend';
  for (const s of series) {
    const li = document.createElement('span'); li.className = 'li';
    const sw = document.createElement('span'); sw.className = kind; sw.style.background = s.color;
    li.appendChild(sw);
    const t = document.createElement('span'); t.textContent = s.label; li.appendChild(t);
    lg.appendChild(li);
  }
  container.appendChild(lg);
}

/**
 * Timeline over dated buckets. Picks its own mark by density and mode:
 *   mode 'stack' (default) → stacked columns up to 92 buckets, stacked areas beyond
 *   mode 'lines'           → one line per series, dot on the latest value
 *
 * days:   [{ d: 'YYYY-MM-DD', values: { seriesKey: number } }]
 * series: [{ key, label, color }]
 * fmtVal: (v, isAxis) => string
 * xFmt:   optional (isoDate, totalBuckets) => string  — default DD/MM, MM/YYYY over 300
 */
export function timeline(container, { days, series, fmtVal, height = 210, mode = 'stack', xFmt, emptyText = 'No data in this window' }) {
  container.replaceChildren();
  const W = Math.max(320, container.clientWidth || 600);
  const H = height, padL = 44, padR = 8, padT = 10, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = days.length;
  if (!n) { container.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: emptyText })); return; }
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: 'display:block;max-width:100%', class: 'chart' }, container);

  const totals = days.map((d) => series.reduce((a, s) => a + (d.values[s.key] || 0), 0));
  const maxSingle = Math.max(...days.flatMap((d) => series.map((s) => d.values[s.key] || 0)), 1e-9);
  const maxV = niceMax(mode === 'lines' ? maxSingle : Math.max(...totals, 1e-9));
  const y = (v) => padT + ih - (v / maxV) * ih;
  const x = (i) => padL + (i + 0.5) * (iw / n);

  // hairline grid + y ticks
  for (let g = 0; g <= 3; g++) {
    const v = (maxV / 3) * g;
    svgEl('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), stroke: css('--grid'), 'stroke-width': 1 }, svg);
    svgEl('text', { x: padL - 6, y: y(v) + 3.5, 'text-anchor': 'end', class: 'axis-lbl' }, svg).textContent = fmtVal(v, true);
  }
  // ~6 x labels
  const fmtX = xFmt || ((d, total) => total > 300 ? `${d.slice(5, 7)}/${d.slice(0, 4)}` : `${d.slice(8, 10)}/${d.slice(5, 7)}`);
  const step = Math.max(1, Math.round(n / 6));
  for (let i = 0; i < n; i += step) {
    svgEl('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', class: 'axis-lbl' }, svg).textContent = fmtX(days[i].d, n);
  }

  const surface = css('--surface');
  if (mode === 'lines') {
    for (const s of series) {
      let dPath = '';
      days.forEach((d, i) => {
        const v = d.values[s.key] || 0;
        dPath += (i ? ' L' : 'M') + `${x(i)},${y(v)}`;
      });
      svgEl('path', { d: dPath, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      const lastV = days[n - 1].values[s.key] || 0;
      svgEl('circle', { cx: x(n - 1), cy: y(lastV), r: 4, fill: s.color, stroke: surface, 'stroke-width': 2 }, svg);
    }
  } else if (n <= 92) {
    const bw = Math.min(24, Math.max(2, (iw / n) - 2));
    days.forEach((d, i) => {
      let acc = 0;
      const segs = series.map((s) => ({ s, v: d.values[s.key] || 0 })).filter((o) => o.v > 0);
      segs.forEach((o, si) => {
        const y1 = y(acc + o.v), y0 = y(acc);
        const h = Math.max(0, y0 - y1 - (si < segs.length - 1 ? 2 : 0)); // 2px gap between segments
        const top = si === segs.length - 1;
        const r = top ? Math.min(4, bw / 2, h) : 0;
        const xx = x(i) - bw / 2;
        const path = top && r > 0
          ? `M${xx},${y0} L${xx},${y1 + r} Q${xx},${y1} ${xx + r},${y1} L${xx + bw - r},${y1} Q${xx + bw},${y1} ${xx + bw},${y1 + r} L${xx + bw},${y0} Z`
          : null;
        if (path) svgEl('path', { d: path, fill: o.s.color }, svg);
        else svgEl('rect', { x: xx, y: y1 + 2, width: bw, height: Math.max(0.5, y0 - y1 - 2), fill: o.s.color }, svg);
        acc += o.v;
      });
    });
  } else {
    // stacked areas: hue wash + 2px line on top of each band
    let base = days.map(() => 0);
    for (const s of series) {
      const top = days.map((d, i) => base[i] + (d.values[s.key] || 0));
      let dPath = `M${x(0)},${y(top[0])}`;
      for (let i = 1; i < n; i++) dPath += ` L${x(i)},${y(top[i])}`;
      let aPath = dPath;
      for (let i = n - 1; i >= 0; i--) aPath += ` L${x(i)},${y(base[i])}`;
      svgEl('path', { d: aPath + ' Z', fill: s.color, opacity: 0.18 }, svg);
      svgEl('path', { d: dPath, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      base = top;
    }
  }
  svgEl('line', { x1: padL, x2: W - padR, y1: y(0), y2: y(0), stroke: css('--baseline'), 'stroke-width': 1 }, svg);

  // crosshair + unified tooltip: one tooltip for the whole bucket, not per mark
  const hair = svgEl('line', { y1: padT, y2: padT + ih, stroke: css('--baseline'), 'stroke-width': 1, visibility: 'hidden' }, svg);
  const hit = svgEl('rect', { x: padL, y: padT, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - padL) / (iw / n))));
    hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i));
    hair.setAttribute('visibility', 'visible');
    tipShow((t) => {
      ttTitle(t, days[i].d);
      for (const s of series) {
        const v = days[i].values[s.key] || 0;
        if (v > 0 || mode === 'lines') ttRow(t, { color: s.color, label: s.label, value: fmtVal(v) });
      }
      if (series.length > 1 && mode !== 'lines') ttRow(t, { label: 'Total', value: fmtVal(totals[i]) });
    }, ev.clientX, ev.clientY);
  });
  hit.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); tipHide(); });
  legend(container, series);
}

/**
 * Calendar heatmap — one cell per day, weeks as columns.
 * byDay: { 'YYYY-MM-DD': number }
 */
export function calendar(container, { byDay, weeks = 26, fmtVal, label = 'value', locale = 'en-IE', endDate }) {
  container.replaceChildren();
  const cell = 13, gap = 3, padT = 16, padL = 26;
  const rows = 7;
  const today = endDate ? new Date(endDate) : new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  const start = new Date(end.getTime() - (weeks * 7 - 1) * 864e5);
  start.setDate(start.getDate() - start.getDay()); // align to Sunday
  const totalDays = Math.round((end - start) / 864e5) + 1;
  const nWeeks = Math.ceil(totalDays / 7);
  const W = padL + nWeeks * (cell + gap), H = padT + rows * (cell + gap) + 4;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: 'display:block;max-width:100%', class: 'chart' }, container);
  const lo = css('--seq-lo'), hi = css('--seq-hi');
  let max = 0;
  for (const v of Object.values(byDay)) max = Math.max(max, v);
  const dayNames = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  dayNames.forEach((d, i) => {
    if (d) svgEl('text', { x: padL - 5, y: padT + i * (cell + gap) + cell - 3, 'text-anchor': 'end', class: 'axis-lbl' }, svg).textContent = d;
  });
  let lastMonth = -1;
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start.getTime() + i * 864e5);
    if (d > end) break;
    const wk = Math.floor(i / 7), dow = d.getDay();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const v = byDay[key] || 0;
    const xx = padL + wk * (cell + gap), yy = padT + dow * (cell + gap);
    if (d.getMonth() !== lastMonth && dow === 0) {
      lastMonth = d.getMonth();
      svgEl('text', { x: xx, y: 10, class: 'axis-lbl' }, svg).textContent = d.toLocaleString(locale, { month: 'short' });
    }
    // gamma 0.55 so mid-range days stay distinguishable from the peak
    const fill = v === 0 || max === 0 ? css('--surface-2') : hexLerp(lo, hi, Math.pow(v / max, 0.55));
    const r = svgEl('rect', { x: xx, y: yy, width: cell, height: cell, rx: 3.5, fill }, svg);
    r.addEventListener('pointermove', (ev) => tipShow((t) => {
      ttTitle(t, d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
      ttRow(t, { label, value: fmtVal(v) });
    }, ev.clientX, ev.clientY));
    r.addEventListener('pointerleave', tipHide);
  }
}

/**
 * Horizontal bars, sorted by the caller. Rolls the tail into "Other (n)".
 * rows: [{ label, value, color, ...anything your tooltip needs }]
 */
export function hbars(container, { rows, fmtVal, height, maxRows = 8, tooltip, otherLabel = 'Other' }) {
  container.replaceChildren();
  const shown = rows.slice(0, maxRows);
  if (rows.length > maxRows) {
    const rest = rows.slice(maxRows);
    shown.push({ label: `${otherLabel} (${rest.length})`, value: rest.reduce((a, r) => a + r.value, 0), color: css('--muted'), _other: true });
  }
  const rowH = 30, padL = 8, padR = 60, labelW = Math.min(180, Math.max(90, (container.clientWidth || 500) * 0.3));
  const W = Math.max(320, container.clientWidth || 500);
  const H = height || shown.length * rowH + 6;
  const iw = W - padL - padR - labelW;
  const maxV = Math.max(...shown.map((r) => r.value), 1e-9);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: 'display:block;max-width:100%', class: 'chart' }, container);
  shown.forEach((r, i) => {
    const yy = i * rowH + 8;
    const bw = Math.max(2, (r.value / maxV) * iw);
    const t = svgEl('text', { x: padL + labelW - 10, y: yy + 10.5, 'text-anchor': 'end', class: 'axis-lbl', style: 'font-size:11.5px' }, svg);
    t.textContent = r.label.length > 24 ? r.label.slice(0, 23) + '…' : r.label;
    const bh = 14;
    const rr = Math.min(4, bw / 2);
    const x0 = padL + labelW;
    svgEl('path', {
      d: `M${x0},${yy} L${x0 + bw - rr},${yy} Q${x0 + bw},${yy} ${x0 + bw},${yy + rr} L${x0 + bw},${yy + bh - rr} Q${x0 + bw},${yy + bh} ${x0 + bw - rr},${yy + bh} L${x0},${yy + bh} Z`,
      fill: r.color,
    }, svg);
    svgEl('text', { x: x0 + bw + 7, y: yy + 11.5, class: 'bar-lbl' }, svg).textContent = fmtVal(r.value);
    const hit = svgEl('rect', { x: 0, y: i * rowH, width: W, height: rowH, fill: 'transparent' }, svg);
    if (tooltip) {
      hit.addEventListener('pointermove', (ev) => tipShow((t2) => tooltip(t2, r), ev.clientX, ev.clientY));
      hit.addEventListener('pointerleave', tipHide);
    }
  });
}

/**
 * Fixed 24-column profile — "when in the day does this happen".
 * values: number[24]. Peak column is full opacity and labelled.
 */
export function hours24(container, { values, fmtVal, height = 130, label = 'value' }) {
  container.replaceChildren();
  const W = Math.max(320, container.clientWidth || 500), H = height, padL = 8, padB = 18, padT = 14;
  const iw = W - padL * 2, ih = H - padB - padT;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: 'display:block;max-width:100%', class: 'chart' }, container);
  const maxV = Math.max(...values, 1e-9);
  const bw = Math.min(24, iw / 24 - 2);
  const peak = values.indexOf(maxV);
  const color = css('--s1');
  values.forEach((v, h) => {
    const xx = padL + h * (iw / 24) + (iw / 24 - bw) / 2;
    const bh = Math.max(v > 0 ? 2 : 0.5, (v / maxV) * ih);
    const yy = padT + ih - bh;
    const rr = Math.min(4, bw / 2, bh);
    svgEl('path', {
      d: `M${xx},${padT + ih} L${xx},${yy + rr} Q${xx},${yy} ${xx + rr},${yy} L${xx + bw - rr},${yy} Q${xx + bw},${yy} ${xx + bw},${yy + rr} L${xx + bw},${padT + ih} Z`,
      fill: color, opacity: h === peak ? 1 : 0.55,
    }, svg);
    if (h === peak) svgEl('text', { x: xx + bw / 2, y: yy - 4, 'text-anchor': 'middle', class: 'bar-lbl' }, svg).textContent = fmtVal(v);
    const hit = svgEl('rect', { x: padL + h * (iw / 24), y: 0, width: iw / 24, height: H, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (ev) => tipShow((t) => {
      ttTitle(t, `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`);
      ttRow(t, { label, value: fmtVal(v) });
    }, ev.clientX, ev.clientY));
    hit.addEventListener('pointerleave', tipHide);
  });
  svgEl('line', { x1: padL, x2: W - padL, y1: padT + ih, y2: padT + ih, stroke: css('--baseline'), 'stroke-width': 1 }, svg);
  for (const h of [0, 6, 12, 18, 23]) {
    svgEl('text', { x: padL + h * (iw / 24) + (iw / 24) / 2, y: H - 4, 'text-anchor': 'middle', class: 'axis-lbl' }, svg).textContent = `${h}`;
  }
}

/**
 * Dot plot — compare several series across the same categories on one scale.
 * Better than grouped bars when you want "who is highest on each row".
 *
 * rows:   [{ label, values: { seriesKey: number } }]
 * series: [{ key, name, color }]
 */
export function dotplot(container, { rows, series, height, max = 10, fmtTick = String, fmtVal }) {
  container.replaceChildren();
  const rowH = 34, padL = 110, padR = 24, padT = 18, padB = 6;
  const W = Math.max(320, container.clientWidth || 500);
  const H = height || rows.length * rowH + padT + padB;
  const iw = W - padL - padR;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: 'display:block;max-width:100%', class: 'chart' }, container);
  const x = (v) => padL + (v / max) * iw;
  fmtVal = fmtVal || ((v) => `${v.toFixed(1)} / ${max}`);
  for (const g of [0, max / 4, max / 2, (3 * max) / 4, max]) {
    svgEl('line', { x1: x(g), x2: x(g), y1: padT - 4, y2: H - padB, stroke: css('--grid'), 'stroke-width': 1 }, svg);
    svgEl('text', { x: x(g), y: 10, 'text-anchor': 'middle', class: 'axis-lbl' }, svg).textContent = fmtTick(g);
  }
  const surface = css('--surface');
  rows.forEach((c, i) => {
    const yy = padT + i * rowH + rowH / 2;
    svgEl('text', { x: padL - 10, y: yy + 3.5, 'text-anchor': 'end', class: 'axis-lbl', style: 'font-size:11.5px' }, svg).textContent = c.label;
    svgEl('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: css('--grid'), 'stroke-width': 1 }, svg);
    for (const s of series) {
      const v = c.values[s.key];
      if (v == null) continue;
      const vc = Math.min(v, max);
      svgEl('circle', { cx: x(vc), cy: yy, r: 6, fill: s.color, stroke: surface, 'stroke-width': 2 }, svg);
      const hit = svgEl('circle', { cx: x(vc), cy: yy, r: 13, fill: 'transparent' }, svg);
      hit.addEventListener('pointermove', (ev) => tipShow((t) => {
        ttTitle(t, c.label);
        ttRow(t, { color: s.color, label: s.name, value: fmtVal(v, c, s) });
      }, ev.clientX, ev.clientY));
      hit.addEventListener('pointerleave', tipHide);
    }
  });
  legend(container, series.map((s) => ({ label: s.name, color: s.color })));
}

/**
 * Sparkline. stretch:true fills the container width and pins flush to the
 * bottom edge — that is the variant the stat tile uses.
 */
export function sparkline(container, { values, color, w = 130, h = 30, stretch = false }) {
  if (!values || values.length < 2) return;
  const attrs = { viewBox: `0 0 ${w} ${h}`, width: w, height: h };
  if (stretch) { attrs.width = '100%'; attrs.preserveAspectRatio = 'none'; attrs.class = 'spark'; }
  const svg = svgEl('svg', attrs, container);
  const max = Math.max(...values, 1e-9);
  const x = (i) => (i / Math.max(1, values.length - 1)) * w;
  const y = (v) => h - 1 - (v / max) * (h - 6);
  let d = `M${x(0)},${y(values[0])}`;
  for (let i = 1; i < values.length; i++) d += ` L${x(i)},${y(values[i])}`;
  svgEl('path', { d: `${d} L${x(values.length - 1)},${h} L${x(0)},${h} Z`, fill: color, opacity: 0.12 }, svg);
  // non-scaling strokes stay crisp under the horizontal stretch
  svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }, svg);
  const lastX = x(values.length - 1), lastY = y(values[values.length - 1]);
  svgEl('circle', { cx: lastX, cy: lastY, r: 2.4, fill: color, stroke: css('--surface'), 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' }, svg);
}
