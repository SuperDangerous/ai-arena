'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { eachJsonl, localDay, readJson, projectOf } = require('./util');
const { cost } = require('./pricing');

const SKIP_USER_PREFIXES = [
  '<user_instructions>', '<environment_context>', '<ide_context>', '<turn_aborted>',
  '<permissions', '<apps_instructions>', '<plugins_instructions>', '<skills_instructions>',
  '<system>', '<memory', '## Memory', '<AGENTS', '# AGENTS',
  '<in-app-browser-context', '<heartbeat', '# In app browser:', '<app_context',
];

// Codex Desktop wraps image/file pastes: "# Files mentioned by the user: ...
// ## My request:\n<the actual prompt>". Unwrap to the human part.
function cleanUserText(t) {
  let imgs = 0;
  if (t.startsWith('# Files mentioned by the user:')) {
    imgs = (t.match(/codex-clipboard|\.png|\.jpe?g/gi) || []).length;
    const parts = t.split(/##\s*My request:\s*/i);
    t = parts.length > 1 ? parts[parts.length - 1].trim() : '';
  }
  return { text: t, imgs };
}

function blankSession(id) {
  return {
    id, tool: 'codex', kind: 'interactive', surface: null, project: null, projectPath: null,
    title: null, branch: null, start: null, end: null,
    counts: { prompts: 0, agentPrompts: 0, asst: 0, tools: 0, imgs: 0, nudges: 0 },
    models: {}, days: {}, hours: new Array(24).fill(0), slash: {}, tech: {},
    promptChars: 0, promptWords: 0, estimated: false, version: null,
  };
}

function bump(map, model) {
  return map[model] || (map[model] = { in: 0, cachedIn: 0, cr: 0, cw5m: 0, cw1h: 0, out: 0, reason: 0, msgs: 0 });
}

function dayRec(s, day) {
  return s.days[day] || (s.days[day] = { p: 0, usd: 0, m: {} });
}

// Session titles live in ~/.codex/session_index.jsonl, not the rollout files.
let titleIndex = null;
function codexTitles() {
  if (titleIndex) return titleIndex;
  titleIndex = new Map();
  const p = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id && o.thread_name) titleIndex.set(o.id, o.thread_name);
      } catch { /* skip */ }
    }
  } catch { /* no index */ }
  return titleIndex;
}

function classifyKind(meta) {
  const src = meta.source;
  if (src && typeof src === 'object') return 'agent';       // subagent / guardian / thread_spawn
  if (src === 'exec') return 'auto';                        // headless `codex exec` (automations)
  return 'interactive';                                     // cli / vscode / desktop UI
}

// Rollout .jsonl (rust CLI / Codex Desktop, mid-2025 onward).
// `start` resumes from a byte offset (session_meta lives at the head, so the
// caller prefills identity fields from the stored session); `promptBase` keeps
// ordinal prompt ids stable across resumes.
async function parseCodexFile(file, { start = 0, promptBase = 0, sid = null, model: model0 = null, effort: effort0 = null } = {}) {
  const fallbackId = (path.basename(file).match(/([0-9a-f-]{36})/i) || [])[1] || path.basename(file);
  const s = blankSession(sid || fallbackId);
  s._promptBase = promptBase;
  const prompts = [];
  let model = model0;
  let curEffort = effort0;
  let sawUserEvents = false;
  const fallbackUsers = []; // for old rollouts without user_message events
  let lastTotal = null, sumLast = { in: 0, cachedIn: 0, cw: 0, out: 0, reason: 0 };

  const prefilter = (line) =>
    line.includes('"session_meta"') || line.includes('"turn_context"') ||
    line.includes('"token_count"') || line.includes('"user_message"') ||
    line.includes('"function_call"') || line.includes('"custom_tool_call"') ||
    line.includes('"agent_message"') || line.includes('"role":"user"');

  const { offset } = await eachJsonl(file, prefilter, (o) => {
    const ts = o.timestamp;
    if (ts) {
      if (!s.start || ts < s.start) s.start = ts;
      if (!s.end || ts > s.end) s.end = ts;
    }
    const p = o.payload || {};
    if (o.type === 'session_meta') {
      s.id = p.id || p.session_id || s.id;
      if (p.cwd) { const pr = projectOf(p.cwd); s.projectPath = pr.path; s.project = pr.name; }
      s.surface = p.originator || null;
      s.version = p.cli_version || null;
      s.kind = classifyKind(p);
      if (p.git && p.git.branch) s.branch = p.git.branch;
      return;
    }
    if (o.type === 'turn_context') {
      if (p.model) model = p.model;
      if (p.effort) curEffort = p.effort;
      if (!s.projectPath && p.cwd) { const pr = projectOf(p.cwd); s.projectPath = pr.path; s.project = pr.name; }
      return;
    }
    if (o.type === 'event_msg') {
      if (p.type === 'user_message') {
        sawUserEvents = true;
        // subagent threads replay the parent's user messages — never count those
        if (s.kind === 'agent') return;
        const raw = String(p.message || '').trim();
        if (!raw || SKIP_USER_PREFIXES.some((x) => raw.startsWith(x))) return;
        const { text, imgs } = cleanUserText(raw);
        if (!text) { s.counts.imgs += imgs; return; }
        // anything that OPENS with an XML-ish tag is machine-injected context
        // (<codex_delegation>, <heartbeat>, whatever ships next) — never human
        if (/^<\w/.test(text)) return;
        addPrompt(s, prompts, text, ts, imgs + (p.images || []).length + (p.local_images || []).length);
      } else if (p.type === 'agent_message') {
        s.counts.asst++;
      } else if (p.type === 'token_count' && p.info) {
        const last = p.info.last_token_usage;
        if (p.info.total_token_usage) lastTotal = p.info.total_token_usage;
        if (!last) return;
        const tk = {
          in: last.input_tokens || 0, cachedIn: last.cached_input_tokens || 0,
          cr: 0, cw5m: 0, cw1h: 0, out: last.output_tokens || 0,
        };
        const reason = last.reasoning_output_tokens || 0;
        sumLast.in += tk.in; sumLast.cachedIn += tk.cachedIn; sumLast.out += tk.out; sumLast.reason += reason;
        const mname = model || 'gpt-5';
        const m = bump(s.models, mname);
        m.in += tk.in; m.cachedIn += tk.cachedIn; m.out += tk.out; m.reason += reason; m.msgs++;
        if (curEffort) { m.eff = m.eff || {}; m.eff[curEffort] = (m.eff[curEffort] || 0) + 1; }
        if (ts) {
          const d = localDay(ts);
          if (d) {
            const dr = dayRec(s, d);
            const dm = bump(dr.m, mname);
            dm.in += tk.in; dm.cachedIn += tk.cachedIn; dm.out += tk.out;
            dr.usd += cost(mname, tk);
          }
        }
      }
      return;
    }
    if (o.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') { s.counts.tools++; return; }
      if (p.type === 'message' && p.role === 'user' && s.kind !== 'agent') {
        // fallback for rollouts predating user_message events
        let t = '';
        for (const b of p.content || []) if (b && b.type === 'input_text') t += (t ? '\n' : '') + (b.text || '');
        t = t.trim();
        if (t && !SKIP_USER_PREFIXES.some((x) => t.startsWith(x))) {
          const { text } = cleanUserText(t);
          if (text && !/^<\w/.test(text)) fallbackUsers.push({ t: text, ts });
        }
      }
      return;
    }
  }, { start });

  if (!sawUserEvents) for (const { t, ts } of fallbackUsers) addPrompt(s, prompts, t, ts, 0);

  // If token events were dropped (crashes), the final cumulative total is more
  // trustworthy than the sum of per-turn deltas; top up the dominant model.
  // Only meaningful on full parses — a resumed tail's cumulative total covers
  // the whole session, not just the tail.
  if (lastTotal && start === 0) {
    const totIn = lastTotal.input_tokens || 0, totOut = lastTotal.output_tokens || 0;
    if (totIn > sumLast.in * 1.1 || totOut > sumLast.out * 1.1) {
      const mname = model || 'gpt-5';
      const m = bump(s.models, mname);
      m.in += Math.max(0, totIn - sumLast.in);
      m.cachedIn += Math.max(0, (lastTotal.cached_input_tokens || 0) - sumLast.cachedIn);
      m.out += Math.max(0, totOut - sumLast.out);
    }
  }

  s.title = codexTitles().get(s.id) || null;
  delete s._promptBase;
  const interactive = s.kind === 'interactive';
  return { sessions: [s], prompts: interactive ? prompts : [], offset, lastModel: model, lastEffort: curEffort };
}

