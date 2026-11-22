# bddr

A BDD automation framework that keeps Gherkin's readability and adds TestNG-style orchestration:
groups, dependencies, mixed parallel/serial execution and layered retries.
TypeScript first, with Java and Python ports planned. The name is short on purpose ("BDD runner"), so it is easy to type.

> **Status:** v0.1. Phases 0, 1, 3 and 4 are done; the data core, reporting (HTML, living docs, history) and the
> Playwright, Selenium and axios plugins are in. Everything done and remaining: [docs/STATUS.md](docs/STATUS.md).
> Next step: [docs/PROGRESS.md](docs/PROGRESS.md). How the pieces fit: the Architecture page of the docs site (`website/docs/architecture.html`).

## Quick start

```bash
git clone https://github.com/afsarali273/bddr.git && cd bddr
npm install
npm run build          # compile all packages (tsc -b)
npm test               # unit + conformance + CLI end-to-end tests (vitest)
npm run example        # run examples/basic through the real CLI
npm run verify         # typecheck + test + example, what CI should run
```

Requires Node.js 20.10 or newer.

## Writing tests

```gherkin
# features/basket.feature
Feature: Shopping basket
  @smoke @id:add-single
  Scenario: Add a single product
    When I add 2 "apple"
    Then the basket total is 1.00
```

```ts
// steps/basket.steps.ts
import { Given, When, Then, Before, defineParameterType } from '@bddr/runtime';

defineParameterType({ name: 'money', regexp: /\d+\.\d{2}/, transformer: (s) => Math.round(Number(s) * 100) });

Before((ctx) => ctx.state.set('basket', []));

When('I add {int} {string}', (ctx, qty: number, product: string) => {
  ctx.state.get<string[]>('basket').push(...Array(qty).fill(product));
});

Then('the basket total is {money}', (ctx, cents: number) => { /* assert */ });
```

Class-based steps with dependency injection:

```ts
import { CONTEXT, Given, Steps, Then, type StepContext } from '@bddr/runtime';

class Wallet {                       // any class can be injected; one instance per scenario
  static inject = [CONTEXT] as const;
  constructor(private ctx: StepContext) {}
  cents = 0;
}

@Steps()
class WalletSteps {
  static inject = [Wallet] as const;
  constructor(private wallet: Wallet) {}

  @Given('a wallet with {int} cents')
  fund(cents: number) { this.wallet.cents = cents; }
}
```

Data-driven scenarios from files (CSV, TSV, JSON, YAML, XLSX):

```gherkin
@data:users.csv?role=admin
Scenario: <name> can log in
  When I log in as "<name>"

Scenario Outline: credit limit for <who>
  Then <who> may spend <limit>

  @data:limits.xlsx#Admins?rows=1-10 @dataField:who=name
  Examples:
    | who | limit |
```

Orchestration: groups, dependencies, locks, priorities, parallel workers:

```gherkin
@id:login @group:setup
Scenario: Log in
  When I log in as "ann"            # ctx.export('token', …)

@checkout @dependsOn:login
Scenario Outline: Buy <product>     # ctx.from('login').get('token')
  ...

@lock:payments-db @priority:1
Scenario: Card payment
```

```ts
export default defineConfig({
  workers: 4,
  groups: {
    setup:    { mode: 'serial', priority: -10 },
    checkout: { mode: 'parallel', workers: 3, dependsOn: ['setup'], match: '@checkout' },
    reports:  { dependsOn: ['checkout'], onDependencyFailure: 'run' },
  },
});
```

Ungrouped scenarios run unconstrained by default; `defaultMode: 'serial'` makes them run one at a time (alongside groups).

Any config value can be overridden from the CLI without editing files:

```bash
bddr run -p ci --set workers=8 --set groups.checkout.mode=serial --set 'groups.api.dependsOn=["setup"]'
```

Logging with levels, attributed to the running scenario (also from helpers via the global `log`):

```ts
import { log } from '@bddr/runtime';
ctx.log.info('paying', { amount });   // in steps/hooks
log.warn('gateway slow');             // anywhere, e.g. page objects / API clients
```

Screenshots and images ride on log lines: `ctx.log.image('after login', await page.screenshot())`, or pass bytes as data
(`log.warn('layout broken', png)`).

The console shows `info` and above by default; `--log-level debug` also shows framework scheduling diagnostics.
Logs (and their images) appear in every report: the HTML report (`html` reporter: one self-contained file with filters,
steps, logs, screenshots, attachments), JUnit `<system-out>`/`<system-err>`, Cucumber JSON step `output`/`embeddings`,
and NDJSON (everything).

Step-level repeat and retry (tags at the end of a step):

```gherkin
Given I create user "user-{{i}}" with email "user{{i}}@example.com" @repeat:100 @concurrency:10
Then the export job is done @retry:5 @delay:1s @backoff:2
And the page shows "Saved" @timeout:10s
```

`@repeat` runs a step N times (`{{i}}`/`{{n}}` = iteration/total); `@retry` re-runs it until it passes. `@concurrency` is
for API/data steps only; browser steps declare `{ concurrent: false }`. BeforeStep/AfterStep run once per step, or per
attempt with `{ eachAttempt: true }`.

Parallel in separate processes (real CPU parallelism, crash isolation):

```bash
bddr run -w 4 --pool process     # or pool: 'process' in the config
```

