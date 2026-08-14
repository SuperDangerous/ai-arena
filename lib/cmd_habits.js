'use strict';
// The habits profiler: a frontier model reads SEQUENCES of your prompts (whole
// sessions, in order) and produces an evidence-backed technique profile — the
// transferable "how they work" a leaderboard can't show. Traits abstract away
// project specifics; evidence quotes are verbatim and user-curated before
// publish. Output: data/<you>/habits.json (shared like the rest of your data).
const { log, fmt } = require('./util');
const config = require('./config');
const store = require('./store');
const { runPrompt, extractJsonObject } = require('./grade');

const KINDS = ['verification', 'planning', 'delegation', 'iteration', 'context', 'scoping', 'standards', 'session-management', 'other'];

function habitsPrompt(name, blocks) {
  return `You are an expert coach studying how one engineer ("${name}") drives AI coding agents (Claude Code / Codex). Below are their real prompts, grouped by session, IN ORDER — so you can see how they open work, steer mid-flight, and react when the agent claims something is done.

Produce a technique PROFILE: the recurring, transferable moves that describe HOW this person works — not what projects they work on. Look especially for: verification habits (do they ask for proof, re-checks, tests after "done"?), planning style (plan-first? rubrics? inventories? checklists tested against criteria?), scoping (guardrails, non-goals), delegation (subagents, parallelism, background work), iteration style (many small corrections vs large re-briefs), session management (long threads vs fresh starts), standards-setting (quality bars, "world class", design systems), and distinctive verbal moves.

Rules:
- 5 to 8 traits. Each must be evidenced by the transcripts, not inferred from one example — prefer patterns you can quote twice.
- Titles and details must be PROJECT-AGNOSTIC (no product names, file names, company terms). Evidence quotes are verbatim (≤140 chars each, up to 2 per trait) and may contain specifics — they will be reviewed by the user.
- strength: 3 = signature move (constant), 2 = regular, 1 = occasional.
- kind: one of ${KINDS.join(' | ')}.
- summary: a rich 4-6 sentence portrait of their overall operating style, third person, using the name "${name}" — how they open work, steer, verify, manage sessions, and what makes them distinctive. This is the headline read; make it dense and specific, not generic praise.
- templates: 3 or 4 COPYABLE prompt templates that distill this person's signature moves into reusable starting points a teammate could paste. Write each in ${name}'s actual voice and register (mirroring quirks like capitalisation and directness), but make it FULLY generic: replace every project/product/file specific with <angle-bracket placeholders>. Each template must carry "trait": the EXACT title of the trait it demonstrates. ≤600 chars each.

Reply with ONLY a JSON object, no prose, no fences:
{"summary":"...","traits":[{"title":"...","detail":"...","kind":"verification","strength":3,"evidence":[{"quote":"..."}]}],"templates":[{"title":"...","trait":"...","prompt":"..."}]}

TRANSCRIPTS:
${blocks}`;
}

function collectBlocks(slug, budgetChars, days) {
  const sessions = store.loadSessions(slug).sessions;
  const pc = store.loadPromptCache();
  const since = days > 0 ? Date.now() - days * 864e5 : 0;
  const bySession = new Map();
  for (const [id, p] of Object.entries(pc)) {
    if (!sessions[p.sid]) continue;
    if (since && p.ts && Date.parse(p.ts) < since) continue;
    if (!bySession.has(p.sid)) bySession.set(p.sid, []);
    bySession.get(p.sid).push(p);
  }
  const ordered = [...bySession.entries()]
    .map(([sid, ps]) => ({ s: sessions[sid], ps: ps.sort((a, b) => (a.ts || '').localeCompare(b.ts || '')) }))
    .filter(({ ps }) => ps.length >= 3)
    .sort((a, b) => (b.s.end || '').localeCompare(a.s.end || ''));

  let used = 0, blocks = [], nSessions = 0, nPrompts = 0;
  for (const { s, ps } of ordered) {
    const lines = [`## Session · ${s.project || 'unknown'} · ${(s.start || '').slice(0, 10)} · ${ps.length} prompts`];
    for (const [i, p] of ps.entries()) {
      const t = p.text.length > 400 ? p.text.slice(0, 400) + '…' : p.text;
      lines.push(`${i + 1}. ${t.replace(/\n+/g, ' ⏎ ')}`);
    }
    const block = lines.join('\n');
    if (used + block.length > budgetChars) { if (nSessions) continue; }
    used += block.length; blocks.push(block); nSessions++; nPrompts += ps.length;
    if (used >= budgetChars) break;
  }
  return { text: blocks.join('\n\n'), nSessions, nPrompts, chars: used };
}

