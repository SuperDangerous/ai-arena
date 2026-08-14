'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { log, readJson, writeJson } = require('./util');
const config = require('./config');
const store = require('./store');

const AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function setAvatar(slug, srcArg) {
  const src = path.resolve(String(srcArg).replace(/^~(?=$|\/)/, process.env.HOME));
  if (!fs.existsSync(src)) { log(`avatar not found: ${src}`); return null; }
  const ext = path.extname(src).toLowerCase();
  if (!AVATAR_EXTS.includes(ext)) { log(`avatar must be one of ${AVATAR_EXTS.join(' ')}`); return null; }
  const dir = store.userDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const e of AVATAR_EXTS) { try { fs.unlinkSync(path.join(dir, 'avatar' + e)); } catch { /* none */ } }
  const dest = path.join(dir, 'avatar' + ext);
  try {
    // keep the shared repo lean — macOS sips downsizes in place; else plain copy
    execFileSync('sips', ['-Z', '256', src, '--out', dest], { stdio: 'ignore' });
  } catch {
    fs.copyFileSync(src, dest);
  }
  const profPath = path.join(dir, 'profile.json');
  const prof = readJson(profPath, { slug });
  prof.avatar = path.basename(dest);
  writeJson(profPath, prof);
  return dest;
}

async function run(args) {
  const cfg = config.load();
  if (args.user) cfg.user = String(args.user);
  if (args['data-dir']) {
    const p = path.resolve(String(args['data-dir']).replace(/^~(?=\/|$)/, process.env.HOME));
    fs.mkdirSync(p, { recursive: true });
    cfg.dataDir = p;
    log(`Data home: ${p}`);
    log(`  Ideal setup: make it a dedicated git repo (git init / clone the team data repo there).`);
    log(`  Existing data in ${path.join(path.dirname(__dirname), 'data')} is NOT moved automatically — copy your data/<you>/ folder over if you're migrating.`);
  }
  config.save(cfg);
  const slug = config.load().slug;
  if (args.avatar) {
    const dest = setAvatar(slug, args.avatar);
    if (dest) log(`Avatar saved to ${path.relative(process.cwd(), dest)} (shared when you publish)`);
  }
  const prof = readJson(path.join(store.userDir(slug), 'profile.json'), {});
  log(`You are "${cfg.user}" (data/${slug})${prof.avatar ? ' · avatar set' : ''}`);
  log(`Config: .arena/config.json (never committed)`);
  log(`  sources:  ${cfg.sources.length ? cfg.sources.join(', ') : '(defaults only — add backups with `scan --add`)'}`);
  log(`  include:  ${cfg.include.length ? cfg.include.join(', ') : '(everything — whitelist projects with `analyze --include <substring>`)'}`);
  log(`  excludes: ${cfg.excludes.length ? cfg.excludes.join(', ') : '(none — add with `analyze --exclude <substring>`)'}`);
  if (!prof.avatar) log(`\nTip: node arena.js init --avatar ~/path/to/photo.jpg  (circle-masked in the dashboard)`);
  log(`Next: node arena.js analyze`);
}

module.exports = { run, setAvatar };
