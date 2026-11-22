import { strict as assert } from 'node:assert';
import { Given, Then, When } from '@bddr/runtime';
import { requiredParam, response, snapshotResponse } from '../support/world.js';

Given('the independent HTTP API base URL is configured', (ctx) => {
  assert.match(requiredParam(ctx, 'independentApiBaseUrl'), /^https?:\/\//);
});

When('I GET independent API path {string}', async (ctx, path: string) => {
  const baseUrl = requiredParam(ctx, 'independentApiBaseUrl');
  await snapshotResponse(ctx, await ctx.request.get(`${baseUrl}${path}`));
});

Then('the independent API field path {string} equals {string}', (ctx, path: string, expected: string) => {
  const actual = path.split('.').reduce<unknown>((value, key) => {
    assert.ok(value !== null && typeof value === 'object', `missing object before field ${key}`);
    return (value as Record<string, unknown>)[key];
  }, response(ctx).body);
  assert.equal(actual, expected);
});
