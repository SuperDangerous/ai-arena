import * as C from '/charts.js';

// ---------------- state ----------------
// One global scope drives every page: 'all' (everyone) or a user slug.
const state = {
  view: 'overview', scope: 'all', days: 30, tool: 'all', project: '',
  teamMetric: 'usd', userMetric: 'usd', modelMetric: 'tokens',
  libCat: '', libSort: 'score', libQuery: '', pubQuery: '', sessSort: 'usd',
};
let DATA = null;
let USERS = [];

const CAT_LABELS = {
  bugfix: 'QA', feature: 'Features', epic: 'Epics', testinfra: 'Test infra',
  workflow: 'Workflow', research: 'Research', ops: 'Ops', other: 'Other',
};
const TECH_LABELS = {
  persona: 'Persona framing', effort: 'Effort modifiers', plan: 'Plan-first', criteria: 'Success criteria',
  verify: 'Verification asks', anchors: 'Precise anchors', agents: 'Agent orchestration',
  refs: 'External references', examples: 'Concrete examples', scope: 'Scope guards',
};

// ---------------- formatting (en-IE locale; currency display is a preference) ----------------
const prefs = {
  currency: localStorage.getItem('arena-cur') || 'USD',
  fxEur: Number(localStorage.getItem('arena-fx')) || 0.86,
};
const fmt = {
  usd: (v, compact) => {
    const eur = prefs.currency === 'EUR';
    const sym = eur ? '€' : '$';
    if (eur) v = v * prefs.fxEur;
    if (compact && v >= 1000) return sym + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
    if (v >= 100) return sym + Math.round(v).toLocaleString('en-IE');
    return sym + v.toFixed(2);
  },
  tok: (v) => {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
  },
  num: (v) => Math.round(v).toLocaleString('en-IE'),
  pct: (v) => (v * 100).toFixed(0) + '%',
  date: (iso) => {
    const d = String(iso || '').slice(0, 10).split('-');
    return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : (iso || '');
  },
};
const metricFmt = { usd: fmt.usd, tokens: fmt.tok, prompts: fmt.num };
const metricLabel = { usd: 'API-equivalent cost', tokens: 'tokens', prompts: 'prompts' };

// ---------------- pricing (client mirror of lib/pricing.js) ----------------
let priceCache = new Map();
function priceFor(model) {
  if (priceCache.has(model)) return priceCache.get(model);
  const id = String(model || '').toLowerCase();
  let hit = DATA.pricing.default;
  for (const m of DATA.pricing.models) if (id.startsWith(m.match.toLowerCase())) { hit = m; break; }
  priceCache.set(model, hit);
  return hit;
}
function costOf(model, tk) {
  const p = priceFor(model), M = 1e6;
  const cached = tk.cachedIn || 0;
  return Math.max(0, (tk.in || 0) - cached) / M * (p.in || 0)
    + cached / M * (p.cacheRead || 0)
    + (tk.cr || 0) / M * (p.cacheRead || 0)
    + (tk.cw5m || 0) / M * (p.cacheWrite5m || 0)
    + (tk.cw1h || 0) / M * (p.cacheWrite1h != null ? p.cacheWrite1h : (p.cacheWrite5m || 0))
    + (tk.out || 0) / M * (p.out || 0);
}

// ---------------- window & filters ----------------
function windowKeys() {
  const end = new Date(); end.setHours(0, 0, 0, 0);
  let start;
  if (state.days > 0) start = new Date(end.getTime() - (state.days - 1) * 864e5);
  else {
    let min = null;
    for (const u of USERS) for (const s of u.sessions) for (const d of Object.keys(s.days)) if (!min || d < min) min = d;
    start = min ? new Date(min + 'T00:00:00') : end;
  }
  const keys = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 864e5) {
    const d = new Date(t);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return keys;
}
function sessionsOf(u) {
  return u.sessions.filter((s) =>
    (!s.kind || s.kind === 'interactive') &&
    (state.tool === 'all' || s.tool === state.tool) &&
    (!state.project || s.project === state.project));
}
function scopedUsers() {
  return state.scope === 'all' ? USERS : USERS.filter((u) => u.slug === state.scope);
}

// ---------------- aggregation (memoized) ----------------
const memo = new Map();
function filterKey() { return [state.days, state.tool, state.project].join('|'); }
function agg(u) {
  const key = u.slug + '::' + filterKey();
  if (memo.has(key)) return memo.get(key);
  const keys = windowKeys();
  const first = keys[0], last = keys[keys.length - 1];
  const daily = new Map(keys.map((k) => [k, { usd: 0, tokens: 0, prompts: 0, byTool: { claude: 0, codex: 0 } }]));
  const models = {}; const projects = {};
  let tk = { fresh: 0, cached: 0, cw: 0, out: 0 };
  let usd = 0, prompts = 0, nSess = 0, estimated = false;
  const hours = new Array(24).fill(0);
  const tech = {}; let techPrompts = 0, nudges = 0, imgs = 0, agentPrompts = 0, toolCalls = 0, promptChars = 0, promptWords = 0, compactions = 0;
  const effAgg = {}; // reasoning-effort level -> assistant msgs, across models
  const sessList = [];

  for (const s of sessionsOf(u)) {
    let sUsd = 0, sTok = 0, sPrompts = 0, touched = false;
    for (const [d, rec] of Object.entries(s.days)) {
      if (d < first || d > last) continue;
      touched = true;
      const day = daily.get(d);
      sPrompts += rec.p; prompts += rec.p;
      if (day) day.prompts += rec.p;
      for (const [m, t] of Object.entries(rec.m || {})) {
        const c = costOf(m, t);
        sUsd += c; usd += c;
        const cached = (t.cachedIn || 0) + (t.cr || 0);
        const total = (t.in || 0) + (t.cr || 0) + (t.cw5m || 0) + (t.cw1h || 0) + (t.out || 0);
        sTok += total;
        if (day) { day.usd += c; day.tokens += total; day.byTool[s.tool] = (day.byTool[s.tool] || 0) + c; }
        const mm = models[m] = models[m] || { usd: 0, in: 0, cached: 0, cw: 0, out: 0, eff: {} };
        mm.usd += c;
        mm.in += Math.max(0, (t.in || 0) - (t.cachedIn || 0));
        mm.cached += cached; mm.cw += (t.cw5m || 0) + (t.cw1h || 0); mm.out += t.out || 0;
        tk.fresh += Math.max(0, (t.in || 0) - (t.cachedIn || 0));
        tk.cached += cached; tk.cw += (t.cw5m || 0) + (t.cw1h || 0); tk.out += t.out || 0;
      }
    }
    if (!touched) continue;
    nSess++;
    if (s.estimated) estimated = true;
    // reasoning-effort mix rides on the session's full-model tallies
    for (const [m, t] of Object.entries(s.models || {})) {
      if (!t.eff) continue;
      const mm = models[m];
      for (const [lvl, n] of Object.entries(t.eff)) {
        effAgg[lvl] = (effAgg[lvl] || 0) + n;
        if (mm) mm.eff[lvl] = (mm.eff[lvl] || 0) + n;
      }
    }
    compactions += (s.slash && s.slash.compact) || 0;
    promptWords += s.promptWords || 0;
    const proj = projects[s.project || '(unknown)'] = projects[s.project || '(unknown)'] || { usd: 0, prompts: 0, sessions: 0 };
    proj.usd += sUsd; proj.prompts += sPrompts; proj.sessions++;
    s.hours.forEach((v, h) => { hours[h] += v; });
    for (const [k, v] of Object.entries(s.tech || {})) tech[k] = (tech[k] || 0) + v;
    techPrompts += s.counts.prompts;
    nudges += s.counts.nudges || 0; imgs += s.counts.imgs || 0;
    agentPrompts += s.counts.agentPrompts || 0; toolCalls += s.counts.tools || 0;
    promptChars += s.promptChars || 0;
    sessList.push({ s, usd: sUsd, tokens: sTok, prompts: sPrompts });
  }

  let activeDays = 0, longest = 0, run = 0;
  for (const k of keys) {
    const p = daily.get(k).prompts;
    if (p > 0) { activeDays++; run++; longest = Math.max(longest, run); } else run = 0;
  }
  const peakHour = hours.indexOf(Math.max(...hours));
  const out = {
    keys, daily, models, projects, tk, usd, prompts, nSess, hours, tech,
    techPrompts, nudges, imgs, agentPrompts, toolCalls, promptChars, promptWords, compactions, effAgg, sessList,
    activeDays, longest, peakHour, estimated,
    cacheHit: tk.cached / Math.max(1, tk.cached + tk.fresh),
    tokens: tk.fresh + tk.cached + tk.cw + tk.out,
  };
  memo.set(key, out);
  return out;
}

function effMix(eff) {
  const entries = Object.entries(eff || {}).sort((a, b) => b[1] - a[1]);
  const tot = entries.reduce((a, [, n]) => a + n, 0);
  if (!tot) return null;
  return entries.slice(0, 2).map(([l, n]) => `${l} ${Math.round(100 * n / tot)}%`).join(' · ');
}

function userScore(u) {
  let n = 0, sum = 0;
  for (const c of Object.values(u.prompts.categories || {})) { n += c.n; sum += c.sum; }
  return n ? sum / n : null;
}
function catAvgs(u) {
  const out = {};
  for (const [cat, c] of Object.entries(u.prompts.categories || {})) if (c.n) out[cat] = { avg: c.sum / c.n, n: c.n };
  return out;
}

// ---------------- DOM helpers ----------------
const view = document.getElementById('view');
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
// info renders as a ? tooltip beside the title (keeps card surfaces clean);
// visibleSub is for genuinely dynamic content that must stay on the surface
function card(title, info, visibleSub) {
  const c = el('div', 'card');
  if (title) {
    const h = el('h3');
    h.appendChild(el('span', null, title));
    if (info) {
      const q = el('button', 'c-info', '?');
      q.setAttribute('aria-label', 'What is this?');
      const show = (ev) => C.tipShow((tt) => { C.ttTitle(tt, title); tt.appendChild(el('div', 'tt-body', info)); }, ev.clientX, ev.clientY);
      q.addEventListener('pointerenter', show);
      q.addEventListener('click', (ev) => { ev.stopPropagation(); show(ev); });
      q.addEventListener('pointerleave', C.tipHide);
      h.appendChild(q);
    }
    c.appendChild(h);
  }
  if (visibleSub) c.appendChild(el('div', 'sub', visibleSub));
  return c;
}
function chartDiv(c) { const d = el('div', 'chart'); c.appendChild(d); return d; }
function seg(options, active, onPick) {
  const s = el('div', 'seg');
  for (const o of options) {
    const b = el('button', o.value === active ? 'active' : '');
    if (o.dotColor) { const d = el('span', 'dot'); d.style.background = o.dotColor; b.appendChild(d); }
    b.appendChild(el('span', null, o.label));
    if (o.demo) b.appendChild(el('span', 'demo-tag', 'DEMO'));
    b.addEventListener('click', () => onPick(o.value));
    s.appendChild(b);
  }
  return s;
}
function headerSeg(cardEl, options, active, onPick) {
  const s = seg(options, active, onPick);
  cardEl.insertBefore(s, cardEl.firstChild);
  s.style.cssText = 'float:right;margin-top:-2px';
}
function tile(label, value, { hero, delta, spark, sparkColor, info } = {}) {
  const hasSpark = spark && spark.length > 1;
  // values centre themselves (above the sparkline when there is one)
  const t = el('div', 'tile' + (!delta ? ' t-center' : '') + (hasSpark ? ' t-spark' : ''));
  t.appendChild(el('div', 't-label', label));
  t.appendChild(el('div', 't-value' + (hero ? ' hero' : ''), value));
  if (delta) t.appendChild(el('div', 't-delta', delta));
  if (hasSpark) C.sparkline(t, { values: spark, color: sparkColor || C.css('--s1'), stretch: true });
  if (info) {
    const q = el('button', 't-info', '?');
    q.setAttribute('aria-label', 'What is this?');
    const show = (ev) => C.tipShow((tt) => { C.ttTitle(tt, label); tt.appendChild(el('div', 'tt-body', info)); }, ev.clientX, ev.clientY);
    q.addEventListener('pointerenter', show);
    q.addEventListener('click', show);
    q.addEventListener('pointerleave', C.tipHide);
    t.appendChild(q);
  }
  return t;
}

