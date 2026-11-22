# bddr: status overview (done so far and what remains)

_Last updated: 2026-11-15 (after session 12: independent UI/API coverage and Page Object Model examples)._

This is the one-page answer to "what does bddr do today, and what is left?". It is a summary: details live in
[IMPLEMENTATION.md](IMPLEMENTATION.md) (how), [DECISIONS.md](DECISIONS.md) (why), [ROADMAP.md](ROADMAP.md) (task
checklist) and [PROGRESS.md](PROGRESS.md) (session log + next step).

**What bddr is:** an automation framework with BDD-style specs (Gherkin), not a BDD-purist tool. It takes the best ideas
from Cucumber, TestNG, Karate, Serenity/JS, Reqnroll, Gauge, Behave, Robot Framework, pytest-bdd, JBehave and
playwright-bdd, on its own architecture: Cucumber's libraries are used only for parsing and expressions, behind
replaceable adapters. TypeScript first, Java later (same config, events and conformance suite).

---

## 1. Phase overview

| Phase | Scope | State |
| --- | --- | --- |
| 0 Foundations | Monorepo, spec model, Gherkin parsing, stable ids, tags, event schema, conformance skeleton | ✅ Done (CCK parse gate deferred) |
| 1 Core runner | Steps, hooks, context, reporters, CLI, config, class steps + DI | ✅ Done (real-project gate passed) |
| 2 Data-driven specs | CSV/TSV/JSON/YAML/XLSX via `@data:` | 🟡 Data core done; composite steps + gate left |
| 3 Orchestration | Groups, dependencies, locks, priorities, parallel/serial, worker processes, logging, step repeat/retry | ✅ Done; `@requires` and `waitedForMs` event left |
| 4 Resilience | Scenario/group/run retry, flaky, quarantine, rerun + merge, soft asserts, cancellation and time budgets | ✅ Done |
| 5 Reporting + DX | HTML v2 (timeline, dependency graph, history), run history + flakiness score, `bddr history` | 🟡 Reporting done; DX tools (debug, watch, sharding, IDE, Cucumber Messages) left |
| 6 Ecosystem | Plugin API, Playwright, HTTP steps, Allure, AI step catalogue/MCP, v1.0 | 🟡 Playwright showcase done; reusable integration pending |
| 7 Java port | JUnit Platform engine, same config/events/conformance | ⬜ Not started |
| Parked | Code-linked Markdown specs; callable scenarios | ⏸ Owner decision: later |

**Health:** `npm run verify` is green: 178 tests (unit, conformance, CLI end to end), plus the offline example projects.
The optional live `examples/playwright-showcase` project is independently green: 125 scenarios / 523 steps across 13
feature files against The Internet, SauceDemo, TodoMVC, JSONPlaceholder, DummyJSON, Playwright documentation and HTTPBin
(not part of root verify because it requires network access and a Chromium download). Six scenarios are deliberately
ungrouped and run without named-group scheduling.

---

## 2. What is done (feature inventory)

### 2.1 Specs and selection
- Gherkin `.feature` files (Feature, Rule, Background, Scenario, Scenario Outline, Examples, data tables, doc strings,
  i18n via `language`), and Markdown-with-Gherkin `.md` specs.
- **Stable scenario ids**: `@id:<id>` or `uri::slug(template name)[row]`. They survive edits elsewhere in the file and
  drive dependencies, reruns and report merging.
- **Key/value tags** (`@owner:ann`, exposed as `ctx.scenario.meta`), tag expressions (`@smoke and not @wip`).
- Selection by paths, folders, globs, `file.feature:LINE`, tags, `--name` regex and ids. Dependencies are pulled in automatically (`--no-deps` turns this off).

### 2.2 Steps (glue code)
- Cucumber Expressions and regex patterns, custom parameter types (`defineParameterType`), scoped steps (`{ tags }`),
  ambiguity detection, undefined-step snippets (`bddr snippets`, `--dry-run`).
- Function style (`Given('…', (ctx, …) => …)`) or **class style** with decorators (`@Steps()` + `@Given` …) and a
  **DI container** (`static inject = [...]`, one instance per scenario, `CONTEXT` token, `dispose()`).
- Step options: `timeoutMs`, `retry` (default retry for that step), `concurrent: false` (never repeat in parallel,
  for browser steps).

### 2.3 Hooks: TestNG-style lifecycle

