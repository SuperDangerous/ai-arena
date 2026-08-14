'use strict';
// One publish flow for both the CLI and the web UI: summarise what data/<you>/
// contains, secret-scan exemplar text, then git add/commit/push — in whichever
// repository holds the data home (the app repo by default, a dedicated data
// repo when `dataDir` points elsewhere).
const { execFileSync } = require('child_process');
const store = require('./store');
const { cost } = require('./pricing');

const SECRET_RES = [
  /sk-ant-[\w-]{10,}/, /sk-proj-[\w-]{10,}/, /sk-[A-Za-z0-9]{32,}/, /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /xox[bap]-[\w-]{10,}/,
];

function repoRoot() {
  try {
    return execFileSync('git', ['-C', store.dataDir(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch { return null; }
}

function git(args) {
  const root = repoRoot();
  if (!root) throw new Error('data home is not inside a git repository');
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

// Commit with a usable identity even when git config is unset on this machine.
function gitCommit(cfg, message) {
  const root = repoRoot();
  let hasIdentity = true;
  try { hasIdentity = !!execFileSync('git', ['-C', root, 'config', 'user.email'], { encoding: 'utf8' }).trim(); } catch { hasIdentity = false; }
  const idFlags = hasIdentity ? [] : ['-c', `user.name=${cfg.user}`, '-c', `user.email=${cfg.slug}@arena.local`];
  return execFileSync('git', ['-C', root, ...idFlags, 'commit', '-m', message], { encoding: 'utf8' }).trim();
}

function summarize(cfg) {
  const sess = store.loadSessions(cfg.slug);
  const prompts = store.loadPrompts(cfg.slug);
  const habits = store.loadHabits(cfg.slug);
  const sessions = Object.values(sess.sessions);
  let usd = 0;
  for (const s of sessions) for (const [m, t] of Object.entries(s.models)) usd += cost(m, t);
  const nEx = Object.values(prompts.exemplars).reduce((a, l) => a + l.length, 0);
  const hits = [];
  const scan = (label, text) => {
    for (const re of SECRET_RES) if (re.test(text)) hits.push(`${label}: "${text.slice(0, 60)}…" matches ${re}`);
  };
  for (const [cat, list] of Object.entries(prompts.exemplars)) for (const e of list) scan(cat, e.text);
  for (const t of (habits && habits.traits) || []) for (const ev of t.evidence || []) scan(`habit:${t.title}`, ev.quote || '');
  return { sessions: sessions.length, exemplars: nEx, habits: habits ? (habits.traits || []).length : 0, usd, hits };
}

function isRepo() { return repoRoot() !== null; }

function changed(cfg) {
  return git(['status', '--porcelain', '--', store.userDir(cfg.slug)]);
}

// Which of these user slugs have uncommitted changes in the data repo?
function dirtySlugs(slugs) {
  try {
    const out = git(['status', '--porcelain', '--', store.dataDir()]);
    return slugs.filter((slug) => out.split('\n').some((l) => l.includes(slug + '/')));
  } catch { return []; }
}

// Performs the commit (+push). Returns a result object, never throws for
// expected conditions.
function doPublish(cfg) {
  if (!isRepo()) return { ok: false, error: 'data home is not a git repository — set one up (see README) or commit by hand' };
  const status = changed(cfg);
  if (!status) return { ok: false, error: 'nothing to publish — data is already committed' };
  git(['add', store.userDir(cfg.slug)]);
  gitCommit(cfg, `arena: ${cfg.user} stats update (${new Date().toISOString().slice(0, 10)})`);
  try {
    git(['push']);
    return { ok: true, pushed: true };
  } catch (e) {
    return { ok: true, pushed: false, error: `commit created but push failed: ${String(e.message).slice(0, 200)}` };
  }
}

module.exports = { SECRET_RES, git, gitCommit, summarize, isRepo, changed, dirtySlugs, doPublish, repoRoot };
