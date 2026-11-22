# Progress log

The single source of truth for "where are we" and the session history. Update it at the end of every work session
(see CLAUDE.md). For a feature-by-feature summary of what is done and what remains, see [STATUS.md](STATUS.md).

## Current state (2026-11-23)

- **Phases 0, 1, 3, 4:** done. **Phase 5:** done except the VS Code extension (HTML v3, run history, living docs, debug, watch,
  `--shard`, Cucumber Messages). **Phase 2:** data core done (composite steps + Phase 2 gate remain).
- **Phase 6:** Playwright, Selenium and axios plugins and the documentation site are done; plugin API extension points, HTTP steps,
  Allure, MCP, npm release and v1.0 remain.
- **Name:** renamed from bddx to bddr (ADR-026). Repo: https://github.com/afsarali273/bddr; docs site on GitHub Pages.
- **Health:** `npm run verify` green (235 of 236 tests; the failing one is `watch.test.ts`, a sandbox file-cleanup problem) plus the
  offline examples. The live Playwright and Selenium showcases have not been run since the rename.
- **Working copy:** `/Users/afsarali/Repository/AI_Projects/BDD_Framework`, remote `git@github.com:afsarali273/bddr.git`
  (SSH; the owner pushes from their Mac).
- **Framing (owner):** an automation framework with BDD-style specs, not BDD-purist. Practical features first.

## Next up

The ordered list is in [STATUS.md](STATUS.md) section 4.1: release readiness for v0.1 (npm publish, `bddr migrate`, retake
screenshots, run the live showcases, CI), then the VS Code extension, Phase 6 leftovers, and the Java and Python ports.

Parked by the owner for a later phase: **code-linked Markdown specs** (see `docs/design/code-linked-markdown.md`) and callable
scenarios. Do not start them without the owner.

## Known gaps / caveats

- `.md` specs use Cucumber's Markdown-with-Gherkin (MDG) syntax (`# Feature:`, `## Scenario:`, `* Given`), not Gauge's
  format. Gauge-style Markdown overlaps with the parked code-linked Markdown design.
- Process pool: feature/rule/group hooks run once per process that runs a member; `ctx.feature`/`ctx.groups` stores
  and module-level variables are per process. Cross-process state: `ctx.export`/`ctx.from` or an external system.
- A worker crash mid-scenario loses that process's After* hooks (the scenario fails; the lane respawns).
- Inline JavaScript promises are cooperative: framework waits abort promptly, but user operations should consume
  `ctx.signal`; process-pool cancellation terminates the lane.
- Console reporter prints logs (by `--log-level`) but not attachments (those are in HTML/NDJSON).
- Run-level hook failures are summarised under "Hook failures:" in console output, not per scenario.
- `bddr list` does not load support code, so it cannot flag undefined steps (use `--dry-run`).
- No `attempt` hook level: by design (scenario hooks run per attempt; step hooks have `eachAttempt`).

## Session log

### 2026-11-15: Session 1 (Phase 0 + Phase 1 core)

Built and verified in the assistant's cloud workspace (also verified from a clean copy: `npm install && npm run verify`).
Delivered to the user as `bddr-session1.zip` (source only: no `node_modules`, `dist`, `reports`) to extract into
their `BDD_Framework` folder, because the session could not write to their computer directly.

- Scaffolding: npm workspaces, `tsconfig.base.json` + per-package project references, vitest with source aliases,
  `tsconfig.test.json` for type-checking tests.
- core: model, Gherkin compile with AST index, stable ids, tags, selection, event schema v1, EventBus.
- runtime: SupportRegistry (lazy expression compile, scoped steps, ambiguity, snippets), global API,
  Executor (run/feature/rule/scenario/step hooks, failure semantics table, dry run, fail-fast, strict),
  Store/Scope with defer, DataTable/DocString, timeouts.
- reporters: console (pretty/progress), ndjson, junit; `createReporter` spec parsing.
- cli: config loading through tsx, profiles, discovery with `file:line`, `run` and `list`, exit codes.
- conformance: README with step vocabulary, 5 features + expected JSON, TS runner.
- examples/basic: basket feature with background, outline (2 Examples blocks), rule, custom parameter type, hooks.
- Docs: README, CLAUDE.md, IMPLEMENTATION.md, DECISIONS.md (ADR-001…009), ROADMAP.md, this file.

### 2026-11-15: Session 1b (moved into the user's folder)

- User extracted the zip into `BDD_Framework`. Restored `.gitignore` (lost in extraction), ran `npm install`
  and `npm run verify` on the user's Mac: 47 tests pass, example passes.
- From now on all work happens directly in this folder (see CLAUDE.md "Where to work").

### 2026-11-15: Session 2 (Phase 1 finished, Phase 2 data core)

Worked directly in the user's folder via device shell.
- Git repo created; first commit `aad9aef`; remote switched to SSH; user pushed.
- runtime: `decorators.ts` (class steps + DI), `api.ts` functions double as decorators (ADR-010). Found and fixed a
  hang: exporting `then` made the package thenable. `vitest.config.ts` gained a TC39-decorator pre-compile plugin.
