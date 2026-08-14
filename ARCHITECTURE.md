# Architecture

Zero-dependency Node (≥18). Four moving parts: **parsers** turn local session logs
into session summaries, the **store** merges them into a durable per-user dataset,
the **grader** scores prompt craft through a local AI CLI, and the **server** feeds
a vanilla-JS dashboard. Sharing is plain git.

```
 ~/.claude/projects/**.jsonl ─┐
 ~/.codex/sessions/**.jsonl ──┤  discover + sniff        merge by session id
 backups (scan --add) ────────┴──► parsers ──► sessions ──► data/<you>/sessions.json
                                      │                          ▲ prune: include/exclude,
                                      └► human prompts           │        non-interactive
                                          │ (.arena/cache/prompts.json, local only)
                                          ▼
                              grade (local claude/codex CLI, rubric, cached)
                                          │
                                          ▼
                    data/<you>/prompts.json  (category aggregates + exemplars ≥7)
                                          │
        serve ◄── data/*/ ◄── publish (review → secret scan → git commit/push)
```

## Data files

### `data/<user>/sessions.json` — the source of truth

`{ schema: 1, sessions: { <id>: Session } }`, merged across runs and machines.
Every dashboard number derives from these; nothing else is authoritative.

```jsonc
{
  "id": "uuid or thread id",
  "tool": "claude | codex",
  "kind": "interactive",              // auto/agent sessions are dropped at ingest
  "surface": "cli | claude-desktop | Codex Desktop | …",
  "project": "acme-app",          // basename of projectPath
  "projectPath": "/Users/x/Code/acme-app",  // rolled up to the git repo root
  "title": "Wizard UI design review", // custom > AI title > codex thread name
  "branch": "dev", "start": "ISO", "end": "ISO", "version": "cli version",
  "counts": { "prompts": 0, "agentPrompts": 0, "asst": 0, "tools": 0, "imgs": 0, "nudges": 0 },
  "models": { "<model>": { "in": 0, "cachedIn": 0, "cr": 0, "cw5m": 0, "cw1h": 0, "out": 0, "reason": 0, "msgs": 0 } },
  "days":   { "YYYY-MM-DD": { "p": 0, "usd": 0, "m": { "<model>": { /* same shape */ } } } },
  "hours":  [24 ints],                // prompt count by local hour
  "slash":  { "compact": 2 },        // slash-command tallies (claude)
  "tech":   { "persona": 3, "verify": 7 },  // regex technique hits (see lib/techniques.js)
  "promptChars": 0, "estimated": false
}
```

Token semantics: Anthropic's `in` excludes cache traffic (`cr`/`cw5m`/`cw1h` are
separate buckets); OpenAI's `in` *includes* `cachedIn`, cache writes are free, and
reasoning tokens are already inside `out`. `lib/pricing.js` (and its client mirror)
prices accordingly; per-day `usd` is baked for convenience but the dashboard
recomputes model costs from raw counts, so editing `pricing.json` needs no re-run.

### `data/<user>/prompts.json`

`categories` (`{cat: {n, sum, hist[11]}}`), `exemplars` (`{cat: [ExemplarPrompt]}`,
score ≥ 7, capped 6/category, full text ≤ 3000 chars), and `gradeRuns` history.
This file always holds **exactly what a publish would share** — excluding a prompt
in the UI physically removes it here and parks it in `.arena/`.

### `data/<user>/habits.json`

The AI technique profile: `{generatedAt, grader, sessionsSampled, promptsSampled,
summary, traits: [{title, detail, kind, strength 1-3, evidence: [{quote}]}]}` —
produced by `cmd_habits` from prompt *sequences* (sessions in order), titles/details
project-agnostic, quotes verbatim and user-curated (`POST /api/habit` removes one).

### `data/<user>/profile.json` + `avatar.*`

Display name, slug, machines seen, tools, first/last activity, avatar filename.

### The data home

`dataDir` in `.arena/config.json` relocates everything above — a dedicated git
repo or shared drive — resolved by `store.dataDir()`; publish/git status run in
whichever repo contains it (`publish_core.repoRoot()`). Default: `<app>/data`.

### `.arena/` (gitignored, never shared)

`config.json` (name, extra sources, include/exclude lists, grader prefs) and
`cache/`: `files.json` (per-file size+mtime fingerprints → incremental parsing),
`claims.json` (request-id → session claims, see dedupe below), `prompts.json`
(every extracted human prompt, the grading pool), `graded.json` (per-prompt grades,
graded once ever), `excluded-exemplars.json` (curated-out exemplars, restorable).

## Parser ledger — the hard-won edge cases

Real logs are messier than their schemas. Everything below was found in production
data; each rule lives in `lib/parse_claude.js` / `lib/parse_codex.js`.

