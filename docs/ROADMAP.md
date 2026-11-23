# Roadmap and task checklist

Tick items as they land (`[x]`). Each phase ends with its gate. For a one-page summary of what is done and what remains,
see [STATUS.md](STATUS.md). The design rationale lives in the
"Next-Gen BDD Framework — Research & Build Plan" doc; syntax proposals for later phases are copied here so this
file is self-contained.

## Phase 0: Foundations ✅

- [x] npm workspaces monorepo: core, runtime, reporters, cli
- [x] Internal model (`ScenarioInstance` etc.)
- [x] Gherkin parsing via `@cucumber/gherkin`, mapped to the model with lines, rules, examples, background flags
- [x] Stable scenario ids
- [x] Key/value tags + tag expressions + selection (tags, name, file:line, ids)
- [x] Event schema v1 + EventBus
- [x] Conformance suite skeleton (5 features)
- [x] Gate: parse every Cucumber Compatibility Kit feature (`core/test/cck.test.ts` reads the official `@cucumber/compatibility-kit` dev dependency: 49 features, zero parse errors, pickle counts equal the kit's reference streams)

## Phase 1: Core runner (TypeScript)

- [x] Cucumber Expressions + regex steps, custom parameter types
- [x] Scoped steps (`{ tags }`), ambiguity detection
- [x] Hooks: run, feature, rule, scenario, step (order, tags, alwaysRun, timeouts)
- [x] Scoped stores (run/feature/scenario) + `defer()` cleanup
- [x] Pending / skip / timeout handling
- [x] Console (pretty, progress), NDJSON, JUnit reporters
- [x] CLI: run, list, --dry-run with snippets, -t, --name, file:line, -p, -D, -f, --fail-fast, --no-strict
- [x] Config file (ts/js/json) with profiles
- [x] Example project
- [x] Class-based steps with decorators (`@Steps()` + `@Given`…) + DI container (`static inject`, per-scenario instances, `dispose()`)
- [x] Cucumber JSON reporter (`cucumber-json` / `json`)
- [x] `bddr snippets` command
- [x] `bddr validate`: parse/plan/config errors, undefined/ambiguous steps, duplicate ids, unused steps, unmatched hooks, optional tag governance
- [x] Gate: a real project runs end to end (`examples/playwright-showcase`: 125 Playwright UI/API scenarios across 13
      feature files, mixing serial and parallel groups in one command)

## Phase 2: Data-driven specs (data core done)

- [x] `DataLoader` / `DataProvider` interfaces in core (`createFileDataLoader`, extra providers by extension)
- [x] `@data:<file>[#selector][?col=val&rows=1-3,7]` on Scenario/Outline (adds Examples) or Examples (fills body)
- [x] Loaders: CSV, TSV (built-in RFC 4180 parser), JSON (dotted selector), YAML, XLSX (exceljs, sheet selector)
- [x] `@dataField:<placeholder>=<column>` mapping (feature/rule/scenario/examples)
- [x] `dataDir` config + per-profile override (`<dataDir>/<profile>/<file>`)
- [x] Stable ids for data rows: `<base>[<source>#<row>]`, base from the TEMPLATE name
- [x] Data errors = parse errors on the tag line (missing file/column, bad filter, no rows); scenario dropped, exit 2
- [ ] Data providers for SQL queries and HTTP endpoints (plugin API, phase 6)
- [ ] Text-defined composite steps (`.steps.md` or `.concept` files)
- [ ] ~~Call a scenario from a step~~ parked by the owner (dependencies + exports + step repeat cover current needs)
- [x] Gate: same feature runs from inline Examples, CSV and XLSX with identical results (`core/test/data-parity.test.ts`, including commas, quotes, unicode, decimals and empty cells)

## Cross-cutting: own architecture, swappable third-party parts

- [x] Ports (`core/src/ports.ts`, `runtime/src/ports.ts`): `SpecParser`, `TagExpressionEngine`, `StepExpressionEngine`
- [x] Cucumber libraries isolated in `adapters/` (only files allowed to import them); spec parser registry by suffix
- [x] TestNG-style hook names (`BeforeSuite`/`AfterSuite`) and hook decorators on static methods at every level

## Phase 3: Orchestration (the differentiator) ✅ (core)

- [x] `defaultMode` / `groups.default` for ungrouped scenarios (implicit group: scheduling only)
- [x] `--set path=value` overrides for any config option
- [x] Levelled logging (`ctx.log.*`, global `log` via AsyncLocalStorage, `--log-level`, framework diagnostics)
- [x] Logs with images (`ctx.log.image`, bytes as data); logs in HTML / JUnit / Cucumber JSON reports
- [x] Step-level `@repeat` / `@retry` / `@delay` / `@backoff` / `@timeout` / `@concurrency` (owner's request; pulled
      forward from Phase 4), `{{i}}`/`{{n}}`, `eachAttempt` step hooks, definition `retry` + `concurrent:false`

Proposed config:

```ts
groups: {
  setup:    { mode: 'serial', priority: 0 },
  checkout: { mode: 'parallel', workers: 4, dependsOn: ['setup'] },
  payments: { mode: 'serial', dependsOn: ['setup'], locks: ['payments-db'] },
  reports:  { mode: 'serial', dependsOn: ['checkout', 'payments'], onDependencyFailure: 'run' },
}
```

Tags: `@group:<name>`, `@id:<id>`, `@dependsOn:<id|group:name>[:soft]`, `@lock:<name>`, `@priority:<n>`, `@requires:<file.feature>`, `@exclusive`.

- [x] Planner (`core/src/plan`): DAG of instances + groups; validates cycles, unknown ids/groups, bad priority/workers
- [x] `bddr plan` (`--plan-format text|json|mermaid`)
- [x] `bddr plan --explain <id>`
- [x] Dependencies of selected scenarios are pulled in by default (`--no-deps` to disable); deps resolved across all spec files
- [x] Scheduler (`runtime/src/scheduler.ts`): ready queue by priority, workers, group modes/caps, locks, exclusive (in-process async)
- [x] Worker processes (`pool: 'process'`, child_process fork), IPC of events, BeforeWorker/AfterWorker, run-store seed, crash recovery
- [x] Group hooks (BeforeGroup/AfterGroup) + group store (`ctx.groups[name]`); feature/rule/group scopes ref-counted
- [x] Hard vs soft dependencies; skip reason `dependency failed: <id> (<status>)`; group `onDependencyFailure`
- [x] Exports between scenarios (`ctx.export`, `ctx.from(id).get`), structured-clone copies (ready for processes)
- [x] Events: `groupStarted/Finished`, planReady `workers`/`groups`, PlannedScenario `groups/dependsOn/locks/priority/exclusive/pulledInBy`
- [x] Event `workerStarted` (process pool: pid, start-up time)
- [x] Event field `waitedForMs` on the first `scenarioStarted` (time a ready scenario waited for a worker, lock, group cap or `@exclusive`; inline and process pool)
- [x] Conformance: `dependencies.feature` (hard/soft/priority); timing rules covered by runtime tests
- [x] `@requires:<file.feature>[:soft]` spec-level preconditions (path relative to the file, to the root, or a unique path ending; ambiguous, missing and self references are plan errors; cycles are caught)
- [ ] HTML/console view of the executed graph (timeline per worker) — Phase 5
- [x] Gate: groups, dependencies and locks demo passes (`examples/orchestration`, `npm run example:orchestration`)

## Phase 4: Resilience ✅ (core)

- [x] Step retry (done early: `@retry:N` on steps, `@stepRetry` per scenario, definition `retry`)
- [x] Scenario retry (`@retry:N`, `@noRetry`, config `retry.scenario`, `--retry`), group retry (`groups.x.retry`, `retryMembers`, `scenarioRetry`), run (`--rerun-failed`)
- [x] Policies: attempts, delay/backoff, `retry.on` (error name / message / regex), worker-crash retry, `setRetryAnalyzer` (TestNG-style)
- [x] ~~`attempt` hook level~~ not needed: scenario hooks run per attempt; step hooks have `eachAttempt`
- [x] Flaky status (pass after fail, incl. merged reruns), `--fail-on-flaky`, `@quarantine`
- [x] Rerun-failed from an NDJSON file + `bddr report` merge
- [x] Soft assertions (`ctx.soft.check/run`)
- [x] Scenario time budget (`@timeout` on scenarios, `scenarioTimeout`)
- [x] Group/run time budgets; cancellation via `AbortSignal`; graceful Ctrl+C (exit 130)

## Phase 5: Reporting + DX

- [x] HTML report v1 (single file): summary, groups, filters, steps, logs with images, attachments, errors (`html` reporter)
- [x] HTML report v2: timeline per worker lane (attempts, retried attempts, worker start-up, busy %, group spans),
      dependency graph (scenarios + groups, soft dashed), history view; all inline SVG, one offline file
- [x] Living documentation view: `bddr docs` (folder tree = requirements; README.md per folder)
- [x] History store (`history` config, `.bddr/history`, keep N) + flakiness score + `bddr history`
- [x] Cucumber Messages adapter (ADR-007): `-f messages[:file]`
- [x] Interactive debug mode: `--debug` (pause on failure), `--debug-step`, `--inspect`
- [ ] VS Code extension + language server (step completion, go to definition)
- [x] Watch mode: `--watch`
- [x] CI sharding by duration: `--shard i/n`

## Parked: code-linked Markdown specs (owner's idea, later phase)

Free-form Markdown documents whose references (symbol links, file:line links, inline calls) bind directly to step code
in TS/Java; the annotated document is the report. Design note: [design/code-linked-markdown.md](design/code-linked-markdown.md).

- [ ] Settle binding syntax and file selection (open questions in the design note)
- [ ] Registry: index step definitions by symbol (class.method / function) in addition to pattern
- [ ] `SpecParser` for Markdown with bindings
- [x] `bddr validate` (general project validation; delivered outside this parked design)
- [ ] `bddr bind --fix` (rewrite line links to symbols)
- [ ] Markdown report renderer with inline statuses

## Phase 6: Ecosystem

- [ ] Plugin API (data loaders, reporters, parameter types, retry analyzers, plan modifiers)
- [x] Reusable Playwright integration package: `plugins/playwright` (browser per worker, page per scenario, failure screenshots and traces)
- [x] Selenium plugin (`plugins/selenium`) and axios plugin (`plugins/axios`)
- [x] Documentation site (`website/`), published to GitHub Pages by a workflow
- [ ] Publish to npm under `@bddr`; `bddr migrate` codemod from bddx; remove the "Not on npm yet" notes
- [ ] HTTP step library (Karate-style JSON matching)
- [ ] Allure reporter
- [x] Step catalogue export: `bddr steps [--json]` (schema v1, ADR-028)
- [ ] MCP server for AI assistants (reads the same catalogue)
- [ ] TypeScript v1.0 release

## Phase 7: Java port

- [ ] JUnit Platform `TestEngine`, annotations (`@Given`, `@Before`…), Maven + Gradle plugins
- [ ] Same config schema (JSON/YAML), same event schema, same reports
- [ ] Passes `conformance/` unchanged

## Phase 8: Python port

- [ ] Decide the runner shape (own CLI, or a pytest plugin)
- [ ] Same config schema, same event schema, same reports
- [ ] Passes `conformance/` unchanged