```ts
BeforeAll((ctx) => ctx.run.set('dbUrl', seedDatabase()));          // once, in the parent; copied to workers
BeforeWorker(async (ctx) => ctx.run.set('browser', await launch())); // once per worker process
```

Resilience:

```gherkin
@retry:2                      # re-run the whole scenario until it passes (flaky passes are reported)
Scenario: Pay through a flaky API

@quarantine                   # known bug: runs and reports, never fails the build
Scenario: Exact totals (BUG-123)

@timeout:2m                   # time budget for the whole scenario
Scenario: Long import
```

```ts
retry: { scenario: 1, delay: '1s', backoff: 2, workerCrash: 1, on: ['TimeoutError', '/ECONNRESET/'] },
runTimeout: '30m',
groups: { setup: { retry: 1, retryMembers: 'all', timeout: '2m' } },
```

```ts
ctx.soft.check(receipt.total > 0, 'total is positive');  // soft assertions: all failures reported at step end
```

```bash
bddr run -f ndjson:reports/run1.ndjson                       # CI run
bddr run --rerun-failed reports/run1.ndjson -f ndjson:reports/run2.ndjson
bddr report reports/run1.ndjson reports/run2.ndjson -f html:reports/report.html -f junit:reports/junit.xml
```

Reports and run history: the `html` reporter is one offline file with a timeline per worker, the dependency graph and,
with `history: true` in the config, pass-rate trends and flakiness scores across runs:

```bash
bddr run -f html:reports/report.html --set history=true
bddr history --top 10        # flakiest and slowest scenarios
```

Living documentation: `bddr docs` turns the spec folders into one HTML page (a `README.md` per folder is its intro),
and `--results reports/run1.ndjson` colours each scenario by its last result:

```bash
bddr docs features -o reports/living-docs.html --results reports/run1.ndjson
```

`bddr plan` prints the graph (`--plan-format mermaid` for a diagram, `--explain <id>` for one scenario).

```ts
// bddr.config.ts
import { defineConfig } from '@bddr/cli';
export default defineConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
  reporters: ['console', 'junit:reports/junit.xml'],
  profiles: { ci: { reporters: ['progress', 'junit:reports/junit.xml'], failFast: true } },
});
```

## CLI

```
bddr [run] [paths...]  -t "@smoke and not @wip"  -p ci  -D env=qa  -f ndjson:reports/e.ndjson  --dry-run
bddr list  [paths...]  # ids + tags of selected scenarios
bddr snippets         # code for every undefined step
bddr validate [paths...] [--fail-on-warnings]  # static project checks; runs no tests
bddr plan [--explain <id>] [--plan-format text|json|mermaid]   # execution graph, runs nothing
bddr run -w 4 --no-deps   # 4 parallel workers; do not pull in dependencies
bddr run -w 4 --pool process   # 4 worker processes
bddr run -r 2 --fail-on-flaky  # retry failed scenarios twice; flaky passes fail the run
bddr run --run-timeout 30m --worker-crash-retry 1
bddr run --rerun-failed reports/bddr.ndjson
bddr report run1.ndjson run2.ndjson -f html:reports/report.html
bddr docs [paths...] -o reports/living-docs.html [--results run.ndjson]   # living documentation
bddr history --top 10   # flakiest and slowest scenarios
```

Paths accept files, folders, globs and `file.feature:LINE`. Exit codes: 0 passed, 1 failed, 2 usage/config/parse error,
130 interrupted. Long-running user operations can observe `ctx.signal` for cooperative cancellation.

## Repository layout

| Path | What |
| --- | --- |
| `packages/core` | Spec model, Gherkin compiler, `@data` loaders, tags, selection, planner, run history, event schema + merge |
| `packages/runtime` | Step registry, hooks, scoped context, executor, scheduler, process pool, logging, global API |
| `packages/reporters` | console, HTML, NDJSON, JUnit XML, Cucumber JSON, Cucumber Messages, living docs |
| `packages/cli` | `bddr` command, config loading, file discovery |
| `plugins/playwright`, `plugins/selenium`, `plugins/axios` | Optional integrations (peer-dependent on the runtime; the core has no browser or HTTP dependency) |
| `conformance` | Language-neutral features + expected results (Java must pass these too) |
| `examples/basic` | Steps, hooks, outlines, class steps + DI, `@data`, step repeat/retry |
| `examples/orchestration` | Groups, dependencies, locks, exports, logs with images (inline and `--pool process`) |
| `examples/resilience` | Scenario/group retry, flaky, quarantine, soft assertions, time budget |
| `examples/playwright-showcase` | Standalone real project: 125 Playwright UI/API scenarios across 13 feature files, run entirely by bddr |
| `examples/selenium-showcase` | The same idea with Selenium WebDriver |
| `website` | Static documentation site (`website/docs/*.html`, authored in `website/src/*.page`) |
| `docs` | Implementation notes, progress log, decisions, roadmap |

## Documentation

- Documentation site: https://afsarali273.github.io/bddr/ (source in `website/`; getting started, guides, references, architecture)
- [docs/STATUS.md](docs/STATUS.md): everything done so far and everything remaining, on one page
- [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md): how it works, module by module
- [docs/PROGRESS.md](docs/PROGRESS.md): what is done, what is next, how to resume
- [docs/DECISIONS.md](docs/DECISIONS.md): architecture decision records
- [docs/ROADMAP.md](docs/ROADMAP.md): all phases with concrete tasks
