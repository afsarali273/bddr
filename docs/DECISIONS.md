# Architecture decision records

Newest last. Each record: context, decision, consequences. Do not edit old records; supersede them.

## ADR-001 Own runner instead of compiling to Playwright Test (2026-11-15)

**Context.** playwright-bdd compiles features into Playwright Test files and gets parallelism, fixtures and
trace viewer for free. But Playwright Test cannot express cross-file scenario dependencies, group-level retry,
named resource locks or mixed serial/parallel groups in one run, which are our main differentiators.

**Decision.** bddr has its own executor and (phase 3) scheduler. Playwright will be an integration (phase 6).

**Consequences.** More work (workers, timeouts, reporting are ours). Full control over the plan graph.
The decision is still open for the user to overturn (comment in the plan doc); if overturned, `core` and the
event schema survive, `runtime/executor.ts` would be replaced by a code generator.

## ADR-002 Working name "bddr", npm scope `@bddr/*` (2026-11-15)

Placeholder name. Renaming = search/replace of `bddr` / `@bddr` + config file names (`bddr.config.*`) +
the global registry symbol (`bddr.registry.v1`).

## ADR-003 npm workspaces + TypeScript project references (2026-11-15)

npm ships with Node, so contributors need nothing extra (the plan doc said pnpm; npm was chosen for zero setup).
`tsc -b` builds `core → runtime → reporters → cli` in order. TypeScript pinned to 5.9 (TS 7 native compiler exists
but we wait until its API/ecosystem settle).

## ADR-004 Reuse Cucumber's open-source building blocks (2026-11-15)

`@cucumber/gherkin` (parser + pickle compiler), `@cucumber/messages` (AST types), `@cucumber/cucumber-expressions`,
`@cucumber/tag-expressions`, all MIT. We get exact Gherkin syntax, all languages, Markdown-with-Gherkin, and the same
expression semantics as Cucumber. We do not use Cucumber's runner.

## ADR-005 Context-first step signature (2026-11-15)

`Given('x {int}', (ctx, n) => …)` instead of Cucumber's `this` world. Works with arrow functions, is explicit about
scope (`ctx.state` / `ctx.feature` / `ctx.run`), and maps 1:1 to a Java method parameter. Class/decorator steps with
dependency injection come later as an alternative style (Phase 1 remainder).

## ADR-006 Stable ids are text-based, not position-based (2026-11-15)

`@id:` tag or `<uri>::<slug(name)>[row]`. Dependencies and reruns need ids that survive reordering and line changes.
Renaming a scenario without `@id` changes its id; teams that depend on a scenario should give it an `@id`.

## ADR-007 Own event schema (v1), Cucumber Messages via adapter later (2026-11-15)

Cucumber Messages lacks concepts we need (groups, attempts per group, locks, hook levels beyond scenario).
We emit our own flat, documented NDJSON schema and will add a Messages adapter (phase 5) for ecosystem tools.
Delivered (session 13) as the `messages` reporter: it translates the event stream, so our schema stays the source of truth.

## ADR-008 TypeScript step files loaded with tsx (2026-11-15)

The CLI calls tsx's `register()` before importing config and support files, so users need no build step.
The global registry lives on `globalThis` under a `Symbol.for` key so duplicate package copies still share it.

## ADR-009 Strict by default (2026-11-15)

Pending, undefined and ambiguous scenarios fail the run unless `strict: false` / `--no-strict`, so a green CI run
means every step really ran.

## ADR-010 Decorators are the normal API functions; `@Steps()` required (2026-11-15)

`Given('x', fn)` registers a function step; `Given('x')` returns a TC39 method decorator. Same for scenario/step
hooks. One vocabulary for both styles, and it maps to Java annotations. Standard (TC39) decorators, not
`experimentalDecorators`: method decorators cannot see their class, so `@Steps()` collects them. DI uses
`static inject = [...]` (no reflection metadata, no `emitDecoratorMetadata`). Lowercase decorator names were tried
and dropped: an export named `then` makes the module thenable and `await import()` hangs.

Vite 8 (vitest 5) transpiles with oxc, which does not lower TC39 decorators yet; `vitest.config.ts` pre-compiles
decorator files with the TypeScript compiler. tsx (esbuild) at runtime handles them natively.

## ADR-011 @data expansion by AST injection (2026-11-15)

