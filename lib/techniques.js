'use strict';
// Deterministic prompt-technique detection. Cheap regex signals applied to every
// human prompt; aggregate rates surface who actually uses personas, effort
// modifiers, plan-first framing, acceptance criteria, verification asks, etc.
const TECHNIQUES = [
  { key: 'persona',  label: 'Persona framing',      re: /\b(you are (a|an|the|my|now)\b|act as\b|take the role|you're (a|an)\b|as (a|an) (senior|expert|world[- ]class|principal))/i },
  { key: 'effort',   label: 'Effort modifiers',     re: /\b(ultrathink|think (very )?hard(er)?|think deeply|think longer|try harder|be (extremely |very )?thorough|exhaustive|comprehensive|meticulous|maximum effort|no shortcuts|deep dive|go deeper|ultra(code)?\b)/i },
  { key: 'plan',     label: 'Plan-first',           re: /\b(make a plan|plan (first|before|out|this)|write (a|the) plan|break (it|this|the task) down|step[- ]by[- ]step|road ?map|in phases|todo list)\b/i },
  { key: 'criteria', label: 'Success criteria',     re: /\b(acceptance criteria|success criteria|definition of done|expected (behaviou?r|result|output)|should (pass|look like|behave|render|return)|when (it'?s|this is) (done|working))\b/i },
  { key: 'verify',   label: 'Verification asks',    re: /\b(verify|make sure|double[- ]check|confirm (that|it|the)|run (the )?tests?|test (it|this|that|the)|screenshot|prove|sanity[- ]check|check (that|it works))\b/i },
  { key: 'anchors',  label: 'Precise anchors',      re: /(`[^`]{2,}`|\/[\w.-]+\/[\w./-]+|\b[\w-]+\.(tsx?|jsx?|py|go|rs|c|cpp|h|css|scss|html|json|md|ya?ml|sh|sql|vue|svelte|cjs|mjs|toml)\b|\bline \d+|:\d+\b)/ },
  { key: 'agents',   label: 'Agent orchestration',  re: /\b(sub[- ]?agents?|worktrees?|in parallel|parallel(ise|ize)?|fan[- ]?out|orchestrat\w+|background (task|agent)|spawn|workflow|multi[- ]agent)\b/i },
  { key: 'refs',     label: 'External references',  re: /(https?:\/\/|\bsee (the )?(docs|documentation|readme|spec|design)\b|\bper the (spec|docs|ticket)\b)/i },
  { key: 'examples', label: 'Concrete examples',    re: /\b(for example|e\.g\.|for instance|like this:|such as|here's an example|similar to (the|how))\b/i },
  { key: 'scope',    label: 'Scope guards',         re: /\b(don't (touch|change|modify|refactor)|do not (touch|change|modify)|leave .{0,30} (alone|as[- ]is)|out of scope|only (change|touch|modify)|nothing else|keep (it|this) (minimal|small|simple))\b/i },
];

function detect(text) {
  const found = [];
  for (const t of TECHNIQUES) if (t.re.test(text)) found.push(t.key);
  return found;
}

// Steering interjections — excluded from AI grading, but their rate is itself a metric.
function isNudge(text) {
  const t = text.trim();
  if (t.length < 12) return true;
  return /^(yes|no|ok(ay)?|sure|go|go ahead|continue|proceed|keep going|do it|next|try again|retry|good|great|perfect|thanks?|ty|please continue|carry on|resume|and|also|why|how|what|hmm+|wait)\b[\s\S]{0,40}$/i.test(t);
}

module.exports = { TECHNIQUES, detect, isNudge };
