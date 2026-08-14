'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { LOCAL, readJson, writeJson, defaultUser, slugify } = require('./util');

const CONFIG_PATH = path.join(LOCAL, 'config.json');

// Live CLI locations checked by default; anything that exists is scanned.
// Backup mirrors (iCloud etc.) are deliberately OPT-IN via `scan --add` or the
// Setup tab: they duplicate local history, and cloud folders can trigger slow
// on-demand downloads. Add one only when restoring lost local logs.
function defaultRoots() {
  const home = os.homedir();
  const roots = [
    path.join(home, '.claude', 'projects'),
    path.join(home, '.config', 'claude', 'projects'),
    path.join(home, '.codex', 'sessions'),
    path.join(home, '.codex', 'archived_sessions'),
  ];
  // Claude Code honours CLAUDE_CONFIG_DIR (and Codex CODEX_HOME) to relocate its
  // data dir — follow the redirect so custom setups are scanned automatically
  if (process.env.CLAUDE_CONFIG_DIR) roots.unshift(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  if (process.env.CODEX_HOME) roots.unshift(path.join(process.env.CODEX_HOME, 'sessions'), path.join(process.env.CODEX_HOME, 'archived_sessions'));
  return roots.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

function load() {
  const cfg = readJson(CONFIG_PATH, {});
  if (!cfg.user) cfg.user = defaultUser();
  cfg.slug = slugify(cfg.user);
  cfg.sources = cfg.sources || [];
  cfg.excludes = cfg.excludes || [];
  cfg.include = cfg.include || [];
  cfg.grader = cfg.grader || {};
  return cfg;
}

function save(cfg) {
  const out = { ...cfg };
  delete out.slug;
  writeJson(CONFIG_PATH, out);
}

module.exports = { load, save, defaultRoots, CONFIG_PATH };