- reporters: `cucumber-json` (+ `json` alias); events: additive `keyword`, `description`, `feature{…}`,
  `example.source/sourceRow` on `PlannedScenario`.
- cli: `bddr snippets`; `dataDir` option; parse via `parseSpecAsync` with a file data loader (also in `list`).
- core: `data/` (CSV parser, loader, providers), `parseSpecAsync`, AST injection (ADR-011), template-name ids (ADR-013).
- deps: `yaml`, `exceljs` in core; root override uuid ^11.1.1 (ADR-012); lockfile regenerated; `npm audit` clean.
- tests: decorators (5), cucumber-json (1), snippets + data CLI (2), data (9), conformance `data.feature`.
- example: `checkout.feature` (class steps), `pricing-data.feature` (CSV + XLSX + qa profile), `data/make-xlsx.mjs`.

### 2026-11-15: Session 2b (own architecture: ports + adapters, TestNG lifecycle names)

- Commit `d66f13d` (Phase 1 complete + Phase 2 data core).
- Ports & adapters (ADR-014): `core/src/ports.ts` (`SpecParser`, `TagExpressionEngine`), `core/src/spec-parsers.ts`
  (registry by suffix, `parseSpecFile`, `specFileGlobSuffix`), `core/src/adapters/cucumber-gherkin.ts` (moved from
  `gherkin.ts`), `core/src/adapters/cucumber-tag-expressions.ts`, `runtime/src/ports.ts` (`StepExpressionEngine`),
  `runtime/src/adapters/cucumber-expressions.ts`; `SupportRegistry({ engine })`. CLI uses `parseSpecFile`.
- Hooks: `BeforeSuite`/`AfterSuite` aliases; hook decorators on static methods for every level (`staticHookDecorator`).
- Owner's code-linked Markdown idea captured in `docs/design/code-linked-markdown.md` (parked); Gauge-style Markdown
  item removed from Phase 2.

### 2026-11-15: Session 3 (Phase 3: orchestration)

- Commit `74ff469` (ports & adapters).
- core: `plan/` — `types.ts` (vocabulary), `planner.ts` (`buildPlan`, closure, validation, cycles, `explainNode`),
  `render.ts` (text, mermaid, JSON). Selection matched by id, not object identity (bug found by tests).
- runtime: `scheduler.ts`; `executor.ts` top half rewritten around the plan: lazily opened, ref-counted feature/rule/group
  scopes; `BeforeGroup/AfterGroup`; `ctx.groups`, `ctx.export`, `ctx.from`; workerId = slot `w1..wN`.
- events: `groupStarted/Finished`, `planReady.workers/groups`, orchestration fields on `PlannedScenario`; HookLevel `group`.
- cli: `prepareRun()` shared by run/plan; `bddr plan` (`--plan-format`, `--explain`); `-w/--workers`, `--no-deps`; config
  `workers`, `groups`; all configured specs parsed so cross-file deps resolve.
- tests: planner (5), orchestration (12, timing-based; ran 3× stable), CLI plan/deps/orchestration (3), conformance
  `dependencies.feature` (expected.json gained `config`).
- example: `examples/orchestration` (4 groups, exports, group hooks, exclusive report), npm scripts
  `example:orchestration`, `plan:orchestration`; `verify` runs both examples.

### 2026-11-15: Session 3b (config overrides, defaultMode, logging)

- Owner asked: run parallel + sequential in one command (already true via groups), config from CLI, proper log levels.
- cli: `-s/--set path=value` (`applySetOverrides`, `OPTION_KEYS`), `--log-level`, config `defaultMode`, `logLevel`;
  `[bddr:debug]` CLI diagnostics on stderr; console reporters receive the log level (`withLogLevel`).
- core: `LogLevel`, `LOG_LEVELS`, `logLevelEnabled`; `log` event gains `level`, `source`, `data`; planner `defaultMode`
  and implicit `default` group (`PlanGroup.implicit`).
- runtime: `logger.ts` (`createLogger`, global `log`, `withLogger` via AsyncLocalStorage); steps/hooks run inside it;
  executor framework debug logs; implicit groups excluded from hooks/stores/events.
- reporters: console buffers scenario logs under the result line, `logLevel` threshold (default warn), data inline.
- example: orchestration steps log at info/debug/warn incl. a helper using global `log`.
- tests: logging (3), console levels (3), defaultMode (3 planner + 1 scheduler), CLI `--set`/`--log-level` (2) +
  `applySetOverrides` unit (1); two older tests now ignore framework logs. 102 total.

### 2026-11-15: Session 3c (logs in reports, images, HTML report)

