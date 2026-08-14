'use strict';
const fs = require('fs');
const path = require('path');
const { log, fmt } = require('./util');
const config = require('./config');
const { discover } = require('./discover');

async function run(args) {
  const cfg = config.load();
  if (args.add) {
    for (const p of [].concat(args.add)) {
      const abs = path.resolve(String(p).replace(/^~(?=$|\/)/, process.env.HOME));
      if (!fs.existsSync(abs)) { log(`not found: ${abs}`); continue; }
      if (!cfg.sources.includes(abs)) cfg.sources.push(abs);
      log(`added source: ${abs}`);
    }
    config.save(cfg);
  }
  const roots = [...config.defaultRoots(), ...cfg.sources];
  log('Scanning for session logs (default locations + your extra sources)...\n');
  const files = discover(roots, {});
  const byRoot = new Map();
  for (const f of files) {
    const root = roots.find((r) => f.file.startsWith(r)) || 'other';
    const k = `${root}`;
    const rec = byRoot.get(k) || { claude: 0, codex: 0, 'codex-old': 0, bytes: 0 };
    rec[f.format]++; rec.bytes += f.size;
    byRoot.set(k, rec);
  }
  for (const [root, r] of byRoot) {
    log(`  ${root}`);
    log(`      claude: ${fmt.num(r.claude)} · codex: ${fmt.num(r.codex + r['codex-old'])} · ${(r.bytes / 1073741824).toFixed(2)} GB`);
  }
  if (!byRoot.size) log('  (nothing found)');
  log(`\n${files.length} log files total. Add backup locations with:  node arena.js scan --add <path>`);
  if (cfg.excludes.length) log(`Excluded project patterns: ${cfg.excludes.join(', ')}`);
}

module.exports = { run };
