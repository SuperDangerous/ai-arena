'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { ROOT, log, readJson, slugify } = require('./util');
const config = require('./config');
const store = require('./store');
const { loadTable } = require('./pricing');
const publishCore = require('./publish_core');
const { setAvatar } = require('./cmd_init');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8',
};

let cache = { at: 0, body: null };
// read-only demo mode (--demo / ARENA_DEMO=1): every non-GET request is
// rejected server-side, and the UI hides anything that would mutate state
let DEMO = false;

function gitStatus() {
  if (!publishCore.isRepo()) return { repo: false, dirty: [] };
  return { repo: true, dirty: publishCore.dirtySlugs(store.listUsers()) };
}

function buildDataset() {
  if (Date.now() - cache.at < 5000 && cache.body) return cache.body;
  const cfg = config.load();
  const users = store.listUsers().map((slug) => ({
    profile: readJson(path.join(store.userDir(slug), 'profile.json'), { name: slug, slug }),
    sessions: Object.values(readJson(path.join(store.userDir(slug), 'sessions.json'), { sessions: {} }).sessions),
    prompts: readJson(path.join(store.userDir(slug), 'prompts.json'), { categories: {}, exemplars: {}, gradeRuns: [] }),
    habits: store.loadHabits(slug),
  }));
  const body = JSON.stringify({
    generatedAt: new Date().toISOString(),
    me: cfg.slug,
    config: {
      user: cfg.user, include: cfg.include, excludes: cfg.excludes, sources: cfg.sources,
      dataDir: store.dataDir(), dataDirIsDefault: !cfg.dataDir, dataRepo: publishCore.isRepo(),
      graders: require('./grade').availableGraders(), demo: DEMO,
    },
    pricing: loadTable(),
    git: gitStatus(),
    excludedExemplars: store.loadExcluded(),
    users,
  });
  cache = { at: Date.now(), body };
  return body;
}

// ---- one background job at a time (analyze / grade), streamed to the UI ----
const job = { proc: null, cmd: null, log: [], startedAt: null, done: true, code: null };

