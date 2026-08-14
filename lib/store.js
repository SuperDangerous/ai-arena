'use strict';
const path = require('path');
const fs = require('fs');
const { DATA, LOCAL, readJson, writeJson, machineName } = require('./util');

// Repo-shared, per-user, merged across runs. Sessions are the single source of
// truth: every aggregate the dashboard shows derives from them, so stats stay
// coherent even when local logs vanish between runs.
//
// The data home is separable from the app: `dataDir` in .arena/config.json
// points anywhere — a dedicated git repo (ideal), a shared drive — and every
// read/write/publish follows it. Default: <app>/data (self-contained mode).
function dataDir() {
  const cfg = readJson(path.join(LOCAL, 'config.json'), {});
  if (cfg.dataDir) {
    const p = path.resolve(String(cfg.dataDir).replace(/^~(?=\/|$)/, require('os').homedir()));
    return p;
  }
  return DATA;
}

function userDir(slug) { return path.join(dataDir(), slug); }

function loadSessions(slug) {
  return readJson(path.join(userDir(slug), 'sessions.json'), { schema: 1, sessions: {} });
}

function richness(s) {
  return (s.counts.prompts || 0) + (s.counts.asst || 0) + Object.keys(s.days || {}).length;
}

function addTokens(dst, src) {
  for (const k of ['in', 'cachedIn', 'cr', 'cw5m', 'cw1h', 'out', 'reason', 'msgs']) dst[k] = (dst[k] || 0) + (src[k] || 0);
}

// Additive merge of a resumed tail onto the stored session (append-only files).
function combineSessions(old, p) {
  const out = { ...old };
  out.counts = { ...old.counts };
  for (const k of Object.keys(p.counts || {})) out.counts[k] = (out.counts[k] || 0) + (p.counts[k] || 0);
  out.models = { ...old.models };
  for (const [m, t] of Object.entries(p.models || {})) {
    out.models[m] = { ...(out.models[m] || {}) };
    addTokens(out.models[m], t);
    if (t.eff) {
      const eff = out.models[m].eff = { ...(out.models[m].eff || {}) };
      for (const [lvl, n] of Object.entries(t.eff)) eff[lvl] = (eff[lvl] || 0) + n;
    }
  }
  out.days = { ...old.days };
  for (const [d, rec] of Object.entries(p.days || {})) {
    const od = out.days[d] = { p: 0, usd: 0, m: {}, ...(out.days[d] ? { ...out.days[d], m: { ...out.days[d].m } } : {}) };
    od.p += rec.p || 0; od.usd += rec.usd || 0;
    for (const [m, t] of Object.entries(rec.m || {})) {
      od.m[m] = { ...(od.m[m] || {}) };
      addTokens(od.m[m], t);
    }
  }
  out.hours = old.hours.map((v, i) => v + ((p.hours || [])[i] || 0));
  out.slash = { ...old.slash };
  for (const [k, v] of Object.entries(p.slash || {})) out.slash[k] = (out.slash[k] || 0) + v;
  out.tech = { ...old.tech };
  for (const [k, v] of Object.entries(p.tech || {})) out.tech[k] = (out.tech[k] || 0) + v;
  out.promptChars = (old.promptChars || 0) + (p.promptChars || 0);
  out.promptWords = (old.promptWords || 0) + (p.promptWords || 0);
  out.estimated = old.estimated || p.estimated;
  if (p.start && (!out.start || p.start < out.start)) out.start = p.start;
  if (p.end && (!out.end || p.end > out.end)) out.end = p.end;
  out.title = p.title || old.title;
  out.branch = p.branch || old.branch;
  out.version = p.version || old.version;
  return out;
}

