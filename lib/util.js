'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const LOCAL = path.join(ROOT, '.arena');
const DATA = path.join(ROOT, 'data');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
}

// Minimal flag parser: --days 30 --exclude a --exclude b --force
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        if (args[key] === undefined) args[key] = next;
        else args[key] = [].concat(args[key], next);
        i++;
      } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

// Stream a .jsonl file. `prefilter(line)` skips JSON.parse on irrelevant lines —
// essential: session logs run to gigabytes and most bytes are tool output.
// `start` resumes from a byte offset (append-only logs); returns the byte offset
// consumed, never advancing past a trailing line that doesn't parse (it may be a
// half-written append — the next run re-reads it).
async function eachJsonl(file, prefilter, onEntry, { start = 0 } = {}) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', start });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let offset = start;
  let lastLine = null;
  for await (const line of rl) {
    if (lastLine !== null) offset += Buffer.byteLength(lastLine, 'utf8') + 1;
    lastLine = line;
    if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
    if (prefilter && !prefilter(line)) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    onEntry(obj);
  }
  if (lastLine !== null) {
    let complete = true;
    if (lastLine.charCodeAt(0) === 123) { try { JSON.parse(lastLine); } catch { complete = false; } }
    if (complete) offset += Buffer.byteLength(lastLine, 'utf8') + 1;
  }
  return { offset };
}

function localDay(ts) { // ISO date in local time
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Sessions belong to their repo: worktree checkouts (repo/.claude/worktrees/<slug>)
// collapse to the parent repo, and cwds inside a repo's subdirectories roll up to
// the repo root — the nearest ancestor with .git when it still exists on disk,
// else the first component under a conventional code dir.
const projCache = new Map();
function projectOf(cwd) {
  if (!cwd) return { path: null, name: null };
  const orig = String(cwd).replace(/\/+$/, '');
  if (projCache.has(orig)) return projCache.get(orig);
  let p = orig;
  const wt = p.indexOf('/.claude/worktrees/');
  if (wt >= 0) p = p.slice(0, wt);
  const wt2 = p.match(/^(.*)\/worktrees\/[^/]+$/);
  if (wt2) p = wt2[1];
  let q = p, gitRoot = null;
  for (let i = 0; i < 12 && q && q !== '/' && q !== '.'; i++) {
    try { if (fs.existsSync(path.join(q, '.git'))) { gitRoot = q; break; } } catch { break; }
    q = path.dirname(q);
  }
  let out = gitRoot;
  if (!out) {
    const root = p.match(/^(.*?\/(?:Code|code|src|repos?|projects|dev|work)\/[^/]+)(?:\/.*)?$/);
    out = root ? root[1] : p;
  }
  const res = { path: out, name: path.basename(out) };
  projCache.set(orig, res);
  return res;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
}

function defaultUser() {
  try { return os.userInfo().username; } catch { return 'user'; }
}

function machineName() {
  try { return os.hostname().replace(/\.local$/, ''); } catch { return 'unknown'; }
}

// Deterministic PRNG for reproducible sampling
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

const fmt = {
  num(n) { return Number(n || 0).toLocaleString('en-US'); },
  usd(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); },
  tokens(n) {
    n = Number(n || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  },
};

function log(msg) { process.stdout.write(msg + '\n'); }
let lastProgress = 0;
function progress(msg) {
  if (process.stdout.isTTY) { process.stdout.clearLine(0); process.stdout.cursorTo(0); process.stdout.write(msg); }
  else if (process.env.ARENA_JOB && Date.now() - lastProgress > 2000) {
    // web-triggered runs have no TTY — emit throttled plain lines for the job log
    lastProgress = Date.now();
    process.stdout.write(msg.trim() + '\n');
  }
}
function progressDone() { if (process.stdout.isTTY) { process.stdout.clearLine(0); process.stdout.cursorTo(0); } }

module.exports = {
  ROOT, LOCAL, DATA, ensureDir, readJson, writeJson, parseArgs, eachJsonl,
  localDay, slugify, projectOf, defaultUser, machineName, mulberry32, hashCode, fmt, log, progress, progressDone,
};
