#!/usr/bin/env node
'use strict';
// AI Arena — analyze local Claude Code / Codex logs, grade prompt
// craft with a local AI, and share what you choose with the team.
const path = require('path');
const { parseArgs, log, fmt } = require('./lib/util');

const commands = {
  analyze: () => require('./lib/cmd_analyze').run,
  grade: () => require('./lib/cmd_grade').run,
  habits: () => require('./lib/cmd_habits').run,
  serve: () => require('./lib/cmd_serve').run,
  scan: () => require('./lib/cmd_scan').run,
  publish: () => require('./lib/cmd_publish').run,
  demo: () => require('./lib/cmd_demo').run,
  init: () => require('./lib/cmd_init').run,
};

const HELP = `
  AI Arena — learn from your team's AI power users

  usage: node arena.js <command> [options]

  init      --user <name>              set your display name (defaults to $USER)
  scan      [--add <path>]             show discovered log sources; --add extra roots (backups etc.)
  analyze   [--days N] [--exclude S]   parse logs into data/<you>/ (default: all history, incremental)
            [--force]                  ...ignore the file cache and re-parse everything
  grade     [--days N] [--sample N]    AI-grade your prompts with the local claude/codex CLI
            [--grader claude|codex] [--model <id>]   (default: your CLI's default/best model)
  habits    [--budget <chars>]         AI technique profile from your prompt SEQUENCES
            [--days N] [--grader ...]  (how you work: verification, planning, steering style)
  serve     [--port N] [--no-open]     start the dashboard (default http://localhost:4177)
  publish   [--dry-run]                review + commit + push your data/<you>/ to share it
  demo      [--remove]                 add/remove two synthetic demo users for a feel of team view

  Typical monthly run:  analyze -> grade -> serve (review) -> publish
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help') { log(HELP); return; }
  const loader = commands[cmd];
  if (!loader) { log(`Unknown command: ${cmd}\n${HELP}`); process.exit(1); }
  await loader()(args);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