// real money not spent because input came from cache instead of fresh
function cacheSavings(models) {
  let usd = 0;
  for (const [m, r] of Object.entries(models)) {
    const p = priceFor(m);
    usd += (r.cached || 0) / 1e6 * Math.max(0, (p.in || 0) - (p.cacheRead || 0));
  }
  return usd;
}

// rough energy estimate from editable factors in pricing.json — always shown as ≈
function energyWh(tk) {
  const e = DATA.pricing.energy || { whPerMTokIn: 60, whPerMTokCached: 6, whPerMTokOut: 400 };
  return (tk.fresh + tk.cw) / 1e6 * e.whPerMTokIn + tk.cached / 1e6 * e.whPerMTokCached + tk.out / 1e6 * e.whPerMTokOut;
}
function fmtEnergy(wh) {
  if (wh >= 100000) return Math.round(wh / 1000) + ' kWh';
  if (wh >= 1000) return (wh / 1000).toFixed(1) + ' kWh';
  return Math.round(wh) + ' Wh';
}
// Circle-masked profile photo; falls back to an initial on the user's accent.
function avatarEl(u, size = 20) {
  if (u.profile && u.profile.avatar) {
    const img = el('img', 'avatar');
    img.src = `/data/${u.slug}/${u.profile.avatar}`;
    img.alt = '';
    img.style.width = img.style.height = size + 'px';
    return img;
  }
  const initial = ((u.name || '?').split(/[\s·]+/).filter(Boolean).pop() || '?')[0].toUpperCase();
  const d = el('span', 'avatar av-fallback', initial);
  d.style.width = d.style.height = d.style.lineHeight = size + 'px';
  d.style.background = u.color;
  d.style.fontSize = Math.round(size * 0.48) + 'px';
  return d;
}
function toolIcon(tool, size = 14) {
  const img = el('img', 'tico tico-' + tool);
  img.src = `/assets/${tool}.png`;
  img.alt = tool;
  img.style.width = img.style.height = size + 'px';
  return img;
}

// ---------------- shared chart blocks ----------------
function modelMixCard(models, subWhenTok) {
  const byTok = state.modelMetric === 'tokens';
  const mc = card('Model mix', byTok
    ? 'Total tokens per model: fresh input + cached input + cache writes + output. Hover a bar for the full breakdown, estimated spend, and the reasoning-effort mix used with that model.'
    : 'API-equivalent spend per model at list prices. ≈ marks models whose prices are unverified guesses (editable in pricing.json). Hover for the token breakdown and effort mix.');
  headerSeg(mc, [{ value: 'tokens', label: 'Tokens' }, { value: 'usd', label: 'Cost' }], state.modelMetric, (v) => { state.modelMetric = v; render(); });
  const mcc = chartDiv(mc);
  C.hbars(mcc, {
    rows: Object.entries(models).map(([m, r]) => ({
      label: (!byTok && priceFor(m).guess ? '≈ ' : '') + m,
      value: byTok ? r.in + r.cached + r.cw + r.out : r.usd,
      color: C.css(m.startsWith('gpt') || m.startsWith('o') || m.startsWith('codex') ? '--codex' : '--claude'),
      _r: r, _m: m,
    })).sort((x, y) => y.value - x.value),
    fmtVal: (v) => byTok ? fmt.tok(v) : fmt.usd(v, true),
    tooltip: (t, r) => {
      C.ttTitle(t, r._m || r.label);
      if (r._r) {
        C.ttRow(t, { label: 'fresh input', value: fmt.tok(r._r.in) });
        C.ttRow(t, { label: 'cached input', value: fmt.tok(r._r.cached) });
        C.ttRow(t, { label: 'cache write', value: fmt.tok(r._r.cw) });
        C.ttRow(t, { label: 'output', value: fmt.tok(r._r.out) });
        C.ttRow(t, { label: 'est. spend', value: fmt.usd(r._r.usd) });
        const mix = effMix(r._r.eff);
        if (mix) C.ttRow(t, { label: 'effort', value: mix });
      }
    },
  });
  C.legend(mc, [{ label: 'Claude', color: C.css('--claude') }, { label: 'Codex', color: C.css('--codex') }]);
  return mc;
}

// staleness chip for patchy team data — sessions merge forever, but a profile
// nobody has refreshed deserves a visible age tag
function staleTag(u) {
  const at = Date.parse(u.profile.updatedAt || u.profile.lastSeen || 0);
  if (!at) return null;
  const days = Math.floor((Date.now() - at) / 864e5);
  if (days < 21) return null;
  const t = el('span', 'demo-tag', `${days}d old`);
  t.title = `Last analysis ${fmt.date(u.profile.updatedAt)} — stats may be missing recent work`;
  return t;
}


// copyable templates, each headed by the trait it demonstrates
function templatesBlock(u) {
  const frag = document.createDocumentFragment();
  const h = u.habits;
  if (!h.templates || !h.templates.length) return frag;
  for (const t of h.templates) {
    const linked = t.trait && h.traits.find((x) => x.title.toLowerCase() === t.trait.toLowerCase());
    const box = el('div', 'tmpl');
    const bh = el('div', 'tmpl-title');
    bh.appendChild(el('span', null, linked ? linked.title : t.title));
    const copy = el('button', 'p-copy', 'Copy');
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(t.prompt).then(() => { copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); });
    });
    bh.appendChild(copy);
    box.appendChild(bh);
    box.appendChild(el('div', 'tmpl-body', t.prompt));
    frag.appendChild(box);
  }
  return frag;
}

