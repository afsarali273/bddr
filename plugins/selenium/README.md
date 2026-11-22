# @bddr/selenium

Selenium WebDriver for [bddr](../../README.md), as a plugin. bddr has no dependency on Selenium: your project installs
both, and this plugin connects them through bddr fixtures. It works the same way as [`@bddr/playwright`](../playwright/README.md).

```bash
npm i -D @bddr/selenium selenium-webdriver
```

```ts
// bddr.config.ts
import { defineConfig } from '@bddr/cli';
import { selenium } from '@bddr/selenium';

export default defineConfig({
  plugins: [selenium({ browser: 'chrome', baseURL: 'https://shop.example.com', screenshot: 'only-on-failure' })],
  // or untyped: plugins: [['@bddr/selenium', { browser: 'firefox' }]]
});
```

```ts
// steps: ask for what you need
Given('I open {string}', ({ open }, path: string) => open(path));
When('I log in', async ({ driver, selenium: { By } }) => {
  await driver.findElement(By.css('#user')).sendKeys('ana');
});
Then('I see the heading', async ({ wait, selenium: { By, until } }) => {
  await wait(until.elementLocated(By.css('h1')));
});

// page objects and step classes: inject()
class LoginPage { private driver = inject('driver'); open() { return this.driver.get('/login'); } }
@Steps() class LoginSteps { private login = inject(LoginPage); /* @Given(...) methods */ }
```

Add `import '@bddr/selenium';` (or `"types": ["@bddr/selenium"]` in tsconfig) in one support file so `ctx.driver`,
`({ driver })` and `inject('driver')` are typed.

bddr starts a fixture only when a step names it (`({ driver })`, `ctx.driver`, `const { driver } = ctx`, `inject('driver')`).
A helper that receives the whole `ctx` and reads `ctx.driver` inside is not seen; destructure it in the step and pass it on.

## Fixtures

| name | scope | what |
|---|---|---|
| `selenium` | worker | the `selenium-webdriver` module: `By`, `Key`, `until`, `Capabilities` ... |
| `driver` | scenario | a fresh `WebDriver` (one browser session) per scenario attempt; screenshot at the end; quit after |
| `open` | scenario | `await open('/login')`: `driver.get()` relative to `baseURL` |
| `wait` | scenario | `await wait(until...)`: `driver.wait()` with `waitTimeoutMs` as the default timeout |
| `newDriver` | scenario | `await newDriver({ browser: 'firefox' })`: extra sessions (second user, other browser); quit after the scenario |

Selenium has no browser/context split, so every session is a real browser process. A scenario that uses none of these
starts nothing. Groups, dependencies, locks, `--pool process`, `--shard` and `--watch` work as usual.

## Options

| option | default | |
|---|---|---|
| `browser` | `'chrome'` | `'chrome' \| 'firefox' \| 'edge' \| 'safari'`; `-D browser=firefox` overrides |
| `headless` | `true` | `-D headed=true` overrides (safari has no headless mode) |
| `args` | | extra browser command line arguments (`'--lang=de'`, `'--incognito'` ...) |
| `capabilities` | | extra W3C capabilities; vendor `args` are combined with the ones above |
| `server` | | remote endpoint (Selenium Grid, a cloud provider): `'http://grid:4444'`; `-D server=` overrides |
| `baseURL` | | base of `open('/path')`; `-D baseURL=` overrides |
| `windowSize` | | `{ width, height }` |
| `implicitWaitMs`, `pageLoadTimeoutMs`, `scriptTimeoutMs` | Selenium's | session timeouts |
| `waitTimeoutMs` | `10000` | default timeout of `wait(...)` |
| `screenshot` | `'only-on-failure'` | `'off' \| 'on' \| 'only-on-failure'`; attached to the report |
| `reuseSession` | `'off'` | `'serial'`: every `@serial` feature shares one browser session |

The plugin uses the `selenium-webdriver` of your project (so your own `import { until } from 'selenium-webdriver'` and the driver
share one copy; Selenium checks conditions with `instanceof`). Selenium Manager (bundled with selenium-webdriver) finds or downloads the browser driver; nothing to install by hand
for chrome, firefox and edge.

## One browser session per feature

```gherkin
@serial @reuseSession
Feature: Checkout journey
  Scenario: log in             # starts the browser
  Scenario: add to basket      # same session, still logged in
  Scenario: pay                # same session
```

- Needs `@serial` on the Feature (a shared session only works one scenario at a time); `@reuseSession` without it is an
  error. `reuseSession: 'serial'` turns it on for every serial feature; `@freshSession` opts one out.
- The browser is quit when the feature ends. In `--pool process` the whole feature runs in one worker process.
- Screenshots are still per failed scenario. A retried scenario continues in whatever state the failed attempt left.
- Selecting one scenario of the feature (`-t`, `file:line`) runs it alone on a new session: it does not replay the
  earlier scenarios.

## Example

`example/` is a complete project that runs offline (a local HTTP server is a worker fixture): login scenarios with a
page object, and a `@serial @reuseSession` journey.

```bash
cd plugins/selenium && npm install
cd example && npx bddr            # or: -D browser=firefox, -D headed=true, --pool process -w 2
```

## Developing

`npm run verify` (typecheck, build, tests). Tests use a fake `selenium-webdriver`, so they need no browsers; the fake
behaves like the real `Builder` (for example `withCapabilities` replaces the browser name), which a real run caught once.
