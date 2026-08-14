'use strict';
const { log, progress, progressDone, fmt } = require('./util');
const config = require('./config');
const { discover } = require('./discover');
const { parseClaudeFile } = require('./parse_claude');
const { parseCodexFile, parseCodexOldFile } = require('./parse_codex');
const { detect, isNudge } = require('./techniques');
const { cost } = require('./pricing');
const store = require('./store');

// grading sessions run from .arena/grader — never let them enter the dataset
const BUILTIN_EXCLUDES = ['/.arena/grader'];

async function run(args) {
  const cfg = config.load();
  if (args.user) { cfg.user = String(args.user); cfg.slug = require('./util').slugify(cfg.user); }
  const userExcludes = [...cfg.excludes, ...[].concat(args.exclude || [])].filter(Boolean);
  if (args.exclude) { cfg.excludes = [...new Set(userExcludes)]; }
  const includes = [...new Set([...cfg.include, ...[].concat(args.include || [])].filter(Boolean))];
  if (args.include) cfg.include = includes;
  if (args['clear-include']) { cfg.include = []; includes.length = 0; }
  config.save(cfg);
  const excludes = [...userExcludes, ...BUILTIN_EXCLUDES];

  const days = args.days ? Number(args.days) : 0;
  const sinceMs = days > 0 ? Date.now() - days * 864e5 : 0;
  const roots = [...config.defaultRoots(), ...cfg.sources];
  log(`Analyzing as ${cfg.user} (data/${cfg.slug})`);
  log(`Sources: ${roots.join('\n         ')}`);
  if (includes.length) log(`Including ONLY projects matching: ${includes.join(', ')}`);
  else log(`Including all projects (opt in to a whitelist with --include <substring>)`);
  if (userExcludes.length) log(`Excluding projects matching: ${userExcludes.join(', ')}`);

  const files = discover(roots, { sinceMs });
  const CACHE_V = 2; // bump when parser output changes — forces one clean reparse
  let fileCache = args.force ? {} : store.loadFileCache();
  if (fileCache._v !== CACHE_V) fileCache = {};
  fileCache._v = CACHE_V;
  const claims = store.loadClaims();
  const existing = store.loadSessions(cfg.slug);
  // scope fingerprint: files whose sessions are entirely out of scope carry a
  // skip marker keyed to it, so growing out-of-scope logs stay free to ignore —
  // changing the include/exclude lists invalidates the markers automatically
  const scopeKey = String(require('./util').hashCode(JSON.stringify([includes, excludes])));
  const inScope = (projectPath) => {
    const p = (projectPath || '').toLowerCase();
    if (includes.length && !includes.some((x) => p.includes(String(x).toLowerCase()))) return false;
    return !excludes.some((x) => p.includes(String(x).toLowerCase()));
  };
  const todo = files.filter((f) => {
    const c = fileCache[f.file];
    if (!c || typeof c !== 'object') return true;
    if (c.skip === scopeKey) return false;
    return !(c.size === f.size && c.mtimeMs === f.mtimeMs);
  });
  log(`Found ${files.length} log files (${todo.length} new/changed to parse)`);

  const parsed = [];
  const newPrompts = [];
  let done = 0, bytes = 0, resumedFiles = 0;
  const totalBytes = todo.reduce((a, f) => a + f.size, 0);
  for (const f of todo) {
    try {
      // append-only logs that only grew resume from the stored byte offset —
      // grown multi-GB threads then cost milliseconds instead of a re-stream
      const c = fileCache[f.file];
      const canResume = c && c.offset && Array.isArray(c.sids) && c.sids.length &&
        f.format !== 'codex-old' && f.size > c.size && c.offset <= f.size &&
        c.sids.every((id) => existing.sessions[id]);
      const start = canResume ? c.offset : 0;
      let res;
      if (f.format === 'claude') res = await parseClaudeFile(f.file, { claims, start });
      else if (f.format === 'codex') {
        const promptBase = canResume ? (existing.sessions[c.sids[0]].counts.prompts || 0) : 0;
        res = await parseCodexFile(f.file, {
          start, promptBase,
          sid: canResume ? c.sids[0] : null,
          // active model + reasoning effort live at the file head
          model: canResume ? c.lastModel : null,
          effort: canResume ? c.lastEffort : null,
        });
      } else res = parseCodexOldFile(f.file);
      if (canResume) {
        resumedFiles++;
        for (const s of res.sessions) {
          const base = existing.sessions[s.id];
          if (base) { // identity lives at the file head — inherit it
            s.kind = base.kind; s.projectPath = s.projectPath || base.projectPath;
            s.project = s.project || base.project; s.surface = s.surface || base.surface;
            s.title = s.title || base.title;
          }
          s._partial = true;
        }
      }
      // the arena tracks people, not fleets: headless runs and subagent
      // threads are classified by the parsers and dropped at ingest
      for (const s of res.sessions) if ((s.start || s._partial) && s.kind === 'interactive') parsed.push(s);
      newPrompts.push(...res.prompts);
      const entry = { size: f.size, mtimeMs: f.mtimeMs, offset: res.offset, sids: res.sessions.map((s) => s.id), lastModel: res.lastModel, lastEffort: res.lastEffort };
      // whole file permanently out of scope? mark it skippable for this scope.
      // (claude 'auto' sessions are exempt — a human can pick those up later.)
      if (!canResume && res.sessions.length && res.sessions.every((s) =>
        !inScope(s.projectPath) || (f.format !== 'claude' && s.kind !== 'interactive'))) {
        entry.skip = scopeKey;
      }
      fileCache[f.file] = entry;
    } catch (e) {
      log(`\n  warn: failed to parse ${f.file}: ${e.message}`);
    }
    done++; bytes += f.size;
    progress(`  parsing ${done}/${todo.length}  (${(bytes / 1048576).toFixed(0)}/${(totalBytes / 1048576).toFixed(0)} MB)`);
  }
  progressDone();
  if (resumedFiles) log(`  resumed ${resumedFiles} grown log file${resumedFiles > 1 ? 's' : ''} from their stored offsets`);

  // technique + nudge detection on the human prompts of each parsed session
  const bySession = new Map();
  for (const p of newPrompts) {
    if (!bySession.has(p.sid)) bySession.set(p.sid, []);
    bySession.get(p.sid).push(p);
  }
  for (const s of parsed) {
    const ps = bySession.get(s.id) || [];
    for (const p of ps) {
      if (isNudge(p.text)) { s.counts.nudges++; continue; }
      for (const t of detect(p.text)) s.tech[t] = (s.tech[t] || 0) + 1;
    }
  }

  const { store: sess, added, updated, excluded, pruned } = store.mergeSessions(cfg.slug, parsed, excludes, includes, existing);
  store.saveSessions(cfg.slug, sess);
  store.saveFileCache(fileCache);
  store.saveClaims(claims);

  // prompt cache (local only) — merged so grading survives log loss too
  const pc = store.loadPromptCache();
  for (const p of newPrompts) if (!isNudge(p.text)) pc[p.id] = { sid: p.sid, ts: p.ts, text: p.text };
  // drop prompts of excluded/pruned sessions
  for (const [id, p] of Object.entries(pc)) if (!sess.sessions[p.sid]) delete pc[id];
  store.savePromptCache(pc);

  const prof = store.updateProfile(cfg.slug, cfg.user, sess);

  // summary
  const all = Object.values(sess.sessions);
  const tot = { usd: 0, in: 0, out: 0, cr: 0, cw: 0, prompts: 0 };
  for (const s of all) {
    tot.prompts += s.counts.prompts;
    for (const [m, t] of Object.entries(s.models)) {
      tot.usd += cost(m, t);
      tot.in += t.in; tot.out += t.out; tot.cr += t.cr + (t.cachedIn || 0); tot.cw += t.cw5m + t.cw1h;
    }
  }
  log(`\nDone. data/${cfg.slug}/sessions.json now holds ${all.length} sessions ` +
      `(+${added} new, ~${updated} updated${excluded + pruned ? `, ${excluded + pruned} excluded` : ''})`);
  log(`  lifetime: ${fmt.num(tot.prompts)} prompts · ${fmt.tokens(tot.in)} in / ${fmt.tokens(tot.out)} out / ` +
      `${fmt.tokens(tot.cr)} cache-read / ${fmt.tokens(tot.cw)} cache-write · ≈${fmt.usd(tot.usd)} API-equivalent`);
  log(`  first activity ${prof.firstSeen ? prof.firstSeen.slice(0, 10) : '—'}, last ${prof.lastSeen ? prof.lastSeen.slice(0, 10) : '—'}`);
  log(`\nNext: node arena.js grade   (AI-grades your prompt craft, local CLI only)`);
  log(`      node arena.js serve   (open the dashboard)`);
}

module.exports = { run };
