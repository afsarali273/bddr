# bddr + Selenium showcase

A UI automation project that runs on bddr with the [`@bddr/selenium`](../../plugins/selenium/README.md) plugin. The
browser, the driver per scenario and failure screenshots all come from the plugin (`bddr.config.ts`); this project has
no browser setup code.

Targets: [the-internet.herokuapp.com](https://the-internet.herokuapp.com/) and [SauceDemo](https://www.saucedemo.com/).

## What runs

33 scenarios, 107 steps, 6 feature files:

| Feature | Scenarios | Shows |
| --- | --- | --- |
| `auth/login.feature` | 4 | Background, Scenario Outline, page object injected into a `@Steps` class |
| `forms/controls.feature` | 11 | Rules, outlines; checkboxes, dropdown, number input, key presses |
| `dynamic/dynamic.feature` | 5 | the `wait` fixture and `until` conditions for content that appears later |
| `browser/dialogs-and-windows.feature` | 5 | JS alert/confirm/prompt, a second window, `newDriver` (two browser sessions in one scenario) |
| `saucedemo/authentication.feature` | 4 | outline over users, a rejected user |
| `saucedemo/journey.feature` | 4 | `@serial @reuseSession`: sign in once, the next scenarios continue in the same browser |

Groups, `workers: 3` and `pool: 'process'` are in `bddr.config.ts`: `the-internet` and `saucedemo` scenarios run in
parallel (2 workers each), the journey runs in order inside its own browser.

## Run it

```bash
cd ../.. && npm install && npm run build                 # bddr itself, once
(cd plugins/selenium && npm install && npm run build)    # the plugin, once
cd examples/selenium-showcase && npm install
npm run verify                          # type check, validate, run (Chrome by default)
npx bddr run -D browser=firefox         # another browser
npx bddr run -D headed=true --set workers=1   # watch it
npx bddr run -D server=http://localhost:4444  # a Selenium Grid
npx bddr run --tags @smoke
```

Selenium Manager (part of selenium-webdriver) downloads the browser driver the first time; the browser itself must be
installed for Chrome and Edge, and is downloaded for Firefox.

## Plugin features used

| Feature | Where |
| --- | --- |
| `driver` per scenario, quit afterwards | every scenario |
| `open('/path')` against `baseURL` | `the-internet.steps.ts` |
| `wait(until...)` | dynamic and window steps, page objects |
| `inject('driver')` in page objects | `src/pages/*.ts` |
| `selenium: { By, Key, until }` | function-style steps |
| `newDriver()` | "A second browser session does not share the login" |
| `@serial @reuseSession` | `features/saucedemo/journey.feature` |
| screenshot on failure | attached to the HTML report |
