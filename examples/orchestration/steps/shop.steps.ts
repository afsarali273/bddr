import { strict as assert } from 'node:assert';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AfterAll, AfterGroup, BeforeAll, BeforeGroup, BeforeWorker, Given, Then, When, log } from '@bddr/runtime';
import { fakeScreenshot } from './fake-screenshot.js';

/** A helper outside any step: the global `log` is attributed to the running scenario. */
const paymentGateway = {
  async charge(amount: number, method: string) {
    log.debug('gateway request', { amount, method });
    if (method === 'wallet') log.warn(`wallet payments are slow in this environment (${amount})`, fakeScreenshot('wallet-slow', [202, 138, 4]));
    await sleep(30);
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fake backend: a file created once per run (BeforeAll runs once, in the parent process). Its path goes into the
 * run store, which worker processes receive a copy of, so this works with `--pool process` too.
 * (An in-memory array would only be shared with `pool: 'inline'`.)
 */
BeforeAll((ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'bddr-shop-'));
  writeFileSync(join(dir, 'orders.txt'), '');
  ctx.run.set('backend', dir);
});
AfterAll((ctx) => rmSync(ctx.run.get<string>('backend'), { recursive: true, force: true }));
BeforeWorker((ctx) => ctx.log.debug(`worker ${process.env['BDDR_WORKER_ID'] ?? 'inline'} ready (pid ${process.pid})`));

const backend = (ctx: { run: { get<T>(k: string): T } }) => join(ctx.run.get<string>('backend'), 'orders.txt');
const orders = (ctx: { run: { get<T>(k: string): T } }) => readFileSync(backend(ctx), 'utf8').split('\n').filter(Boolean);

BeforeGroup('@group:checkout', (ctx) => {
  ctx.group.set('cart-service', 'http://localhost:4000');
  ctx.log('checkout group: cart service ready');
});
AfterGroup('@group:checkout', (ctx) => ctx.log(`checkout group done: ${orders(ctx).length} orders`));

Given('I create user {string}', async (ctx, name: string) => {
  await sleep(20);
  ctx.export('user', { name, id: 'u-1' });
});

When('I log in as {string}', async (ctx, name: string) => {
  const user = ctx.from('create-user').get<{ name: string; id: string }>('user');
  assert.equal(user.name, name);
  await sleep(20);
  ctx.log.debug('logged in', { user });
  ctx.export('token', `token-for-${user.id}`);
});

Given('I am logged in', (ctx) => {
  ctx.state.set('token', ctx.from('login').get<string>('token'));
});

When('I buy {string}', async (ctx, product: string) => {
  assert.ok(ctx.groups['checkout']?.get('cart-service'));
  await sleep(50);
  appendFileSync(backend(ctx), `${product}\n`);
  ctx.state.set('order', product);
  ctx.log.image(`cart page after adding ${product}`, fakeScreenshot(product, [37, 99, 235]), { name: `cart-${product}.png` });
});

Then('the order is confirmed', (ctx) => {
  assert.ok(orders(ctx).includes(ctx.state.get<string>('order')));
});

When('I pay {int} by {string}', async (ctx, amount: number, method: string) => {
  ctx.log.info(`paying ${amount} by ${method}`);
  await paymentGateway.charge(amount, method);
});

Then('the report lists all orders', (ctx) => {
  ctx.attach(JSON.stringify(orders(ctx)), 'application/json', 'orders');
  assert.equal(orders(ctx).length, 4);
});