function startJob(cmd, cliArgs) {
  if (job.proc) return { ok: false, error: 'busy', running: job.cmd };
  job.cmd = cmd; job.log = []; job.startedAt = Date.now(); job.done = false; job.code = null;
  const child = spawn(process.execPath, [path.join(ROOT, 'arena.js'), cmd, ...cliArgs], {
    cwd: ROOT, env: { ...process.env, ARENA_JOB: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.proc = child;
  const push = (d) => {
    for (const line of String(d).split(/\r|\n/)) {
      const t = line.trim();
      if (t) { job.log.push(t); if (job.log.length > 60) job.log.shift(); }
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', (code) => {
    job.done = true; job.code = code; job.proc = null;
    cache.at = 0; // fresh dataset on next fetch
  });
  return { ok: true };
}

// POST /api/exemplar {cat, id, action: 'exclude'|'include'} — curate what ships.
function curateExemplar(payload) {
  const cfg = config.load();
  const { cat, id, action } = payload || {};
  if (!cat || !id || !['exclude', 'include'].includes(action)) return { ok: false, error: 'bad request' };
  const prompts = store.loadPrompts(cfg.slug);
  const excluded = store.loadExcluded();
  if (action === 'exclude') {
    const list = prompts.exemplars[cat] || [];
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return { ok: false, error: 'not found' };
    excluded[id] = { cat, exemplar: list[i], at: new Date().toISOString() };
    list.splice(i, 1);
    if (!list.length) delete prompts.exemplars[cat];
  } else {
    const rec = excluded[id];
    if (!rec) return { ok: false, error: 'not found' };
    const list = prompts.exemplars[rec.cat] = prompts.exemplars[rec.cat] || [];
    if (!list.some((e) => e.id === id)) {
      list.push(rec.exemplar);
      list.sort((a, b) => b.score - a.score || (b.date || '').localeCompare(a.date || ''));
    }
    delete excluded[id];
  }
  store.savePrompts(cfg.slug, prompts);
  store.saveExcluded(excluded);
  cache.at = 0;
  return { ok: true };
}

const str = (v, max = 200) => typeof v === 'string' && v.length <= max ? v.trim() : null;
const strList = (v) => Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, 50) : null;

const API = {
  'POST /api/exemplar': (payload) => curateExemplar(payload),

  'POST /api/run': (payload) => {
    const cmd = payload && payload.cmd;
    if (cmd === 'analyze') {
      const args = [];
      if (payload.force) args.push('--force');
      return startJob('analyze', args);
    }
    if (cmd === 'grade') {
      const args = ['--days', String(Math.max(0, Number(payload.days ?? 30) || 0)),
        '--sample', String(Math.min(1000, Math.max(1, Number(payload.sample ?? 250) || 250)))];
      return startJob('grade', args);
    }
    if (cmd === 'habits') {
      const args = ['--budget', String(Math.min(2e6, Math.max(20000, Number(payload.budget) || 1000000)))];
      return startJob('habits', args);
    }
    return { ok: false, error: 'unknown cmd' };
  },

  // curate the habits profile: drop a trait before (or after) sharing
  'POST /api/habit': (payload) => {
    const cfg = config.load();
    const habits = store.loadHabits(cfg.slug);
    const i = Number(payload && payload.index);
    if (!habits || !Number.isInteger(i) || i < 0 || i >= habits.traits.length) return { ok: false, error: 'not found' };
    habits.traits.splice(i, 1);
    store.saveHabits(cfg.slug, habits);
    cache.at = 0;
    return { ok: true };
  },

  'POST /api/profile': (payload) => {
    const cfg = config.load();
    const name = str(payload && payload.user, 60);
    if (!name) return { ok: false, error: 'name required' };
    const oldSlug = cfg.slug, newSlug = slugify(name);
    if (newSlug !== oldSlug && fs.existsSync(store.userDir(oldSlug)) && !fs.existsSync(store.userDir(newSlug))) {
      fs.renameSync(store.userDir(oldSlug), store.userDir(newSlug));
    }
    cfg.user = name;
    config.save(cfg);
    const profPath = path.join(store.userDir(newSlug), 'profile.json');
    const prof = readJson(profPath, { slug: newSlug });
    prof.name = name; prof.slug = newSlug;
    fs.mkdirSync(store.userDir(newSlug), { recursive: true });
    fs.writeFileSync(profPath, JSON.stringify(prof, null, 1));
    cache.at = 0;
    return { ok: true, slug: newSlug };
  },

  'POST /api/settings': (payload) => {
    const cfg = config.load();
    if (payload && payload.dataDir === null) delete cfg.dataDir;
    else if (payload && typeof payload.dataDir === 'string' && payload.dataDir.trim()) {
      const p = path.resolve(payload.dataDir.trim().replace(/^~(?=\/|$)/, require('os').homedir()));
      try { fs.mkdirSync(p, { recursive: true }); } catch { return { ok: false, error: 'cannot create that folder' }; }
      cfg.dataDir = p;
    }
    const inc = strList(payload && payload.include);
    const exc = strList(payload && payload.excludes);
    const src = strList(payload && payload.sources);
    if (inc) cfg.include = inc;
    if (exc) cfg.excludes = exc;
    if (src) {
      const home = require('os').homedir();
      cfg.sources = src
        .map((p) => path.resolve(p.replace(/^~(?=\/|$)/, home)))
        .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
      if (cfg.sources.length < src.length) {
        config.save(cfg); cache.at = 0;
        return { ok: true, warning: 'some paths were dropped — they must be existing folders', config: { include: cfg.include, excludes: cfg.excludes, sources: cfg.sources } };
      }
    }
    config.save(cfg);
    cache.at = 0;
    return { ok: true, config: { include: cfg.include, excludes: cfg.excludes, sources: cfg.sources, dataDir: store.dataDir(), dataRepo: publishCore.isRepo() } };
  },

  'POST /api/publish': () => {
    const cfg = config.load();
    const sum = publishCore.summarize(cfg);
    if (sum.hits.length) return { ok: false, error: 'possible secrets in exemplar text — review the Prompts list', hits: sum.hits };
    const res = publishCore.doPublish(cfg);
    cache.at = 0;
    return res;
  },
};

function handleAvatar(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (d) => { size += d.length; if (size > 8e6) req.destroy(); else chunks.push(d); });
  req.on('end', () => {
    const cfg = config.load();
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[req.headers['content-type']];
    if (!ext || !chunks.length) { res.writeHead(400); res.end('{"ok":false,"error":"send image bytes with an image/* content-type"}'); return; }
    const tmp = path.join(require('os').tmpdir(), 'arena-avatar' + ext);
    fs.writeFileSync(tmp, Buffer.concat(chunks));
    const dest = setAvatar(cfg.slug, tmp);
    try { fs.unlinkSync(tmp); } catch { /* fine */ }
    cache.at = 0;
    res.writeHead(dest ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(dest ? { ok: true } : { ok: false, error: 'could not save avatar' }));
  });
}

async function run(args) {
  const port = Number(args.port || 4177);
  DEMO = !!(args.demo || process.env.ARENA_DEMO);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;

    if (DEMO && req.method !== 'GET') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"read-only demo — clone https://github.com/SuperDangerous/ai-arena to run on your own logs"}');
      return;
    }
    if (key === 'POST /api/avatar') { handleAvatar(req, res); return; }
    if (API[key]) {
      let raw = '';
      req.on('data', (d) => { raw += d; if (raw.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let payload; try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
        const result = API[key](payload);
        res.writeHead(result && result.ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }
    // sizing data for the Run controls: how much is there to grade/profile?
    if (key === 'GET /api/run-estimate') {
      const cfg = config.load();
      const days = Math.max(0, Number(url.searchParams.get('days') || 30));
      const since = days > 0 ? Date.now() - days * 864e5 : 0;
      const sessions = readJson(path.join(store.userDir(cfg.slug), 'sessions.json'), { sessions: {} }).sessions;
      const pc = store.loadPromptCache();
      const graded = readJson(path.join(require('./util').LOCAL, 'cache', 'graded.json'), {});
      let candidates = 0, chars = 0, allChars = 0, allPrompts = 0;
      const seen = new Set();
      for (const [id, p] of Object.entries(pc)) {
        if (!sessions[p.sid]) continue;
        allChars += p.text.length; allPrompts++;
        if (since && p.ts && Date.parse(p.ts) < since) continue;
        if (graded[id] || p.text.trim().length < 12) continue;
        const norm = p.text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400);
        if (seen.has(norm)) continue;
        seen.add(norm);
        candidates++; chars += p.text.length;
      }
      // precise sizing for the habits deep read (independent of grading state)
      let habitsEst = null;
      try {
        const { collectBlocks } = require('./cmd_habits');
        const hb = collectBlocks(cfg.slug, 1000000, 0);
        habitsEst = { sessions: hb.nSessions, prompts: hb.nPrompts, chars: hb.chars };
      } catch { /* no data yet */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates, avgChars: candidates ? Math.round(chars / candidates) : 0, allPromptChars: allChars, allPrompts, habits: habitsEst }));
      return;
    }
    if (key === 'GET /api/job') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ running: !!job.proc, cmd: job.cmd, done: job.done, code: job.code, log: job.log.slice(-12), startedAt: job.startedAt }));
      return;
    }
    if (url.pathname === '/api/dataset') {
      cache.at = url.searchParams.has('fresh') ? 0 : cache.at;
      const body = buildDataset();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(body);
      return;
    }
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    // avatars live with each user's published data (wherever the data home is)
    let file;
    if (p.startsWith('/data/') && /\.(png|jpe?g|webp|gif|svg)$/i.test(p)) {
      file = path.normalize(path.join(store.dataDir(), p.slice('/data/'.length)));
      if (!file.startsWith(store.dataDir() + path.sep)) { res.writeHead(403); res.end(); return; }
    } else if (p === '/RUBRIC.md') {
      file = path.join(ROOT, 'RUBRIC.md');
    } else {
      file = path.normalize(path.join(ROOT, 'web', p));
      if (!file.startsWith(path.join(ROOT, 'web') + path.sep)) { res.writeHead(403); res.end(); return; }
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      // no-cache = revalidate every load; a stale app.js after an update is
      // worse than the few small refetches this costs
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    log(`AI Arena dashboard → ${url}`);
    // gentle preflight so common gaps are visible before anyone hits a wall
    const graders = require('./grade').availableGraders();
    if (!graders.length) {
      log('note: no AI CLI found — Analyze works, but Grade/Profile need Claude Code');
      log('      (https://claude.com/claude-code) or Codex CLI (https://developers.openai.com/codex/cli).');
    }
    if (!publishCore.isRepo()) {
      log('note: the data home is not a git repository — publishing is disabled until it is');
      log(`      (data home: ${store.dataDir()} — git init there, or clone your team's data repo).`);
    }
    if (!args['no-open'] && process.platform === 'darwin') execFile('open', [url], () => {});
  });
}

module.exports = { run };