// trait review rows for publishing — same clean language as the Habits
// section: title + Remove, with the verbatim quotes that need eyeballs
function traitsReview(u, { curate: canCurate } = {}) {
  const frag = document.createDocumentFragment();
  for (const [i, t] of u.habits.traits.entries()) {
    const row = el('div', 'tmpl');
    const head = el('div', 'tmpl-title');
    head.appendChild(el('span', null, t.title));
    if (canCurate) {
      const rm = el('button', 'p-copy', 'Remove');
      rm.addEventListener('click', async () => {
        const res = await fetch('/api/habit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: i }) }).then((r) => r.json()).catch(() => ({ ok: false }));
        if (res.ok) { u.habits.traits.splice(i, 1); if (!DATA.git.dirty.includes(DATA.me)) DATA.git.dirty.push(DATA.me); updateSetupDot(); render(); }
      });
      head.appendChild(rm);
    }
    row.appendChild(head);
    for (const ev of t.evidence || []) row.appendChild(el('div', 'habit-quote', '“' + ev.quote + '”'));
    frag.appendChild(row);
  }
  return frag;
}


function craftDotplot(users) {
  const scored = users.filter((u) => userScore(u) != null);
  if (scored.length < 1) return null;
  const dp = card('Prompt craft by category', 'avg AI-graded score, 0–10 — hover for sample sizes');
  const dpc = chartDiv(dp);
  const cats = Object.keys(CAT_LABELS).filter((c) => scored.some((u) => catAvgs(u)[c]));
  C.dotplot(dpc, {
    cats: cats.map((c) => ({
      label: CAT_LABELS[c],
      scores: Object.fromEntries(scored.map((u) => [u.slug, catAvgs(u)[c]?.avg]).filter(([, v]) => v != null)),
      counts: Object.fromEntries(scored.map((u) => [u.slug, catAvgs(u)[c]?.n || 0])),
    })),
    users: scored.map((u) => ({ slug: u.slug, name: u.name, color: u.color })),
    fmtVal: (v, c, u) => `${v.toFixed(1)} / 10 · n=${c.counts[u.slug] || 0}`,
  });
  return dp;
}

function techniqueDotplot(users) {
  const techUsers = users.filter((u) => agg(u).techPrompts > 20);
  if (!techUsers.length) return null;
  const tc = card('Technique adoption', '% of prompts using each technique');
  const tcc = chartDiv(tc);
  const topTech = Object.keys(TECH_LABELS).map((t) => ({
    t, max: Math.max(...techUsers.map((u) => (agg(u).tech[t] || 0) / agg(u).techPrompts)),
  })).sort((a, b) => b.max - a.max).slice(0, 7).map((o) => o.t);
  C.dotplot(tcc, {
    cats: topTech.map((t) => ({
      label: TECH_LABELS[t],
      scores: Object.fromEntries(techUsers.map((u) => [u.slug, 100 * (agg(u).tech[t] || 0) / agg(u).techPrompts])),
      counts: {},
    })),
    users: techUsers.map((u) => ({ slug: u.slug, name: u.name, color: u.color })),
    max: Math.min(100, Math.ceil(Math.max(1, ...topTech.flatMap((t) => techUsers.map((u) => 100 * (agg(u).tech[t] || 0) / agg(u).techPrompts))) / 10) * 10 + 10),
    fmtTick: (v) => v + '%',
    fmtVal: (v) => v.toFixed(1) + '% of prompts',
  });
  return tc;
}

// ---------------- overview: everyone ----------------
function renderTeamOverview() {
  const active = USERS.filter((u) => agg(u).nSess > 0);
  const wk = windowKeys();

  const tiles = el('div', 'tiles');
  const totUsd = active.reduce((a, u) => a + agg(u).usd, 0);
  const totTok = active.reduce((a, u) => a + agg(u).tokens, 0);
  const totPrompts = active.reduce((a, u) => a + agg(u).prompts, 0);
  const totSess = active.reduce((a, u) => a + agg(u).nSess, 0);
  const teamDaily = wk.map((k) => active.reduce((a, u) => a + agg(u).daily.get(k).usd, 0));
  const est = active.some((u) => agg(u).estimated);
  tiles.appendChild(tile('Team spend', (est ? '≈' : '') + fmt.usd(totUsd, true), {
    hero: true, spark: teamDaily,
    info: 'What this usage would bill at API list prices (pricing.json). Most of the team is on subscriptions, so read it as value extracted, not money spent.',
  }));
  tiles.appendChild(tile('Tokens', fmt.tok(totTok), { info: 'Everything processed: fresh input, cached input, cache writes, and generated output.' }));
  tiles.appendChild(tile('Prompts', fmt.num(totPrompts)));
  tiles.appendChild(tile('Sessions', fmt.num(totSess)));
  const totSaved = active.reduce((s, u) => s + cacheSavings(agg(u).models), 0);
  tiles.appendChild(tile('Cache savings', '≈' + fmt.usd(totSaved, true), {
    info: 'Both CLIs re-send your whole session context on every call, and repeated context bills at ~10% of the fresh rate (prompt caching — automatic, not something you manage). This is the difference. It grows with long, steadily-iterated sessions, and shrinks with fresh starts and idle gaps that let the cache expire (5 min–1 h).',
  }));
  const totWh = active.reduce((s, u) => { const a2 = agg(u); return s + energyWh(a2.tk); }, 0);
  tiles.appendChild(tile('Energy', '≈' + fmtEnergy(totWh), {
    info: 'Rough estimate — no vendor publishes per-token energy. Computed from editable Wh-per-million-token factors in pricing.json, anchored to the few public per-prompt disclosures. Directional only.',
  }));
  const allDepths = active.flatMap((u) => agg(u).sessList.map((x) => x.prompts)).filter((n) => n > 0).sort((x, y) => x - y);
  const medDepth = allDepths.length ? allDepths[Math.floor(allDepths.length / 2)] : 0;
  tiles.appendChild(tile('Median session depth', fmt.num(medDepth), {
    info: 'Median prompts per session. High depth means long collaborative threads (which is also what drives cache savings); low depth means many fresh starts.',
  }));
  const teamActiveDays = Math.max(...active.map((u) => agg(u).activeDays), 0);
  const costPerDay = teamActiveDays ? totUsd / teamActiveDays : 0;
  tiles.appendChild(tile('Cost / active day', (est ? '≈' : '') + fmt.usd(costPerDay, true), {
    info: 'Team spend divided by the number of days with at least one prompt — the burn rate, normalized for patchy attendance.',
  }));
  view.appendChild(tiles);

  const tl = card('Daily activity by teammate', 'Each bar is one day, stacked by teammate. Toggle Cost / Tokens / Prompts top-right. Costs are API-equivalent at list prices — value extracted, not money spent.');
  headerSeg(tl, [{ value: 'usd', label: 'Cost' }, { value: 'tokens', label: 'Tokens' }, { value: 'prompts', label: 'Prompts' }], state.teamMetric, (v) => { state.teamMetric = v; render(); });
  const tlChart = chartDiv(tl);
  view.appendChild(tl);
  C.timeline(tlChart, {
    days: wk.map((k) => ({ d: k, values: Object.fromEntries(active.map((u) => [u.slug, agg(u).daily.get(k)[state.teamMetric]])) })),
    series: active.map((u) => ({ key: u.slug, label: u.name, color: u.color })),
    fmtVal: metricFmt[state.teamMetric],
    height: 240,
  });

  const mm = {};
  for (const u of active) for (const [m, t] of Object.entries(agg(u).models)) {
    const r = mm[m] = mm[m] || { usd: 0, in: 0, cached: 0, cw: 0, out: 0, eff: {} };
    r.usd += t.usd; r.in += t.in; r.cached += t.cached; r.cw += t.cw; r.out += t.out;
    for (const [lvl, n] of Object.entries(t.eff || {})) r.eff[lvl] = (r.eff[lvl] || 0) + n;
  }
  view.appendChild(modelMixCard(mm));

  const lb = card('Leaderboard', 'Everyone who has published data, ranked by spend in the window. Cache hit is the share of input served from cache; Prompt score is their AI-graded craft average (0–10). Click a row to scope the whole dashboard to that person.');
  const tbl = el('table', 'lb');
  const thead = el('thead'); const hr = el('tr');
  for (const h of ['Teammate', 'Cost', 'Tokens', 'Prompts', 'Sessions', 'Active days', 'Best streak', 'Cache hit', 'Prompt score']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr); tbl.appendChild(thead);
  const tbody = el('tbody');
  const ranked = [...active].sort((a, b) => agg(b).usd - agg(a).usd);
  const maxUsd = Math.max(...ranked.map((u) => agg(u).usd), 1e-9);
  for (const u of ranked) {
    const a = agg(u); const score = userScore(u);
    const tr = el('tr');
    const td0 = el('td');
    const uspan = el('span', 'u'); uspan.appendChild(avatarEl(u, 22)); uspan.appendChild(el('span', null, u.name));
    if (u.demo) uspan.appendChild(el('span', 'demo-tag', 'DEMO'));
    const st = staleTag(u); if (st) uspan.appendChild(st);
    td0.appendChild(uspan); tr.appendChild(td0);
    const costTd = el('td', 'bar-cell');
    const mini = el('span', 'mini-bar'); mini.style.width = (a.usd / maxUsd * 100) + '%'; mini.style.background = u.color;
    costTd.appendChild(mini); costTd.appendChild(el('span', null, (a.estimated ? '≈' : '') + fmt.usd(a.usd, true)));
    tr.appendChild(costTd);
    for (const v of [fmt.tok(a.tokens), fmt.num(a.prompts), fmt.num(a.nSess), String(a.activeDays), a.longest + 'd', fmt.pct(a.cacheHit), score ? score.toFixed(1) : '—']) tr.appendChild(el('td', null, v));
    tr.addEventListener('click', () => setScope(u.slug));
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody); lb.appendChild(tbl); view.appendChild(lb);

  renderHabitsSection(active);
}

// habits: technique profiles + stealable templates, project-agnostic —
// the "learn from each other" surface. One shape everywhere: the person
// filter just narrows whose rows appear.
function renderHabitsSection(users) {
  const withHabits = users.filter((u) => u.habits && u.habits.traits && u.habits.traits.length);
  if (!withHabits.length) return;
  const pb = card('Habits', 'A frontier model reads each person\'s prompt sequences — whole sessions, in order — and distils how they work: a summary plus copyable prompt templates in their voice, with project specifics replaced by <placeholders>. Copy a template to replicate the technique.');
  for (const u of withHabits) {
    const row = el('div', 'pb-row');
    const who = el('button', 'pb-who');
    who.appendChild(avatarEl(u, 26));
    who.appendChild(el('b', null, u.name));
    who.addEventListener('click', () => setScope(u.slug));
    row.appendChild(who);
    const body = el('div', 'pb-body');
    if (u.habits.summary) body.appendChild(el('div', 'pb-summary', u.habits.summary));
    body.appendChild(templatesBlock(u));
    row.appendChild(body);
    pb.appendChild(row);
  }
  view.appendChild(pb);
}

// ---------------- overview: one user ----------------
function insightsFor(u) {
  const a = agg(u);
  const others = USERS.filter((o) => o !== u && agg(o).techPrompts > 20);
  const bullets = [];
  const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

  const standouts = [];
  for (const t of Object.keys(TECH_LABELS)) {
    const mine = (a.tech[t] || 0) / Math.max(1, a.techPrompts);
    if (mine < 0.04) continue;
    const med = median(others.map((o) => (agg(o).tech[t] || 0) / Math.max(1, agg(o).techPrompts)));
    standouts.push({ t, mine, ratio: med > 0.005 ? mine / med : Infinity });
  }
  standouts.sort((x, y) => y.ratio - x.ratio);
  for (const s of standouts.slice(0, 2)) {
    const ratioTxt = s.ratio === Infinity ? 'rare on the team' : s.ratio >= 1.15 ? `${s.ratio.toFixed(1)}× the team median` : null;
    bullets.push([`${TECH_LABELS[s.t]}`, ` in ${(s.mine * 100).toFixed(0)}% of prompts${ratioTxt ? ` — ${ratioTxt}` : ''}`]);
  }
  if (a.prompts > 10) {
    const wkend = (() => { let we = 0, tot = 0; for (const k of a.keys) { const p = a.daily.get(k).prompts; tot += p; const d = new Date(k + 'T12:00').getDay(); if (d === 0 || d === 6) we += p; } return tot ? we / tot : 0; })();
    bullets.push([`Peak hour ${String(a.peakHour).padStart(2, '0')}:00`, ` · ${(wkend * 100).toFixed(0)}% of prompts on weekends · best streak ${a.longest} days`]);
  }
  if (a.nSess > 3) {
    const depth = a.techPrompts / Math.max(1, a.nSess);
    const nudge = a.nudges / Math.max(1, a.techPrompts);
    bullets.push([`${depth.toFixed(0)} prompts per session`, ` · ${(nudge * 100).toFixed(0)}% are short nudges · ${(a.toolCalls / Math.max(1, a.techPrompts)).toFixed(0)} tool calls per prompt`]);
  }
  bullets.push([`${(a.cacheHit * 100).toFixed(0)}% cache hit rate`, a.activeDays ? ` · ${fmt.usd(a.usd / a.activeDays, true)} per active day` : '']);
  if (a.agentPrompts > 5) bullets.push([`Delegates to subagents`, ` — ${fmt.num(a.agentPrompts)} agent prompts alongside ${fmt.num(a.techPrompts)} of their own`]);
  if (a.imgs > 3) bullets.push([`Shows, doesn't tell`, ` — ${fmt.num(a.imgs)} screenshots/images pasted into prompts`]);
  return bullets.slice(0, 6);
}

function renderUserOverview(u) {
  const a = agg(u);
  const wk = a.keys;
  const est = a.estimated ? '≈' : '';

  const tiles = el('div', 'tiles');
  tiles.appendChild(tile('Spend', est + fmt.usd(a.usd, true), {
    hero: true, spark: wk.map((k) => a.daily.get(k).usd), sparkColor: u.color,
    info: 'What this usage would bill at API list prices (pricing.json) — value extracted, not money spent.',
  }));
  tiles.appendChild(tile('Tokens', fmt.tok(a.tokens), { info: `Everything processed: fresh input, cached input, cache writes, and output (${fmt.tok(a.tk.out)} generated).` }));
  tiles.appendChild(tile('Prompts', fmt.num(a.prompts), { info: `Across ${fmt.num(a.nSess)} sessions in this window.` }));
  tiles.appendChild(tile('Active days', `${a.activeDays}/${wk.length}`, { info: `Days with at least one prompt. Best streak: ${a.longest} consecutive days.` }));
  tiles.appendChild(tile('Peak hour', a.prompts ? `${String(a.peakHour).padStart(2, '0')}:00` : '—'));
  tiles.appendChild(tile('Cache hit', fmt.pct(a.cacheHit), {
    info: 'Share of input served from cache at ~10% of the fresh rate. Automatic — driven by long, steadily-iterated sessions rather than fresh starts.',
  }));
  view.appendChild(tiles);

  const tl = card('Daily ' + metricLabel[state.userMetric], 'Each bar is one day, stacked by tool (Claude vs Codex). Toggle Cost / Tokens / Prompts top-right.');
  headerSeg(tl, [{ value: 'usd', label: 'Cost' }, { value: 'tokens', label: 'Tokens' }, { value: 'prompts', label: 'Prompts' }], state.userMetric, (v) => { state.userMetric = v; render(); });
  const tlc = chartDiv(tl); view.appendChild(tl);
  const tools = ['claude', 'codex'].filter((t) => a.sessList.some(({ s }) => s.tool === t));
  C.timeline(tlc, {
    days: wk.map((k) => {
      const vals = {};
      for (const t of tools) vals[t] = 0;
      if (state.userMetric === 'usd') {
        const day = a.daily.get(k);
        for (const t of tools) vals[t] = day.byTool[t] || 0;
      } else {
        for (const { s } of a.sessList) {
          const rec = s.days[k]; if (!rec) continue;
          if (state.userMetric === 'prompts') vals[s.tool] += rec.p;
          else for (const t2 of Object.values(rec.m || {})) vals[s.tool] += (t2.in || 0) + (t2.cr || 0) + (t2.cw5m || 0) + (t2.cw1h || 0) + (t2.out || 0);
        }
      }
      return { d: k, values: vals };
    }),
    series: tools.map((t) => ({ key: t, label: t === 'claude' ? 'Claude' : 'Codex', color: C.css(t === 'claude' ? '--claude' : '--codex') })),
    fmtVal: metricFmt[state.userMetric],
    height: 230,
  });

  const g1 = el('div', 'grid g23');
  const cal = card('Activity calendar', 'One cell per day over the last six months — darker means more prompts. Deliberately ignores the date filter so the long-term rhythm (streaks, gaps, weekend habits) is always visible.');
  const calc = chartDiv(cal); g1.appendChild(cal);
  const hrs = card('Hour of day', 'When prompts are written, by local hour, within the selected window. The peak hour is labelled; the shape shows morning-vs-evening working style.');
  const hrc = chartDiv(hrs); g1.appendChild(hrs);
  view.appendChild(g1);
  const byDay = {};
  for (const s of sessionsOf(u)) for (const [d, rec] of Object.entries(s.days)) byDay[d] = (byDay[d] || 0) + rec.p;
  C.calendar(calc, { byDay, weeks: 26, fmtVal: fmt.num });
  C.hours24(hrc, { hours: a.hours, fmtVal: fmt.num });

  const g2 = el('div', 'grid g2');
  g2.appendChild(modelMixCard(a.models, 'total tokens in this window'));
  const pc = card('Projects', 'Spend per project in this window. Worktree checkouts and repo subfolders roll up to their git repo, so this is genuinely per-project. Hover for prompts and sessions.');
  const pcc = chartDiv(pc); g2.appendChild(pc);
  C.hbars(pcc, {
    rows: Object.entries(a.projects).sort((x, y) => y[1].usd - x[1].usd).map(([p, r]) => ({
      label: p, value: r.usd, color: u.color, _r: r,
    })),
    fmtVal: (v) => fmt.usd(v, true),
    tooltip: (t, r) => {
      C.ttTitle(t, r.label);
      C.ttRow(t, { label: 'spend', value: fmt.usd(r.value) });
      if (r._r) { C.ttRow(t, { label: 'prompts', value: fmt.num(r._r.prompts) }); C.ttRow(t, { label: 'sessions', value: fmt.num(r._r.sessions) }); }
    },
  });
  view.appendChild(g2);

  const g3 = el('div', 'grid g2');
  const avgs = catAvgs(u);
  if (Object.keys(avgs).length) {
    const sc = card('Prompt craft',
      'Average AI-graded score per category (0–10), from the shared rubric in About. Trivial asks cap at 5 by design, so mid-range averages are normal; ≥7 becomes a shared example.',
      `overall ${userScore(u).toFixed(1)}/10`);
    const scc = chartDiv(sc); g3.appendChild(sc);
    C.scoreBars(scc, {
      cats: Object.entries(avgs).sort((x, y) => y[1].avg - x[1].avg).map(([c, v]) => ({ label: CAT_LABELS[c], avg: v.avg, n: v.n })),
      color: u.color,
    });
    const runs = u.prompts.gradeRuns || [];
    if (runs.length) sc.appendChild(el('div', 'mini-hint', `graded ${Object.values(u.prompts.categories).reduce((x, c) => x + c.n, 0)} prompts over ${runs.length} run${runs.length > 1 ? 's' : ''} · rubric in About`));
  } else {
    const sc = card('Prompt craft', 'not graded yet');
    sc.appendChild(el('div', 'empty', u.slug === DATA.me ? 'Run: node arena.js grade' : 'This teammate hasn\'t published grades yet'));
    g3.appendChild(sc);
  }
  const ins = card('Signature moves', 'Deterministic signals (regex technique detection, timing, token accounting) compared against the team median — no AI judgement involved. The Habits section below is the AI-read counterpart.');
  const insWrap = el('div', 'insights');
  for (const [b, rest] of insightsFor(u)) {
    const row = el('div', 'insight');
    row.appendChild(el('span', 'i-mark', '◆'));
    const span = el('span');
    span.appendChild(el('b', null, b)); span.append(rest);
    row.appendChild(span);
    insWrap.appendChild(row);
  }
  ins.appendChild(insWrap); g3.appendChild(ins);
  view.appendChild(g3);

  renderHabitsSection([u]);

  // best prompts preview — flat: one heading row + one text box per prompt
  const ex = Object.entries(u.prompts.exemplars || {}).flatMap(([cat, list]) => list.map((e) => ({ ...e, cat })));
  if (ex.length) {
    const bp = card('Best prompts', 'the highest-scored examples — everything in the Prompts tab');
    for (const e of ex.sort((x, y) => y.score - x.score).slice(0, 3)) {
      const box = el('div', 'tmpl');
      const bh = el('div', 'tmpl-title');
      const lead = el('span', 'tmpl-lead');
      lead.appendChild(el('span', 'p-score' + (e.score >= 8 ? ' s8' : ''), e.score + '/10'));
      lead.appendChild(el('span', 'tmpl-meta', `${CAT_LABELS[e.cat] || e.cat} · ${fmt.date(e.date)}`));
      bh.appendChild(lead);
      const copy = el('button', 'p-copy', 'Copy');
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(e.text).then(() => { copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); });
      });
      bh.appendChild(copy);
      box.appendChild(bh);
      box.appendChild(el('div', 'tmpl-body', e.text.length > 900 ? e.text.slice(0, 900) + ' …' : e.text));
      bp.appendChild(box);
    }
    const more = el('button', 'linky', `See all ${ex.length} exemplars from ${u.name} →`);
    more.style.marginTop = '12px';
    more.addEventListener('click', () => setView('prompts'));
    bp.appendChild(more);
    view.appendChild(bp);
  }

  const st = card('Sessions', 'Sessions touching the window, with their prompts, total tokens (all buckets) and API-equivalent cost. Titles come from the session logs; the icon shows the tool.');
  headerSeg(st, [{ value: 'usd', label: 'By spend' }, { value: 'recent', label: 'Recent' }], state.sessSort, (v) => { state.sessSort = v; render(); });
  const tbl = el('table', 'sess-table');
  const hr = el('tr');
  for (const [h, cls] of [['Session', ''], ['Project', ''], ['Surface', ''], ['Started', ''], ['Prompts', 'num'], ['Tokens', 'num'], ['Cost', 'num']]) hr.appendChild(el('th', cls, h));
  tbl.appendChild(hr);
  const sorted = [...a.sessList].sort(state.sessSort === 'usd' ? (x, y) => y.usd - x.usd : (x, y) => (y.s.end || '').localeCompare(x.s.end || ''));
  for (const { s, usd, tokens, prompts } of sorted.slice(0, 14)) {
    const tr = el('tr');
    const td0 = el('td');
    const ico = toolIcon(s.tool, 13); ico.style.marginRight = '7px'; ico.style.verticalAlign = '-2px';
    td0.appendChild(ico); td0.append(s.title || s.id.slice(0, 8));
    td0.title = s.title || s.id;
    tr.appendChild(td0);
    tr.appendChild(el('td', null, s.project || '—'));
    tr.appendChild(el('td', null, s.surface || 'cli'));
    tr.appendChild(el('td', null, fmt.date(s.start)));
    tr.appendChild(el('td', 'num', fmt.num(prompts)));
    tr.appendChild(el('td', 'num', fmt.tok(tokens)));
    tr.appendChild(el('td', 'num', fmt.usd(usd, true)));
    tbl.appendChild(tr);
  }
  st.appendChild(tbl); view.appendChild(st);
}

