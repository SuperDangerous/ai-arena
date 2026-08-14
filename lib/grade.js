'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LOCAL, ensureDir } = require('./util');

// The CLIs aren't always on a non-interactive PATH (Codex ships inside the
// ChatGPT desktop app). Resolve known install locations as fallbacks.
const CMD_FALLBACKS = {
  codex: [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
  ],
  claude: [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
  ],
};
const cmdCache = new Map();
function resolveCmd(cmd) {
  if (cmdCache.has(cmd)) return cmdCache.get(cmd);
  let found = null;
  const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => {
    try { return d && fs.existsSync(path.join(d, cmd)); } catch { return false; }
  });
  if (onPath) found = cmd;
  else for (const p of CMD_FALLBACKS[cmd] || []) {
    if (fs.existsSync(p)) { found = p; break; }
  }
  cmdCache.set(cmd, found);
  return found;
}
// Which grading CLIs exist on this machine? Most people have exactly one.
function availableGraders() {
  return ['claude', 'codex'].filter((c) => resolveCmd(c));
}

const CATS = ['bugfix', 'feature', 'epic', 'testinfra', 'workflow', 'research', 'ops', 'other'];

function rubricPrompt(batch) {
  return `You are an exacting prompt-engineering coach. Below are prompts real engineers gave to coding agents (Claude Code / Codex CLI). Classify and grade each one.

Categories: bugfix (bug fixing/QA) | feature (specific feature) | epic (large multi-part functionality) | testinfra (tests/test infrastructure) | workflow (goal/process/meta prompts about HOW the agent should work) | research (investigation/understanding) | ops (env/build/deploy/git) | other

Score 0-10 against the ideal FOR THAT CATEGORY. Core principle: the agent has tools — it can read the codebase, run the app, search. A great prompt supplies only what the agent cannot discover: intent, location, constraints, what done looks like. Brevity with precise anchors is excellent ("fix the wizard badge regression in System Manager — badge should sit top-right like before" = 9). Length alone earns nothing.
STAKES GATE: score the craft the task allows, not mere adequacy. A trivial ask — a quick lookup question, a casual aside, a one-liner tweak any phrasing would convey equally well — caps at 5 even when perfectly phrased: there is no craft differential to reward. Reserve 7+ for prompts demonstrating transferable technique on substantive work (multi-step, ambiguous, or high-consequence), and 9-10 for substantive briefs a teammate could not have written better.
Ideals: bugfix→symptom+where+repro/evidence+expected behaviour. feature→outcome+integration point+constraints+acceptance criteria. epic→goal+scope in/out+phases+quality bar+verification plan. testinfra→coverage target+framework+how to run+what done means. workflow→process design: plan-first, checkpoints, verification gates, loops, when to stop. research→question+why+depth+output format. ops→task+environment+safety rails.
Deduct: vague intent ("make it better"), missing anchors the user clearly had, no success criteria on big asks, kitchen-sink over-spec burying the goal, ambiguity. Credit when apt: personas, effort modifiers, plan-first, verification asks, examples, doc references, scope guards.

For each prompt return: i (index), cat, score (integer 0-10), s (up to 2 short strengths), w (up to 2 short weaknesses), note (ONE punchy coaching sentence, ≤120 chars).

Reply with ONLY a JSON array, no prose, no markdown fences, same order as input:
[{"i":0,"cat":"bugfix","score":8,"s":["precise anchor"],"w":["no expected behaviour"],"note":"..."}]

PROMPTS:
${JSON.stringify(batch.map((p, i) => ({ i, text: p.text.length > 1600 ? p.text.slice(0, 1600) + ' …[truncated]' : p.text })), null, 0)}`;
}

function extractJson(text, open, close) {
  const start = text.indexOf(open);
  if (start < 0) return null;
  // walk to the matching close bracket of the outermost structure
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    } }
  }
  return null;
}
const extractJsonArray = (text) => extractJson(text, '[', ']');
const extractJsonObject = (text) => extractJson(text, '{', '}');

// Grading sessions are themselves logged by the CLIs; running from this scratch
// cwd (matched by a built-in exclude in analyze) keeps them out of the dataset.
function graderCwd() {
  return ensureDir(path.join(LOCAL, 'grader'));
}

