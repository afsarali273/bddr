# bddr + Playwright showcase

This is a standalone TypeScript automation project. **bddr is the only test runner**; Playwright supplies Chromium and
the HTTP client. The suite targets [The Internet](https://the-internet.herokuapp.com/), [SauceDemo](https://www.saucedemo.com/)
and [TodoMVC](https://demo.playwright.dev/todomvc/) for UI coverage, plus [JSONPlaceholder](https://jsonplaceholder.typicode.com/)
and [DummyJSON](https://dummyjson.com/) for API coverage. Independent checks also cover [Playwright documentation](https://playwright.dev/)
and [HTTPBin](https://httpbin.org/).

## What runs

- 139 scenarios and 569 BDD steps across 16 feature files: UI, API, health/retry, and 8 mixed UI + API scenarios.
- Four process workers. A single `bddr run` mixes serial and parallel groups: `sauceDemo` and `dummyJson` are serial;
  `theInternet`, `jsonPlaceholder`, and `todoMvc` are parallel; all wait for the serial `health` group.
- Playwright comes from the `@bddr/playwright` plugin (`bddr.config.ts`): one Chromium browser per worker, an isolated
  context and page per UI scenario, an API request context per scenario, screenshots on failure. Steps just ask for
  `ctx.page` / `ctx.request` or `inject('page')`; there is no browser code in `src/support/`.
- SauceDemo and TodoMVC UI steps use page objects under `src/pages/`, keeping selectors and waits out of step definitions.
- Six `@independent` scenarios have no named group or group dependency and run unconstrained by group scheduling.
- HTML, JUnit and NDJSON reports under `reports/`.

The public APIs fake writes rather than persisting them, so POST/PUT/PATCH/DELETE scenarios are safe to repeat and run
in parallel.

The execution plan is intentionally mixed:

| Group | Mode | Members | Purpose |
| --- | --- | ---: | --- |
| `health` | serial | 6 | Gate all public targets and demonstrate retry |
| `theInternet` | parallel ×2 | 30 | Existing UI coverage |
| `jsonPlaceholder` | parallel ×3 | 33 | Existing API coverage |
| `sauceDemo` | serial | 20 | Authentication, inventory and cart |
| `todoMvc` | parallel ×2 | 15 | Independent browser contexts and filtering |
| `dummyJson` | serial | 15 | Product and user API coverage |

## Install and run

Build bddr once from the repository root, then install this project's local dependencies and Chromium:

```bash
cd ../..
npm install
npm run build

# the Playwright plugin is a separate package: build it once too
(cd plugins/playwright && npm install && npm run build)

cd examples/playwright-showcase
(cd ../../plugins/axios && npm install && npm run build)   # the axios plugin, once
npm install
npx playwright install chromium
npm run verify
```

Useful commands:

```bash
npm run validate       # static bddr validation; executes no scenarios
npm run plan           # inspect groups and dependencies
npm test               # complete process-pool suite
npm run test:ui        # UI plus pulled-in health prerequisites
npm run test:api       # API plus pulled-in health prerequisites
npm run test:smoke
npm run test:inline    # same suite in one Node process
npx bddr run --tags @independent  # only the ungrouped Playwright docs + HTTPBin checks
```

Override targets or browser visibility without editing the config:

```bash
npm test -- -D uiBaseUrl=https://example.test -D apiBaseUrl=https://api.example.test
npm test -- -D headed=true --set workers=1   # watch the browser
npm test -- -D browser=firefox
```

## Framework coverage

| Capability | Where it is demonstrated |
| --- | --- |
| Gherkin Background, Rule, Scenario Outline | all 13 feature files |
| External CSV data | `data/post-ids.csv` via `@data` |
| Data tables and doc strings | API POST and PUT scenarios |
| Stable ids and scenario dependencies | health scenarios and `@dependsOn` |
| Groups, priorities, worker caps and group dependencies | `bddr.config.ts` |
| Mixed serial + parallel execution in one command | `health`, `sauceDemo`, `dummyJson` vs `theInternet`, `jsonPlaceholder`, `todoMvc` |
| Ungrouped execution | `features/independent/` with `@independent`; no named group or group dependency |
| Process pool and worker lifecycle | `pool: 'process'`, plugin worker-scoped `browser` fixture |
| Browser per worker, page per scenario | `@bddr/playwright` plugin, configured in `bddr.config.ts` |
| Retrying assertions (`expect`) | `ui.steps.ts`, `saucedemo.steps.ts`, `todomvc.steps.ts` |
| `getByTestId` via `testIdAttribute` | `src/pages/saucedemo.page.ts` |
| One browser session per `@serial` feature (`@reuseContext`) | `features/plugin/session.feature` |
| Extra contexts (`newContext`) and device emulation | `features/plugin/contexts.feature`, `src/steps/plugin.steps.ts` |
| Traces on failure | `reports/playwright/traces/` |
| UI and API in one scenario (`@bddr/playwright` + `@bddr/axios`) | `features/mixed/ui-and-api.feature`, `src/steps/mixed.steps.ts` |
| Page Object Model | `src/pages/saucedemo.page.ts` and `src/pages/todomvc.page.ts` |
| Class steps and fixture injection | `InternetUiSteps` in `src/steps/ui.steps.ts` (`inject('page')`) |
| Custom parameter type | `{apiResource}` in `src/steps/api.steps.ts` |
| Scoped stores and exports | hooks, response state, and health exports |
| Run/group/feature/scenario/step hooks | `src/support/hooks.ts` |
| Scenario retry and flaky reporting | controlled transient scenario in `health.feature` |
| Concurrent step repeat | API probe with `@repeat` and `@concurrency` |
| Soft assertions | API object data-table matching |
| Time budgets, retry backoff and worker-crash retry | `bddr.config.ts` |
| Logging and attachments | health logs, API response JSON, captured UI screenshot |
| Profiles and tag selection | `ci`, `ui`, `api`, and `smoke` profiles |
| HTML, JUnit and NDJSON reporting | `bddr.config.ts` reporters |

`reports/`, `node_modules/`, and browser downloads are not committed.