function renderOverview() {
  if (state.scope === 'all') renderTeamOverview();
  else {
    const u = USERS.find((x) => x.slug === state.scope);
    if (u) renderUserOverview(u);
    else renderTeamOverview();
  }
}

// ---------------- stats (always comparative; scoped user highlighted) ----------------
function renderStats() {
  const users = USERS.filter((u) => agg(u).nSess > 0 || userScore(u) != null);
  if (!users.length) { view.appendChild(el('div', 'empty', 'No data in this window')); return; }
  const wk = windowKeys();
  const hl = (slug) => slug === state.scope ? 'hl' : '';

  const mt = card('Head to head', state.scope !== 'all' ? 'Every published teammate side by side; the scoped teammate is highlighted. All rows respect the sidebar filters.' : 'Every published teammate, side by side. Nudge ratio = short steering messages; compactions/session = thread reuse; reasoning effort = the levels actually used with their models.');
  const tbl = el('table', 'lb');
  const hr = el('tr'); hr.appendChild(el('th', null, ''));
  for (const u of users) {
    const th = el('th', hl(u.slug));
    const s = el('span', 'u'); s.appendChild(avatarEl(u, 20)); s.appendChild(el('span', null, u.name));
    if (u.demo) s.appendChild(el('span', 'demo-tag', 'DEMO'));
    th.appendChild(s); th.style.textAlign = 'right'; hr.appendChild(th);
  }
  tbl.appendChild(hr);
  const rows = [
    ['Spend', (a) => (a.estimated ? '≈' : '') + fmt.usd(a.usd, true)],
    ['Tokens', (a) => fmt.tok(a.tokens)],
    ['Prompts', (a) => fmt.num(a.prompts)],
    ['Sessions', (a) => fmt.num(a.nSess)],
    ['Prompts / session', (a) => (a.techPrompts / Math.max(1, a.nSess)).toFixed(1)],
    ['Words / prompt', (a) => a.promptWords ? (a.promptWords / Math.max(1, a.techPrompts)).toFixed(0) : '—'],
    ['Sessions / active day', (a) => a.activeDays ? (a.nSess / a.activeDays).toFixed(1) : '—'],
    ['Compactions / session', (a) => a.nSess ? (a.compactions / a.nSess).toFixed(2) : '—'],
    ['Reasoning effort', (a) => effMix(a.effAgg) || '—'],
    ['Nudge ratio', (a) => fmt.pct(a.nudges / Math.max(1, a.techPrompts))],
    ['Screenshots pasted', (a) => fmt.num(a.imgs)],
    ['Tool calls / prompt', (a) => (a.toolCalls / Math.max(1, a.techPrompts)).toFixed(0)],
    ['Cache hit', (a) => fmt.pct(a.cacheHit)],
    ['Active days', (a) => String(a.activeDays)],
    ['Best streak', (a) => a.longest + 'd'],
    ['Peak hour', (a) => a.prompts ? String(a.peakHour).padStart(2, '0') + ':00' : '—'],
    ['Prompt score', (a, u) => { const s = userScore(u); return s ? s.toFixed(2) + ' / 10' : '—'; }],
    ['Cost / active day', (a) => a.activeDays ? fmt.usd(a.usd / a.activeDays, true) : '—'],
  ];
  for (const [label, fn] of rows) {
    const tr = el('tr'); tr.appendChild(el('td', null, label));
    for (const u of users) tr.appendChild(el('td', hl(u.slug), fn(agg(u), u)));
    tbl.appendChild(tr);
  }
  mt.appendChild(tbl); view.appendChild(mt);

  if (users.length > 1) {
    const tl = card('Daily spend', 'One line per teammate, overlaid (not stacked) so trajectories are comparable. API-equivalent at list prices.');
    const tlc = chartDiv(tl); view.appendChild(tl);
    C.timeline(tlc, {
      days: wk.map((k) => ({ d: k, values: Object.fromEntries(users.map((u) => [u.slug, agg(u).daily.get(k).usd])) })),
      series: users.map((u) => ({ key: u.slug, label: u.name, color: u.color })),
      fmtVal: (v, c) => fmt.usd(v, c), mode: 'lines', height: 220,
    });
  }

  const g = el('div', 'grid g2');
  const dp = craftDotplot(users);
  if (dp) g.appendChild(dp);
  const tc = techniqueDotplot(users);
  if (tc) g.appendChild(tc);
  if (g.children.length) view.appendChild(g);
}

