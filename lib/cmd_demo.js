'use strict';
// Two synthetic, clearly-badged users so the team views are explorable before
// real teammates publish. `node arena.js demo --remove` deletes them.
const fs = require('fs');
const path = require('path');
const { log, mulberry32, writeJson, localDay } = require('./util');
const { dataDir } = require('./store');

const PERSONAS = [
  {
    slug: 'demo-ada', name: 'Demo · Ada', tool: 'claude', peak: 9,
    models: ['claude-fable-5', 'claude-sonnet-5'], surface: 'cli',
    projects: ['acme-gateway', 'acme-dashboard', 'acme-firmware'],
    tech: { persona: 0.22, effort: 0.3, plan: 0.25, criteria: 0.28, verify: 0.35, anchors: 0.6, agents: 0.18, refs: 0.12, examples: 0.15, scope: 0.2 },
    intensity: 1.4, nudgeRate: 0.15, avgLen: 340,
    exemplars: {
      epic: [{
        score: 9, note: 'Scope in AND out, phased, with a verification gate per phase.',
        strengths: ['explicit non-goals', 'verification plan'], weak: [],
        text: 'We\'re adding multi-site support to acme-dashboard. Goal: a site switcher in the top nav that scopes every panel to the selected site.\n\nIn scope: nav switcher, per-site data scoping in the query layer, deep links (/site/:id/...), empty states for new sites. Out of scope: per-site permissions (next quarter), mobile layout changes.\n\nWork in phases — 1) query layer + tests, 2) nav + routing, 3) empty states + polish. After each phase run the e2e suite and show me a screenshot before moving on. Quality bar: no visible layout shift when switching sites.',
        tech: ['plan', 'criteria', 'verify', 'scope'], project: 'acme-dashboard', date: '2026-07-18',
      }],
      bugfix: [{
        score: 9, note: 'Symptom, place, repro, expected behaviour — eleven seconds to read.',
        strengths: ['precise anchor', 'expected behaviour'], weak: [],
        text: 'Fix the flaky reconnect in acme-gateway: when the broker restarts, clients reconnect but subscriptions are silently dropped (repro: docker restart broker while watching /debug/subs — count goes to 0 and stays). Expected: subscriptions re-established within 5s. Suspect the resubscribe path in mqtt/session.ts.',
        tech: ['anchors', 'criteria'], project: 'acme-gateway', date: '2026-07-30',
      }],
      workflow: [{
        score: 8, note: 'Delegation with checkpoints — the agent knows when to stop and ask.',
        strengths: ['checkpoints', 'clear stop condition'], weak: ['could name the quality bar'],
        text: 'Plan first, then implement. Break the migration into steps I can review; after each step, run the tests and stop if anything fails twice in a row. Use subagents for the mechanical renames so the main thread stays focused on the schema changes. Don\'t push anything — leave commits local for my review.',
        tech: ['plan', 'verify', 'agents', 'scope'], project: 'acme-firmware', date: '2026-08-02',
      }],
    },
  },
  {
    slug: 'demo-grace', name: 'Demo · Grace', tool: 'codex', peak: 14,
    models: ['gpt-5.6-sol', 'gpt-5.5'], surface: 'Codex Desktop',
    projects: ['acme-api', 'acme-etl', 'acme-site'],
    tech: { persona: 0.08, effort: 0.12, plan: 0.15, criteria: 0.2, verify: 0.4, anchors: 0.5, agents: 0.3, refs: 0.2, examples: 0.1, scope: 0.12 },
    intensity: 1.0, nudgeRate: 0.28, avgLen: 190,
    exemplars: {
      testinfra: [{
        score: 9, note: 'Names the framework, the flake, the fix criteria and how to prove it.',
        strengths: ['what done means', 'how to run'], weak: [],
        text: 'Our vitest suite in acme-api has three flaky specs (search "retry(2)" to find them). Root-cause each one instead of bumping retries — they share a leaked fake-timer pattern. Done means: retries removed, suite green 20 consecutive runs (`npm run test:loop 20`), and a short note in TESTING.md about the timer rule.',
        tech: ['anchors', 'criteria', 'verify'], project: 'acme-api', date: '2026-07-25',
      }],
      research: [{
        score: 8, note: 'A question with depth and an output format — not "look into it".',
        strengths: ['output format', 'bounded depth'], weak: [],
        text: 'Before we pick a queue for acme-etl: compare Redis Streams vs NATS JetStream for our workload (5k msg/s bursts, at-least-once, 7-day replay). Read the actual docs, not blog posts. Output: a one-page table (throughput, replay, ops burden, our-stack fit) + your recommendation with the single strongest reason and the single biggest risk.',
        tech: ['criteria', 'refs'], project: 'acme-etl', date: '2026-08-05',
      }],
      feature: [{
        score: 8, note: 'Outcome + integration point + acceptance criteria in four sentences.',
        strengths: ['integration point named'], weak: ['no non-goals'],
        text: 'Add CSV export to the acme-site admin orders table. Reuse the existing filter state so the export matches what\'s on screen. Stream it server-side (some tenants have 500k rows) — no in-memory buffering. Accept: a 500k-row export completes without the node process exceeding 300MB RSS.',
        tech: ['anchors', 'criteria'], project: 'acme-site', date: '2026-08-08',
      }],
    },
  },
];

