# AI Arena

**Learn from your team's AI power users.** Arena analyses each teammate's local
Claude Code and Codex session logs, works out what the usage would cost at API list
prices, grades prompt craft with a local AI against a shared [rubric](RUBRIC.md),
and profiles how each person actually drives their agents — then gives the team a
dashboard to compare styles, steal techniques, and copy each other's best prompts.

![AI Arena dashboard](docs/screenshot.png)

Zero dependencies. Node 18+ and plain git. Nothing ever leaves a machine unless
its owner commits and pushes it.

## The question it answers

Given the same tools and similar experience, why is teammate X more effective with
AI than teammate Y? Leaderboards can't tell you. Arena gets at it three ways:

- **Deterministic habit metrics** — words per prompt, session depth and reuse,
  compaction habits, reasoning-effort mix per model, cache efficiency, rhythm.
- **AI-graded prompt craft** — every sampled prompt scored 0–10 against a
  category-specific rubric where an 11-word bug report with precise anchors can
  beat a 500-word essay, and trivial asks can't inflate the average.
- **Habit profiles** — a frontier model reads whole sessions *in order* (how
  someone opens work, steers mid-flight, reacts when the agent claims "done") and
  writes an evidence-backed technique profile plus **copyable prompt templates in
  that person's voice**, with project specifics replaced by `<placeholders>`.

## Quick start

```bash
git clone https://github.com/SuperDangerous/ai-arena.git
cd ai-arena

node arena.js init --user "Your Name" --avatar ~/photo.jpg
node arena.js analyze --include Code/your-project   # parse local logs (whitelist recommended)
node arena.js serve                                 # dashboard → run Grade & Profile from Setup
```

Everything after `serve` can be driven from the web UI: grading (with a
how-many slider and live token/cost estimate), habit profiling, scope and
profile settings, and publishing. Two clearly-badged demo teammates ship in the
repo so the team views are explorable immediately (`node arena.js demo --remove`).

## Team setup: a shared data repo

Keep the tool public and your data private by pointing Arena's **data home** at a
separate private repo:

```bash
git clone https://github.com/your-org/ai-arena-data.git ~/Code/ai-arena-data
node arena.js init --data-dir ~/Code/ai-arena-data    # or Setup → Data home
```

Every read, write, avatar, and publish commit follows the data home. Teammates
run the tool at whatever cadence they like — sessions merge by id, so patchy
monthly runs still accumulate into one coherent history per person, even when
local logs get purged in between.

## What gets shared (and what doesn't)

| Shared via `«data home»/<you>/` | Never shared |
|---|---|
| Per-session **summaries**: counts, tokens by model, project names, timing | Chat transcripts, tool output, file contents |
| **Aggregate** prompt scores per category | Ungraded prompt texts (local cache only) |
| Your **best prompts** (score ≥ 7, best 6 per category), full text | Anything outside your include list |
| Your **habit profile** + copyable templates | `.arena/` config & caches |
| Profile: display name, avatar, machines, first/last activity | Removed examples & traits (parked locally) |

The Setup tab is a four-step pipeline — Collect → Grade → Profile → Share — with
live state at each step (what's ingested, graded vs ungraded, staged vs
published), honest token/cost estimates before every AI step, and a review
surface listing exactly what a publish would commit, item by item, each removable.

## Commands

```text
init      --user <name> [--avatar <img>] [--data-dir <path>]
scan      [--add <path>]                  discover log sources; add backups
analyze   [--days N]                      parse logs (incremental; resumes grown files)
          [--include S] [--exclude S]     project whitelist / blacklist (persisted)
          [--force] [--clear-include]
grade     [--days N] [--sample N]         AI-grade prompts via your local CLI
          [--grader claude|codex] [--model <id>]
habits    [--budget <chars>]              AI technique profile from prompt sequences
serve     [--port N] [--no-open]          dashboard at http://localhost:4177
publish   [--dry-run] [--yes]             review + commit + push your data
demo      [--remove]                      add/remove the demo teammates
```

Logs are found automatically in `~/.claude/projects`, `~/.codex/sessions` (and
`archived_sessions`), including the 2025 flat rollout format and dirs relocated
via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Backup mirrors are opt-in
(`scan --add`), duplicates de-duplicate by session id, and grown append-only
logs resume from a stored byte offset — warm re-analyses take well under a second.

## Honest numbers

- **Cost is API-equivalent** at list prices from the editable
  [`pricing.json`](pricing.json) — read it as *value extracted*, not money spent.
  Unverified model prices are flagged and render with ≈.
- **Grading** runs through whichever CLI you have (Claude Code or Codex),
  defaulting to its strongest model — on a 250-prompt benchmark two frontier
  graders agreed with each other at r = 0.86 while a budget model ran ~1.5 points
  harsher and noisier. Every grade is cached forever, so scores never drift.
- **Energy** is shown as a clearly-marked rough estimate (no vendor publishes
  per-token energy); the Wh-per-million-token factors are editable.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data flow, file formats, and the
parser edge-case ledger (replayed subagent threads, headless-CLI detection,
injected-context guards, dedupe claims — real logs are messy).

## Repo layout

```
arena.js          CLI entry
lib/              parsers, pricing, grading, habits, server, store
web/              the dashboard (vanilla JS + hand-rolled SVG, no build step)
pricing.json      editable price + energy factors
RUBRIC.md         the grading rubric
ARCHITECTURE.md   internals
data/demo-*/      demo teammates (safe to delete)
```