// ---------------- prompts ----------------
async function curate(cat, id, action) {
  const res = await fetch('/api/exemplar', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cat, id, action }),
  });
  const out = await res.json().catch(() => ({ ok: false }));
  if (out.ok) {
    // mirror the server's change locally so re-renders stay consistent
    if (!DATA.git.dirty.includes(DATA.me)) DATA.git.dirty.push(DATA.me);
    const me = USERS.find((x) => x.slug === DATA.me);
    if (me) {
      if (action === 'exclude') {
        const list = me.prompts.exemplars[cat] || [];
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) { DATA.excludedExemplars[id] = { cat, exemplar: list[i] }; list.splice(i, 1); }
      } else {
        const rec = DATA.excludedExemplars[id];
        if (rec) {
          (me.prompts.exemplars[rec.cat] = me.prompts.exemplars[rec.cat] || []).push(rec.exemplar);
          me.prompts.exemplars[rec.cat].sort((a, b) => b.score - a.score);
          delete DATA.excludedExemplars[id];
        }
      }
    }
  }
  return out.ok;
}

// one flat prompt row: heading line + text box — same shape as Best prompts
function promptRow(e, u) {
  const box = el('div', 'tmpl');
  const bh = el('div', 'tmpl-title');
  const lead = el('span', 'tmpl-lead');
  if (u) { lead.appendChild(avatarEl(u, 18)); lead.appendChild(el('span', null, u.name)); }
  lead.appendChild(el('span', 'p-score' + (e.score >= 8 ? ' s8' : ''), e.score + '/10'));
  lead.appendChild(el('span', 'tmpl-meta', `${CAT_LABELS[e.cat] || e.cat}${e.project ? ' · ' + e.project : ''} · ${fmt.date(e.date)}`));
  if (e.tool) lead.appendChild(toolIcon(e.tool, 13));
  bh.appendChild(lead);
  const actions = el('span', 'p-actions');
  if (u && u.slug === DATA.me && DATA.git.repo) {
    const btn = el('button', 'p-copy', 'Shared ✓');
    btn.title = 'Click to exclude this prompt from your published examples';
    btn.addEventListener('click', async () => {
      const off = box.classList.contains('p-off');
      const ok = await curate(e.cat, e.id, off ? 'include' : 'exclude');
      if (!ok) return;
      box.classList.toggle('p-off', !off);
      btn.textContent = off ? 'Shared ✓' : 'Excluded — undo';
      updateSetupDot();
    });
    actions.appendChild(btn);
  }
  const copy = el('button', 'p-copy', 'Copy');
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(e.text).then(() => { copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); });
  });
  actions.appendChild(copy);
  bh.appendChild(actions);
  box.appendChild(bh);
  box.appendChild(el('div', 'tmpl-body scroll', e.text));
  return box;
}

