# Fixtures, `inject()` and plugins

Fixtures replace the hand-written glue that every step file used to need (`page(ctx)` helpers, `static inject = [CONTEXT]`,
getters). They are a runtime feature: groups, dependencies, locks, retries, the process pool and sharding work exactly as
before. A fixture is only created when something asks for it.

Source: `packages/runtime/src/fixtures.ts` (engine), `api.ts` (`defineFixture`, `definePlugin`), `decorators.ts` (`inject`),
`cli/src/run.ts` (`loadPlugins`). Tests: `runtime/test/fixtures.test.ts`, `cli/test/fixtures.test.ts` (project
`cli/test/fixtures/fixtures-project`, a fake browser plugin run inline, in the process pool and sharded).

## Define

```ts
import { defineFixture } from '@bddr/runtime';

defineFixture('browser', () => chromium.launch(), { scope: 'worker', teardown: (b) => b.close() });
defineFixture('page', async ({ browser }) => browser.newPage(), {
  teardown: async (page, { status }) => {
    if (status === 'failed') await page.screenshot({ path: `reports/${Date.now()}.png` });
    await page.close();
  },
});
defineFixture('login', ({ page }) => new LoginPage(page)); // page objects can be fixtures too

declare module '@bddr/runtime' {              // types for ctx.page, ({ page }) and inject('page')
  interface Fixtures { browser: Browser; page: Page; login: LoginPage }
}
```

| scope | lifetime |
|---|---|
| `'scenario'` (default) | one per scenario attempt; a retry gets a fresh one; torn down when the scenario ends |
| `'feature'` | one per feature in a worker process, created on first use (also from `BeforeFeature` hooks), torn down when the feature ends, after `AfterFeature`. A `@serial` feature always runs in one worker process (scheduler affinity in the process pool), so the value really is shared by all its scenarios. In a parallel feature, scenarios running at the same time get the same value |
| `'worker'` | one per worker **process**, created on first use, torn down after `AfterWorker` hooks. Pool `inline` = one process, so concurrent scenarios share it; pool `process` = one per worker process |

Fixtures may depend on other fixtures by destructuring them (or by reading `ctx.name` in the body). A fixture may use
fixtures of the same or a longer scope: scenario -> feature -> worker, never the other way round.
Feature and worker fixtures can add `afterScenario(value, { status, error, ctx })`, called at the end of every scenario
that used them (a screenshot of a shared page for each failed scenario). Teardown is reverse creation order, after steps, `After` hooks, `ctx.defer` and `dispose()` (fixtures outlive
everything that may use them). Teardown receives the scenario's final `status` and `error`. A failing teardown fails the
scenario (worker: the run), reported as a hook named `fixture teardown`.

## Use

```ts
// function steps and hooks: destructure the first parameter
Given('I log in as {string}', ({ login }, user: string) => login.as(user));
After(async ({ page }) => { /* ... */ });

// anywhere: await it
const page = await ctx.fixture('page');

// classes: inject() in a field or the constructor (no static inject list)
@Steps()
class LoginSteps {
  private login = inject(LoginPage);   // class: one instance per scenario, shared by all step classes
  private page = inject('page');       // fixture by name (async fixtures work)
  private ctx = inject(CONTEXT);       // only when you need it
  @Given('I log in as {string}') as(user: string) { return this.login.as(user); }
}
class LoginPage { private page = inject('page'); /* ... */ }
```

How it works: bddr reads the first parameter of steps, hooks and fixture setups (like Playwright Test) and creates the
destructured fixtures before calling them. `inject('x')` on an async fixture that is not ready yet stops construction; bddr
creates the fixture and constructs again (constructors must not have side effects beyond field set-up, which is normal).
Reading `ctx.page` without requesting it works for synchronous or already-created fixtures; otherwise the error says how
to request it. `static inject = [...]` and `resolve()` still work.

Names are identifiers and must not clash with context properties (`state`, `params`, `log`, ...); duplicates are errors.

## Plugins

A plugin bundles fixtures, hooks, steps and parameter types. bddr depends on no browser or HTTP library; the plugin
is a dependency of the project that uses it.

```ts
// @bddr/playwright (or ./support/db.plugin.ts)
import { definePlugin, defineFixture } from '@bddr/runtime';
export default definePlugin<{ browser?: 'chromium' | 'firefox' }>({
  name: 'playwright',
  setup(options) { defineFixture('browser', /* ... */); defineFixture('page', /* ... */); },
});
```

```ts
// bddr.config.ts
export default defineConfig({ plugins: ['@bddr/playwright', ['./support/db.plugin.ts', { url: 'postgres://...' }]] });
```

`setup` runs once per process (main and every worker process) before step files load. Package names resolve from the
config folder; paths starting with `.` are relative to it. A missing plugin is a usage error (exit 2).

## Available plugins

- `plugins/playwright` (`@bddr/playwright`): `playwright`, `browser` (worker), `context`, `page`, `request` (scenario);
  screenshots, traces and videos by `'off' | 'on' | 'only-on-failure'`; `-D browser= / headed= / baseURL=` overrides.
  `reuseContext: 'serial'` (or `@reuseContext` on a `@serial` feature) gives the whole feature one context and page.
  A standalone package (not a bddr workspace): Playwright is its peer dependency, never bddr's. Offline example in
  `plugins/playwright/example`. See its README.
