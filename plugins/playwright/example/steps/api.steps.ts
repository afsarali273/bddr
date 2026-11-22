import { strict as assert } from 'node:assert';
import { Then, When } from '@bddr/runtime';

// API steps use the `request` fixture: no browser is launched for these scenarios.
When('I GET {string}', async ({ request, shop, state }, path: string) => {
  const res = await request.get(`${shop.url}${path}`);
  state.set('status', res.status());
  state.set('body', await res.json());
});

Then('the status is {int}', ({ state }, status: number) => {
  assert.equal(state.get('status'), status);
});

Then('there are {int} products', ({ state }, n: number) => {
  assert.equal(state.get<unknown[]>('body').length, n);
});