function mergeSessions(slug, parsed, excludes, includes, preloaded) {
  const store = preloaded || loadSessions(slug);
  let added = 0, updated = 0, excluded = 0;
  // include list (when set) wins first: only matching projects enter the dataset
  const isExcluded = (s) => {
    const p = (s.projectPath || '').toLowerCase();
    if (includes && includes.length && !includes.some((x) => p.includes(String(x).toLowerCase()))) return true;
    return excludes.some((x) => p.includes(String(x).toLowerCase()));
  };
  for (const s of parsed) {
    if (isExcluded(s)) { excluded++; continue; }
    const old = store.sessions[s.id];
    if (s._partial) {
      // resumed tail: add onto the stored session (never replace)
      delete s._partial;
      if (old) { store.sessions[s.id] = combineSessions(old, s); updated++; }
      continue; // no stored base → the tail alone is meaningless; next --force rebuilds
    }
    if (!old) { store.sessions[s.id] = s; added++; }
    else if (richness(s) >= richness(old)) {
      if (!s.title && old.title) s.title = old.title;
      store.sessions[s.id] = s; updated++;
    }
  }
  // honor newly-added excludes (and the interactive-only rule) for previously stored sessions
  let pruned = 0;
  for (const [id, s] of Object.entries(store.sessions)) {
    if (isExcluded(s) || (s.kind && s.kind !== 'interactive')) { delete store.sessions[id]; pruned++; }
  }
  return { store, added, updated, excluded, pruned };
}

function saveSessions(slug, store) {
  writeJson(path.join(userDir(slug), 'sessions.json'), store);
}

function updateProfile(slug, name, store) {
  const p = path.join(userDir(slug), 'profile.json');
  const prof = readJson(p, { name, slug, machines: [], demo: false });
  prof.name = name || prof.name;
  prof.slug = slug;
  const mach = machineName();
  if (!prof.machines.includes(mach)) prof.machines.push(mach);
  const sessions = Object.values(store.sessions);
  const dates = sessions.flatMap((s) => [s.start, s.end]).filter(Boolean).sort();
  prof.firstSeen = dates[0] || null;
  prof.lastSeen = dates[dates.length - 1] || null;
  prof.tools = [...new Set(sessions.map((s) => s.tool))].sort();
  prof.updatedAt = new Date().toISOString();
  writeJson(p, prof);
  return prof;
}

function loadPrompts(slug) {
  return readJson(path.join(userDir(slug), 'prompts.json'), {
    schema: 1, categories: {}, exemplars: {}, gradeRuns: [],
  });
}

function savePrompts(slug, obj) {
  writeJson(path.join(userDir(slug), 'prompts.json'), obj);
}

// ---- local (never committed) ----
function cachePath(name) { return path.join(LOCAL, 'cache', name); }

function loadFileCache() { return readJson(cachePath('files.json'), {}); }
function saveFileCache(c) { writeJson(cachePath('files.json'), c); }

function loadClaims() {
  const raw = readJson(cachePath('claims.json'), {});
  return new Map(Object.entries(raw));
}
function saveClaims(map) {
  writeJson(cachePath('claims.json'), Object.fromEntries(map));
}

function loadPromptCache() { return readJson(cachePath('prompts.json'), {}); }
function savePromptCache(c) { writeJson(cachePath('prompts.json'), c); }

// Exemplars the user pulled back from sharing. Local-only: prompts.json always
// holds exactly what would be committed; excluded ones are parked here (with
// their full record, so they can be re-included) and re-grading skips them.
function loadExcluded() { return readJson(cachePath('excluded-exemplars.json'), {}); }
function saveExcluded(c) { writeJson(cachePath('excluded-exemplars.json'), c); }

function listUsers() {
  try {
    const d = dataDir();
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => fs.existsSync(path.join(d, n, 'profile.json')));
  } catch { return []; }
}

function loadHabits(slug) {
  return readJson(path.join(userDir(slug), 'habits.json'), null);
}
function saveHabits(slug, obj) {
  writeJson(path.join(userDir(slug), 'habits.json'), obj);
}

module.exports = {
  dataDir, userDir, loadSessions, mergeSessions, combineSessions, saveSessions, updateProfile,
  loadPrompts, savePrompts, loadHabits, saveHabits, loadFileCache, saveFileCache, loadClaims, saveClaims,
  loadPromptCache, savePromptCache, loadExcluded, saveExcluded, listUsers,
};