Data rows are injected into the Gherkin AST as Examples rows before Cucumber's pickle compiler runs, so placeholders in
step text, data tables and doc strings behave exactly like normal outlines and the compiler stays unmodified.
Loading is async (`parseSpecAsync`); the sync `parseSpec` flags `@data` scenarios as errors rather than running
them with unresolved placeholders. Missing data is an error, never a silent zero-row pass.

## ADR-012 exceljs for XLSX, uuid forced to 11 (2026-11-15)

SheetJS's npm package is unmaintained (the maintained build is off-registry); exceljs is MIT and on npm.
exceljs 4.4 depends on uuid 8 (advisory GHSA-w5hq-g745-h8pq); root `overrides` pins uuid ^11.1.1, verified
by the XLSX tests. Remove the override when exceljs updates. XLSX/YAML are loaded with dynamic `import()`
so they cost nothing unless used.

## ADR-013 Stable ids use the template name (supersedes part of ADR-006) (2026-11-15)

Ids are built from the scenario name BEFORE `<placeholder>` substitution and, for data rows, from the source row
number BEFORE filtering. Inline outline rows keep `[<row index>]`; data rows use `[<source>#<row>]`.

## ADR-014 Ports & adapters: bddr owns the architecture, Cucumber libraries are replaceable parts (2026-11-15)

**Context.** The owner wants bddr to be its own framework (TestNG-style lifecycle, groups, dependencies), not a Cucumber
derivative. bddr never used Cucumber's runner, but three Cucumber libraries were imported directly in core/runtime files.

**Decision.** Define `SpecParser`, `TagExpressionEngine` and `StepExpressionEngine` interfaces; move every Cucumber import
into `adapters/`. Gherkin stays the default spec format through `cucumberGherkinParser`; other formats (the parked
code-linked Markdown specs) register as additional `SpecParser`s. Lifecycle names follow TestNG where it helps
(`BeforeSuite`/`AfterSuite`), and hooks may be static methods at any level.

**Consequences.** Any of the three libraries can be replaced without touching the runner. The Java port can implement
the same ports with JVM libraries or its own parser. Small cost: one indirection per call.

## ADR-015 Orchestration: pure planner + in-process scheduler first, worker processes next (2026-11-15)

**Decision.** The plan is a pure data structure built in core (testable, renderable with `bddr plan`, portable to Java).
Execution concurrency starts IN-PROCESS (async), which already gives parallel I/O-bound tests (API, browser automation
drivers) and lets us prove the semantics (deps, locks, group modes, priority, exclusive, scope ref-counting) with fast
tests. Worker processes come next behind the same `runNode` callback; exports are already structured-clone copies so
they can cross process boundaries unchanged.

**Semantics choices.** Hard dependency "passes" only with status `passed`. Selected scenarios pull in hard
dependencies by default (`--no-deps` to opt out); soft deps never pull anything in. Group = outer scope relative to
feature (close order rule → feature → group). Priority: lower first, TestNG-like. Ids for dependency targets should be
`@id` tags; outline/data families can be targeted by their base id.

## ADR-016 Logging through the event stream; AsyncLocalStorage attribution (2026-11-15)

Logs are events like everything else (one pipeline, available to every reporter and to the future HTML report),
with levels debug/info/warn/error and `source` user|bddr. The global `log` uses AsyncLocalStorage so helpers need no
context parameter and stay correct with concurrent scenarios. Console default threshold is `warn` so passing runs stay
quiet; `--log-level debug` turns on user debug logs plus framework scheduling diagnostics.

## ADR-017 `--set` generic overrides and implicit `default` group (2026-11-15)

Every config option is reachable from the CLI via `--set path=value` with JSON-typed values (CI-friendly, no file edits),
validated against `OPTION_KEYS`. Ungrouped scenarios get a group only when asked (`defaultMode` / `groups.default`),
keeping the Phase 3 default (unconstrained) unchanged.

## ADR-018 Logs in every report; images ride on log lines; HTML report v1 (2026-11-15)

Owner wants logs (with screenshots) in reports and console. A log event can carry one attachment (base64) so an image
is shown exactly where it was logged. Each file reporter filters logs with its own `logLevel` (JUnit/Cucumber JSON
default info, HTML embeds debug and filters in the page). Framework diagnostics stay out of CI formats (JUnit, Cucumber
JSON) to keep them clean; HTML keeps them behind a toggle. Console default changed from warn to info so user logs are
visible without flags. HTML report v1 is server-rendered, dependency-free, one file (shareable as a CI artifact);
v2 (graph/timeline/history) stays in Phase 5.