function matchesQuery(e, q) {
  if (!q) return true;
  const hay = `${e.text}\n${e.project || ''}\n${CAT_LABELS[e.cat] || e.cat}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((term) => hay.includes(term));
}

function renderPrompts() {
  const all = [];
  for (const u of scopedUsers()) {
    for (const [cat, list] of Object.entries(u.prompts.exemplars || {})) {
      for (const e of list) all.push({ ...e, cat, user: u });
    }
  }
  const cats = Object.keys(CAT_LABELS).filter((c) => all.some((e) => e.cat === c));
  const bar = el('div', 'filterbar'); bar.style.padding = '0 0 4px';
  bar.appendChild(seg(
    [{ value: '', label: 'All categories' }, ...cats.map((c) => ({ value: c, label: CAT_LABELS[c] || c }))],
    state.libCat, (v) => { state.libCat = v; render(); },
  ));
  bar.appendChild(seg(
    [{ value: 'score', label: 'Top scored' }, { value: 'date', label: 'Newest' }],
    state.libSort, (v) => { state.libSort = v; render(); },
  ));
  const search = el('input', 'search');
  search.type = 'search'; search.placeholder = 'Search prompt text…'; search.value = state.libQuery;
  bar.appendChild(search);
  view.appendChild(bar);

  const holder = el('div', 'card');
  view.appendChild(holder);
  const apply = () => {
    holder.replaceChildren();
    const filtered = all
      .filter((e) => (!state.libCat || e.cat === state.libCat) && matchesQuery(e, state.libQuery))
      .sort(state.libSort === 'date'
        ? (a, b) => (b.date || '').localeCompare(a.date || '') || b.score - a.score
        : (a, b) => b.score - a.score || (b.date || '').localeCompare(a.date || ''));
    if (!filtered.length) {
      holder.appendChild(el('div', 'empty', all.length ? 'No exemplars match' : 'No graded prompts yet — run: node arena.js grade, then publish'));
      return;
    }
    for (const e of filtered) holder.appendChild(promptRow(e, e.user));
  };
  // filter in place so the search box keeps focus while typing
  search.addEventListener('input', () => { state.libQuery = search.value; apply(); });
  apply();
}

// ---------------- share detail (step 4's expansion) ----------------
// Exactly what a commit of data/<me>/ would contain, itemised and curatable.
function renderShareSection() {
  const me = USERS.find((x) => x.slug === DATA.me);
  if (!me || !me.sessions.length) return;

  // stats being shared — all-time, unfiltered by the toolbar
  const all = me.sessions.filter((s) => !s.kind || s.kind === 'interactive');
  const projAgg = {};
  let totUsd = 0, totTok = 0, totPrompts = 0;
  let first = null, last = null;
  for (const s of all) {
    const pr = projAgg[s.project || '(unknown)'] = projAgg[s.project || '(unknown)'] || { sessions: 0, prompts: 0, usd: 0 };
    pr.sessions++;
    if (s.start && (!first || s.start < first)) first = s.start;
    if (s.end && (!last || s.end > last)) last = s.end;
    for (const rec of Object.values(s.days)) {
      pr.prompts += rec.p; totPrompts += rec.p;
      for (const [m, t] of Object.entries(rec.m || {})) {
        const c = costOf(m, t);
        pr.usd += c; totUsd += c;
        totTok += (t.in || 0) + (t.cr || 0) + (t.cw5m || 0) + (t.cw1h || 0) + (t.out || 0);
      }
    }
  }
  const st = card('Step 4 detail · stats that ship', 'sessions.json + profile.json — counts, tokens, models, timing; never chat content');
  const sp = el('div', 'sub');
  sp.append(`${fmt.num(all.length)} session summaries · ${fmt.num(totPrompts)} prompts · ${fmt.tok(totTok)} tokens · ≈${fmt.usd(totUsd, true)} API-equivalent · ` +
    `${fmt.date(first)} → ${fmt.date(last)} · machines: ${(me.profile.machines || []).join(', ')}`);
  st.appendChild(sp);
  const tbl = el('table', 'lb');
  const hr = el('tr');
  for (const h of ['Project', 'Sessions', 'Prompts', 'Est. cost']) hr.appendChild(el('th', null, h));
  tbl.appendChild(hr);
  for (const [p, r] of Object.entries(projAgg).sort((a, b) => b[1].usd - a[1].usd)) {
    const tr = el('tr');
    tr.appendChild(el('td', null, p));
    tr.appendChild(el('td', null, fmt.num(r.sessions)));
    tr.appendChild(el('td', null, fmt.num(r.prompts)));
    tr.appendChild(el('td', null, fmt.usd(r.usd, true)));
    tbl.appendChild(tr);
  }
  st.appendChild(tbl);
  const hint = el('div', 'mini-hint');
  hint.style.marginTop = '8px';
  const nTraits = (me.habits && me.habits.traits && me.habits.traits.length) || 0;
  hint.append(`Technique profile: ${nTraits ? `${nTraits} traits ship with this (review them — including evidence quotes — in the habits card below)` : 'none yet (step 3 above)'}. Too broad? Adjust the include list in Data scope.`);
  st.appendChild(hint);
  view.appendChild(st);

  // prompts being shared — searchable so bulk pruning is quick
  const exList = Object.entries(me.prompts.exemplars || {}).flatMap(([cat, list]) => list.map((e) => ({ ...e, cat })))
    .sort((a, b) => b.score - a.score);
  const px = card('Step 4 detail · examples that ship', `${exList.length} prompts made the cut (scored ≥7, best 6 per category) — full text, every one removable`);
  if (!exList.length) px.appendChild(el('div', 'sub', 'None yet — run: node arena.js grade'));
  else {
    const search = el('input', 'search');
    search.type = 'search'; search.placeholder = 'Search to find prompts to exclude…'; search.value = state.pubQuery;
    search.style.marginBottom = '6px';
    px.appendChild(search);
    const listWrap = el('div');
    px.appendChild(listWrap);
    const apply = () => {
      listWrap.replaceChildren();
      const shown = exList.filter((e) => matchesQuery(e, state.pubQuery));
      if (!shown.length) listWrap.appendChild(el('div', 'sub', 'No prompts match'));
      for (const e of shown) {
        const row = el('div', 'pubrow');
        row.appendChild(el('span', 'p-score' + (e.score >= 8 ? ' s8' : ''), e.score + '/10'));
        row.appendChild(el('span', 'pr-cat', CAT_LABELS[e.cat] || e.cat));
        row.appendChild(el('span', 'pr-text', e.text.replace(/\s+/g, ' ').slice(0, 160)));
        const btn = el('button', 'p-copy', 'Remove');
        btn.addEventListener('click', async () => { if (await curate(e.cat, e.id, 'exclude')) { updateSetupDot(); render(); } });
        row.appendChild(btn);
        listWrap.appendChild(row);
      }
    };
    search.addEventListener('input', () => { state.pubQuery = search.value; apply(); });
    apply();
  }
  view.appendChild(px);

  // habits that ship — the curation surface for traits and their evidence
  if (me.habits && me.habits.traits && me.habits.traits.length) {
    const hx = card('Step 4 detail · habits that ship',
      'your summary + these traits + the copyable templates — evidence quotes are verbatim and may contain project specifics; remove any trait you\'d rather keep private');
    hx.appendChild(traitsReview(me, { curate: DATA.git.repo }));
    view.appendChild(hx);
  }

  // excluded, restorable
  const exc = Object.entries(DATA.excludedExemplars || {});
  if (exc.length) {
    const xc = card('Excluded by you', 'kept locally only — restore any time; re-grading will not re-add them');
    for (const [id, rec] of exc) {
      const e = rec.exemplar;
      const row = el('div', 'pubrow');
      row.appendChild(el('span', 'p-score', e.score + '/10'));
      row.appendChild(el('span', 'pr-cat', CAT_LABELS[rec.cat] || rec.cat));
      row.appendChild(el('span', 'pr-text', e.text.replace(/\s+/g, ' ').slice(0, 160)));
      const btn = el('button', 'p-copy', 'Restore');
      btn.addEventListener('click', async () => { if (await curate(rec.cat, id, 'include')) { updateSetupDot(); render(); } });
      row.appendChild(btn);
      xc.appendChild(row);
    }
    view.appendChild(xc);
  }
}

// ---------------- setup: the whole CLI, clickable ----------------
let jobTimer = null;
let jobRunning = false;
function updateSetupDot() {
  const dot = document.getElementById('setup-dot');
  if (jobRunning) { dot.hidden = false; dot.classList.add('run'); }
  else {
    dot.classList.remove('run');
    dot.hidden = !(DATA.git.repo && DATA.git.dirty.includes(DATA.me));
  }
}
function pollJob(logEl, onDone) {
  clearInterval(jobTimer);
  const tick = async () => {
    const j = await fetch('/api/job').then((r) => r.json()).catch(() => null);
    if (!j) return;
    jobRunning = j.running;
    updateSetupDot();
    if (logEl && logEl.isConnected) {
      const lines = (j.log || []).join('\n') || 'starting…';
      logEl.textContent = j.running ? lines + '\n⏳ working…' : lines;
      logEl.scrollTop = logEl.scrollHeight;
    }
    if (!j.running && j.done) {
      clearInterval(jobTimer); jobTimer = null;
      if (logEl && logEl.isConnected) logEl.textContent += `\n✓ finished${j.code ? ` (exit ${j.code})` : ''} — refreshing…`;
      if (onDone) onDone(j);
    }
  };
  tick();
  jobTimer = setInterval(tick, 1500);
}

function chipEditor(parent, label, values, placeholder) {
  const field = el('div', 'field');
  field.appendChild(el('label', null, label));
  const chips = el('div', 'chips');
  const list = [...values];
  const draw = () => {
    chips.replaceChildren();
    for (const [i, v] of list.entries()) {
      const c = el('span', 'chip');
      c.appendChild(el('span', null, v));
      const x = el('button', null, '×');
      x.addEventListener('click', () => { list.splice(i, 1); draw(); });
      c.appendChild(x);
      chips.appendChild(c);
    }
    const inp = el('input', 'text');
    inp.placeholder = placeholder; inp.style.width = '180px';
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && inp.value.trim()) { list.push(inp.value.trim()); draw(); }
    });
    chips.appendChild(inp);
  };
  draw();
  field.appendChild(chips);
  parent.appendChild(field);
  return { get: () => list };
}

function renderSetup() {
  const me = USERS.find((x) => x.slug === DATA.me);
  const cfg = DATA.config || { user: DATA.me, include: [], excludes: [], sources: [] };

  // profile
  const prof = card('Profile', 'how you appear to the team — shared with your data');
  const nameField = el('div', 'field');
  nameField.appendChild(el('label', null, 'Display name'));
  const nameInp = el('input', 'text'); nameInp.value = cfg.user || '';
  nameField.appendChild(nameInp);
  const nameBtn = el('button', 'btn subtle', 'Save name');
  const nameMsg = el('span', 'setup-note');
  nameBtn.addEventListener('click', async () => {
    const res = await fetch('/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: nameInp.value }) }).then((r) => r.json()).catch(() => ({ ok: false }));
    nameMsg.textContent = res.ok ? 'Saved.' : (res.error || 'Failed.');
    if (res.ok) await reloadData();
  });
  nameField.appendChild(nameBtn); nameField.appendChild(nameMsg);
  prof.appendChild(nameField);

  const avField = el('div', 'field');
  avField.appendChild(el('label', null, 'Photo'));
  if (me && me.profile.avatar) {
    const img = el('img', 'avatar-lg');
    img.src = `/data/${me.slug}/${me.profile.avatar}?t=${DATA.generatedAt}`;
    avField.appendChild(img);
  } else if (me) avField.appendChild(avatarEl(me, 56));
  const file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp,image/gif'; file.hidden = true;
  const avBtn = el('button', 'btn subtle', 'Upload photo…');
  const avMsg = el('span', 'setup-note', 'circle-masked in the dashboard, resized to 256px');
  avBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0]; if (!f) return;
    avMsg.textContent = 'Uploading…';
    const res = await fetch('/api/avatar', { method: 'POST', headers: { 'content-type': f.type }, body: f }).then((r) => r.json()).catch(() => ({ ok: false }));
    avMsg.textContent = res.ok ? 'Saved.' : (res.error || 'Failed.');
    if (res.ok) await reloadData();
  });
  avField.appendChild(avBtn); avField.appendChild(file); avField.appendChild(avMsg);
  prof.appendChild(avField);
  view.appendChild(prof);

  // scope
  const scope = card('Data scope', 'which sessions enter your dataset — applied on the next analysis (whitelist recommended)');
  const inc = chipEditor(scope, 'Include only', cfg.include || [], 'project path fragment ⏎');
  const exc = chipEditor(scope, 'Exclude', cfg.excludes || [], 'project path fragment ⏎');
  const src = chipEditor(scope, 'Extra log dirs', cfg.sources || [], '~/Backups/ai-logs ⏎');
  // data home: where the shared dataset lives — a dedicated repo, shared drive, or the app's data/
  const dhField = el('div', 'field');
  dhField.appendChild(el('label', null, 'Data home'));
  const dhInp = el('input', 'text'); dhInp.style.width = '340px';
  dhInp.value = cfg.dataDir || ''; dhInp.placeholder = '~/Code/arena-data (blank = app repo\'s data/)';
  dhField.appendChild(dhInp);
  const dhTag = el('span', 'setup-note', cfg.dataRepo ? '✓ git repo' : '⚠ not a git repo — publish needs one');
  dhField.appendChild(dhTag);
  scope.appendChild(dhField);
  scope.appendChild(el('div', 'setup-note',
    'Include/Exclude match case-insensitive fragments of each session\'s project path — "Code/acme" covers ~/Code/acme-app, ~/Code/acme-api and their worktrees. ' +
    'Extra log dirs are folders of backed-up session logs, as full paths or ~/ paths; formats are sniffed automatically.'));
  const scopeBtn = el('button', 'btn subtle', 'Save scope');
  const scopeMsg = el('span', 'setup-note');
  const scopeField = el('div', 'field');
  scopeBtn.addEventListener('click', async () => {
    const body = { include: inc.get(), excludes: exc.get(), sources: src.get() };
    if (dhInp.value.trim() !== (cfg.dataDir || '')) body.dataDir = dhInp.value.trim() || null;
    const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({ ok: false }));
    scopeMsg.textContent = res.ok ? (res.warning ? `Saved. ⚠ ${res.warning}` : 'Saved — run an analysis to apply.') : (res.error || 'Failed.');
    if (res.ok) { DATA.config = { ...cfg, ...res.config }; await reloadData(); setView('setup'); }
  });
  scopeField.appendChild(scopeBtn); scopeField.appendChild(scopeMsg);
  scope.appendChild(scopeField);
  view.appendChild(scope);

  // ---- the pipeline: one numbered workflow with live lifecycle state ----
  const gradedCount = me ? Object.values(me.prompts.categories || {}).reduce((x, c) => x + c.n, 0) : 0;
  const nEx = me ? Object.values(me.prompts.exemplars || {}).flat().length : 0;
  const nTraits = (me && me.habits && me.habits.traits && me.habits.traits.length) || 0;
  const dirty = me && DATA.git.repo && DATA.git.dirty.includes(me.slug);

  const pipe = card('Your pipeline', 'The whole workflow, in order. Each step shows its live state, what it costs before you run it, and what it produces. Steps tick as they complete; nothing is shared until step 4.');
  const steps = el('div', 'steps');
  pipe.appendChild(steps);
  const buttons = [];
  const logEl = el('div', 'joblog', '');
  logEl.hidden = true;
  const busyUI = () => { for (const b of buttons) b.disabled = true; logEl.hidden = false; };
  const idleUI = () => { for (const b of buttons) b.disabled = false; };
  const watch = () => { busyUI(); pollJob(logEl, async () => { idleUI(); await reloadData(); }); };
  const runJob = async (body) => {
    busyUI();
    logEl.textContent = 'starting…';
    const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({ ok: false, error: 'request failed' }));
    if (!res.ok && res.error === 'busy') { logEl.textContent = `A ${res.running} run is already in progress — showing its live log.\n`; watch(); return; }
    if (!res.ok) { logEl.textContent = res.error || 'failed to start'; idleUI(); return; }
    jobRunning = true; updateSetupDot();
    watch();
  };
  const step = (n, done, title, statusParts, note) => {
    const s = el('div', 'step' + (done ? ' done' : ''));
    s.appendChild(el('div', 'step-num', done ? '✓' : String(n)));
    const body = el('div');
    const head = el('div', 'step-head');
    head.appendChild(el('span', 'step-title', title));
    const status = el('span', 'step-status');
    for (const p of statusParts) {
      if (p.b) status.appendChild(el('b', null, p.b)); else status.append(p);
    }
    head.appendChild(status);
    body.appendChild(head);
    const controls = el('div', 'step-controls');
    body.appendChild(controls);
    body.appendChild(el('div', 'step-note', note));
    s.appendChild(body);
    steps.appendChild(s);
    return controls;
  };

  // 1 · collect
  const s1 = step(1, !!(me && me.sessions.length), 'Collect your history',
    me && me.sessions.length
      ? [{ b: fmt.num(me.sessions.length) }, ' sessions in your dataset · last analyzed ', { b: fmt.date(me.profile.updatedAt) }]
      : ['nothing collected yet'],
    'Parses every local Claude Code / Codex log into session summaries — counts, tokens, models, projects. No AI, no cost, incremental (seconds after the first run). Only projects matching your Data scope below are ingested; headless/automation runs are dropped. Re-run any time: sessions merge by id, so history accumulates even if local logs get purged.');
  const anBtn = el('button', 'btn', me && me.sessions.length ? 'Analyze again' : 'Analyze logs');
  buttons.push(anBtn);
  anBtn.addEventListener('click', () => runJob({ cmd: 'analyze' }));
  s1.appendChild(anBtn);

  // 2 · grade
  const s2 = step(2, gradedCount > 0, 'Grade prompt craft',
    [{ b: fmt.num(gradedCount) }, ' graded so far · ', { b: '…' }, ' awaiting'],
    'Your local AI CLI scores each sampled prompt 0–10 against the shared rubric (About tab). Every grade is cached forever — re-runs only grade new prompts, so this bill is incremental. Results feed your category averages, and prompts scoring ≥7 are auto-staged as candidate examples for the team (capped at the best 6 per category — you curate them in step 4).');
  const grStatus = steps.querySelectorAll('.step-status')[1];
  const slider = el('input', 'slider'); slider.type = 'range'; slider.min = 0; slider.value = 0; slider.max = 0; slider.step = 5;
  const grEst = el('span', 'est', 'sizing…');
  const frontier = priceFor('claude-fable-5'), budget = priceFor('haiku');
  let estState = { candidates: 0, avgChars: 300 };
  const updateGrEst = () => {
    const n = Number(slider.value);
    const tokIn = Math.round(n * (estState.avgChars / 4 + 120));
    const tokOut = n * 70;
    const costAt = (p) => (tokIn / 1e6) * (p.in || 0) + (tokOut / 1e6) * (p.out || 0);
    grEst.replaceChildren();
    grEst.append('grade ');
    grEst.appendChild(el('b', null, String(n)));
    grEst.append(` of them → ~${fmt.tok(tokIn + tokOut)} tokens · ${fmt.usd(costAt(budget))}–${fmt.usd(costAt(frontier))} by model`);
    grBtn.disabled = jobRunning || n === 0;
  };
  const grBtn = el('button', 'btn', 'Grade');
  buttons.push(grBtn);
  slider.addEventListener('input', updateGrEst);
  grBtn.addEventListener('click', () => runJob({ cmd: 'grade', days: 30, sample: Number(slider.value) }));
  s2.appendChild(grBtn); s2.appendChild(slider); s2.appendChild(grEst);

  // 3 · profile — always a deep read; cost depends only on history volume
  const s3 = step(3, nTraits > 0, 'Profile your habits',
    nTraits ? [{ b: String(nTraits) }, ' traits · generated ', { b: fmt.date(me.habits.generatedAt) }] : ['no technique profile yet'],
    'A separate analysis from grading, with its own instructions and no rubric: a frontier model reads your raw prompt sequences — whole sessions in order, so it sees how you open work, steer mid-flight, and react when the agent says "done" — and writes your trait profile (with verbatim evidence quotes) plus copyable prompt templates in your style, made project-generic. Its cost depends only on how much history you have; grading more prompts in step 2 does not change it. Re-running replaces the previous profile.');
  const hbEst = el('span', 'est', 'sizing…');
  const hbBtn = el('button', 'btn', nTraits ? 'Re-profile' : 'Profile habits');
  buttons.push(hbBtn);
  hbBtn.addEventListener('click', () => runJob({ cmd: 'habits', budget: 1000000 }));
  s3.appendChild(hbBtn); s3.appendChild(hbEst);

  // 4 · review & share
  const s4 = step(4, !!(me && DATA.git.repo && !dirty && (nEx || gradedCount)), 'Review & share',
    me ? [{ b: fmt.num(nEx) }, ' examples + ', { b: String(nTraits) }, ' traits staged · ',
      dirty ? { b: 'unpublished changes' } : DATA.git.repo ? '✓ in sync with the team' : '⚠ data home is not a git repo'] : ['—'],
    'Nothing leaves this machine until you publish. The cards below list exactly what a publish commits — session summaries, score aggregates, your staged examples (full text), and your technique profile. Remove any example or trait first; removals stick, even across re-grades. Publishing is a git commit + push of your folder only.');
  const pubBtn = el('button', 'btn', dirty ? 'Publish — commit & push' : 'Published ✓');
  pubBtn.disabled = !dirty || !DATA.git.repo;
  const pubMsg = el('span', 'setup-note');
  pubBtn.addEventListener('click', async () => {
    pubBtn.disabled = true; pubBtn.textContent = 'Publishing…'; pubMsg.textContent = 'committing and pushing…';
    const res = await fetch('/api/publish', { method: 'POST' }).then((r) => r.json()).catch(() => ({ ok: false, error: 'request failed' }));
    if (res.ok && res.pushed) { pubMsg.textContent = 'Published ✓'; await reloadData(); }
    else if (res.ok) { pubMsg.textContent = res.error || 'Committed; push failed — run git push manually.'; await reloadData(); }
    else { pubMsg.textContent = res.error || 'Publish failed.'; pubBtn.disabled = false; pubBtn.textContent = 'Publish — commit & push'; }
  });
  s4.appendChild(pubBtn); s4.appendChild(pubMsg);

  pipe.appendChild(logEl);
  view.appendChild(pipe);

  // live sizing for step 2 + 3
  fetch('/api/run-estimate?days=30').then((r) => r.json()).then((e) => {
    estState = e;
    slider.max = Math.min(1000, e.candidates || 0);
    slider.value = Math.min(250, e.candidates || 0);
    if (grStatus) {
      grStatus.replaceChildren();
      grStatus.appendChild(el('b', null, fmt.num(gradedCount)));
      grStatus.append(' graded so far · ');
      grStatus.appendChild(el('b', null, fmt.num(e.candidates)));
      grStatus.append(' not yet graded (last 30 days)');
    }
    updateGrEst();
    hbEst.replaceChildren();
    if (e.habits && e.habits.prompts) {
      const tokIn = Math.round(e.habits.chars / 4) + 1200;
      hbEst.append('deep read: ');
      hbEst.appendChild(el('b', null, `${fmt.num(e.habits.prompts)} prompts across ${fmt.num(e.habits.sessions)} sessions`));
      hbEst.append(` · ~${fmt.tok(tokIn)} tokens · ~${fmt.usd((tokIn / 1e6) * (frontier.in || 0) + 0.05)} frontier`);
    } else hbEst.append('needs collected history first');
  }).catch(() => { grEst.textContent = 'estimate unavailable'; });

  // a run may already be in flight (started earlier or in another window)
  fetch('/api/job').then((r) => r.json()).then((j) => {
    if (j && j.running) { logEl.textContent = (j.log || []).join('\n'); watch(); }
  }).catch(() => {});

  // step 4's detail: exactly what ships
  renderShareSection();

  // preferences (this browser only) — display concerns, kept out of the workflow
  const pref = card('Preferences', 'display only, stored in this browser — the shared data stays in USD');
  const curField = el('div', 'field');
  curField.appendChild(el('label', null, 'Currency'));
  curField.appendChild(seg(
    [{ value: 'USD', label: '$ USD' }, { value: 'EUR', label: '€ EUR' }],
    prefs.currency, (v) => { prefs.currency = v; localStorage.setItem('arena-cur', v); render(); },
  ));
  if (prefs.currency === 'EUR') {
    const rate = el('input', 'text'); rate.style.width = '90px';
    rate.value = prefs.fxEur; rate.inputMode = 'decimal';
    rate.addEventListener('change', () => {
      const v = Number(rate.value);
      if (v > 0 && v < 10) { prefs.fxEur = v; localStorage.setItem('arena-fx', String(v)); render(); }
    });
    curField.appendChild(el('label', null, '€ per $'));
    curField.appendChild(rate);
  }
  pref.appendChild(curField);
  pref.appendChild(el('div', 'setup-note', 'Dates and numbers use Irish formatting (DD/MM/YYYY). Costs are API-list estimates; the € view applies your rate at display time.'));
  view.appendChild(pref);
}

// ---------------- about ----------------
function mdRender(md, target) {
  const lines = md.replace(/([^\n|>#-])\n(?![\n|>#-])/g, '$1 ').split('\n');
  let i = 0, listEl = null, tableEl = null;
  const inline = (parent, text) => {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    for (const p of parts) {
      if (p.startsWith('**')) parent.appendChild(el('b', null, p.slice(2, -2)));
      else if (p.startsWith('`')) parent.appendChild(el('code', null, p.slice(1, -1)));
      else parent.append(p);
    }
  };
  const closeList = () => { listEl = null; };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\|/.test(line)) {
      if (!tableEl) { tableEl = el('table'); target.appendChild(tableEl); }
      if (!/^\|[\s:-]+\|/.test(line)) {
        const tr = el('tr');
        for (const cell of line.split('|').slice(1, -1)) {
          const td = el(tableEl.children.length ? 'td' : 'th');
          inline(td, cell.trim());
          tr.appendChild(td);
        }
        tableEl.appendChild(tr);
      }
      i++; continue;
    }
    tableEl = null;
    const h = line.match(/^(#{1,3}) (.*)/);
    if (h) { closeList(); target.appendChild(el('h' + h[1].length, null, h[2])); i++; continue; }
    if (/^> /.test(line)) { closeList(); const q = el('blockquote'); inline(q, line.slice(2)); target.appendChild(q); i++; continue; }
    if (/^- /.test(line)) {
      if (!listEl) { listEl = el('ul'); target.appendChild(listEl); }
      const li = el('li'); inline(li, line.slice(2)); listEl.appendChild(li); i++; continue;
    }
    closeList();
    if (line.trim()) { const p = el('p'); inline(p, line); target.appendChild(p); }
    i++;
  }
}

