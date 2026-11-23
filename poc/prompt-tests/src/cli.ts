/**
 * POC command line.
 *   tsx src/cli.ts status  [dir]
 *   tsx src/cli.ts approve [dir] [--by name] [id ...]
 *   tsx src/cli.ts run     [dir] [--mutate a,b] [--heal off|propose|write]
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from '../app/shop.js';
import { LocatorHealer, CommandAgent } from './agents.js';
import { approve, scan } from './project.js';
import { runAll } from './runner.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { by: { type: 'string' }, mutate: { type: 'string' }, heal: { type: 'string' } },
});
const [command = 'status', dirArg, ...ids] = positionals;
const dir = resolve(dirArg ?? join(import.meta.dirname, '..', 'tests'));
const tmpDir = join(import.meta.dirname, '..', '.tmp');

if (command === 'status') {
  for (const e of scan(dir)) console.log(`${e.state.padEnd(20)} ${e.id}${e.reasons.length ? `  (${e.reasons.join('; ')})` : ''}`);
} else if (command === 'approve') {
  const done = approve(dir, ids.length ? ids : 'all', values.by ?? process.env.USER ?? 'unknown', new Date().toISOString().slice(0, 10));
  console.log(`approved ${done.length}: ${done.join(', ')}`);
} else if (command === 'run') {
  const mutations = values.mutate ? values.mutate.split(',') : [];
  const agent = process.env.BDDR_AGENT ? new CommandAgent(process.env.BDDR_AGENT) : new LocatorHealer();
  const reports = await runAll({
    dir,
    tmpDir,
    heal: (values.heal as 'off' | 'propose' | 'write') ?? 'off',
    agent,
    fixtures: (attempt) => createApp(mutations, { attempt }),
  });
  let failed = 0;
  for (const r of reports) {
    const outcome = r.result?.outcome ?? r.state;
    if (outcome !== 'passed') failed++;
    const healed = r.heal ? `  heal: ${r.heal.status} after ${r.heal.attempts} attempt(s)` : '';
    console.log(`${outcome.padEnd(22)} ${r.id}${r.retries ? `  (retried ${r.retries})` : ''}${healed}`);
    if (r.result?.error && outcome !== 'passed') console.log(`${''.padEnd(23)}${r.result.failedCheck ? `${r.result.failedCheck}: ` : ''}${r.result.error.message}`);
    for (const reason of r.heal?.reasons ?? []) console.log(`${''.padEnd(25)}${reason}`);
  }
  console.log(`\n${reports.length - failed} passed, ${failed} not passed`);
  process.exitCode = failed ? 1 : 0;
} else {
  console.error(`unknown command ${command}`);
  process.exitCode = 2;
}
