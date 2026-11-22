import { strict as assert } from 'node:assert';
import { Given, Then, When, defineParameterType, type DataTable, type DocString } from '@bddr/runtime';
import { requiredParam, response, snapshotResponse } from '../support/world.js';

type JsonObject = Record<string, unknown>;

defineParameterType({
  name: 'apiResource',
  regexp: /posts|comments|albums|photos|todos|users/,
  transformer: (value) => value,
});

Given('the API base URL is configured', (ctx) => {
  assert.match(requiredParam(ctx, 'apiBaseUrl'), /^https?:\/\//);
});

When('I GET API path {string}', async (ctx, path: string) => {
  await snapshotResponse(ctx, await ctx.request.get(path));
});

When('I GET the {apiResource} API collection', async (ctx, resource: string) => {
  await snapshotResponse(ctx, await ctx.request.get(`/${resource}`));
});

When('I POST API path {string} with values:', async (ctx, path: string, table: DataTable) => {
  const row = table.hashes()[0];
  assert.ok(row, 'expected one data row');
  const data = { title: row['title'], body: row['body'], userId: Number(row['userId']) };
  await snapshotResponse(ctx, await ctx.request.post(path, { data }));
});

When('I PUT API path {string} with JSON:', async (ctx, path: string, body: DocString) => {
  await snapshotResponse(ctx, await ctx.request.put(path, { data: JSON.parse(body.content) as unknown }));
});

When('I PATCH API path {string} with title {string}', async (ctx, path: string, title: string) => {
  await snapshotResponse(ctx, await ctx.request.patch(path, { data: { title } }));
});

When('I DELETE API path {string}', async (ctx, path: string) => {
  await snapshotResponse(ctx, await ctx.request.delete(path));
});

When(/^I probe API post (?:\{\{i\}\}|\d+) of (?:\{\{n\}\}|\d+)$/, async (ctx) => {
  const id = ctx.step?.attempt ?? 1;
  const total = ctx.step?.of ?? 1;
  const result = await ctx.request.get(`/posts/${id}`);
  assert.equal(result.status(), 200);
  ctx.log.debug('Concurrent probe passed', { id, total, attempt: ctx.step?.attempt });
});

Then('the API response status is {int}', (ctx, expected: number) => {
  assert.equal(response(ctx).status, expected);
});

Then('the API field {string} equals {int}', (ctx, field: string, expected: number) => {
  assert.equal(objectBody(ctx)[field], expected);
});

Then('the API field {string} equals {string}', (ctx, field: string, expected: string) => {
  assert.equal(objectBody(ctx)[field], expected);
});

Then('the API object contains:', (ctx, table: DataTable) => {
  const body = objectBody(ctx);
  for (const row of table.hashes()) {
    const field = row['field'] ?? '';
    const rawExpected = row['value'] ?? '';
    const actual = body[field];
    const expected: unknown = typeof actual === 'number' ? Number(rawExpected) : rawExpected;
    ctx.soft.check(actual === expected, `${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
});

Then('the API array contains {int} items', (ctx, expected: number) => {
  const body = response(ctx).body;
  assert.ok(Array.isArray(body), 'expected an array response');
  assert.equal(body.length, expected);
});

Then('every API item has {string} equal to {int}', (ctx, field: string, expected: number) => {
  const body = response(ctx).body;
  assert.ok(Array.isArray(body), 'expected an array response');
  body.forEach((item, index) => {
    assert.equal((item as JsonObject)[field], expected, `item ${index + 1}`);
  });
});

Then('the API response is an empty object', (ctx) => {
  assert.deepEqual(response(ctx).body, {});
});

function objectBody(ctx: Parameters<typeof response>[0]): JsonObject {
  const body = response(ctx).body;
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body), 'expected an object response');
  return body as JsonObject;
}
