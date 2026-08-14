'use strict';
const { log, progress, progressDone, mulberry32, hashCode, readJson, writeJson } = require('./util');
const path = require('path');
const { LOCAL } = require('./util');
const config = require('./config');
const store = require('./store');
const { CATS, gradeBatch, availableGraders } = require('./grade');
const { detect } = require('./techniques');

const GRADED_CACHE = path.join(LOCAL, 'cache', 'graded.json');

function topModel(session) {
  let best = null, n = -1;
  for (const [m, t] of Object.entries(session.models || {})) if (t.msgs > n) { n = t.msgs; best = m; }
  return best;
}

async function run(args) {
  const cfg = config.load();
  const days = args.days !== undefined ? Number(args.days) : 30;
  const sampleN = args.sample !== undefined ? Number(args.sample) : 250;
  const avail = availableGraders();
  if (!avail.length) {
    log('Grading needs the Claude Code or Codex CLI installed (either one works).');
    log('  Claude Code:  https://claude.com/claude-code');
    log('  Codex CLI:    https://developers.openai.com/codex/cli');
    process.exit(1);
  }
  let grader = args.grader || cfg.grader.cmd || 'claude';
  if (!avail.includes(grader)) {
    log(`(${grader} CLI not found — using ${avail[0]} instead)`);
    grader = avail[0];
  }
  const model = args.model || cfg.grader.model || null;
  const since = days > 0 ? Date.now() - days * 864e5 : 0;

  const sessions = store.loadSessions(cfg.slug).sessions;
  const pc = store.loadPromptCache();
  const graded = readJson(GRADED_CACHE, {});
  const excluded = store.loadExcluded();

  // candidates: human prompts from interactive sessions in the window, ungraded
  const seenText = new Set();
  const candidates = [];
  for (const [id, p] of Object.entries(pc)) {
    const s = sessions[p.sid];
    if (!s || s.kind !== 'interactive') continue;
    if (!p.ts || (since && Date.parse(p.ts) < since)) continue;
    const text = p.text.trim();
    if (text.length < 12) continue;
    if (graded[id]) continue;
    const norm = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 400);
    if (seenText.has(norm)) continue;
    seenText.add(norm);
    candidates.push({ id, sid: p.sid, ts: p.ts, text });
  }
  if (!candidates.length) {
    log(`Nothing new to grade in the last ${days || '∞'} days (already graded: ${Object.keys(graded).length}).`);
    log(`Widen the window with --days 90, or --days 0 for all history.`);
    return;
  }

  // sample: all long prompts are interesting; fill the rest with a seeded shuffle
  candidates.sort((a, b) => b.text.length - a.text.length);
  const longest = candidates.slice(0, Math.min(60, sampleN));
  const rest = candidates.slice(longest.length);
  const rng = mulberry32(hashCode(cfg.slug + days));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const sample = [...longest, ...rest.slice(0, Math.max(0, sampleN - longest.length))];

  log(`Grading ${sample.length} of ${candidates.length} ungraded prompts from the last ${days || '∞'} days`);
  log(`Grader: ${grader}${model ? ` (${model})` : ` (your CLI's default model)`} — local CLI, nothing leaves your machine`);

  const BATCH = 12, CONC = 3;
  const batches = [];
  for (let i = 0; i < sample.length; i += BATCH) batches.push(sample.slice(i, i + BATCH));
  let doneB = 0, ok = 0, failed = 0;
  const results = new Map(); // id -> grade
  let usedGrader = grader;

  async function worker(queue) {
    while (queue.length) {
      const batch = queue.shift();
      try {
        const { byIdx, grader: g } = await gradeBatch(batch, { grader, model });
        usedGrader = g;
        for (const [i, r] of byIdx) { results.set(batch[i].id, r); ok++; }
      } catch (e) {
        failed += batch.length;
        progressDone();
        log(`  warn: batch failed (${String(e.message).slice(0, 140)})`);
      }
      doneB++;
      progress(`  batches ${doneB}/${batches.length} · graded ${ok} · failed ${failed}`);
    }
  }
  const queue = [...batches];
  await Promise.all(Array.from({ length: Math.min(CONC, batches.length) }, () => worker(queue)));
  progressDone();

  if (!results.size) { log('No batches succeeded — check that `claude` or `codex` runs on this machine.'); process.exit(1); }

  // persist per-prompt grades locally; fold aggregates + exemplars into the shared file
  const at = new Date().toISOString();
  const prompts = store.loadPrompts(cfg.slug);
  const byCat = {};
  for (const [id, r] of results) {
    graded[id] = { ...r, at };
    const c = prompts.categories[r.cat] = prompts.categories[r.cat] || { n: 0, sum: 0, hist: new Array(11).fill(0) };
    c.n++; c.sum += r.score; c.hist[r.score]++;
    const b = byCat[r.cat] = byCat[r.cat] || { n: 0, sum: 0 };
    b.n++; b.sum += r.score;

    if (r.score >= 7 && !excluded[id]) {
      const p = pc[id]; const s = sessions[p.sid] || {};
      const ex = prompts.exemplars[r.cat] = prompts.exemplars[r.cat] || [];
      if (!ex.some((e) => e.id === id)) {
        ex.push({
          id, score: r.score, note: r.note, strengths: r.s, weak: r.w,
          text: p.text.length > 3000 ? p.text.slice(0, 3000) + ' …' : p.text,
          tool: s.tool, model: topModel(s), project: s.project || null,
          title: s.title || null, date: (p.ts || '').slice(0, 10),
          tech: detect(p.text),
        });
        ex.sort((a, b) => b.score - a.score || (b.date || '').localeCompare(a.date || ''));
        prompts.exemplars[r.cat] = ex.slice(0, 6);
      }
    }
  }
  prompts.gradeRuns.push({
    at, days, sampled: sample.length, graded: results.size, grader: usedGrader,
    byCat: Object.fromEntries(Object.entries(byCat).map(([c, b]) => [c, { n: b.n, avg: +(b.sum / b.n).toFixed(2) }])),
  });
  store.savePrompts(cfg.slug, prompts);
  writeJson(GRADED_CACHE, graded);

  log(`\nGraded ${results.size} prompts:\n`);
  const rows = CATS.filter((c) => byCat[c]).map((c) => ({
    category: c, prompts: byCat[c].n, 'avg score': +(byCat[c].sum / byCat[c].n).toFixed(2),
    exemplars: (prompts.exemplars[c] || []).length,
  }));
  console.table(rows);
  log(`Exemplars (score ≥7) saved to data/${cfg.slug}/prompts.json — review them with \`node arena.js serve\``);
  log(`or edit the file directly before publishing. Nothing is shared until you run \`node arena.js publish\`.`);
}

module.exports = { run };