- Owner: logs must be in reports and console, with screenshots/images.
- core: log event `attachment`. runtime: `ctx.log.image`, bytes-as-data → image, `sniffMediaType`, global `log.image`.
- reporters: `logs.ts` (`LogIndex` with framework filter, `formatLogLine`), new `html.ts` reporter (`html`), JUnit
  `<system-out>/<system-err>` (CDATA-safe), Cucumber JSON step `output` + log-image embeddings + `before` hook output,
  console default level info + image marker.
- examples: both configs write `reports/report.html`; orchestration logs generated PNG "screenshots"
  (`steps/fake-screenshot.ts`, no browser needed).
- Verified the HTML visually (headless Chrome screenshots: images inline, level filter, framework toggle).
- tests: +5 (107).

### 2026-11-15: Session 3d (step-level repeat/retry)

- Owner: framing = automation framework with BDD-style specs (practical over BDD-purist); calling scenarios parked.
- core: `step-tags.ts` (`extractStepTags`, `scenarioStepDefaults`, `parseDuration`), `StepInstance.tags/run`, parser
  errors for bad tags; events `stepAttemptFinished`, `stepFinished.mode/attempts`, `log.attempt`.
- runtime: attempt loop in `runStep` (retry with delay/backoff, repeat with `{{i}}`/`{{n}}` and `runRepeat`
  concurrency), `attemptContext`, `eachAttempt` hooks, definition `retry` and `concurrent:false` guard,
  `ctx.step.attempt/of/mode`.
- reporters: `attemptsNote`; console/HTML/JUnit show attempts; HTML per-attempt list.
- example: `examples/basic/features/bulk-and-polling.feature` (100 users ×10 concurrency, polling with retry).
- conformance: `step-repeat-retry.feature` + 2 vocabulary steps. Tests: +14 (121).

### 2026-11-15: Session 4 (Phase 4: resilience)

- core: events `willRetry/flaky/quarantined` on scenarioFinished, `groupRetrying`, group start/finish `attempt`, summary
  `flaky/quarantined/retried`; planner `PlanNode.retry/quarantined` (`@retry`, `@noRetry`, `@quarantine`, group
  `scenarioRetry`), `PlanGroup.retry/retryMembers`; `events-merge.ts` (`parseNdjson`, `finalResults`, `idsToRerun`,
  `mergeEventStreams`).
- runtime: `runNode` retry loop, `shouldRetry` (attempts, `retry.on`, analyzer), `settleGroup` (group retry: re-open
  scopes, requeue), summary from final attempts, soft assertions (`ctx.soft`), scenario time budget; scheduler retry-group
  settling; `setRetryAnalyzer`, `RetryOptions`.
- cli: config `retry`, `scenarioTimeout`; `-r/--retry`, `--fail-on-flaky`, `--rerun-failed <file>`; `bddr report`.
- reporters: console retry/flaky/quarantine display; JUnit `<flakyFailure>` + quarantined → skipped; HTML badges,
  earlier attempts, group retries, trimmed stack traces.
- examples/resilience (+ `npm run example:resilience`, in `verify`); fixture `rerun-project`; conformance
  `scenario-retry.feature` (+1 vocabulary step). Tests now 137.

### 2026-11-15: Session 5 (worker processes)

- runtime: `pool.ts` (protocol, `ProcessPool`, `serveWorker`, `planFingerprint`, `WorkerCrashedError`/`WorkerInitError`);
  Executor coordinator mode (`pool` option: `runRemote`, `releaseRemote`, run-store seed) and worker mode
  (`remoteWorker`: `initWorker`, `runAssigned`, `closeScopes`, `shutdownWorker`); hook level `worker`
  (`BeforeWorker`/`AfterWorker`, inline = once); groupStarted/Finished carry `attempt` on group retries.
- cli: config `pool`, `--pool inline|process`, `worker.ts` entry, `prepareWorker`, SIGINT kills workers.
- examples/orchestration: fake backend moved from memory to a temp file (BeforeAll → run store) so it runs in both
  pools; `npm run example:orchestration:process` in verify.
- tests: `runtime/test/pool.test.ts` (fake in-process pool: protocol, hooks, exports, retries, crash, BeforeWorker
  failure, inline worker hooks); CLI e2e `fixtures/pool-project` (real processes, crash, init failure, parity). 148 tests.

### 2026-11-15: Session 5b (documentation pass)

- New `docs/STATUS.md`: one-page summary of everything done (feature inventory, hook lifecycle table, tag/config/CLI
  reference) and everything remaining (next phases, leftovers, known limitations, parked items, idea sources).
- Brought README, CLAUDE.md, ROADMAP, IMPLEMENTATION (package tables: plan/, step-tags, events-merge, scheduler, pool,
  logger, worker.ts) and this file in line with the code; CLI help lists the `html` reporter.

### 2026-11-15: Session 6 (`bddr validate` + resilience completion)

- cli: new `bddr validate` / `validateProject()` with structured errors and warnings for parse/config/plan problems,
  duplicate ids, undefined/ambiguous steps, unused definitions, unmatched hooks and optional tag governance;
  `--fail-on-warnings`. Matching does not run parameter transformers.