**Claude Code (`~/.claude/projects/<munged-cwd>/<uuid>.jsonl`)**
- Assistant entries carry `message.usage` (4 token buckets incl. 5m/1h cache-write
  split) and `requestId`. Forked/resumed sessions replay history into new files with
  the same requestIds → usage is claimed once, globally, via `claims.json`.
- Human prompts are `type:user` entries whose `origin.kind === 'human'`. Entries
  with `promptSource` but no human origin are headless `-p`/SDK input (apps driving
  the CLI) → the session classifies as automation and is dropped. Legacy logs
  predate both fields → treated as human.
- Slash commands log as `<command-message>` wrappers; the human part is inside
  `<command-args>` and is extracted (that's how `/goal` and `/loop` prompts count).
- Skipped: tool results, `isMeta`, sidechains (counted as `agentPrompts`),
  `<teammate-message>`, task notifications, compaction continuations ("This session
  is being continued…"), interruption markers, and **anything opening with an
  XML-ish tag** — the generic guard that catches future injected context.
- Session titles: `custom-title` > `ai-title` > `summary` lines.

**Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)**
- `session_meta.payload.source` classifies the thread: `exec` → automation,
  `{subagent}` → agent thread, else interactive. **Subagent files replay the
  parent's `user_message` events** — never counted.
- Tokens come from `event_msg:token_count` — per-turn `last_token_usage` summed for
  daily attribution, with the final cumulative total as a top-up when events were
  dropped. Model comes from the latest `turn_context`.
- Codex Desktop wraps image pastes in "# Files mentioned by the user: … ## My
  request:" → unwrapped to the human part. `<in-app-browser-context>`,
  `<heartbeat>`, `<codex_delegation>` etc. fall to the tag guard.
- Titles come from `~/.codex/session_index.jsonl` (thread names).
- The flat 2025 `rollout-*.json` format has no usage data → tokens estimated at
  ~4 chars/token and flagged `estimated` (rendered with ≈).

**Both**
- `projectOf(cwd)` rolls worktree checkouts (`repo/.claude/worktrees/x`,
  `repo/worktrees/x`) and repo subdirectories up to the nearest ancestor with
  `.git` (regex fallback for vanished paths) — so worktrees and subdirs never
  masquerade as projects.
- Merging: sessions merge by id, richer parse wins; backup copies de-duplicate
  naturally. Include/exclude lists and the interactive-only rule prune both new
  and previously-stored sessions.
- Incremental cost control: unchanged files skip via size+mtime fingerprints;
  grown append-only logs RESUME from a stored byte offset (per-file sid, active
  model, and prompt ordinal ride along in the cache; tails merge additively onto
  the stored session, and a half-written trailing line never advances the
  offset). Files whose sessions are entirely out of scope carry a skip marker
  keyed to the include/exclude fingerprint — growing out-of-scope logs cost
  nothing until the scope changes. Cloud backup mirrors are opt-in sources
  (scan --add), never defaults: reading iCloud folders can trigger on-demand
  downloads of the entire mirror.

## Grading

`grade` samples ungraded prompts from the window (longest 60 + seeded-random fill,
≤ `--sample`), batches 12 per call to the local CLI with `RUBRIC.md`'s logic
embedded, and validates strict-JSON responses (category whitelist, score clamp,
one retry, then the other CLI if installed). Results cache permanently by prompt id
(`.arena/cache/graded.json`) so scores never drift — re-runs only grade new
prompts. Grader binaries resolve off-PATH install locations (Codex ships inside
ChatGPT.app); machines with one CLI use that one, with neither get install links.
Grading sessions themselves run from `.arena/grader` cwd, which a built-in exclude
keeps out of the dataset.

Model choice matters: on a 250-prompt benchmark, Fable and gpt-5.6 agreed with each
other at r = 0.86 (88% within ±1 point) while haiku correlated ~0.75 with either
and ran ~1.45 points harsher. Default is therefore your CLI's strongest model.

## Server & dashboard

`serve` is a dependency-free HTTP server: static `web/`, avatar images from
`data/`, `GET /api/dataset` (all users + pricing + git status, 5s cache) and
`POST /api/exemplar` (the Shared/Excluded toggle). The dashboard is vanilla ES
modules: `app.js` (state, aggregation memoised per filter set, five views) and
`charts.js` (hand-rolled SVG: stacked/line timelines with crosshair tooltips,
calendar heatmap, dot plots, bars — mark specs follow the house dataviz rules).
All user-supplied text enters the DOM via `textContent`.

## Publishing

`publish` (CLI) and the Publish tab (UI) are two faces of one flow: show exactly
what `data/<you>/` contains, secret-scan exemplar text, then plain `git add/commit/
push` — run for you after a y/N, or by hand. Nothing outside `data/<you>/` is ever
touched, so sharing stays voluntary, reviewable, and reversible per person.
