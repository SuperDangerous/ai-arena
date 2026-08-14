'use strict';
const path = require('path');
const { eachJsonl, localDay, projectOf } = require('./util');
const { cost } = require('./pricing');

const SKIP_PREFIXES = [
  '<command-name>', '<local-command-caveat>', '<local-command-stdout>',
  '<task-notification>', '<system-reminder>', '<bash-input>', '<bash-stdout>',
  '[Request interrupted', 'API Error', '<user-memory-input>',
  '<teammate-message', 'Another Claude session sent a message',
  '[SYSTEM NOTIFICATION', '<session-context>',
  'This session is being continued from a previous conversation',
];

function extractText(content) {
  if (typeof content === 'string') return { text: content, imgs: 0, toolResult: false };
  if (!Array.isArray(content)) return { text: '', imgs: 0, toolResult: false };
  let text = '', imgs = 0, toolResult = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') text += (text ? '\n' : '') + (b.text || '');
    else if (b.type === 'image') imgs++;
    else if (b.type === 'tool_result') toolResult = true;
  }
  return { text, imgs, toolResult };
}

function blankSession(id) {
  return {
    id, tool: 'claude', kind: 'interactive', surface: null, project: null, projectPath: null,
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

// Parses one Claude Code session .jsonl. `claims` maps requestId -> sessionId so
// forked/duplicated files (resume forks, backup copies) never double-count usage.
// `start` > 0 resumes an append-only file from a byte offset; the caller merges
// the resulting partial additively onto the stored session.
async function parseClaudeFile(file, { claims, start = 0 }) {
  const sessions = new Map(); // usually exactly one per file
  const prompts = [];
  const fallbackId = path.basename(file).replace(/\.jsonl$/, '');
  const titles = {}; // sid -> {custom, ai, summary}

  const prefilter = (line) =>
    line.includes('"type":"user"') || line.includes('"type":"assistant"') ||
    line.includes('"custom-title"') || line.includes('"ai-title"') || line.includes('"type":"summary"');

  const { offset } = await eachJsonl(file, prefilter, (o) => {
    if (o.type === 'custom-title') { (titles[o.sessionId] = titles[o.sessionId] || {}).custom = o.customTitle; return; }
    if (o.type === 'ai-title') { (titles[o.sessionId] = titles[o.sessionId] || {}).ai = o.aiTitle; return; }
    if (o.type === 'summary') { (titles.__last = titles.__last || {}).summary = o.summary; return; }
    if (o.type !== 'user' && o.type !== 'assistant') return;

    const sid = o.sessionId || fallbackId;
    let s = sessions.get(sid);
    if (!s) { s = blankSession(sid); sessions.set(sid, s); s._human = 0; s._auto = 0; }
    if (o.cwd && !s.projectPath) { const pr = projectOf(o.cwd); s.projectPath = pr.path; s.project = pr.name; }
    if (o.gitBranch && !s.branch) s.branch = o.gitBranch;
    if (o.version) s.version = o.version;
    if (o.entrypoint && !s.surface) s.surface = o.entrypoint;
    const ts = o.timestamp;
    if (ts) {
      if (!s.start || ts < s.start) s.start = ts;
      if (!s.end || ts > s.end) s.end = ts;
    }

    if (o.type === 'user') {
      const msg = o.message || {};
      if (msg.role !== 'user') return;
      const { text, imgs, toolResult } = extractText(msg.content);
      if (toolResult) return;
      s.counts.imgs += imgs;
      let t = (text || '').trim();
      if (!t && !imgs) return;
      // Slash commands are logged as <command-message>/<command-name> wrappers;
      // the human-authored part, when any, is inside <command-args>.
      const cmd = t.match(/<command-name>\/?([\w:-]+)<\/command-name>/);
      if (cmd) {
        s.slash[cmd[1]] = (s.slash[cmd[1]] || 0) + 1;
        const cargs = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
        t = cargs ? cargs[1].trim() : '';
        if (t.length < 12) return;
      }
      if (o.isMeta) return;
      if (SKIP_PREFIXES.some((p) => t.startsWith(p))) return;
      // generic guard: a prompt that OPENS with an XML-ish tag is injected
      // machine context, not typing (command wrappers were unwrapped above)
      if (/^<\w/.test(t)) return;
      if (o.isSidechain) { s.counts.agentPrompts++; return; }
      if (!t) return; // image-only message
      // origin.kind distinguishes typed prompts from headless -p / SDK input
      // (apps invoking the CLI). Legacy logs predate both fields → human.
      if (o.origin && o.origin.kind !== 'human') return; // task-notification etc.
      const isHuman = o.origin ? o.origin.kind === 'human' : !('promptSource' in o);
      s.counts.prompts++;
      if (isHuman) { s._human++; s.promptChars += t.length; s.promptWords += t.split(/\s+/).filter(Boolean).length; } else s._auto++;
      if (ts) {
        const d = localDay(ts);
        if (d) dayRec(s, d).p++;
        s.hours[new Date(ts).getHours()]++;
      }
      if (isHuman) prompts.push({ id: `${sid}#${o.uuid || s.counts.prompts}`, sid, ts, text: t, imgs });
    } else {
      const msg = o.message || {};
      const u = msg.usage;
      s.counts.asst++;
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) if (b && b.type === 'tool_use') s.counts.tools++;
      }
      if (!u || !msg.model || msg.model === '<synthetic>') return;
      const reqKey = o.requestId || o.uuid;
      if (reqKey) {
        const owner = claims.get(reqKey);
        if (owner && owner !== sid) return; // replayed in a forked/copied file
        claims.set(reqKey, sid);
      }
      const cc = u.cache_creation || {};
      const cw5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens || 0);
      const cw1h = cc.ephemeral_1h_input_tokens || 0;
      const tk = {
        in: u.input_tokens || 0, cachedIn: 0, cr: u.cache_read_input_tokens || 0,
        cw5m, cw1h, out: u.output_tokens || 0,
      };
      const m = bump(s.models, msg.model);
      m.in += tk.in; m.cr += tk.cr; m.cw5m += tk.cw5m; m.cw1h += tk.cw1h; m.out += tk.out; m.msgs++;
      // reasoning effort rides on each assistant entry (e.g. "high", "max")
      if (o.effort) { m.eff = m.eff || {}; m.eff[o.effort] = (m.eff[o.effort] || 0) + 1; }
      if (ts) {
        const d = localDay(ts);
        if (d) {
          const dr = dayRec(s, d);
          const dm = bump(dr.m, msg.model);
          dm.in += tk.in; dm.cr += tk.cr; dm.cw5m += tk.cw5m; dm.cw1h += tk.cw1h; dm.out += tk.out; dm.msgs++;
          dr.usd += cost(msg.model, tk);
        }
      }
    }
  }, { start });

  for (const [sid, s] of sessions) {
    const t = titles[sid] || titles.__last || {};
    s.title = t.custom || t.ai || t.summary || null;
    // sessions whose only inputs were headless/SDK are automation, not a person
    if (!s._human && s._auto) s.kind = 'auto';
    delete s._human; delete s._auto;
  }
  return { sessions: [...sessions.values()], prompts, offset };
}

module.exports = { parseClaudeFile };