## ADR-019 Step-level repeat/retry via inline trailing tags (2026-11-15)

Owner's request: repeat a step N times (bulk data, e.g. 100 users) and retry a step until it passes. Gherkin has no step
tags, so recognised `@key:value` tokens at the END of a step's text are parsed (only known keys, so emails and other
`@words` are safe). BeforeStep/AfterStep run once per step by default; `{ eachAttempt: true }` runs them per attempt.
A pass after retries is a pass (attempts recorded, not a failure). `{{i}}`/`{{n}}` give each repetition unique data.
`@concurrency` is opt-in and only for steps safe to run in parallel with themselves (API/data); browser- or
Selenium-driving steps must declare `{ concurrent: false }`, which turns `@concurrency` into an error. Calling scenarios
was discussed and parked by the owner (bddr is an automation framework with BDD-style specs, not BDD-purist).

## ADR-020 Resilience model (2026-11-15)

- **Retry unit = full scenario attempt** (fresh state, hooks, Background); dependents see only the final attempt; summary is
  computed from final attempts at the end of the run.
- **Group retry** is decided by the scheduler/executor once all members finished (`settleGroup`), re-running all or only
  failed members with group hooks; outside dependents wait for the group to settle. This gives "retry the setup group as a
  unit" (TestNG-style) without blocking worker slots.
- **Flaky** = pass after any failure (scenario retry, group retry, merged rerun); reported, not failing unless
  `failOnFlaky`. **Quarantine** keeps known-broken tests visible without breaking CI; JUnit maps quarantined failures to
  `<skipped>` so CI dashboards stay green, and flaky passes to Surefire `<flakyFailure>`.
- **Rerun + merge** works from NDJSON events (no hidden state files), so it composes with CI artifacts and with the future
  Java engine (same schema).

## ADR-021 Worker processes: parent coordinates, workers execute (2026-11-15)

- **Parent keeps the plan and scheduler**; each lane is a forked process that rebuilds the same run from the CLI request
  (no AST/plan serialisation) and proves it with a plan fingerprint. Only ids, results and events cross IPC
  (`serialization: 'advanced'`).
- **BeforeAll/AfterAll run once in the parent** (TestNG BeforeSuite semantics, e.g. seed a DB once). Per-process setup is
  the new `worker` hook level (BeforeWorker/AfterWorker), which also exists inline (runs once) so suites are pool-agnostic.
  Rejected: BeforeAll per worker (Cucumber-js parallel) — surprising for global setup.
- **Scope hooks run per process, closed by the parent's global ref count**: keeps "AfterGroup before dependents" and lets
  hooks create process-local resources. Lifecycle events are emitted once by the parent so reports don't duplicate.
- **Inline stays the default**: zero overhead, shared memory, simplest debugging; `process` is opt-in.

## ADR-022 Static validation and cancellation use existing runtime contracts (2026-11-15)

**Static validation.** `bddr validate` reuses config loading, spec parsing and the pure planner, then loads support code
and performs definition-only matching. `SupportRegistry.analyzeMatch` deliberately does not evaluate parameter
transformers: validation must not execute user test logic. Undefined/ambiguous steps, parse/plan/config errors and
duplicate ids are errors; unused definitions, unmatched hooks and governed unknown tags are warnings. Warnings fail
only with `--fail-on-warnings`. Tag governance is opt-in (`validation.allowedTagKeys`) because arbitrary business tags
are otherwise a valid part of Gherkin.

**Cancellation.** One `AbortSignal` contract covers programmatic cancellation, Ctrl+C, run budgets and group budgets,
and is exposed as `ctx.signal` so user libraries can cooperate. Inline work races hooks/steps/delays against that signal;
process work cancels by terminating the affected lane and respawning it when needed. After-hooks and deferred cleanups
are not pre-aborted, so teardown still gets a chance to run. Ctrl+C returns the conventional exit code 130 after
reporters are flushed where possible.

**Budgets and retries.** A group timeout starts with the first member of each group attempt and is reset for a group
retry. It aborts running members and skips queued members. Scenario retry delay supports exponential backoff; worker
crash retry is separate from ordinary scenario retry and only handles `WorkerCrashedError`, never deterministic worker
initialisation failures.

## ADR-023 Live Playwright showcase is a standalone, optional consumer project (2026-11-15)

