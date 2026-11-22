# @bddr/playwright

Playwright for [bddr](../../README.md), as a plugin. bddr has no dependency on Playwright: your project installs
both, and this plugin connects them through bddr fixtures.

```bash
npm i -D @bddr/playwright playwright
npm i -D @playwright/test        # optional: only for `expect` (same version as playwright)
npx playwright install chromium
```

```ts
// bddr.config.ts
import { defineConfig } from '@bddr/cli';
import { playwright } from '@bddr/playwright';

export default defineConfig({
  plugins: [playwright({ browser: 'chromium', screenshot: 'only-on-failure', trace: 'only-on-failure' })],
  // or untyped: plugins: [['@bddr/playwright', { browser: 'firefox' }]]
});
```

```ts
// steps: ask for what you need
Given('I open {string}', ({ page }, path: string) => page.goto(path));
When('I GET {string}', async ({ request, state }, path: string) => state.set('res', await request.get(path)));

// page objects and step classes: inject()
class LoginPage { private page = inject('page'); open() { return this.page.goto('/login'); } }
@Steps() class LoginSteps { private login = inject(LoginPage); /* @Given(...) methods */ }
```

Add `import '@bddr/playwright';` (or `"types": ["@bddr/playwright"]` in tsconfig) in one support file so `ctx.page`,
`({ page })` and `inject('page')` are typed. Importing `playwright()` in the config does not do this for step files.

Tip: bddr starts a fixture only when a step names it (`({ page })`, `ctx.page`, `const { page } = ctx`, `inject('page')`).
A helper that receives the whole `ctx` and reads `ctx.page` inside is not seen; destructure `page` in the step and pass
it on (`docs(page)`). The error says so: `Fixture "page" is asynchronous and was not requested before use`.

## Fixtures

| name | scope | what |
|---|---|---|
| `playwright` | worker | the `playwright` module (devices, selectors) |
| `browser` | worker | launched on first use; one per worker process (pool `inline`: one for the run, shared by concurrent scenarios) |
| `context` | scenario | fresh `BrowserContext` per scenario attempt (isolated cookies and storage); trace and video |
| `page` | scenario | a page in that context; screenshot at the end |
| `request` | scenario | `APIRequestContext` for API tests; never launches a browser |
| `expect` | worker | Playwright's web-first `expect` (needs `@playwright/test`); `expectTimeoutMs` sets its timeout |
| `newContext` | scenario | `await newContext({ locale: 'de-DE' })`: extra isolated contexts (second user, other locale), closed after the scenario |

With `reuseContext`, a `@serial` feature uses one context and page for all its scenarios instead (feature-scoped
`sharedContext` / `sharedPage`); see below. Scenarios that use none of these start nothing. Retries get a fresh context and page. Groups, dependencies, locks,
`--pool process`, `--shard` and `--watch` work as usual.

## Playwright features, bddr runner

bddr stays the runner (groups, retries, shards, reports); the plugin hands you Playwright itself, so everything it can do
is available:

```ts
Then('the heading is {string}', async ({ page, expect }, text: string) => {
  await expect(page.locator('h1')).toHaveText(text);           // retries until expectTimeoutMs
  await expect.poll(() => page.locator('li').count()).toBeGreaterThan(2);
});
When('a second user joins', async ({ newContext }) => {
  const page = await (await newContext({ storageState: 'bob.json' })).newPage();
});
Given('a mobile user', ({ playwright }) => { /* playwright.devices, selectors, _electron, _android ... */ });
```

- Auto-waiting actions, `locator.waitFor()`, `waitForURL`, `waitForResponse`, `route`, `getByRole`, tracing, `storageState`,
  HAR (`context: { recordHar }`), permissions, geolocation, locale, timezone: all Playwright APIs, all unchanged.
- `device: 'Pixel 7'` (or `-D device=...`) emulates a device. `testIdAttribute` configures `getByTestId`.
- `connect: { wsEndpoint }` or `cdpUrl: 'http://localhost:9222'` use a browser that is already running.
- Not available: anything that needs Playwright's own test runner (`toHaveScreenshot` / snapshot matching, `test.step`,
  `test.info()`). Use the screenshot option or attach files with `ctx.attach`.

## Options

| option | default | |
|---|---|---|
| `browser` | `'chromium'` | `'chromium' \| 'firefox' \| 'webkit'`; `-D browser=firefox` overrides |
| `channel` | | chromium only: `'chrome'`, `'msedge'` ... |
| `headless` | `true` | `-D headed=true` overrides |
| `launch` | | extra `launch()` options (`slowMo`, `args`, `proxy` ...) |
| `context` | | `newContext()` options (`baseURL`, `viewport`, `locale`, `storageState` ...); `-D baseURL=...` overrides `baseURL` |
| `request` | | `request.newContext()` options; `baseURL` defaults to the context's |
| `device` | | Playwright device name; `-D device=` overrides; `context` options win over it |
| `testIdAttribute` | `data-testid` | attribute used by `getByTestId` |
| `connect` | | `{ wsEndpoint, options }`: `browserType.connect` instead of launching |
| `cdpUrl` | | chromium only: `connectOverCDP` to a running browser |
| `expectTimeoutMs` | 5000 | timeout of `expect` assertions |
| `actionTimeoutMs`, `navigationTimeoutMs` | Playwright's | context default timeouts |
| `screenshot` | `'only-on-failure'` | `'off' \| 'on' \| 'only-on-failure'`; full page, attached to the report |
| `trace` | `'off'` | same values; saved under `outputDir/traces`, path logged (`npx playwright show-trace <file>`) |
| `video` | `'off'` | same values; saved under `outputDir/videos` |
| `outputDir` | `'reports/playwright'` | relative to the working directory |
| `reuseContext` | `'off'` | `'serial'`: every `@serial` feature shares one context and page |

## One browser session per feature

```gherkin
@serial @reuseContext
Feature: Checkout journey
  Scenario: log in             # opens the context and page
  Scenario: add to basket      # same page, still logged in
  Scenario: pay                # same page
```

- Needs `@serial` on the Feature (sharing a page only works one scenario at a time); `@reuseContext` without it is an
  error. `reuseContext: 'serial'` turns it on for every serial feature; `@freshContext` opts one out.
- The browser stays open; the context and page are closed when the feature ends. In `--pool process` the whole feature
  runs in one worker process, so nothing is lost between scenarios.
- Screenshots are still per failed scenario (from the shared page). The trace and video cover the whole feature and are
  kept when any of its scenarios failed (`only-on-failure`).
- A retried scenario continues on the same page, in whatever state the failed attempt left it.
- Selecting one scenario of the feature (`-t`, `file:line`) runs it alone on a new shared session: it does not replay the
  earlier scenarios, so make it able to start on its own or run the whole feature.

## Example

`example/` is a complete project that runs offline (a local HTTP server is a worker fixture): UI login scenarios in a
serial group with a page object, and API scenarios that never open a browser.

```bash
cd plugins/playwright && npm install && npx playwright install chromium
cd example && npx bddr            # or: npx bddr --pool process -w 2, -D headed=true, --tags @api
```

## Developing

`npm run verify` (typecheck, build, tests). Tests use a fake Playwright module, so they need no browsers.