- runtime/core: `ctx.signal`, external cancellation, abort-aware hooks/steps/delays, group-attempt budgets, run budget,
  graceful Ctrl+C (exit 130), scenario retry backoff, worker-crash retry on a fresh process; new config
  `groups.x.timeout`, `runTimeout`, `retry.backoff`, `retry.workerCrash` and CLI flags.
- tests: validation fixture, inline and process time budgets, programmatic cancellation, Ctrl+C, retry backoff and
  worker crash recovery. 157 tests pass; ADR-022 records the semantics.

### 2026-11-15: Session 7 (real Playwright UI/API project)

- added standalone `examples/playwright-showcase` TypeScript project using local bddr packages and Playwright 1.65.1;
  bddr remains the runner, while Playwright provides Chromium and its API request context.
- 66 scenarios / 289 steps: 30 UI scenarios against The Internet, 33 API scenarios against JSONPlaceholder, two
  prerequisite health scenarios and one deterministic scenario-retry demonstration.
- exercises process workers, worker/group/feature/scenario/step hooks, browser-per-worker/page-per-scenario lifecycle,
  groups/dependencies/exports, outlines, CSV `@data`, tables, doc strings, custom parameter types, class DI, soft
  assertions, repeat concurrency, retry/flaky reporting, budgets, logging, screenshots/JSON attachments and reports.
- verification: standalone TypeScript compile and `bddr validate --fail-on-warnings` are clean; complete live run passed
  all 66 scenarios (one deliberately flaky pass on attempt 2). Root unit/conformance/example verification remains
  separate so offline CI is deterministic. ADR-023 records target and isolation choices.

### 2026-11-15: Session 8 (mixed serial/parallel expansion)

- added six feature files and 53 new scenarios: SauceDemo authentication/inventory (20, serial), TodoMVC lifecycle/
  filtering (15, parallel), DummyJSON products/users (15, serial), plus three additional target-health rows.
- expanded the single plan to six named groups: serial `health`, `sauceDemo`, `dummyJson`; parallel `theInternet`,
  `jsonPlaceholder`, `todoMvc`, with group dependencies and worker caps visible in `bddr plan`.
- live verification: `bddr validate` reports 119 scenarios / 504 steps / 87 definitions with zero errors or warnings;
  complete process-pool run passes all 119 scenarios and 504 steps, including the intentional retry/flaky scenario.
- corrected public-target selector timing and documented the expanded matrix in the showcase README, status, roadmap and
  implementation notes.

### 2026-11-15: Session 9 (Phase 5 reporting: HTML v2 + run history)

- Owner chose Phase 5 reporting for this session (overriding the session-8 note). Committed sessions 6–8 work first
  (`0cc28ae`). The local `node_modules` had macOS-only rolldown/esbuild binaries; Linux arm64 binaries were unpacked
  next to them (no package.json/lock change) so the cloud VM can run vitest/tsx.
- core: `history.ts` (`HistoryRecorder`, `loadHistory`, `saveHistory`, `scenarioHistory`, `rankScenarios`); event
  `workerStarted`.
- reporters: `html-views.ts` (timeline per worker lane with retried attempts, worker start-up and group rows;
  dependency graph; history view with pass-rate bars, flakiest table, trend dots, flaky score); html.ts wiring + anchors.
- runtime: ProcessPool emits `workerStarted`. cli: config `history`, record after each run (not dry runs), previous runs
  passed to html reporters, `bddr history [--top n]`. `.bddr/` gitignored.
- tests: core history (score, recorder, keep/load), reporters v2 views, CLI e2e (history + workerStarted). 164 tests.
- Not committed by this session: `examples/playwright-showcase/src/pages/` (created concurrently by another session).

### 2026-11-15: Session 11 (HTML report v3: statistics + redesign, JUnit hook failures)

- Ran the Playwright showcase from the cloud VM: live targets and browsers are unreachable there (validate/plan/dry-run
  and a failing `@health` run only). That run exposed a JUnit gap: failed run/worker/group/feature hooks were dropped, so
  JUnit showed 0 failures while the run was FAILED. Fixed: they now appear as errored test cases in a `Hooks` suite.
- HTML report v3 (`html.ts`, new `html-stats.ts`): tabs Overview / Results / Execution / History; Overview has KPI cards
  (pass rate with delta vs previous run, scenarios, steps, wall time, parallelism, stability), status donut, steps bar,
  duration percentiles + histogram, failures grouped by cause (numbers normalised), slowest scenarios, retried/flaky,
  breakdowns by feature, tag and group (rows link into filtered Results).
- Sharing/UX: Copy summary (Slack/PR text), Copy link (tab + search + filters live in the URL hash), Download JSON
  (`#bddr-data`, also embedded), Print/PDF styles, light/dark/auto theme, per-scenario permalinks, copy-error buttons,
  clickable tag chips, "Failures only" preset, shortcuts `/` `n` `p` `1`-`4`.
