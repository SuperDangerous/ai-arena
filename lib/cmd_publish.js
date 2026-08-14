'use strict';
const readline = require('readline');
const { log, fmt } = require('./util');
const config = require('./config');
const core = require('./publish_core');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); }));
}

async function run(args) {
  const cfg = config.load();
  const dir = `data/${cfg.slug}`;
  if (!core.isRepo()) {
    log('Not a git repository yet. Clone the team repo, or create it first.'); process.exit(1);
  }

  const sum = core.summarize(cfg);
  log(`About to share ${dir}/ with the team:\n`);
  log(`  sessions.json  ${fmt.num(sum.sessions)} session summaries (counts, tokens, models, projects — no chat content)`);
  log(`  prompts.json   ${sum.exemplars} exemplar prompts (full text, score ≥7) + category score aggregates`);
  log(`  profile.json   name, avatar, machines, first/last activity`);
  log(`  lifetime ≈${fmt.usd(sum.usd)} API-equivalent across ${fmt.num(sum.sessions)} sessions\n`);

  if (sum.hits.length) {
    log(`⚠ possible secrets in exemplar prompts — edit data/${cfg.slug}/prompts.json first:`);
    for (const h of sum.hits) log(`   ${h}`);
  }

  const status = core.changed(cfg);
  if (!status) { log('Nothing new to publish — data is already committed.'); return; }
  log(`Changed files:\n${status.split('\n').map((l) => '  ' + l).join('\n')}\n`);

  if (args['dry-run']) { log('(dry run — nothing committed)'); return; }
  if (!args.yes) {
    const a = await ask(`Review in the dashboard's Publish tab first if unsure.\nCommit & push ${dir}? [y/N] `);
    if (a !== 'y' && a !== 'yes') { log('Aborted — nothing shared.'); return; }
  }
  const res = core.doPublish(cfg);
  if (!res.ok) log(res.error);
  else if (res.pushed) log('Published. Teammates will see your data on their next `git pull`.');
  else log(`${res.error}\nRun \`git push\` when you have access.`);
}

module.exports = { run };
