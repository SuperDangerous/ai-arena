'use strict';
const fs = require('fs');
const path = require('path');

// Walks roots and returns candidate log files tagged with a format:
//   claude      — ~/.claude/projects/<munged-cwd>/<uuid>.jsonl
//   codex       — rollout-*.jsonl (2025+ rust CLI / desktop)
//   codex-old   — rollout-*.json single-document (early 2025 TS CLI)
// Unknown .jsonl files are sniffed by reading the first line, so backup copies
// in arbitrary directory layouts are picked up too.
function walk(dir, out, depth) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile()) {
      if (e.name.endsWith('.jsonl') || (e.name.startsWith('rollout-') && e.name.endsWith('.json'))) out.push(p);
    }
  }
}

function sniff(file) {
  const name = path.basename(file);
  if (name.startsWith('rollout-') && name.endsWith('.json')) return 'codex-old';
  if (name.startsWith('rollout-') && name.endsWith('.jsonl')) return 'codex';
  if (!name.endsWith('.jsonl')) return null;
  // Claude session files are <uuid>.jsonl inside a project dir; backups may not
  // preserve that layout, so sniff content.
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8', 0, n);
  } catch { return null; }
  if (head.includes('"session_meta"') || head.includes('"turn_context"')) return 'codex';
  if (head.includes('"sessionId"') || head.includes('"parentUuid"')) return 'claude';
  return null;
}

function discover(roots, { sinceMs } = {}) {
  const files = [];
  for (const root of roots) walk(root, files, 0);
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.size < 10) continue;
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    const format = sniff(f);
    if (!format) continue;
    out.push({ file: f, format, size: st.size, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

module.exports = { discover, sniff };