- Statistics come from one function (`computeStats`, exported) so cards, summary text and JSON agree.
- tests: JUnit hook failure, html v3 (tabs, JSON payload, computeStats, history delta). 178 tests. Verified interactions in
  headless Chrome (routing, filters, clipboard, download, dark theme).
- Not run live: the Playwright showcase end to end (needs network + `npx playwright install chromium` on the Mac).

### 2026-11-15: Session 12 (Page Objects + ungrouped independent targets)

- Added SauceDemo and TodoMVC Page Object Models under `examples/playwright-showcase/src/pages/`; migrated their UI
  step definitions so selectors, waits and component actions are centralized outside Gherkin glue.
- Added six deliberately ungrouped `@independent` scenarios across two new feature files: Playwright documentation UI
  checks and HTTPBin API checks. They have no named group or group dependency and can run independently with
  `npx bddr run --tags @independent`.
- Validation now reports 125 scenarios / 523 steps / 96 definitions with zero errors or warnings. The independent
  run passed all 6 scenarios and 19 steps; the migrated SauceDemo/TodoMVC run passed 41 scenarios and 148 steps.
- follow-up (same session): data-driven display. `html-data.ts`: one table per Examples block / `@data` source (rows stay
  normal scenario cards so filters, permalinks and shortcuts keep working; the summary line is a CSS-grid row, columns =
  parameters, failing row shows its error inline), template with `<placeholders>`, step data tables and doc strings.
  Event schema: `planReady` steps gain optional `arg` (additive). Dependency graph shows how many scenarios have no
  dependencies. 178 tests.
- follow-up 2 (same session): UI/UX + responsive pass (`html-responsive.ts`). Sticky tab bar with a status chip (header
  scrolls away), sticky filter bar on desktop, "N of M shown" count, empty-filter state with reset, empty features and
  datasets hide when filtered, back-to-top button, focus outlines. Breakpoints 900/720/520px: two-column KPIs, single
  column cards, scrolling action row, stacked label/value cards for data rows, scrollable timeline, hidden status bars in
  breakdown tables. Verified at 390, 820 and 1360px in headless Chrome (no horizontal overflow). 178 tests.
- follow-up 3 (same session): data sets with more than 5 parameters keep the table layout on every screen size and scroll
  sideways (pinned status + row number, visible scrollbar, "scroll sideways" hint, inline error and expanded body stay in
  view); 5 or fewer stay compact (stacked cards on phones). Verified with a 14-column CSV at 390 and 1360px. 178 tests.

### 2026-11-15: Session 13 (debug mode)
- Added `--debug`, `--debug-step`, `--inspect [port]`. Runtime: `DebugController` (`runtime/src/debug.ts`) called from `Executor.runStep`
  (before a step; after a final failure, with retry-the-step). Debugging disables timeouts and scenario/group retries.
  CLI: readline prompt (`cli/src/debug.ts`, injectable IO), `forDebugging()` in `run.ts`. Tests: `runtime/test/debug.test.ts`, `cli/test/debug.test.ts`, 2 CLI tests. 190 tests green.
- Added `--shard i/n` (`core/src/plan/shard.ts`, `parseShard`/`shardPlan`; union-find units over deps/groups/locks + LPT packing by history avg). Tests: `core/test/shard.test.ts` + CLI. 197 tests green.
- Added `--watch` (`cli/src/watch.ts`, `cli/test/watch.test.ts` incl. an end-to-end edit-and-rerun test). 200 tests green.
- Added Cucumber Messages reporter (`reporters/src/messages.ts`, `-f messages`), 2 CLI tests (parseEnvelope validation, retry attempts). New deps on `@cucumber/gherkin`/`messages` in reporters.
- Added `bddr docs` living documentation (tests: `reporters/test/living-docs.test.ts`, CLI test; DOM behaviour checked in jsdom). 208 tests green.
- Added fixtures (`defineFixture`, scenario/worker scope, teardown with status), `inject()` for classes and page objects, plugins (`definePlugin`, config `plugins`). Guide: docs/FIXTURES.md, ADR-025. Tests: runtime/test/fixtures.test.ts (11), cli/test/fixtures.test.ts (4: inline, process pool, shards, missing plugin). 223 tests green.
- Added `plugins/playwright` (`@bddr/playwright`, standalone package, peer deps playwright + @bddr/runtime; `npm run verify` there: 7 tests with a fake Playwright). Offline example `plugins/playwright/example` (API scenarios verified live here; UI needs `npx playwright install` on a machine with browsers). Runtime: fixture teardown now gets `ctx`; fixtures are also detected from `ctx.name` / `const { name } = ctx` in function bodies.
- Added serial features: `@serial` on a Feature or Rule, config `featureMode: 'serial'` + `@parallel` opt-out (docs/SERIAL-FEATURES.md, runtime/test/serial-feature.test.ts, 7 tests). Verified live: basic example, process pool, 3 workers: 0 overlaps within a feature, features in parallel. 230 tests green.
- Added feature-scoped fixtures (`scope: 'feature'`, also in BeforeFeature hooks), `afterScenario` for feature/worker fixtures, `ctx.scenario.serial`, scheduler affinity (process pool: a serial feature stays on one worker process). Playwright plugin: `reuseContext: 'serial'` / `@reuseContext` / `@freshContext` (sharedContext/sharedPage). Tests: runtime fixtures (13), affinity (2), CLI serial session in the process pool (x3), plugin (12). 235 bddr tests green.
- NEXT: run the example UI scenarios on the Mac (incl. features/journey.feature); migrate examples/playwright-showcase to the plugin; Selenium/HTTP plugins; VS Code extension.

