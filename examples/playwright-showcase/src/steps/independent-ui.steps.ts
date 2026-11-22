import { strict as assert } from 'node:assert';
import { Given, Then, When } from '@bddr/runtime';
import type { Page } from 'playwright';
import { PlaywrightDocsPage } from '../pages/playwright-docs.page.js';
import { requiredParam } from '../support/world.js';

// Steps ask for `page` themselves ({ page }): bddr only sees what a step body or its parameters name, not what a helper reads.
const docs = (page: Page) => new PlaywrightDocsPage(page);

Given('the independent Playwright documentation site is open', async (ctx) => {
  const { page } = ctx;
  await docs(page).open(requiredParam(ctx, 'independentUiBaseUrl'));
});

When('I open the independent Playwright documentation path {string}', async (ctx, path: string) => {
  const { page } = ctx;
  await docs(page).open(requiredParam(ctx, 'independentUiBaseUrl'), path);
});

When('I open the Playwright getting started guide', async ({ page }) => {
  await docs(page).openGettingStarted();
});

Then('the independent UI title contains {string}', async ({ page }, expected: string) => {
  assert.ok((await docs(page).title()).includes(expected));
});

Then('the independent UI heading is {string}', async ({ page }, expected: string) => {
  assert.equal(await docs(page).heading(expected), expected);
});

Then('the independent UI path is {string}', ({ page }, expected: string) => {
  assert.equal(docs(page).currentPath(), expected);
});
