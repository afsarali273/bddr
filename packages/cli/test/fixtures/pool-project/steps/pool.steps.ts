import { strict as assert } from 'node:assert';
import { appendFileSync } from 'node:fs';
import { AfterAll, AfterFeature, AfterWorker, BeforeAll, BeforeFeature, BeforeWorker, Given, Then } from '@bddr/runtime';

if (process.env['BDDR_TEST_BREAK_WORKER'] && process.env['BDDR_WORKER_ID']) throw new Error('support code broken in workers');

/** Hook trace: -D trace=<file> */
const trace = (ctx: { params: Record<string, string> }, line: string) => {
  if (ctx.params['trace']) appendFileSync(ctx.params['trace'], `${line}\n`);
};

BeforeAll((ctx) => {
  trace(ctx, `beforeAll ${process.env['BDDR_WORKER_ID'] ?? 'parent'}`);
  ctx.run.set('seed', { n: 1 });
  ctx.run.set('notCloneable', () => 1);
});
AfterAll((ctx) => trace(ctx, `afterAll ${process.env['BDDR_WORKER_ID'] ?? 'parent'}`));
BeforeWorker((ctx) => trace(ctx, `beforeWorker ${process.env['BDDR_WORKER_ID'] ?? 'inline'}`));
AfterWorker((ctx) => trace(ctx, `afterWorker ${process.env['BDDR_WORKER_ID'] ?? 'inline'}`));
BeforeFeature((ctx) => trace(ctx, `beforeFeature ${process.env['BDDR_WORKER_ID'] ?? 'inline'}`));
AfterFeature((ctx) => trace(ctx, `afterFeature ${process.env['BDDR_WORKER_ID'] ?? 'inline'}`));

Given('I export my process id', (ctx) => ctx.export('pid', process.pid));
Then("I can read the producer's process id", (ctx) => assert.equal(typeof ctx.from('producer').get<number>('pid'), 'number'));
Then('the run store holds the BeforeAll seed', (ctx) => {
  assert.deepEqual(ctx.run.get('seed'), { n: 1 });
  if (process.env['BDDR_WORKER_ID']) assert.equal(ctx.run.has('notCloneable'), false);
});
Given('I record my process id', async (ctx) => {
  trace(ctx, `scenario ${process.pid}`);
  await new Promise((r) => setTimeout(r, 30));
});
Given('the worker crashes if crash=yes', (ctx) => {
  if (ctx.params['crash'] === 'yes') process.exit(3);
  if (ctx.params['hang'] === 'yes') return new Promise((resolve) => setTimeout(resolve, 2000));
});