function synthSessions(p, rng) {
  const sessions = {};
  const now = Date.now();
  for (let d = 110; d >= 1; d--) {
    const date = new Date(now - d * 864e5);
    const dow = date.getDay();
    const workday = dow >= 1 && dow <= 5;
    if (rng() > (workday ? 0.82 : 0.25)) continue;
    const nSess = 1 + Math.floor(rng() * 2.4 * p.intensity);
    for (let i = 0; i < nSess; i++) {
      const id = `demo-${p.slug}-${d}-${i}`;
      const prompts = 2 + Math.floor(rng() * 18);
      const model = p.models[rng() < 0.8 ? 0 : 1];
      const project = p.projects[Math.floor(rng() * p.projects.length)];
      const inTok = Math.round(prompts * (300e3 + rng() * 2.2e6) * p.intensity);
      const cached = Math.round(inTok * (0.88 + rng() * 0.09));
      const outTok = Math.round(prompts * (4e3 + rng() * 16e3));
      const hour = Math.max(7, Math.min(21, Math.round(p.peak + (rng() * 6 - 3))));
      const start = new Date(date); start.setHours(hour, Math.floor(rng() * 59), 0, 0);
      const end = new Date(start.getTime() + (20 + rng() * 160) * 60e3);
      const day = localDay(start);
      const hours = new Array(24).fill(0); hours[hour] = prompts;
      const isClaude = p.tool === 'claude';
      const tk = isClaude
        ? { in: Math.round(inTok * 0.02), cachedIn: 0, cr: cached, cw5m: Math.round(inTok * 0.015), cw1h: Math.round(inTok * 0.01), out: outTok, reason: 0, msgs: prompts * 4 }
        : { in: inTok, cachedIn: cached, cr: 0, cw5m: 0, cw1h: 0, out: outTok, reason: Math.round(outTok * 0.4), msgs: prompts * 4 };
      const tech = {};
      for (const [k, rate] of Object.entries(p.tech)) {
        const n = Math.round(prompts * rate * (0.6 + rng() * 0.8));
        if (n > 0) tech[k] = n;
      }
      sessions[id] = {
        id, tool: p.tool, kind: 'interactive', surface: p.surface,
        project, projectPath: `/home/demo/${project}`, title: null, branch: 'main',
        start: start.toISOString(), end: end.toISOString(),
        counts: { prompts, agentPrompts: Math.round(prompts * (p.tech.agents || 0)), asst: prompts * 4, tools: prompts * 6, imgs: rng() < 0.3 ? 1 : 0, nudges: Math.round(prompts * p.nudgeRate) },
        models: { [model]: tk },
        days: { [day]: { p: prompts, usd: 0, m: { [model]: tk } } },
        hours, slash: isClaude ? { compact: rng() < 0.2 ? 1 : 0 } : {}, tech,
        promptChars: prompts * p.avgLen, estimated: false, version: 'demo',
      };
    }
  }
  return sessions;
}

function synthCats(p, rng) {
  const cats = {};
  const base = { bugfix: 6.8, feature: 6.5, epic: 7.2, testinfra: 6.2, workflow: 7.5, research: 6.9, ops: 6.0, other: 5.5 };
  for (const [c, avg] of Object.entries(base)) {
    const n = 8 + Math.floor(rng() * 30);
    const hist = new Array(11).fill(0);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.max(2, Math.min(10, Math.round(avg + (rng() * 4 - 2))));
      hist[s]++; sum += s;
    }
    cats[c] = { n, sum, hist };
  }
  return cats;
}

async function run(args) {
  if (args.remove) {
    for (const p of PERSONAS) fs.rmSync(path.join(dataDir(), p.slug), { recursive: true, force: true });
    log('Demo users removed.');
    return;
  }
  for (const p of PERSONAS) {
    const rng = mulberry32(p.slug.length * 7919 + 13);
    const sessions = synthSessions(p, rng);
    const dir = path.join(dataDir(), p.slug);
    writeJson(path.join(dir, 'sessions.json'), { schema: 1, sessions });
    const exemplars = {};
    for (const [cat, list] of Object.entries(p.exemplars)) {
      exemplars[cat] = list.map((e, i) => ({ id: `demo-${p.slug}-ex-${cat}-${i}`, tool: p.tool, model: p.models[0], title: null, ...e }));
    }
    writeJson(path.join(dir, 'prompts.json'), {
      schema: 1, categories: synthCats(p, rng), exemplars,
      gradeRuns: [{ at: new Date().toISOString(), days: 30, sampled: 120, graded: 118, grader: 'demo', byCat: {} }],
    });
    writeJson(path.join(dir, 'profile.json'), {
      name: p.name, slug: p.slug, demo: true, machines: ['demo'], tools: [p.tool],
      firstSeen: new Date(Date.now() - 110 * 864e5).toISOString(), lastSeen: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    log(`created ${dir}`);
  }
  log('Demo users added — they are marked DEMO in the dashboard. Remove with: node arena.js demo --remove');
}

module.exports = { run };
