import { strict as assert } from 'node:assert';
import { Before, BeforeAll, Given, Then, When, defineParameterType, type DataTable } from '@bddr/runtime';

interface Basket {
  lines: Array<{ product: string; qty: number }>;
  discount: number;
}

// A custom parameter type: {money} turns "1.00" into a number of cents.
defineParameterType({
  name: 'money',
  regexp: /\d+\.\d{2}/,
  transformer: (s) => Math.round(Number(s) * 100),
});

BeforeAll(async (ctx) => {
  ctx.run.set('codes', { TEN: 0.1, FIVE: 0.05 });
  ctx.log(`Prices in ${ctx.params['currency'] ?? 'unknown currency'}`);
});

Before({ name: 'fresh basket' }, (ctx) => {
  ctx.state.set<Basket>('basket', { lines: [], discount: 0 });
});

Given('the catalogue:', (ctx, table: DataTable) => {
  const prices = Object.fromEntries(table.hashes().map((r) => [r['product'], Math.round(Number(r['price']) * 100)]));
  ctx.state.set('prices', prices);
});

Given('an empty basket', (ctx) => {
  assert.equal(ctx.state.get<Basket>('basket').lines.length, 0);
});

Given('the discount code {string} is active', (ctx, code: string) => {
  const codes = ctx.run.get<Record<string, number>>('codes');
  ctx.state.get<Basket>('basket').discount = codes[code] ?? 0;
});

When('I add {int} {string}', (ctx, qty: number, product: string) => {
  ctx.state.get<Basket>('basket').lines.push({ product, qty });
});

Then('the basket total is {money}', (ctx, expectedCents: number) => {
  const basket = ctx.state.get<Basket>('basket');
  const prices = ctx.state.get<Record<string, number>>('prices');
  const gross = basket.lines.reduce((sum, l) => sum + (prices[l.product] ?? 0) * l.qty, 0);
  const total = Math.round(gross * (1 - basket.discount));
  ctx.attach(JSON.stringify({ gross, total }), 'application/json', 'totals');
  assert.equal(total, expectedCents, `total was ${total} cents`);
});