async function renderAbout() {
  // a docs page: no tooltips — detail lives on the page, everything on one measure
  const flow = card('How this works');
  const fp = el('div', 'prose');
  fp.appendChild(el('p', null, 'The full pipeline runs locally. Only the files in your data folder are ever shared — and only when you publish.'));
  flow.appendChild(fp);
  const steps = el('div', 'steps about-steps');
  const step = (n, title, text) => {
    const s = el('div', 'step');
    s.appendChild(el('div', 'step-num', n));
    const body = el('div');
    body.appendChild(el('div', 'step-title', title));
    body.appendChild(el('div', 'step-note', text));
    s.appendChild(body);
    steps.appendChild(s);
  };
  step('1', 'Collect', 'Your local Claude Code and Codex session logs are parsed into per-session summaries — counts, tokens, models, projects, timing. Deterministic, free, incremental. Only interactive sessions count (headless runs and subagent threads are dropped), and only projects matching your include list are ingested. Sessions merge by id across runs and machines, so history accumulates even if local logs are purged.');
  step('2', 'Grade', 'Your own AI CLI scores sampled prompts 0–10 against the rubric below, one verdict per prompt, cached forever. Aggregates build your category averages; prompts scoring ≥7 are staged as shareable examples (best 6 per category), which you curate before publishing.');
  step('3', 'Profile', 'A separate deep read: a frontier model reads whole sessions in order and writes your technique profile — a summary plus copyable, project-agnostic prompt templates. Its cost depends only on how much history you have, not on grading.');
  step('4', 'Share', 'Publishing is a git commit of your data folder that you trigger yourself, after reviewing exactly what it contains — in Setup, or with node arena.js publish. Teammates see it on their next pull. Everything else (.arena/ caches, ungraded prompt texts, excluded items) never leaves your machine.');
  fp.appendChild(steps);
  view.appendChild(flow);

  const rub = card('The rubric');
  const rp = el('div', 'prose');
  rp.appendChild(el('p', null, 'The standard the grader applies, word for word — argue with the standard, not the scores. It lives in RUBRIC.md in the repo.'));
  rub.appendChild(rp); view.appendChild(rub);
  try {
    const md = await (await fetch('/RUBRIC.md')).text();
    mdRender(md.replace(/^# .*\n/, ''), rp);
  } catch { rp.textContent = 'RUBRIC.md not found'; }

  const pr = card('Pricing');
  const pp = el('div', 'prose');
  pp.appendChild(el('p', null, 'Every cost in the app is computed from these USD list prices per million tokens. ≈ marks models newer than our reference data — best guesses, editable in pricing.json; the dashboard recomputes on reload.'));
  const tbl = el('table');
  const hr = el('tr');
  for (const [h, cls] of [['Model prefix', ''], ['Input', 'num'], ['Cached read', 'num'], ['Cache write 5m / 1h', 'num'], ['Output', 'num']]) hr.appendChild(el('th', cls, h));
  tbl.appendChild(hr);
  for (const m of [...DATA.pricing.models].sort((a, b) => a.match.localeCompare(b.match))) {
    const tr = el('tr');
    if (m.guess) tr.className = 'guess';
    tr.appendChild(el('td', null, (m.guess ? '≈ ' : '') + m.match));
    tr.appendChild(el('td', 'num', '$' + m.in));
    tr.appendChild(el('td', 'num', '$' + (m.cacheRead ?? 0)));
    tr.appendChild(el('td', 'num', m.cacheWrite5m != null ? `$${m.cacheWrite5m} / $${m.cacheWrite1h ?? m.cacheWrite5m}` : '—'));
    tr.appendChild(el('td', 'num', '$' + m.out));
    tbl.appendChild(tr);
  }
  pp.appendChild(tbl);
  const note = el('p');
  note.append('Cached reads bill at ~10% of fresh input for both vendors; cache writes apply to Anthropic only (5-minute / 1-hour tiers); Codex reasoning tokens are already inside its output figure.');
  pp.appendChild(note);
  pr.appendChild(pp); view.appendChild(pr);
}

// ---------------- shell ----------------
function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('active', b.dataset.view === v);
  render();
}
function setScope(slug) {
  state.scope = slug;
  buildSidebar();
  render();
}
function render() {
  if (memo.size > 400) memo.clear();
  view.replaceChildren();
  ({ overview: renderOverview, stats: renderStats, prompts: renderPrompts, setup: renderSetup, about: renderAbout })[state.view]();
}

// Refetch the dataset in place (after web-triggered actions) without losing view state.
async function reloadData() {
  const res = await fetch('/api/dataset?fresh=1');
  DATA = await res.json();
  hydrateUsers();
  memo.clear();
  const mePill = document.getElementById('me-pill');
  const meUser = USERS.find((u) => u.slug === DATA.me);
  mePill.replaceChildren();
  if (meUser) { mePill.appendChild(avatarEl(meUser, 20)); mePill.appendChild(el('span', null, meUser.name)); }
  else mePill.textContent = 'no local data yet';
  updateSetupDot();
  buildSidebar();
  render();
}

// The sidebar is the single home for global filters: who, period, tool, project.
function buildSidebar() {
  const side = document.getElementById('sidebar');
  side.replaceChildren();
  const group = (label) => {
    const g = el('div', 'fgroup');
    g.appendChild(el('div', 'flabel', label));
    side.appendChild(g);
    return g;
  };
  const row = (g, { label, active, dotColor, avatar, icon, demo, onPick }) => {
    const b = el('button', 'frow' + (active ? ' active' : ''));
    if (avatar) b.appendChild(avatarEl(avatar, 18));
    else if (icon) b.appendChild(toolIcon(icon, 15));
    else if (dotColor) { const d = el('span', 'dot'); d.style.background = dotColor; b.appendChild(d); }
    b.appendChild(el('span', null, label));
    if (demo) b.appendChild(el('span', 'demo-tag', 'DEMO'));
    b.addEventListener('click', onPick);
    g.appendChild(b);
    return b;
  };

  const who = group('Who');
  if (USERS.length <= 7) {
    row(who, { label: 'Everyone', active: state.scope === 'all', onPick: () => setScope('all') });
    for (const u of USERS) row(who, { label: u.name, active: state.scope === u.slug, avatar: u, onPick: () => setScope(u.slug) });
  } else {
    const sel = document.createElement('select');
    sel.className = 'ctl';
    for (const [v, l] of [['all', 'Everyone'], ...USERS.map((u) => [u.slug, u.name])]) {
      const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o);
    }
    sel.value = state.scope;
    sel.addEventListener('change', () => setScope(sel.value));
    who.appendChild(sel);
  }

  const period = group('Period');
  const rsel = document.createElement('select');
  rsel.className = 'ctl';
  for (const [v, l] of [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [180, 'Last 180 days'], [0, 'All time']]) {
    const o = document.createElement('option'); o.value = v; o.textContent = l; rsel.appendChild(o);
  }
  rsel.value = state.days;
  rsel.addEventListener('change', () => { state.days = Number(rsel.value); memo.clear(); render(); });
  period.appendChild(rsel);

  const tool = group('Tool');
  row(tool, { label: 'Both tools', active: state.tool === 'all', onPick: () => { state.tool = 'all'; memo.clear(); buildSidebar(); render(); } });
  row(tool, { label: 'Claude', active: state.tool === 'claude', icon: 'claude', onPick: () => { state.tool = 'claude'; memo.clear(); buildSidebar(); render(); } });
  row(tool, { label: 'Codex', active: state.tool === 'codex', icon: 'codex', onPick: () => { state.tool = 'codex'; memo.clear(); buildSidebar(); render(); } });

  const proj = group('Project');
  const psel = document.createElement('select');
  psel.className = 'ctl';
  const projects = new Set();
  for (const u of USERS) for (const s of u.sessions) if (s.project) projects.add(s.project);
  const po = document.createElement('option'); po.value = ''; po.textContent = 'All projects'; psel.appendChild(po);
  for (const p of [...projects].sort()) {
    const o = document.createElement('option'); o.value = p; o.textContent = p; psel.appendChild(o);
  }
  psel.value = state.project;
  psel.addEventListener('change', () => { state.project = psel.value; memo.clear(); render(); });
  proj.appendChild(psel);
}

