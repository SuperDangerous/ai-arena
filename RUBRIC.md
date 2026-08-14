# Prompt-craft rubric

Every sampled prompt is classified into a category, then scored 0–10 **against the
ideal for that category** — never against a generic "more detail is better" scale.

## The core principle

Agents have tools. They can read the codebase, run the app, and search the web.
A great prompt supplies the things the agent *cannot* discover on its own — intent,
location, constraints, and what "done" looks like — and nothing else.

> "fix the wizard badge regression in System Manager — badge should sit top-right
> of the button like before" — 9/10. Symptom, place, expected behaviour. Eleven words.

Length is neither rewarded nor punished. A 2,000-word epic brief and an 11-word bug
report can both be perfect; a vague 40-word prompt ("make it better, also clean up")
is worse than either.

**Stakes gate.** Scores reward *craft*, not adequacy — and craft only shows on tasks
that could go wrong. A casual lookup question or one-liner tweak that any phrasing
would convey equally well caps at 5, however tidy. 7+ means the prompt demonstrates
technique a teammate could transfer to their own substantive work; that's what makes
an exemplar worth putting in the shared library.

## Categories and their ideals

| Category | The ideal prompt gives... |
|---|---|
| **bugfix** — bug fixing / QA | symptom, where it happens (app / area / file), repro or evidence, expected behaviour |
| **feature** — a specific feature | outcome, where it integrates, constraints, acceptance criteria |
| **epic** — large multi-part functionality | goal, scope boundaries (in *and* out), phases or priorities, quality bar, verification plan |
| **testinfra** — tests & test infrastructure | what to cover or harden, framework/conventions, how to run, what flaky/done means |
| **workflow** — goal/process/meta prompts | a working process: plan-first, checkpoints, verification gates, loops, subagents, when to stop |
| **research** — investigation / understanding | the question, why it matters, depth wanted, output format |
| **ops** — environment / build / deploy / git | the task, the environment, safety rails |
| **other** — anything else | clear intent, enough anchors to act |

## Scoring guide

- **9–10** — a substantive brief a teammate could not have written better. Precise
  anchors, clear outcome, right level of trust in the agent's tools. Worth stealing.
- **7–8** — strong technique on real work; minor gaps (e.g. no expected behaviour on
  a bug, fuzzy scope edge).
- **5–6** — workable but the agent must guess something important — or a trivial ask,
  however neatly phrased (adequate ≠ exemplary).
- **3–4** — vague intent or kitchen-sink over-specification that buries the goal.
- **0–2** — "make it better" / contradictory / unanswerable as written.

**Deductions:** missing anchors the user clearly had; no success criteria on a large
ask; ambiguity between multiple plausible readings; over-specifying details the agent
can find itself (pasting code it could read); scope creep mid-prompt.

**Credit (when apt):** personas, effort modifiers ("think hard", "ultrathink"),
plan-first framing, explicit verification asks, concrete examples, references to
docs/specs, scope guards ("don't touch X").

Nudges ("continue", "yes", "try again") are not graded — but a high nudge-to-prompt
ratio is itself a signal worth watching on the dashboard.