function addPrompt(s, prompts, text, ts, imgs) {
  s.counts.prompts++;
  s.promptChars += text.length;
  s.promptWords += text.split(/\s+/).filter(Boolean).length;
  s.counts.imgs += imgs || 0;
  if (ts) {
    const d = localDay(ts);
    if (d) dayRec(s, d).p++;
    s.hours[new Date(ts).getHours()]++;
  }
  prompts.push({ id: `${s.id}#${(s._promptBase || 0) + s.counts.prompts}`, sid: s.id, ts, text, imgs: imgs || 0 });
}

// Flat rollout-*.json documents from the early-2025 TypeScript CLI.
// No usage data — tokens are estimated from text volume (~4 chars/token).
function parseCodexOldFile(file) {
  let doc;
  try { doc = readJson(file, null); } catch { doc = null; }
  if (!doc || !doc.session) return { sessions: [], prompts: [] };
  const s = blankSession(doc.session.id || path.basename(file));
  s.estimated = true;
  s.surface = 'codex-cli-ts';
  const ts0 = doc.session.timestamp;
  s.start = s.end = ts0 || null;
  const prompts = [];
  let inChars = 0, outChars = 0;
  for (const it of doc.items || []) {
    if (it.type === 'message' && it.role === 'user') {
      let t = '';
      for (const b of it.content || []) if (b && (b.type === 'input_text' || b.type === 'text')) t += (t ? '\n' : '') + (b.text || '');
      t = t.trim();
      inChars += t.length;
      if (t && !SKIP_USER_PREFIXES.some((x) => t.startsWith(x))) addPrompt(s, prompts, t, ts0, 0);
    } else if (it.type === 'message' && it.role === 'assistant') {
      s.counts.asst++;
      for (const b of it.content || []) if (b && b.text) outChars += b.text.length;
    } else if (it.type === 'function_call') {
      s.counts.tools++;
      outChars += (it.arguments || '').length;
    } else if (it.type === 'function_call_output') {
      inChars += (typeof it.output === 'string' ? it.output : '').length;
    }
  }
  const mname = 'o4-mini';
  const m = bump(s.models, mname);
  m.in = Math.round(inChars / 4); m.out = Math.round(outChars / 4); m.msgs = s.counts.asst;
  if (ts0) {
    const d = localDay(ts0);
    if (d) {
      const dr = dayRec(s, d);
      const dm = bump(dr.m, mname);
      dm.in = m.in; dm.out = m.out;
      dr.usd += cost(mname, { in: m.in, out: m.out });
    }
  }
  return { sessions: [s], prompts };
}

module.exports = { parseCodexFile, parseCodexOldFile };
