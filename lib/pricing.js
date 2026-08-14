'use strict';
const path = require('path');
const { ROOT, readJson } = require('./util');

let table = null;
function loadTable() {
  if (!table) {
    table = readJson(path.join(ROOT, 'pricing.json'), { models: [], default: { in: 3, out: 15, cacheRead: 0.3 } });
    // longest prefix wins
    table.models.sort((a, b) => b.match.length - a.match.length);
  }
  return table;
}

function priceFor(model) {
  const t = loadTable();
  const id = String(model || '').toLowerCase();
  for (const m of t.models) if (id.startsWith(m.match.toLowerCase())) return m;
  return t.default;
}

// tokens: { in, cachedIn, cr, cw5m, cw1h, out }
//   Anthropic: `in` excludes cache traffic; cr/cw* are separate buckets.
//   OpenAI:    `in` includes cachedIn; cached reads billed at cacheRead rate; writes free.
function cost(model, tk) {
  const p = priceFor(model);
  const M = 1e6;
  let usd = 0;
  const cached = tk.cachedIn || 0;
  usd += Math.max(0, (tk.in || 0) - cached) / M * (p.in || 0);
  usd += cached / M * (p.cacheRead || 0);
  usd += (tk.cr || 0) / M * (p.cacheRead || 0);
  usd += (tk.cw5m || 0) / M * (p.cacheWrite5m || 0);
  usd += (tk.cw1h || 0) / M * (p.cacheWrite1h != null ? p.cacheWrite1h : (p.cacheWrite5m || 0));
  usd += (tk.out || 0) / M * (p.out || 0);
  return usd;
}

module.exports = { priceFor, cost, loadTable };
