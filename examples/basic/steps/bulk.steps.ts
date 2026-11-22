import { strict as assert } from 'node:assert';
import { AfterStep, Given, Then } from '@bddr/runtime';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Given('I create user {string} with email {string}', async (ctx, name: string, email: string) => {
  const users = ctx.state.getOrSet<Map<string, string>>('users', () => new Map());
  await sleep(5); // pretend to call an API
  users.set(name, email);
  if (ctx.step!.attempt % 25 === 0) ctx.log.info(`created ${ctx.step!.attempt}/${ctx.step!.of} users`);
});

Then('there are {int} users', (ctx, n: number) => {
  assert.equal(ctx.state.get<Map<string, string>>('users').size, n);
});

Given('an export job that needs {int} checks', (ctx, n: number) => {
  ctx.state.set('job', { checksLeft: n });
});

Then('the export job is done', (ctx) => {
  const job = ctx.state.get<{ checksLeft: number }>('job');
  job.checksLeft--;
  ctx.log.info(`status check ${ctx.step!.attempt}: ${job.checksLeft > 0 ? 'RUNNING' : 'DONE'}`);
  assert.ok(job.checksLeft <= 0, 'export still RUNNING');
});

// Runs around EVERY attempt of a retried/repeated step (default hooks run once per step).
AfterStep({ eachAttempt: true, tags: 'not @quiet' }, (ctx) => {
  if (ctx.step?.mode === 'retry') ctx.log.debug(`attempt ${ctx.step.attempt}/${ctx.step.of} finished`);
});
