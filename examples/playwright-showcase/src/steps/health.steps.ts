import { strict as assert } from 'node:assert';
import { Then, When } from '@bddr/runtime';
import { HEALTH_STATUS, requiredParam } from '../support/world.js';

When('I check the {string} target', async (ctx, target: string) => {
  const params: Record<string, string> = {
    ui: 'uiBaseUrl',
    api: 'apiBaseUrl',
    saucedemo: 'sauceBaseUrl',
    todomvc: 'todoBaseUrl',
    dummyjson: 'dummyApiBaseUrl',
  };
  const param = params[target];
  if (!param) throw new Error(`Unknown health target: ${target}`);
  const url = requiredParam(ctx, param);
  const result = await ctx.request.get(url, { timeout: 15_000 });
  ctx.state.set(HEALTH_STATUS, result.status());
  ctx.log.info(`${target} health response`, { url, status: result.status() });
});

Then('the health response status is {int}', (ctx, expected: number) => {
  assert.equal(ctx.state.get<number>(HEALTH_STATUS), expected);
});

Then('I export the successful health check', (ctx) => {
  ctx.export('status', ctx.state.get<number>(HEALTH_STATUS));
});

Then('health check {string} exported status {int}', (ctx, id: string, expected: number) => {
  assert.equal(ctx.from(id).get<number>('status'), expected);
});

When('a controlled transient step runs', (ctx) => {
  if (ctx.scenario.attempt === 1) throw new Error('controlled transient failure for retry demonstration');
});

Then('the scenario attempt is {int}', (ctx, expected: number) => {
  assert.equal(ctx.scenario.attempt, expected);
});