function validateHabits(obj) {
  if (!obj || !Array.isArray(obj.traits)) return null;
  const traits = obj.traits.slice(0, 8).map((t) => ({
    title: String(t.title || '').slice(0, 80),
    detail: String(t.detail || '').slice(0, 300),
    kind: KINDS.includes(t.kind) ? t.kind : 'other',
    strength: Math.max(1, Math.min(3, Math.round(Number(t.strength) || 1))),
    evidence: (Array.isArray(t.evidence) ? t.evidence : []).slice(0, 2)
      .map((e) => ({ quote: String((e && e.quote) || '').slice(0, 160) }))
      .filter((e) => e.quote.length > 5),
  })).filter((t) => t.title);
  if (!traits.length) return null;
  // trim the summary at a sentence boundary, never mid-word
  let summary = String(obj.summary || '');
  if (summary.length > 1400) {
    const cut = summary.slice(0, 1400);
    summary = cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.')) + 1) || cut;
  }
  const templates = (Array.isArray(obj.templates) ? obj.templates : []).slice(0, 4)
    .map((t) => ({
      title: String((t && t.title) || '').slice(0, 80),
      trait: String((t && t.trait) || '').slice(0, 90),
      prompt: String((t && t.prompt) || '').slice(0, 700),
    }))
    .filter((t) => t.title && t.prompt.length > 20);
  return { summary, traits, templates };
}

async function run(args) {
  const cfg = config.load();
  const budget = Math.max(20000, Math.min(2e6, Number(args.budget) || 1000000));
  const days = args.days !== undefined ? Number(args.days) : 0;
  const { text, nSessions, nPrompts, chars } = collectBlocks(cfg.slug, budget, days);
  if (nSessions < 3) {
    log('Not enough prompt history for a habits profile — run an analysis first (need ≥3 sessions with ≥3 prompts).');
    process.exit(1);
  }
  log(`Profiling ${cfg.user}: ${nPrompts} prompts across ${nSessions} sessions (~${fmt.tokens(Math.round(chars / 4))} tokens to your local AI CLI)`);
  const prompt = habitsPrompt(cfg.user, text);

  let habits = null, used = null;
  for (let attempt = 0; attempt < 2 && !habits; attempt++) {
    const res = await runPrompt(prompt, { grader: args.grader || 'claude', model: args.model || null });
    used = res.grader;
    habits = validateHabits(extractJsonObject(res.out));
  }
  if (!habits) { log('The model did not return a valid profile — try again.'); process.exit(1); }

  const out = {
    schema: 1, generatedAt: new Date().toISOString(), grader: used,
    sessionsSampled: nSessions, promptsSampled: nPrompts, budgetChars: chars,
    summary: habits.summary, traits: habits.traits, templates: habits.templates,
  };
  store.saveHabits(cfg.slug, out);
  log(`\n${habits.summary}\n`);
  for (const t of habits.traits) {
    log(`  ${'◆'.repeat(t.strength)}${'◇'.repeat(3 - t.strength)} ${t.title} [${t.kind}]`);
    log(`      ${t.detail}`);
  }
  log(`\nSaved to data/${cfg.slug}/habits.json — review evidence quotes in the Setup tab's Share section before publishing.`);
}

module.exports = { run, collectBlocks };