function runCli(cmd, cliArgs, input, timeoutMs) {
  const bin = resolveCmd(cmd);
  if (!bin) return Promise.resolve({ code: -1, out: '', err: `${cmd} CLI not installed` });
  return new Promise((resolve) => {
    const child = spawn(bin, cliArgs, {
      cwd: graderCwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

async function gradeBatchClaude(batch, model) {
  const prompt = rubricPrompt(batch);
  // no model flag → the CLI's own default, i.e. the user's strongest model
  const args = model ? ['-p', '--model', model, '--output-format', 'text'] : ['-p', '--output-format', 'text'];
  const res = await runCli('claude', args, prompt, 540000);
  if (res.code !== 0) throw new Error(`claude exited ${res.code}: ${(res.err || res.out).slice(0, 300)}`);
  const arr = extractJsonArray(res.out);
  if (!arr) throw new Error(`no JSON array in claude output: ${res.out.slice(0, 200)}`);
  return arr;
}

async function gradeBatchCodex(batch, model) {
  const prompt = rubricPrompt(batch);
  const args = ['exec', '--skip-git-repo-check'];
  if (model) args.push('-m', model);
  args.push('-');
  const res = await runCli('codex', args, prompt, 540000);
  if (res.code !== 0) throw new Error(`codex exited ${res.code}: ${(res.err || res.out).slice(0, 300)}`);
  const arr = extractJsonArray(res.out.split('\n').filter((l) => !l.startsWith('{')).join('\n')) || extractJsonArray(res.out);
  if (!arr) throw new Error(`no JSON array in codex output`);
  return arr;
}

function validate(arr, batchLen) {
  const byIdx = new Map();
  for (const r of Array.isArray(arr) ? arr : []) {
    if (!r || typeof r.i !== 'number' || r.i < 0 || r.i >= batchLen) continue;
    const cat = CATS.includes(r.cat) ? r.cat : 'other';
    const score = Math.max(0, Math.min(10, Math.round(Number(r.score))));
    if (isNaN(score)) continue;
    byIdx.set(r.i, {
      cat, score,
      s: (Array.isArray(r.s) ? r.s : []).slice(0, 2).map(String),
      w: (Array.isArray(r.w) ? r.w : []).slice(0, 2).map(String),
      note: String(r.note || '').slice(0, 200),
    });
  }
  return byIdx;
}

async function gradeBatch(batch, { grader, model }) {
  const avail = availableGraders();
  if (!avail.length) throw new Error('neither the claude nor the codex CLI is installed — grading needs one of them');
  const order = (grader === 'codex' ? ['codex', 'claude'] : ['claude', 'codex']).filter((g) => avail.includes(g));
  let lastErr;
  for (const g of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const arr = g === 'claude' ? await gradeBatchClaude(batch, model) : await gradeBatchCodex(batch, grader === 'codex' ? model : null);
        const byIdx = validate(arr, batch.length);
        if (byIdx.size >= Math.max(1, batch.length * 0.5)) return { byIdx, grader: g };
        lastErr = new Error(`only ${byIdx.size}/${batch.length} valid results`);
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr;
}

// Run an arbitrary prompt through the best available local CLI; returns stdout.
async function runPrompt(prompt, { grader, model, timeoutMs = 900000 } = {}) {
  const avail = availableGraders();
  if (!avail.length) throw new Error('neither the claude nor the codex CLI is installed');
  const order = (grader === 'codex' ? ['codex', 'claude'] : ['claude', 'codex']).filter((g) => avail.includes(g));
  let lastErr;
  for (const g of order) {
    const args = g === 'claude'
      ? (model ? ['-p', '--model', model, '--output-format', 'text'] : ['-p', '--output-format', 'text'])
      : ['exec', '--skip-git-repo-check', ...(grader === 'codex' && model ? ['-m', model] : []), '-'];
    const res = await runCli(g, args, prompt, timeoutMs);
    if (res.code === 0 && res.out.trim()) return { out: res.out, grader: g };
    lastErr = new Error(`${g} exited ${res.code}: ${(res.err || res.out).slice(0, 200)}`);
  }
  throw lastErr;
}

module.exports = { CATS, gradeBatch, gradeBatchClaude, gradeBatchCodex, validate, rubricPrompt, extractJsonArray, extractJsonObject, runPrompt, availableGraders };
