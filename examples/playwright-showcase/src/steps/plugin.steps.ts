import { Given, Then, When } from '@bddr/runtime';
import type { Page } from 'playwright';
import { requiredParam } from '../support/world.js';

// Plugin features used here: `newContext` (extra isolated contexts), `playwright.devices` (emulation) and `expect`.
// The fixtures are named in each step's parameters / `ctx.x` reads, which is how bddr knows to start them.

Given('user {string} is logged in to the secure area', async (ctx, _user: string) => {
  const { page } = ctx;
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.locator('#username').fill('tomsmith');
  await page.locator('#password').fill('SuperSecretPassword!');
  await page.getByRole('button', { name: 'Login' }).click();
  await ctx.expect(page).toHaveURL(/\/secure$/);
});

When('a second browser context opens the secure area', async (ctx) => {
  const other = await (await ctx.newContext({ baseURL: requiredParam(ctx, 'uiBaseUrl') })).newPage();
  await other.goto('/secure', { waitUntil: 'domcontentloaded' });
  ctx.state.set('plugin.other', other);
});

Then('the second context is sent to the login page', async (ctx) => {
  await ctx.expect(ctx.state.get<Page>('plugin.other')).toHaveURL(/\/login$/);
});

Then('user {string} is still in the secure area', async (ctx, _user: string) => {
  await ctx.page.reload({ waitUntil: 'domcontentloaded' });
  await ctx.expect(ctx.page).toHaveURL(/\/secure$/);
});

When('I open the heading page on {string}', async (ctx, device: string) => {
  const options = device === 'Desktop' ? { viewport: { width: 1280, height: 800 } } : ctx.playwright.devices[device];
  if (!options) throw new Error(`unknown device ${device}`);
  const page = await (await ctx.newContext({ ...options, baseURL: requiredParam(ctx, 'uiBaseUrl') })).newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  ctx.state.set('plugin.device', page);
});

Then('the heading is visible and the viewport is wider than {int} pixels', async (ctx, min: number) => {
  const page = ctx.state.get<Page>('plugin.device');
  await ctx.expect(page.locator('h1')).toBeVisible();
  ctx.expect(page.viewportSize()?.width ?? 0).toBeGreaterThan(min);
});