| Level | Hooks | Runs (inline pool) | Runs (process pool) |
| --- | --- | --- | --- |
| run / suite | `BeforeAll`/`AfterAll` (= `BeforeSuite`/`AfterSuite`) | once | once, in the parent |
| worker | `BeforeWorker`/`AfterWorker` | once | once per worker process |
| group | `BeforeGroup`/`AfterGroup` | before the first member / after the last member | per process that runs a member; After* when the last member finishes overall |
| feature | `BeforeFeature`/`AfterFeature` | before the first / after the last scenario of the feature | per process (as for groups) |
| rule | `BeforeRule`/`AfterRule` | same, per Rule | per process |
| scenario | `Before`/`After` (= `BeforeScenario`/`AfterScenario`) | every scenario attempt | in the worker |
| step | `BeforeStep`/`AfterStep` | every step (once, or per attempt with `{eachAttempt:true}`) | in the worker |

Hook options: tag filter, `order`, `alwaysRun`, `timeoutMs`, `name`. Hooks can be functions or decorators on static
methods at every level, plus instance methods in `@Steps` classes for the scenario and step levels. `defer()` cleanups at every
scope. Failure semantics (what is skipped and what still runs) are a documented table, enforced by conformance tests.

### 2.4 Context and data sharing
- Scoped stores: `ctx.run`, `ctx.groups[name]`, `ctx.feature`, `ctx.state` (scenario). Typed `get`/`set`/`getOrSet`.
- `ctx.params` (`-D k=v` / config `params`), `ctx.scenario` (id, name, tags, meta, example row, attempt), `ctx.step`.
- **Scenario-to-scenario data**: `ctx.export(key, value)` and `ctx.from(id).get(key)`, as structured-clone copies. Works
  across worker processes.

### 2.5 Data-driven specs
- `@data:<file>[#selector][?col=val&rows=1-3,7]` on a Scenario, Outline or Examples block. CSV, TSV, JSON (dotted
  selector), YAML and XLSX (sheet selector) are supported.
- `@dataField:<placeholder>=<column>` mapping, `dataDir` with per-profile folders (`<dataDir>/<profile>/file`).
- Data rows get stable ids. Data errors are reported as parse errors on the tag line (exit 2).

### 2.6 Orchestration: groups, dependencies, parallel and serial in one run
- **Groups**: `@group:<name>` or config `groups.x.match`, with modes `parallel` / `serial` / `exclusive`, a `workers`
  cap per group, `dependsOn` other groups, `onDependencyFailure: skip|run`, `priority` and `locks`. Ungrouped scenarios use
  `defaultMode`.
- **Dependencies**: `@dependsOn:<id>` (hard), `@dependsOn:<id>:soft`, `@dependsOn:group:<name>`. Cycles and unknown ids are
  reported before anything runs.
- `@lock:<name>` (mutual exclusion), `@priority:<n>`, `@exclusive`.
- `bddr plan` (text, JSON or Mermaid) and `bddr plan --explain <id>`.
- One command runs parallel and serial work together; the scheduler respects all of the above.

### 2.7 Execution pools
- `pool: 'inline'` (default): async concurrency in one process. `workers` sets the number of lanes.
- `pool: 'process'` (`--pool process`): one Node process per lane, giving real CPU parallelism and crash isolation.
  - The parent owns the plan, scheduling, reports and BeforeAll/AfterAll; workers rebuild the same plan, which is
    checked with a fingerprint.
  - BeforeAll's run store is copied to workers. Exports are synced between workers.
  - A crashed worker fails only its own scenario and its lane respawns; a worker that cannot start stops the run.
  - Each worker gets the `BDDR_WORKER_ID` and `BDDR_WORKER_INDEX` environment variables.

### 2.8 Step-level repeat and retry (inline trailing tags)
- `@repeat:N` (bulk data, e.g. create 100 users, with `{{i}}`/`{{n}}` placeholders), `@retry:N` (until it passes),
  `@delay`, `@backoff`, `@timeout`, `@concurrency` (opt-in, for API/data steps only).
- Scenario-wide defaults: `@stepRetry`, `@stepDelay`, `@stepTimeout`. The `stepAttemptFinished` event records each attempt.