### 2026-11-15: Showcase migrated to `@bddr/playwright`

- `examples/playwright-showcase` no longer launches Playwright itself: `bddr.config.ts` has `plugins: [playwright({...})]`
  (context baseURL/viewport, request baseURL/headers, `actionTimeoutMs`, screenshot on failure). Removed BeforeWorker/
  AfterWorker, the `@ui` Before/After hooks and the BROWSER/API/PAGE plumbing from `src/support/`. Steps use `ctx.page`,
  `ctx.request`, `inject('page')`; `hooks.ts` imports `@bddr/playwright` for types. `-D headless=false` became `-D headed=true`.
- Added dependency `@bddr/playwright: file:../../plugins/playwright` (plugin must be built: `npm run build` there).
- Verified from the VM with real Chromium (installed, plus libxdamage1 unpacked to a local dir via LD_LIBRARY_PATH):
  full run 125/125 scenarios, `--pool process` 4 workers. First run showed the helper-reads-`ctx.page` pitfall
  (fixed in `independent-ui.steps.ts`, documented in the plugin README).
- Uncommitted: this and the other session's showcase work (`features/independent/`, `src/pages/`, ...). package-lock.json
  not regenerated: run `npm install` in the showcase on the Mac.

### 2026-11-15: Playwright plugin exposes the whole Playwright API

