import { strict as assert } from 'node:assert';
import { BeforeGroup, Given, Then, When } from '@bddr/runtime';

class ServiceUnavailable extends Error {
  override name = 'ServiceUnavailable';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let apiFailuresLeft = -1; // process-wide fake API state (survives scenario retries)
let warmPasses = 0;

Given('the payment API fails {int} time(s) with {string}', (ctx, times: number) => {
  if (apiFailuresLeft < 0) apiFailuresLeft = times;
  ctx.log.info(`attempt ${ctx.scenario.attempt}: API will fail ${apiFailuresLeft} more time(s)`);
});

When('I pay {int}', (ctx, amount: number) => {
  if (apiFailuresLeft > 0) {
    apiFailuresLeft--;
    throw new ServiceUnavailable('payment API returned 503');
  }
  ctx.state.set('paid', amount);
});

Then('the payment is accepted', (ctx) => assert.equal(ctx.state.get('paid'), 25));

BeforeGroup('@group:warmup', (ctx) => ctx.log.info('warm-up group starting'));

Then('the cache is warm after {int} pass/passes', (ctx, needed: number) => {
  warmPasses++;
  ctx.log.info(`warm-up pass ${warmPasses}/${needed}`);
  if (warmPasses < needed) throw new Error('ServiceUnavailable: cache still cold');
});

Then('the cache answers instantly', () => assert.ok(warmPasses >= 2));

Then('0.1 + 0.2 equals 0.3 exactly', () => {
  assert.equal(0.1 + 0.2, 0.3, 'BUG-123: float rounding in totals');
});

Then('the receipt has all fields', (ctx) => {
  const receipt = { id: 'R-1', total: 25, currency: 'SGD', items: 1 };
  ctx.soft.check(receipt.id.startsWith('R-'), 'id has the R- prefix');
  ctx.soft.check(receipt.total > 0, 'total is positive');
  ctx.soft.run(() => assert.equal(receipt.currency, 'SGD'));
  ctx.soft.check(receipt.items === 1, 'one item');
});

Given('a step that takes {int} ms', (_ctx, ms: number) => sleep(ms));