**Decision.** Prove the real-project gate with `examples/playwright-showcase`, using bddr as the sole runner and
Playwright only for Chromium and HTTP transport. The Internet is the UI target because it exposes stable, purpose-built
automation controls; JSONPlaceholder is the API target because it needs no key and simulates writes without mutating
shared state. The project launches one browser/API context per process worker and one isolated page context per UI
scenario. All browser definitions declare `concurrent:false`.

**Why standalone and optional.** This is deliberately a normal consumer with its own `package.json`, lockfile and
scripts, not a hidden root dev dependency. It proves the public package surface and gives users a copyable project.
Its live 66-scenario run is not added to root `npm run verify`: public network availability and the Chromium download
would make the otherwise deterministic framework CI unreliable and slow.

**Consequence.** The showcase proves lifecycle and reporting patterns, but does not pretend to be the final Phase 6
integration package. Reusable fixtures, automatic screenshots/traces only on failure, browser selection and shared
configuration remain extraction work.

## ADR-024 HTML v2 views as inline SVG; history as per-run JSON files (2026-11-15)

- **Inline SVG, no Mermaid/JS libraries.** The report must stay one self-contained file that opens offline (CI artifacts,
  email). Timeline and dependency graph are laid out by bddr (`reporters/src/html-views.ts`): lanes from
  `scenarioStarted.workerId`, longest-path layering for the graph. `bddr plan --plan-format mermaid` remains for docs.
- **History = one compact JSON file per run** in `.bddr/history` (`<startedAt>-<runId>.json`, newest `keep` kept).
  Files are append-only and merge-friendly (CI can cache/restore the folder), need no database and are cheap to read.
  Built from events by `HistoryRecorder` (core), so `bddr report` and the Java port can produce the same records.
- **Flakiness score** = share of recorded runs that were unstable (outcome differs from the previous run, or passed only
  after a retry). Consistent failures score 0 on purpose: broken ≠ flaky.
- **Opt-in** (`history: true`): bddr does not write into a project folder unasked. Dry runs are never recorded.
- New event `workerStarted` (additive) so the timeline can tell worker start-up apart from idle time.

## ADR-025 Fixtures, `inject()` and plugins in the runtime; integrations as separate plugins (2026-11-15)

Step code had to wire everything by hand (`page(ctx)` helpers, `static inject = [CONTEXT]`, getters). Fixtures (named,
lazy, `scenario` or `worker` scoped, with dependencies and teardown) live in `@bddr/runtime`, requested by destructuring
the first parameter (as in Playwright Test), `ctx.fixture(name)` or `inject()` in classes. Worker scope means "per worker
process" so it maps onto both pools without changing scheduling; fixtures never affect the plan, so groups, dependencies,
locks, retries and sharding are untouched. `inject('x')` for an async fixture throws `FixtureNotReady` during
construction; the `@Steps()` wrapper creates the fixture and constructs again (construction is synchronous, so a
module-level "constructing" context is safe under concurrency). Integrations (Playwright, Selenium, HTTP) are plugins
(`definePlugin`, config `plugins`) resolved from the user's project: bddr has no dependency on them (TestNG/JUnit model).
Considered: a lazy proxy for async values (breaks `instanceof` and identity) and re-running steps on demand (unsafe side
effects); rejected.

## ADR-026 Renamed the project from bddx to bddr (2026-11-22)

**Context.** The unscoped npm package and command `bddx` already belong to another Gherkin CLI (aexol, version 0.2.3). The owner's GitHub name `smart-bdd` also collides with the existing Java "Smart BDD" framework (bit-smart-io/smart-bdd), and the planned Java port would sit next to it. The owner wanted a short name containing "bdd" that is easy to type in the CLI.

**Decision.** The product, command and npm scope are now `bddr` ("BDD runner"): `@bddr/core`, `@bddr/runtime`, `@bddr/reporters`, `@bddr/cli`, `@bddr/playwright`, `@bddr/selenium`, `@bddr/axios`; config file `bddr.config.ts`; env vars `BDDR_*`; history folder `.bddr/`. Both names have four letters, so nothing was re-wrapped or re-aligned. Nothing was published yet, so there is no compatibility shim.

**Checked (2026-11-22).** `bddr` is free on npm, PyPI, crates.io and RubyGems; a web search found no test tool of that name. The owner created the GitHub repo `afsarali273/bddr` the same day. NOT yet checked by us: the npm scope `@bddr`, domains, trademarks.

**Consequences.** `bddr` is one letter from the other project's `bddx`, so a typo could run their tool. Old name in history entries (PROGRESS.md, git log) is `bddx`; a global replace was applied to all docs, so older entries now read `bddr`.