- Plugin: `expect` fixture (Playwright's web-first assertions from the optional peer `@playwright/test`; `expectTimeoutMs`),
  `newContext` fixture (extra contexts closed after the scenario), options `device`/`-D device`, `testIdAttribute`,
  `connect`, `cdpUrl`. 17 plugin tests. Showcase `ui.steps.ts` now uses `expect` (36 @the-internet scenarios pass on real Chromium).
- Bug fixed in cli: `--set` crashed (`DataCloneError`) when the config held a plugin object (a function); it now copies only
  the paths it changes. Regression test added.
- Root `tsconfig.test.json` excludes `examples/playwright-showcase` (its own `tsc` checks it; the cli fake-browser fixture
  declares a conflicting global `page` type).
- Showcase now uses the new plugin features: `expect` (ui/saucedemo/todomvc steps), `testIdAttribute: 'data-test'` +
  `getByTestId` page objects, `trace: 'only-on-failure'`, `expectTimeoutMs`, and `features/plugin/` (`@serial @reuseContext`
  journey, `newContext` two-user isolation, device emulation). 131 scenarios / 539 steps pass on real Chromium (process
  pool 4 workers and inline); plugin 17 tests; root verify 236 tests.

### 2026-11-15: `@bddr/selenium` plugin

- New `plugins/selenium` (separate package, same shape as the Playwright plugin): fixtures `selenium`, `driver`, `open`,
  `wait`, `newDriver`, `sharedDriver` (feature scoped); options browser/headless/args/capabilities/server (Grid)/baseURL/
  windowSize/timeouts/screenshot/`reuseSession` (`@reuseSession`, `@freshSession`); `-D browser|headed|server|baseURL`.
- 12 tests with a fake selenium-webdriver; `example/` project (local shop server, login + `@serial @reuseSession` journey).
- Verified with REAL Firefox 160 via Selenium Manager from the VM (inline and `--pool process -w 2`: 5/5 scenarios; a failing
  scenario attaches a PNG). Needed libgtk-3/libcolord2/libdbus-glib/libxdamage unpacked locally (LD_LIBRARY_PATH); not needed on a Mac.
  A real run caught a bug the fake missed: `Builder.withCapabilities()` replaces the browser name, so it is called before `forBrowser()`.
- Not tried: Chrome/Edge/Safari and a remote Grid (Chrome-for-Testing downloads are blocked in the VM).

### 2026-11-15: `examples/selenium-showcase`

- New project with 33 scenarios / 107 steps in 6 feature files (the-internet + SauceDemo), using only `@bddr/selenium`.
  Passes on real Firefox 160 in the process pool (3 workers, 97s); the SauceDemo group also passes with `--pool inline`.
- Plugin fixes found by it: `wait(until.elementLocated(..))` now types as `WebElement` (overloads); the plugin loads the
  PROJECT's `selenium-webdriver` (createRequire from cwd) because `until.*` conditions use `instanceof` and a second copy
  (linked/duplicated install) made `driver.wait` reject them ("Wait condition must be a promise-like object").
- Not tried: Chrome/Edge/Safari, a remote Grid. package-lock for the new project is not committed-checked; run `npm install` on the Mac.

### 2026-11-15: `@bddr/axios` plugin (API testing)

- New `plugins/axios`: fixtures `axios`, `api` (instance with baseURL/headers/timeout/auth, 4xx/5xx do not throw),
  `newApi`; call log attached as `api-calls.json` (only-on-failure by default; Authorization/cookie headers masked,
  bodies truncated); `-D token`, `-D baseURL`; loads the project's axios (createRequire from cwd).
- 9 tests with REAL axios against a local server; `example/` project (6 scenarios, local products API) passes inline and
  `--pool process -w 3`. Verified a failed scenario attaches the log with the token masked.
- Using it together with `@bddr/playwright` / `@bddr/selenium` in one scenario: documented, not yet exercised in a showcase.

### 2026-11-15: mixed UI + API scenarios (Playwright showcase)

- Showcase now uses both plugins: `@bddr/playwright` (`page`, `context`, `newContext`, `expect`) and `@bddr/axios` (`api`).
  `features/mixed/ui-and-api.feature` (8 scenarios, group `mixed`): API data -> UI (post title becomes a TodoMVC item),
  API vs browser status-code pages, basic auth in both (API `auth`, browser `httpCredentials` via `newContext`), browser
  login cookies handed to an API call. All pass on real Chromium; full showcase 139 scenarios / 569 steps.

### 2026-11-15: documentation site theme (`website/`)

- Static HTML, no build: `index.html` (landing; hero is a worker-lane schedule of the showcase run, HTML/CSS),
  `docs/getting-started.html` (requirements for macOS/Windows/Linux, install from the clone, first project, plugins,
  Windows notes, troubleshooting), `docs/components.html` (every component with markup), `docs/_template.html`.
- `assets/css/theme.css` (tokens, light/dark, layout, components), `assets/js/site.js` (theme toggle, sidebar from
  `assets/js/nav.js`, TOC, anchors, syntax colours, copy, tabs synced by group), IBM Plex fonts self-hosted (OFL).
- Image placeholders: `figure.placeholder` `data-kind="ai"` (prompt to generate) or `"screenshot"` (what to capture).
- Verified: pages render without script errors in headless Chromium (light, dark, mobile); the getting-started project
  and its axios example were built from the page's own code blocks and pass. Screenshots in `website/.preview/` (gitignored).
- Facts used: Playwright needs Node 20/22/24, macOS 14+, Windows 11+/Server 2019+/WSL (playwright.dev); installed
  selenium-webdriver declares Node ^22.23.4 || ^24.22.1 || >=26.12.1. Windows not yet verified by bddr's own runs (stated on the page).
- Next: write the planned pages listed in nav.js (ready: false), generate images from the prompts.

### 2026-11-15: documentation site, all planned pages written (`website/`)

- 36 pages written in `website/src/*.page` and generated to `website/docs/*.html` by `website/tools/build-pages.mjs`
  (it also flips `ready: true` in `assets/js/nav.js`). Sidebar now has no planned-only pages left.
  - Introduction: why-bddr, first-project, from-cucumber (plus the hand-written getting-started).
  - Writing tests: feature-files, steps, parameter-types, data-tables, data-files, hooks, fixtures, class-steps.
  - Running: cli, configuration, profiles, tags, debugging.
  - Orchestration: groups, dependencies, serial-features, locks, retries, process-pool, sharding.
  - Reports: reporters, html-report, living-docs.
  - Plugins: plugins, playwright, selenium, axios, mixed, writing-plugins.
  - Reference: reference-cli, reference-config, reference-api, reference-events.
- Sources of truth used: `--help` output, `docs/STATUS.md`, `docs/IMPLEMENTATION.md`, `docs/FIXTURES.md`, `docs/SERIAL-FEATURES.md`,
  the plugin READMEs and `packages/*/src` types. The first-project page was run in `~/code/tut-first` (7 scenarios, plan output pasted).
- Checks run: internal links and anchors (only the markup sample in components.html points at a missing image), every page loads
  in Chromium with no console errors and no horizontal overflow at 1280 and 390 px.
- Image placeholders (AI prompt or "capture yourself") are still to be filled by the owner. List them with
  `grep -rho 'Save as <code>assets/img/[^<]*' website/docs | sort -u`.
- Not verified: Windows runs of bddr itself; the GitHub Actions example in sharding.html was not run; Chrome/Edge/Safari/Grid for
  Selenium; examples in pages that call public sites were not re-run (they come from the showcases, which passed earlier).
- Page claims that came from docs and not from a run: group `mode: 'exclusive'` semantics, `--inspect` attach steps, `bddr docs`
  defaults, `messages` reporter limits. Re-check these if behaviour changes.
- Next: owner fills images; optionally write `bddr migrate` codemod (the from-cucumber page says none exists); mark "Not on npm yet"
  wording in getting-started, plugins and sharding when packages are published.


### 2026-11-22: feature images and Architecture page
- `website/tools/feature-images.mjs` + `render-images.mjs` make 10 feature explainer images (`website/assets/img/features/`, one per unique feature: bddr vs Cucumber.js alone). Left-card Cucumber.js claims still need checking against the target version.
- New Introduction page **Architecture** (`website/src/architecture.page`, last item in the Introduction nav): big-picture image (`assets/img/architecture.svg`), packages, life of a run, worker processes (`assets/img/process-pool.svg`), plugins and fixture scopes, why it is built this way.
- Three inline SVG diagrams (packages, run pipeline, fixture scopes) are generated by `website/tools/arch-diagrams.mjs` into `website/src/diagrams/*.html` and inlined with `<include src="diagrams/x.html"/>` (new in `build-pages.mjs`). They use the theme CSS variables (`.diagram`, `.d-*` classes at the end of `theme.css`), so dark mode works. Regenerate: `node tools/arch-diagrams.mjs && node tools/build-pages.mjs architecture`.
- The landing page "How the pieces fit" placeholder and the process-pool page placeholder now use the two SVGs. Fixed the arrow that struck through "(.feature)" in `architecture.svg`.
- Not yet done: feature images are not placed on the landing page or a "Why bddr" gallery; nothing from this entry is committed.
- LinkedIn post image: `website/social/linkedin-intro.html` renders to `linkedin-intro.png` (1080x1350, 2x) with `node tools/render-social.mjs` (needs Playwright in the running project). Shows the intro line, the architecture overview and six headline features. Uncommitted.

### 2026-11-22: renamed bddx to bddr
- Global rename (see the new ADR in DECISIONS.md): 287 text files, 17 files/dirs renamed (`bddx.config.ts` to `bddr.config.ts`, `why-bddx` page), `node_modules/@bddx` scope and `.bin/bddx` re-linked to `@bddr`, `dist/` rebuilt (core, runtime, reporters, cli and the three plugins).
- Verified: `npm run typecheck` clean; `vitest run` 235/236 (the one failure, `watch.test.ts`, only fails on its temp-dir cleanup because this sandbox forbids deleting files; run it on the Mac); `example`, `example:orchestration`, `example:orchestration:process`, `example:resilience` all pass. The live `playwright-showcase` and `selenium-showcase` were NOT run.
- Regenerated: 10 feature images, the LinkedIn image, the architecture diagrams, and all 37 docs pages.
- On the Mac after pulling: `rm -rf node_modules */node_modules examples/*/node_modules plugins/*/node_modules && npm install`, then `npm run build` and `npm run build` in each plugin. Env vars are now `BDDR_*`, history folder `.bddr/` (old `.bddx/` can be deleted).
- Still shows the old name (pixels, cannot be regenerated here): `website/assets/img/first-run-terminal.png`, `groups-plan.png`, `debug-prompt.png`, `first-project-report.png` (and its duplicate `data-driven-report.png`). Retake them with `npx bddr ...`.
- GitHub repo is now https://github.com/afsarali273/bddr (public, created by the owner). `origin` was updated to `git@github.com:afsarali273/bddr.git`; GitHub links and clone/install paths in the website and docs now say `bddr` (`../bddr/plugins/...`). Not pushed yet: the repo's README on GitHub still says bddx until the next push.
- Not renamed: the local folder `BDD_Framework`.
- Not checked: npm scope `@bddr`, domains, trademarks.

### 2026-11-23: release preparation for v0.1
- MIT `LICENSE`; npm metadata (license, repository, homepage, keywords, publishConfig) on all seven packages; short READMEs for core, runtime, reporters and cli.
- A bare package `packages/bddr` (`npm i -D bddr`) was built and tested, but npm rejected the name as too similar to existing packages (bser, budo, add, fdir), so it is marked private and not published. Users install `@bddr/cli`; `npx bddr` works after install. A name appeal to npm support is possible later.
- `.github/workflows/ci.yml` (verify on Node 20 and 22) and `release.yml` (publish on a `v*` tag, dependency order, provenance; uses npm Trusted Publishing, so no token: create the `@bddr` npm org, publish 0.1.0 of each package by hand once, then add the trusted publisher (repo `afsarali273/bddr`, workflow `release.yml`) on each package).
- `bddr migrate [dir] [--write]`: rewrites `@bddx/*`, `BDDX_*`, `bddx.config`, `.bddx` and renames the config file and history folder (`cli/src/migrate.ts`, 2 tests).
- Fixes: `AfterWorker` no longer runs after a failed `BeforeWorker` or `BeforeAll` (inline and process pools, tests added); `--shard` warns that `@exclusive` only holds inside one shard; `bddr docs` falls back to `reports/events.ndjson` when there is no `--results` and no history.
- Verified: typecheck clean, 240 of 240 tests, offline examples pass.
- Still to do for the release: create the `@bddr` npm org, retake the screenshots that show bddx, run the live showcases, then tag `v0.1.0` and remove the "Not on npm yet" notes.
