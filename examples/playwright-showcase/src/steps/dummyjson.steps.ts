import { strict as assert } from 'node:assert';
import { Given, Then, When } from '@bddr/runtime';
import { requiredParam, response, snapshotResponse } from '../support/world.js';

type JsonObject = Record<string, unknown>;

Given('the DummyJSON API base URL is configured', (ctx) => {
  assert.match(requiredParam(ctx, 'dummyApiBaseUrl'), /^https?:\/\//);
});

When('I GET DummyJSON path {string}', async (ctx, path: string) => {
  await snapshotResponse(ctx, await ctx.request.get(`${requiredParam(ctx, 'dummyApiBaseUrl')}${path}`));
});

Then('the API field {string} is not empty', (ctx, field: string) => {
  const value = objectBody(ctx)[field];
  assert.ok(value !== undefined && value !== null && String(value).trim().length > 0);
});

Then('the API nested array {string} contains {int} items', (ctx, field: string, expected: number) => {
  assert.equal(nestedArray(ctx, field).length, expected);
});

Then('the API nested array {string} has at least {int} item', (ctx, field: string, minimum: number) => {
  assert.ok(nestedArray(ctx, field).length >= minimum);
});

Then('every API item in {string} has {string} equal to {string}', (ctx, array: string, field: string, expected: string) => {
  nestedArray(ctx, array).forEach((item, index) => {
    assert.equal(item[field], expected, `item ${index + 1}`);
  });
});

Then('some API item in {string} contains {string} in field {string}', (ctx, array: string, expected: string, field: string) => {
  const needle = expected.toLowerCase();
  assert.ok(nestedArray(ctx, array).some((item) => String(item[field] ?? '').toLowerCase().includes(needle)));
});

function objectBody(ctx: Parameters<typeof response>[0]): JsonObject {
  const body = response(ctx).body;
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body), 'expected an object response');
  return body as JsonObject;
}

function nestedArray(ctx: Parameters<typeof response>[0], field: string): JsonObject[] {
  const value = objectBody(ctx)[field];
  assert.ok(Array.isArray(value), `expected ${field} to be an array`);
  return value as JsonObject[];
}