function buildHelpPopover() {
  const pop = document.getElementById('help-pop');
  pop.replaceChildren();
  pop.appendChild(el('h4', null, 'Your data'));
  const p1 = el('p');
  p1.append('Everything here derives from ');
  p1.appendChild(el('code', null, `data/${DATA.me}/`));
  p1.append(' — session summaries, aggregates, and exemplar prompts. Never full chats, never tool output.');
  pop.appendChild(p1);
  const p2 = el('p');
  if (!DATA.git.repo) p2.append('Not a git repository yet — clone the team repo to share.');
  else if (DATA.git.dirty.includes(DATA.me)) p2.append('You have local changes teammates cannot see. Review and share from the Setup tab.');
  else p2.append('Published and in sync with the team repo.');
  pop.appendChild(p2);
  const p3 = el('p');
  p3.appendChild(el('code', null, '.arena/'));
  p3.append(' (caches, config, excluded prompts) never leaves this machine.');
  pop.appendChild(p3);
}

function wireChrome() {
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (b) setView(b.dataset.view);
  });
  const helpBtn = document.getElementById('help-toggle');
  const helpPop = document.getElementById('help-pop');
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    buildHelpPopover();
    helpPop.hidden = !helpPop.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!helpPop.hidden && !helpPop.contains(e.target)) helpPop.hidden = true;
  });
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem('arena-theme', document.documentElement.dataset.theme);
    priceCache = new Map();
    buildSidebar();
    render();
  });
  addEventListener('resize', () => { clearTimeout(wireChrome._t); wireChrome._t = setTimeout(render, 150); });
}

function initTheme() {
  const saved = localStorage.getItem('arena-theme');
  document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function hydrateUsers() {
  const slots = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
  USERS = DATA.users
    .sort((a, b) => (a.profile.firstSeen || '9').localeCompare(b.profile.firstSeen || '9'))
    .map((u, i) => ({
      slug: u.profile.slug, name: u.profile.name, demo: !!u.profile.demo,
      profile: u.profile, sessions: u.sessions, prompts: u.prompts, habits: u.habits || null,
      slot: slots[i % slots.length],
    }));
  for (const u of USERS) Object.defineProperty(u, 'color', { get() { return C.css(this.slot); } });
  if (!USERS.some((u) => u.slug === state.scope)) state.scope = 'all';
}

async function boot() {
  initTheme();
  const res = await fetch('/api/dataset');
  DATA = await res.json();
  hydrateUsers();

  const mePill = document.getElementById('me-pill');
  const meUser = USERS.find((u) => u.slug === DATA.me);
  mePill.replaceChildren();
  if (meUser) { mePill.appendChild(avatarEl(meUser, 20)); mePill.appendChild(el('span', null, meUser.name)); }
  else mePill.textContent = 'no local data yet';
  updateSetupDot();
  document.getElementById('foot-meta').textContent =
    `${USERS.length} teammate${USERS.length === 1 ? '' : 's'} · dataset ${new Date(DATA.generatedAt).toLocaleString('en-IE')}`;
  buildSidebar();
  wireChrome();
  render();
  requestAnimationFrame(() => render()); // re-measure once layout has settled
  // reflect an already-running job in the Setup tab dot from anywhere
  fetch('/api/job').then((r) => r.json()).then((j) => {
    if (j && j.running) { jobRunning = true; updateSetupDot(); }
  }).catch(() => {});
}

boot().catch((e) => {
  view.replaceChildren(el('div', 'empty', 'Failed to load dataset: ' + e.message));
});