### 2.9 Resilience
- **Scenario retry**: `@retry:N`, `@noRetry`, config `retry {scenario, delay, on, failOnFlaky}`, `--retry`, and
  `setRetryAnalyzer()` (like TestNG's IRetryAnalyzer).
- Retry delays support `backoff`; process crashes can retry on a fresh worker with `retry.workerCrash` or
  `--worker-crash-retry`.
- **Group retry**: `groups.x.retry`, `retryMembers: all|failed` and `scenarioRetry`. Dependents wait until the group settles.
- **Flaky detection**: a pass after a failure is reported, and fails the run only with `--fail-on-flaky`. **`@quarantine`** runs and
  reports a scenario but never fails the build.
- **Run retry**: `--rerun-failed <events.ndjson>`; `bddr report a.ndjson b.ndjson` merges runs into any report format.
- **Soft assertions**: `ctx.soft.check()` / `ctx.soft.run()`.
- **Time budgets**: step/hook timeouts, `@timeout:<dur>` / `scenarioTimeout`, `groups.x.timeout`, and `runTimeout` /
  `--run-timeout`. Programmatic cancellation and Ctrl+C share `ctx.signal`; Ctrl+C exits 130 after cleanup/report flush.

### 2.10 Logging and reporting
- Levelled logs (`debug`, `info`, `warn`, `error`) via `ctx.log` or the global `log` (from page objects and API clients, attributed
  to the running scenario through AsyncLocalStorage). `ctx.log.image()` attaches screenshots; `ctx.attach()` attaches anything.
- `--log-level` controls the console. Framework diagnostics appear at `debug`.
- Reporters:
  - **console** (pretty or progress, with retry/flaky/quarantine markers)
  - **HTML v3** (one self-contained file, works offline; tabs Overview / Results / Execution / History):
    - **statistics overview**: KPI cards (pass rate with delta vs previous run, duration, parallelism, stability),
      status donut, duration percentiles and histogram, failures grouped by cause, slowest scenarios, breakdown by
      feature, tag and group
    - **data-driven views**: every Examples block / CSV / Excel / JSON data set is one colour-coded table (a row per
      scenario, a column per parameter, source badge, status bar, collapsible scenario template with highlighted
      `<placeholders>`); step data tables and doc strings render as tables tinted by the step status
    - **responsive**: works from phones to wide screens (sticky tab bar, stacked data rows on small screens, filter
      count and empty state, back-to-top)
    - **sharing**: copy summary (Slack/PR text), copy link (tab, search and filters are in the URL), download JSON,
      print/PDF, light/dark theme, per-scenario permalinks, keyboard shortcuts
    - filters, steps, logs with images, attachments, attempts, trimmed stacks (v1)
    - **timeline**: one lane per worker (bars = scenario attempts, retried attempts hatched, worker start-up shown,
      busy %), plus one row per group; bars link to the scenario
    - **dependency graph**: scenarios and groups that depend on each other, laid out left to right; soft
      dependencies dashed
    - **history**: pass rate per run, flakiest scenarios table, and per-scenario trend dots + flaky score
  - **JUnit XML** (Surefire `flakyFailure`; quarantined failures become `<skipped>`; failed run/worker/group hooks become errored cases)
  - **Cucumber JSON**
  - **NDJSON** event stream (versioned schema; the source of truth for every other report)
- **Run history** (`history: true`): one small JSON record per run in `.bddr/history` (last 50 kept). Flakiness
  score = share of runs whose outcome flipped or that passed only after a retry (a consistently failing scenario
  scores 0: it is broken, not flaky). `bddr history` prints the flakiest and slowest scenarios.

### 2.11 Validation, configuration and CLI
- `bddr validate` checks every configured spec without executing tests or parameter transformers: parse/config/plan
  errors, duplicate ids, undefined/ambiguous steps, unused definitions and unmatched hooks. Optional
  `validation.allowedTagKeys` enables tag governance; `--fail-on-warnings` makes warnings fail CI.
- `bddr.config.{ts,mts,js,mjs,json}` via `defineConfig`, `profiles`, and `--set path=value` overrides for any option.
- Commands: `run` (default), `list`, `snippets`, `validate`, `plan`, `report`, `history`. Exit codes: 0 passed, 1 failed,
  2 usage/config/parse error, 130 interrupted.

### 2.12 Architecture and quality
- Packages: `core` (model, parsing, plan, events), `runtime` (registry, executor, scheduler, pool), `reporters`, `cli`.
- Ports and adapters: `SpecParser`, `TagExpressionEngine`, `StepExpressionEngine`. Cucumber libraries are imported only in `adapters/`.
- Language-neutral **conformance suite** (9 features with expected JSON) that the Java port must also pass.
- Four runnable examples: `examples/basic`, `examples/orchestration`, `examples/resilience`, plus the standalone
  `examples/playwright-showcase` real project (125 UI/API scenarios across 13 feature files, powered by Playwright but
  run by bddr).
- 24 ADRs recording the design decisions.

---

## 3. Quick reference

### 3.1 Tags

| Tag | Where | Meaning |
| --- | --- | --- |
| `@id:<id>` | scenario | stable id (for dependencies, reruns, `ctx.from`) |
| `@group:<name>` | feature/rule/scenario | group membership |
| `@dependsOn:<id>[:soft]`, `@dependsOn:group:<name>` | scenario | wait for another scenario or group |
| `@lock:<name>` / `@priority:<n>` / `@exclusive` | scenario | mutual exclusion / order / run alone |
| `@data:<file>…` / `@dataField:<ph>=<col>` | scenario/outline/examples | external data rows |
| `@retry:N` / `@noRetry` | scenario | scenario retry |
| `@quarantine` | scenario | report, never fail the build |
| `@timeout:<dur>` | scenario | time budget for the whole scenario |
| `@stepRetry:N` / `@stepDelay:<dur>` / `@stepTimeout:<dur>` | scenario | defaults for every step |
| `@repeat:N` `@retry:N` `@delay:<dur>` `@backoff:<x>` `@timeout:<dur>` `@concurrency:N` | end of a step line | step repeat / retry |

### 3.2 Config options
`features`, `steps`, `tags`, `name`, `reporters`, `params`, `stepTimeoutMs`, `failFast`, `strict`, `language`, `dataDir`,
`workers`, `pool`, `groups` (mode, workers, dependsOn, onDependencyFailure, priority, locks, match, retry, retryMembers,
scenarioRetry, timeout), `defaultMode`, `logLevel`, `retry` (scenario, delay, backoff, workerCrash, on, failOnFlaky),
`scenarioTimeout`, `runTimeout`, `validation`, `history` (true or {dir, keep}), `profiles`.

### 3.3 CLI flags
`-c/--config`, `-p/--profile`, `-t/--tags`, `--name`, `-f/--format`, `-D/--define`, `--dry-run`, `--fail-fast`,
`--no-strict`, `--timeout`, `-w/--workers`, `--pool`, `-s/--set`, `--log-level`, `--no-deps`, `-r/--retry`,
`--worker-crash-retry`, `--run-timeout`, `--fail-on-flaky`, `--rerun-failed`, `--fail-on-warnings`, `--plan-format`, `--explain`,
`--top` (with `bddr history`). Commands: `run`, `list`, `snippets`, `validate`, `plan`, `report`, `history`.

---

## 4. What remains

### 4.1 Next (in order)
1. **Phase 5: the rest (developer experience)**
   - ~~Debug mode~~ DONE (session 13): `--debug` pauses after a failing step, `--debug-step` before every step, `--inspect [port]`
     opens the Node inspector and waits. Prompt: `c` continue, `n` next step, `r` retry the failed step, `s` state, `e <expr>`
     (eval with `ctx`), `q` quit. Forces 1 worker, inline pool, no scenario/group/run/step/hook timeouts, no retries.
     Needs a TTY (exit 2 otherwise). Runtime: `ExecuteOptions.debug: DebugController` (`beforeStep`, `onFailure`);
     CLI: `packages/cli/src/debug.ts`. Open: when `beforeWorker` fails, `afterWorker` still runs (cascading error).
   - ~~Cucumber Messages adapter~~ DONE (session 13): `-f messages[:file]` (default `reports/messages.ndjson`, `reporters/src/messages.ts`).
     Regenerates `source`/`gherkinDocument`/`pickle` from the feature files (`sourceRoot`, set to the project root by the CLI) with
     `@cucumber/gherkin`, then maps run events to `testRunStarted`, `testCase`, `testCaseStarted` (attempt, workerId),
     `testStepStarted/Finished` (with exception), `attachment` (attachments, screenshots, user logs as `text/x-cucumber-log+plain`),
     `testCaseFinished` (`willBeRetried`), `testRunFinished`, plus `stepDefinition`. Validated with `parseEnvelope`.
     Limits: scenarios from `@data` files have no pickle and are left out; groups/locks/hook levels have no Messages equivalent;
     hooks are not emitted as `hook`/`testStep` messages yet.
   - ~~Watch mode~~ DONE (session 13): `bddr --watch` (`cli/src/watch.ts`). Each run is a fresh child process (step code, page
     objects and config always reload). Changed `.feature`/`.md` files re-run just those files; any other change re-runs the
     original selection; changes during a run are coalesced. Keys: Enter/`a` all, `f` failed (via `--rerun-failed`), `q` quit.
     Ignores node_modules, .git, .bddr, dist, reports. Not combinable with `--debug`/`--dry-run`. Uses recursive `fs.watch`.
   - ~~CI sharding~~ DONE (session 13): `--shard i/n` on `run` and `plan`. `core/src/plan/shard.ts`: scenarios linked by dependencies,
     named groups or locks form one unit (never split across machines); units are packed largest-first onto shards by average
     duration from run history (`history: true`; equal weights without it, unknown durations use the median). Deterministic, so
     every CI machine agrees. Warns when one unit dominates; an empty shard exits 0. CI example: matrix of `--shard $i/4`,
     restore `.bddr/history` as a cache, merge results with `bddr report a.ndjson b.ndjson -f html`.
   - ~~Living documentation~~ DONE (session 13): `bddr docs [paths] [-o file] [--results events.ndjson]... [--title t]`
     (`cli/src/run.ts buildLivingDocs`, `reporters/src/living-docs.ts`). One offline HTML page: folder tree navigation, each
     folder's `README.md` is its introduction (first heading = folder title), features with description, scenarios, steps, data
     tables and doc strings, tag chips, search. Results (from `--results`, else the latest history run) colour scenarios and
     roll up per folder. Markdown is a small safe subset (links limited to http(s), mailto, relative).
   - VS Code extension and language server: step completion, go to definition.
2. **Phase 6: ecosystem**
   - Plugin API: data loaders, reporters, parameter types, retry analyzers, plan modifiers.
   - **Reusable Playwright integration** (extract and generalise the patterns proven in `examples/playwright-showcase`):
     - a browser per worker (BeforeWorker) and a page per scenario
     - screenshots and traces on failure
     - browser steps marked `concurrent: false`
   - HTTP step library (Karate-style JSON matching).
   - Allure reporter.
   - Step catalogue export plus an MCP server for AI assistants.
   - TypeScript v1.0 release.
3. **Phase 7: Java port**
   - JUnit Platform `TestEngine`, annotations, Maven and Gradle plugins.
   - Same config schema, event schema and reports; must pass `conformance/` unchanged.

### 4.2 Smaller leftovers
- **Phase 2:**
  - text-defined composite steps (`.steps.md` / `.concept`)
  - the Phase 2 gate (same feature gives identical results from inline Examples, CSV and XLSX)
  - SQL/HTTP data providers (with the plugin API)
- **Phase 3:**
  - `@requires:<file.feature>` spec-level preconditions
  - `waitedForMs` event (`workerStarted` is done)
- **Phase 0/1 gates:**
  - parse the Cucumber Compatibility Kit features
  - ~~run a real project end to end~~ done by `examples/playwright-showcase`
- **Gauge-style Markdown specs:** today `.md` means Markdown-with-Gherkin. This overlaps with the parked code-linked
  Markdown work.

### 4.3 Known limitations
- With the process pool:
  - feature/group/rule hooks run once per process that runs a member
  - `ctx.feature`/`ctx.groups` stores and module-level variables are per process
  - share state across processes with `ctx.export`/`ctx.from` or an external system
- A worker crash in the middle of a scenario loses that worker's After* hooks.
- JavaScript promises cannot be forcibly stopped in the inline pool; framework waits stop promptly, and user code
  should pass `ctx.signal` to cancellable APIs. Process-pool cancellation terminates the lane.
- `bddr list` does not load support code, so it cannot flag undefined steps; use `--dry-run` for that.
- Run-level hook failures are summarised in the console's "Hook failures" section, not per scenario.

### 4.4 Parked (owner decision; do not start without the owner)
- **Code-linked Markdown specs**: free-form Markdown that links to step code (TS/Java symbols or file:line) and becomes
  the report. Design: [design/code-linked-markdown.md](design/code-linked-markdown.md).
- **Callable scenarios** (`Given I run scenario "X"`): parked. Dependencies, exports and repeat steps cover the
  current needs.

---

## 5. Where ideas came from

| Idea | Inspired by |
| --- | --- |
| Gherkin specs, expressions, tag expressions | Cucumber |
| Hook lifecycle (suite → group → feature → scenario → step), groups, dependencies, retry analyzer, priorities | TestNG |
| Data from CSV/Excel, soft assertions, HTTP-style steps (planned) | Karate, Gauge, Robot Framework |
| Class steps + DI container, scenario context | Reqnroll/SpecFlow, Serenity/JS |
| Rerun failed + report merge, flaky/quarantine | Surefire/Maven, pytest plugins |
| Fixture-like scoped stores with `defer()` | pytest / pytest-bdd |
| Browser-aware execution (planned Playwright integration) | playwright-bdd |
| Living documentation and Markdown specs (parked) | Gauge, Serenity |
