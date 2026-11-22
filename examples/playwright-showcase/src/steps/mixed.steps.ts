import { strict as assert } from 'node:assert';
import { Given, Then, When } from '@bddr/runtime';
import { TodoMvcPage } from '../pages/todomvc.page.js';
import { requiredParam } from '../support/world.js';

// Steps in this file name fixtures from BOTH plugins: `api` (@bddr/axios) and `page`, `context`, `newContext`,
// `expect` (@bddr/playwright). Values travel between them in the scenario state.

// ---- API data -> UI
When('I fetch the title of post {int} through the API', async (ctx, id: number) => {
  const { api, state } = ctx;
  const response = await api.get(`/posts/${id}`); // baseURL comes from the axios plugin options
  assert.equal(response.status, 200);
  state.set('mixed.title', (response.data as { title: string }).title);
});

When('I add that title as a todo in TodoMVC', async (ctx) => {
  const { page, state } = ctx;
  const todo = new TodoMvcPage(page);
  await todo.open(requiredParam(ctx, 'todoBaseUrl'));
  await todo.addTodo(state.get<string>('mixed.title'));
});

Then('TodoMVC lists that title', async (ctx) => {
  const { page, state, expect } = ctx;
  await expect(new TodoMvcPage(page).item(state.get<string>('mixed.title'))).toHaveCount(1);
});

// ---- API and browser see the same thing
When('I request the status code page {int} through the API', async (ctx, code: number) => {
  const { api, state } = ctx;
  state.set('mixed.apiStatus', (await api.get(`${requiredParam(ctx, 'uiBaseUrl')}/status_codes/${code}`)).status); // 404/500 do not throw
});

Then('the API status is {int}', ({ state }, expected: number) => {
  assert.equal(state.get<number>('mixed.apiStatus'), expected);
});

When('I open the status code page {int} in the browser', async (ctx, code: number) => {
  await ctx.page.goto(`${requiredParam(ctx, 'uiBaseUrl')}/status_codes/${code}`, { waitUntil: 'domcontentloaded' });
});

Then('the browser page reports status code {int}', async (ctx, code: number) => {
  await ctx.expect(ctx.page.locator('#content')).toContainText(`returned a ${code} status code`);
});

// ---- credentials
Then('the API gets 401 from the protected page without credentials', async (ctx) => {
  assert.equal((await ctx.api.get(`${requiredParam(ctx, 'uiBaseUrl')}/basic_auth`)).status, 401);
});

Then('the API gets 200 from the protected page with credentials {string} and {string}', async (ctx, username: string, password: string) => {
  const response = await ctx.api.get(`${requiredParam(ctx, 'uiBaseUrl')}/basic_auth`, { auth: { username, password } });
  assert.equal(response.status, 200);
  assert.match(String(response.data), /Congratulations/);
});

Then('a browser context with credentials {string} and {string} sees the congratulations page', async (ctx, username: string, password: string) => {
  const other = await ctx.newContext({ httpCredentials: { username, password } }); // an extra context from the Playwright plugin
  const page = await other.newPage();
  await page.goto(`${requiredParam(ctx, 'uiBaseUrl')}/basic_auth`, { waitUntil: 'domcontentloaded' });
  await ctx.expect(page.locator('#content')).toContainText('Congratulations');
});

// ---- browser session -> API
Given('I log in through the browser as {string} with password {string}', async (ctx, username: string, password: string) => {
  const { page } = ctx;
  await page.goto(`${requiredParam(ctx, 'uiBaseUrl')}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Login' }).click();
  await ctx.expect(page).toHaveURL(/\/secure$/);
});

Then("the API call carrying the browser's cookies reaches the secure area", async (ctx) => {
  const cookie = (await ctx.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  assert.ok(cookie, 'the browser has no cookies');
  const response = await ctx.api.get(`${requiredParam(ctx, 'uiBaseUrl')}/secure`, { headers: { Cookie: cookie }, maxRedirects: 0 });
  assert.equal(response.status, 200);
  assert.match(String(response.data), /Secure Area/);
});

Then('the API call without the cookies is redirected to the login page', async (ctx) => {
  const response = await ctx.api.get(`${requiredParam(ctx, 'uiBaseUrl')}/secure`, { maxRedirects: 0 });
  assert.equal(response.status, 302);
  assert.match(String(response.headers['location']), /\/login$/);
});
