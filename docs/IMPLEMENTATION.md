# Implementation guide

How bddr works today, module by module. Keep this in sync with the code; it is the first thing a new
contributor (human or AI) reads after PROGRESS.md.

Last updated: 2026-11-15 (Phases 0–1 done, Phase 2 data core done, Phase 3 planner + in-process scheduler done).

## 1. Big picture

```
 specs ──► SpecParser ──► ScenarioInstance[] ──► selectScenarios ──► buildPlan (groups, deps, locks)
                                                                          │
 steps/*.ts ──(import)──► global API ──► SupportRegistry                  ▼
                                               └────────► Executor ◄── schedule(plan) ──► EventBus ──► reporters
```

- **Everything becomes `ScenarioInstance`s first.** One instance = one executable test (an outline row is
  its own instance). Later phases will expand `@data:` tags the same way.
- **Everything observable is an event.** Reporters never look at runtime internals.
- **The CLI is a thin shell** around `runBddr()` (packages/cli/src/run.ts), which is also the programmatic API.

The **Planner** (`core/src/plan`) turns the selection into a validated graph; the **Scheduler**
(`runtime/src/scheduler.ts`) decides what runs when; the **Executor** runs nodes and owns scopes/hooks/events.
Worker processes (`pool: 'process'`) drive the same Executor in "worker mode" (§2f), so keep scenario execution free of
global state.

## 2. Own core, swappable third-party parts (ports & adapters)

bddr's runner, hooks, context, DI, data, ids, events, reports and CLI are its own code. Third-party libraries are used
only for three narrow jobs, each behind an interface bddr owns:

| Port (interface) | Defined in | Default adapter | Library |
| --- | --- | --- | --- |
| `SpecParser` (file → `ScenarioInstance[]`) | `core/src/ports.ts` | `core/src/adapters/cucumber-gherkin.ts` | `@cucumber/gherkin`, `@cucumber/messages` |
| `TagExpressionEngine` | `core/src/ports.ts` | `core/src/adapters/cucumber-tag-expressions.ts` | `@cucumber/tag-expressions` |
| `StepExpressionEngine` (pattern → matcher, parameter types, snippets) | `runtime/src/ports.ts` | `runtime/src/adapters/cucumber-expressions.ts` | `@cucumber/cucumber-expressions` |

Rule: only files under `adapters/` may import these libraries (`grep -rn "@cucumber/" packages/*/src | grep -v adapters/`
must print nothing). New spec formats register with `registerSpecParser()` and are chosen by the longest matching file
suffix (`specParserFor`); the CLI's folder globs come from `specFileGlobSuffix()`. Swap tag engine with
`setTagExpressionEngine()`, step engine with `new SupportRegistry({ engine })`.

## 2b. Packages

### 2.1 `@bddr/core` (no internal deps)

| File | Responsibility |
| --- | --- |
| `model.ts` | The internal model: `ScenarioInstance`, `StepInstance`, `Tag`, `FeatureInfo`, `RuleRef`, `ExampleRef`, `Status`, `worstStatus()`, `toErrorInfo()` |
| `ports.ts`, `spec-parsers.ts` | Interfaces + spec parser registry (`parseSpecFile`) |
| `adapters/cucumber-gherkin.ts` | `parseSpec(source, uri, {language, format})` (sync) and `parseSpecAsync(…, {dataLoader})` (with `@data` expansion), using `@cucumber/gherkin`. Never throw on syntax/data errors; return `errors[]` with lines |
| `data/loader.ts` | `@data` support: `parseDataRef`, `createFileDataLoader` (path resolution, providers by extension, `applyQuery` filters), built-in CSV/TSV/JSON/YAML/XLSX providers |
| `data/csv.ts` | RFC 4180 CSV parser |
| `tags.ts` | `parseTag()` (key/value split), `tagsToMeta()`, `compileTagExpression()` (wraps `@cucumber/tag-expressions`) |
| `selection.ts` | `selectScenarios(all, {tags, name, lines, ids})`, `parsePathWithLines('a.feature:12')` |
| `events.ts` | Event schema v1 (`BddrEvent` union), `EventBus`, `emptySummary()`, `LogLevel` |
| `events-merge.ts` | `parseNdjson`, `finalResults`, `idsToRerun` (--rerun-failed), `mergeEventStreams` (`bddr report`) |
| `step-tags.ts` | Step-line trailing tags (`@repeat` … `@concurrency`), scenario step defaults, `parseDuration` |
| `plan/` | Planner (`buildPlan`: groups, deps, locks, priority, retry, quarantine, validation), plan types, text/JSON/Mermaid rendering |
| `ids.ts` | `slugify()`, `createIdGenerator()` |

**Parsing pipeline** (`adapters/cucumber-gherkin.ts`):
1. `Parser` + `AstBuilder` + token matcher (classic, or Markdown-with-Gherkin for `.md`) → `GherkinDocument`.
2. `buildIndex()` walks the AST and records, per AST node id: step line/keyword/fromBackground, scenario + its
   rule, example rows (1-based index across all Examples blocks, row values), tag lines.
3. `compile()` (Cucumber's pickle compiler) expands backgrounds, outlines and tag inheritance → `Pickle[]`.
4. `pickleToInstance()` maps each pickle back through the index → `ScenarioInstance`.
5. `assignStableIds()`.

**Stable scenario ids** (used for dependencies, reruns, reports):
- `@id:<value>` tag wins → `<value>`; outline rows → `<value>[<row>]`; data rows → `<value>[<source>#<dataRow>]`.
- Otherwise `<uri>::<slug(template name)>` (+ the same suffixes). The TEMPLATE name is the name before
  `<placeholder>` substitution, so changing data values never changes ids. `<dataRow>` is the row's number in the
  source file (header excluded) BEFORE filtering, so filters never renumber.
- Collisions within a file get `@<line>` appended.
- URIs are POSIX paths relative to the config folder (rootDir).

**Tags**: `@key:value` and `@key=value` split at the first `:` or `=`. `meta` maps key → value (`'true'` for
bare tags). Effective tags = feature + rule + scenario + examples, de-duplicated by name.

**External data (`@data`)** — `parseSpecAsync` step 1b, between parsing and `compile()`:
1. Find `@data:` tags on Scenarios (feature- and rule-level children) and on Examples blocks.
2. Load each via the `DataLoader` (`createFileDataLoader`): resolve `<dataDir>/<profile>/<file>` → `<dataDir>/<file>`
   → next to the spec; pick a provider by extension; apply `?col=value` and `?rows=1-3,7` filters.
3. Inject into the AST: a Scenario tag appends a synthetic Examples block (header = all columns, renamed by
   `@dataField:<placeholder>=<column>`); an Examples tag replaces that block's body and keeps its header (the header
   decides which columns are used). Injected rows are remembered (`RowSources`) so `ExampleRef.source/sourceRow` and
   ids can name them.
4. Cucumber's `compile()` then expands them exactly like normal outline rows (it expands any scenario with Examples).
5. Any data problem → a `ParseErrorInfo` on the tag line and the scenario is removed from the document.
   The CLI exits 2 when there are parse errors (other scenarios still run).

### 2.2 `@bddr/runtime` (depends on core)

| File | Responsibility |
| --- | --- |
| `ports.ts`, `adapters/cucumber-expressions.ts` | `StepExpressionEngine` interface + Cucumber Expressions adapter |
| `registry.ts` | `SupportRegistry`: steps, hooks, parameter types (delegated to the engine), matching, snippets. `getGlobalRegistry()` (stored on `globalThis[Symbol.for('bddr.registry.v1')]`), `resetGlobalRegistry()`, `callerLocation()` |
| `api.ts` | Global user API: `Given/When/Then/Step`, `BeforeAll/AfterAll` (= `BeforeSuite/AfterSuite`), `BeforeWorker/AfterWorker`, `BeforeGroup/AfterGroup`, `BeforeFeature/AfterFeature`, `BeforeRule/AfterRule`, `Before/After` (= `BeforeScenario/AfterScenario`), `BeforeStep/AfterStep`, `defineParameterType`, `setDefaultTimeout`, `setRetryAnalyzer` |
| `executor.ts` | `Executor` / `execute()`: plan execution (lazy ref-counted scopes), hooks, contexts, step repeat/retry, scenario/group retry, soft asserts, events, summary; coordinator mode and worker mode for the process pool |
| `scheduler.ts` | `schedule(plan, callbacks)`: ready queue by priority, lanes (`workers`), group modes/caps, locks, exclusive, dependency waits, group-retry settling |
| `pool.ts` | Process pool: IPC protocol, `ProcessPool` (parent), `serveWorker` (child), `planFingerprint`, worker errors |
| `logger.ts` | Levelled logger, global `log` attributed through AsyncLocalStorage, `ctx.log.image` |
| `context.ts` | `Store` (typed key/value) and `Scope` (store + LIFO `defer()` cleanups) |
| `decorators.ts` | Class-based steps: `@Steps()` class decorator, pending-method collection, per-scenario DI container (`resolve`, `CONTEXT` token, `static inject`, `dispose()`) |
| `datatable.ts` | `DataTable` (`raw/rows/hashes/rowsHash/asObjects/transpose`), `DocString` |
| `signals.ts` | `PendingSignal`, `SkipSignal`, `TimeoutError`, `CancellationError`, abort-aware `withTimeout()` / `abortableSleep()` |
| `types.ts` | `StepContext`, `FeatureContext`, `RunContext`, `ScenarioInfo`, hook/step option types |

**Step matching** (`SupportRegistry.match`):
- String patterns are Cucumber Expressions, RegExps are regular expressions.
- Expressions compile lazily (`finalize()`), so `defineParameterType` can come after the steps that use it.
- A definition with `tags` (scope) only matches scenarios whose tags satisfy it. If any scoped definition
  matches, unscoped ones are ignored ("more specific wins"). More than one winner → `ambiguous`.
- Keyword (Given/When/Then) does not affect matching, like Cucumber.

**Step function signature**: `(ctx: StepContext, ...expressionArgs, dataTable | docString?)`.
The context is always first (no `this`), so arrow functions work and the shape ports to Java.

**StepContext**:
- `ctx.state`: scenario store (fresh per scenario and per attempt)
- `ctx.feature`: feature store; `ctx.run`: run store
- `ctx.params`: config `params` + CLI `-D`
- `ctx.signal`: aborts for external cancellation, Ctrl+C, run timeout, or the scenario's group time budget
- `ctx.scenario`: id, name, tags, meta, example values, attempt
- `ctx.step`: current step (inside steps and step hooks)
- `ctx.log()`, `ctx.attach(body, mediaType, name)`: emit `log` / `attachment` events tagged with scenario/step
- `ctx.defer(fn)`: cleanup in the current scope (scenario for steps; feature for feature hooks; run for run hooks)
- `ctx.pending(reason)`, `ctx.skip(reason)`

**Class-based steps** (`decorators.ts`): `Given/When/Then/Before/After/BeforeStep/AfterStep` called WITHOUT a
function return a TC39 method decorator. Method decorators run before the class decorator, so they push onto a
module-level pending list that `@Steps()` drains and registers (`@Steps()` is required). Registered functions call
`resolve(ctx, Class)`, which creates one instance per class per scenario (stored in `ctx.state`), resolving
`static inject = [Dep, CONTEXT]` recursively with cycle detection. Instances with `dispose()` are disposed LIFO when
the scenario scope closes. Run/feature/rule hooks cannot decorate methods (no per-scenario instance exists).
**Trap:** never export a value named `then` from a package: its module namespace becomes thenable and
`await import()` hangs (this happened with an early lowercase `then` decorator).

**Hook levels implemented**: run (= suite: `BeforeAll`/`BeforeSuite`), worker, group, feature, rule, scenario, step.
Hooks can be functions, instance methods of `@Steps()` classes (scenario/step levels), or **static methods at any level**
(`@BeforeSuite() static start(ctx)`), registered on class definition without `@Steps()`. There is deliberately no
attempt hook: scenario hooks already run per scenario attempt; step hooks use `eachAttempt`.
- Tag filters: feature hooks → feature tags; rule hooks → rule tags; scenario/step hooks → scenario tags.
- Order: before-hooks by `order` asc then registration; after-hooks exactly reversed.
- `alwaysRun` (before-hooks): run even if an earlier before-hook at the same level failed.

**Failure semantics** (also in the header of executor.ts; change both together):

| Event | Effect |
| --- | --- |
| BeforeAll fails | every scenario skipped with reason; AfterAll still runs; run fails |
| BeforeGroup fails | that group's scenarios skipped with reason; AfterGroup still runs; run fails |
| hard dependency did not pass | scenario skipped `dependency failed: <id> (<status>)` (cascades); soft deps run anyway |
| BeforeFeature fails | that feature's scenarios skipped with reason; AfterFeature still runs; run fails |
| BeforeRule fails | the rule's scenarios skipped with reason; AfterRule still runs; run fails |
| Before (scenario) fails | later before-hooks skipped unless `alwaysRun`; steps skipped; After hooks run; scenario failed |
| Step fails | remaining steps skipped; After hooks run; scenario failed |
| BeforeStep fails | step failed, body not run; AfterStep still runs |
| After / AfterStep fails | scenario / step becomes failed |
| `defer()` cleanup throws | owning scenario or feature becomes failed (reported as a cleanup hook) |
| `ctx.pending()` | step pending, rest skipped, scenario pending |
| `ctx.skip(reason)` | step skipped, rest skipped, scenario skipped with reason |
| undefined / ambiguous step | that status; rest skipped |
| step/hook timeout (default 30 s) | failed with `TimeoutError` |
| cancellation / run or group timeout | in-flight cancellable work fails; queued work is skipped; After hooks and cleanups still run |

Scenario status = worst of its step and hook statuses (`failed > ambiguous > undefined > pending > skipped > passed`).
Run success (strict, default): no scenario failed/pending/undefined/ambiguous and no run/feature/rule hook failed.
`strict: false` lets pending/undefined/ambiguous pass.

**Dry run**: no hooks run, no step bodies run; matched steps are `skipped`, unmatched are `undefined` with snippets.

### 2.3 `@bddr/reporters` (depends on core)

| Reporter | Notes |
| --- | --- |
| `console` (`pretty`, `progress`) | Scenario lines, failing steps, failure list with first user stack frame, undefined-step snippets, summary. Options: `style`, `verbose`, `colors`, `write` |
| `ndjson` | Every event as one JSON line. Option `outputFile` (default `reports/bddr.ndjson`) |
| `html` | Single self-contained page: summary, groups, filters (status, log level, framework logs, search), scenarios with steps, errors, snippets, skip reasons, logs + images, attachments, run-level logs and hook failures. Options `outputFile` (default `reports/report.html`), `title`, `logLevel` |
| `cucumber-json` (alias `json`) | Legacy Cucumber JSON (features → elements → steps, ns durations, embeddings) for existing dashboards. Option `outputFile` (default `reports/cucumber.json`) |
| `junit` | One testsuite per feature. failed/undefined/ambiguous → `<failure>`, skipped/pending → `<skipped>`, retried attempts before a pass → `<flakyFailure>`, quarantined failures → `<skipped>`, logs in `<system-out>`/`<system-err>`. Option `outputFile`, `suiteName` |

`createReporter(spec)` accepts `'name'`, `'name:outputFile'`, `['name', options]` or a `Reporter` object.

### 2.4 `@bddr/cli` (depends on all)

| File | Responsibility |
| --- | --- |
| `config.ts` | `BddrConfig`, `defineConfig`, `loadConfig()` (ts/mts/js/mjs/json), profiles, `mergeOptions()` (tags ANDed, params/groups/retry merged), `--set` (`applySetOverrides`, `OPTION_KEYS`) |
| `run.ts` | `prepareRun()` (config → specs → selection → plan, incl. `--rerun-failed`), `runBddr()` pipeline (support code, reporters, Executor, process pool), `prepareWorker()`, `reportFromEvents()` (`bddr report`); `registerTypeScriptLoader()` (tsx `register()`) |
| `validate.ts` | Static checks: parse/config/plan errors, duplicate ids, undefined/ambiguous steps without running transformers, unused definitions, unmatched hooks, optional tag governance |
| `main.ts` | Argument parsing (`node:util` `parseArgs`), `run`, `list`, `snippets`, `validate`, `plan`, `report` commands, help, exit codes |
| `worker.ts` | Worker process entry for `pool: 'process'` (`serveWorker(prepareWorker)`) |
| `bin.ts` | `#!/usr/bin/env node` entry |

**`runBddr()` pipeline**: register tsx → load config (+profile) → merge CLI overrides → discover specs
(paths/globs/`file:line`) → parse → select → import support files (they register on the global registry) →
create reporters (output paths resolved against the config folder; specs parsed with `parseSpecAsync` and a
file data loader built from `dataDir` + `--profile`) → build the plan → `Executor.execute()` (with a `ProcessPool`
when `pool: 'process'`) → flush bus →
close reporters → exit code.

Path rules: config globs are relative to the config file's folder (rootDir). CLI positional paths are relative to
the shell's cwd and converted to rootDir-relative URIs.

## 2c. Orchestration (Phase 3)

**Vocabulary.** Tags: `@group:<name>`, `@id:<id>`, `@dependsOn:<id>[:soft]`, `@dependsOn:group:<name>[:soft]`,
`@lock:<name>`, `@priority:<n>` (lower first), `@exclusive`. Config `groups.<name>`: `mode` (parallel | serial |
exclusive), `workers`, `dependsOn`, `onDependencyFailure` ('skip' | 'run'), `priority`, `locks`, `match` (tag
expression). Config/CLI `workers` (default 1). Full reference: `core/src/plan/types.ts` header.

**Planner** (`buildPlan(all, selected, options)`, pure):
1. Facts per scenario from tags (+ `match` groups). Dependency targets: exact id, or an id "family" (`rows` matches
   `rows[1]`, `rows[2]`, data rows `x[file#n]`).
2. Closure: hard deps of selected scenarios (and members of groups their groups depend on, unless soft) are pulled in,
   with `pulledInBy`. CLI parses ALL configured specs so targets in other files resolve.
3. Nodes in base order (features together, file order). Priority: `@priority` > min(group priority) > 0. Locks: own +
   group locks. Exclusive: `@exclusive` or group mode exclusive.
4. Deps resolved to node ids (hard wins over soft for duplicates); group `dependsOn` adds deps on every member.
5. Validation errors (never throws): unknown target/group, bad priority, bad workers, cycles (`a -> c -> b -> a`).
   The CLI exits 2 on plan errors; `Executor` throws for an invalid plan passed programmatically.

**Scheduler** (`schedule(plan, callbacks)`): loop { skip ready nodes whose HARD dep did not pass (cascades) or when a
stop reason exists (fail-fast, BeforeAll failure) → start ready nodes by (priority, order) while a slot is free and
locks/group caps/exclusivity allow → await any running }. Slots are named `w1..wN` (= `workerId` in events). Dry run
ignores dependency results. Safety net: if nothing runs and nothing can start, the rest is skipped (never hangs).

**Scopes under any order/concurrency**: feature, rule and group scopes OPEN lazily when their first scenario starts
(Before* hooks, memoised promise so concurrent members wait for the same hooks) and CLOSE when their last member
finishes or is skipped (reference counts). Close order when several end together: rule → feature → groups (group is
the outer scope). A scope never opened (all members skipped before starting) runs no hooks and emits no events.

**Exports**: `ctx.export(key, value)` stores a structured clone per scenario; `ctx.from(id).get(key)` returns a clone,
and throws if that scenario has not finished (hint: add `@dependsOn`) or is not in the plan.

**Ungrouped scenarios**: with `defaultMode` (config/`--set`) or a configured `groups.default`, scenarios without a group
join the group `default`. From `defaultMode` alone it is *implicit*: it constrains scheduling (e.g. serial) but has no
hooks, store or group events (`Executor.realGroups`). A configured `groups.default` is a normal group.

## 2c-bis. Step-level repeat / retry

**Syntax** (`core/src/step-tags.ts`): recognised tags at the END of a step's text are stripped before matching and
stored in `StepInstance.run`: `@repeat:N`, `@retry:N`, `@delay:<dur>`, `@backoff:<x>`, `@timeout:<dur>`,
`@concurrency:N` (durations: `500ms`, `2s`, `1m`, plain number = ms). Only these keys are taken; other trailing `@words`
(emails, `@team`) stay in the text. Scenario-level defaults: `@stepRetry:N`, `@stepDelay`, `@stepTimeout` (merged in the
parser; an explicit `@repeat` drops a scenario retry). Invalid values/combinations → parse errors on the step line.

**Precedence** for retry: step tag / scenario tag > step definition option `retry` (`3` or
`{attempts, delay, backoff}`); timeout: `@timeout` > definition `timeoutMs` > default.

**Execution** (`Executor.runStep`): match once → BeforeStep hooks (non-`eachAttempt`) once → attempt loop → AfterStep
once. Each attempt runs `eachAttempt` step hooks around the body, uses its own context view (`attemptContext`:
`ctx.step.attempt/of/mode`, logger tagging `attempt`) and emits `stepAttemptFinished`. `{{i}}`/`{{iteration}}` and
`{{n}}`/`{{total}}` are substituted per attempt in step text (re-matched when it changes), data tables and doc strings.
- `@retry`: re-run only `failed` (incl. timeouts) until pass or attempts exhausted; delay × backoff between attempts.
  Pass after retries = passed (`attempts` > 1 recorded); final failure = last error.
- `@repeat`: N runs, stop starting new ones at the first non-passed; `@concurrency` = in-flight limit (`runRepeat`).
  Step definitions with `{ concurrent: false }` (browser/Selenium-driving steps) reject `@concurrency` with an error.
- `ctx.pending()` / `ctx.skip()` / undefined / ambiguous are never retried. State is shared across attempts.
- `stepFinished` gains `mode`, `attempts`; console prints "(passed after 3 attempts)" / "(repeated 100×)" and
  "(1 step retried)" on the scenario line; HTML lists every attempt (status, text, duration, error) and tags logs `#n`;
  JUnit failure messages add the attempt info.

## 2c-ter. Resilience (Phase 4)

| Feature | How | Where |
| --- | --- | --- |
| Scenario retry | `@retry:N` / `@noRetry` on a scenario (planner → `PlanNode.retry`), group `scenarioRetry`, config `retry.scenario`, CLI `-r/--retry` | `Executor.runNode` loop + `shouldRetry` |
| Retry filters | config `retry.on` (error name exact / message substring / "/regex/"), `setRetryAnalyzer(fn)` (TestNG IRetryAnalyzer style) | `shouldRetry` |
| Group retry | `groups.x.retry: N`, `retryMembers: 'all' \| 'failed'` | scheduler `settleGroup` callback + `Executor.settleGroup` |
| Flaky | final pass after any non-passed attempt (scenario retry, group retry, or merged rerun) → `scenarioFinished.flaky`, `summary.flaky`; `--fail-on-flaky` / `retry.failOnFlaky` fails the run | `finishScenario`, `mergeEventStreams` |
| Quarantine | `@quarantine`: runs and reports, excluded from the success decision and fail-fast | planner `quarantined`, executor summary |
| Rerun failed | `--rerun-failed <events.ndjson>`: selects ids whose final status was not `passed` (`idsToRerun`), dependencies pulled in | `prepareRun` |
| Merge reports | `bddr report a.ndjson b.ndjson -f html:… -f junit:…`: later streams win per scenario, recovered = flaky, summary recomputed | `core/src/events-merge.ts`, `reportFromEvents` |
| Soft assertions | `ctx.soft.check(cond, msg)`, `ctx.soft.run(fn)`; the step fails at its end with all failures | `createSoftAssert`, `attemptOnce` |
| Scenario time budget | `@timeout:<dur>` on a scenario / config `scenarioTimeout`; each step's timeout is capped to the time left; after the deadline remaining steps are skipped | `runScenario`, `runStep` |
| Group time budget | `groups.x.timeout`; starts with the first member of each group attempt, aborts in-flight members and skips queued members | scheduler group budget controllers |
| Run cancellation/time budget | config `runTimeout`, CLI `--run-timeout`, programmatic `RunRequest.signal`, Ctrl+C → exit 130; exposed as `ctx.signal` | CLI abort controller + abort-aware executor |
| Retry backoff | config `retry.backoff` multiplies `retry.delay` after each scenario failure | `Executor.runNode` |
| Worker crash retry | config `retry.workerCrash` / `--worker-crash-retry`; a fresh process retries only `WorkerCrashedError` | `Executor.runRemote` + `ProcessPool` |

**Scenario retry semantics.** Each attempt is a full scenario run: fresh scenario store and DI instances, Background,
Before/After hooks, exports reset (dependents only ever see the final attempt's exports). Only `failed` is retried
(not pending/undefined/ambiguous/skipped). `scenarioFinished` is emitted per attempt; non-final ones carry
`willRetry: true`. The run summary is computed at the END from final attempts (`lastStepStatuses`, `statuses`), so
retried attempts are never double-counted.

**Group retry semantics.** When every member of a retry group has a result, the scheduler calls `settleGroup`. If a member
did not pass and attempts remain, the executor re-opens the group (BeforeGroup/AfterGroup run again) and the feature/
rule scopes of the re-run members, bumps their attempt numbers, emits `groupRetrying`, and the scheduler re-queues them.
Dependents of a retry group's members (outside that group) wait until the group SETTLES. Members' own scenario retries
happen first, inside each member run.

**Reporters.** Console: `↻ … retrying`, `flaky (passed on attempt n)`, `[quarantined]`, a "Quarantined failures" section,
summary extras; group-retried failures are removed from "Failures". JUnit: Surefire `<flakyFailure>` per earlier failed
attempt; quarantined failures become `<skipped message="quarantined: …">`. HTML: flaky/quarantined/attempt badges,
earlier attempts list, group retries in the Run section, stack traces trimmed to user frames (`trimStack`).

## 2f. Worker processes (`pool: 'process'`)

`pool: 'inline'` (default) runs every scenario in one Node process with async concurrency (`workers` = lanes).
`pool: 'process'` (`--pool process`) backs every scheduler lane w1…wN with its own Node process: real CPU parallelism,
crash isolation, per-process globals (browsers, module state).

```
parent (coordinator)                                   worker process wK (forked lazily, one per lane)
  config, specs, plan, scheduler, reporters              same config/specs/plan (fingerprint checked)
  BeforeAll / AfterAll  (once)                           BeforeWorker / AfterWorker  (once per process)
  feature/group lifecycle EVENTS, summary,               Before/AfterFeature, Rule, Group hooks (lazily, per
  retries of groups, fail-fast, rerun bookkeeping          process that runs a member), scenarios, steps,
                                                           scenario retries, soft asserts, timeouts
        ── init{request, run-store seed} ──▶
        ── run{nodeId, attemptBase, failedBefore, finished[]} ──▶   ◀── events (re-emitted as-is) ──
        ◀── result{status, attempts, stepStatuses, flaky, exports, runFailed} ──
        ── close{scopes} (when the GLOBAL ref count hits 0) ──▶   ── shutdown ──▶
```

| Piece | Where |
| --- | --- |
| Protocol, `ProcessPool` (parent), `serveWorker` (child), `planFingerprint` | `runtime/src/pool.ts` |
| Coordinator mode (`ExecuteOptions.pool`): `runRemote`, `releaseRemote`, `runStoreSeed` | `runtime/src/executor.ts` |
| Worker mode (`remoteWorker: true`): `initWorker`, `runAssigned`, `closeScopes`, `shutdownWorker` | `runtime/src/executor.ts` |
| Worker entry (rebuilds the run from the parent's RunRequest) | `cli/src/worker.ts`, `prepareWorker` in `cli/src/run.ts` |

**Semantics (owner-facing):**
- `BeforeAll`/`AfterAll` (= BeforeSuite/AfterSuite) run ONCE in the parent. Run-store values set there are copied
  (structured clone) into each worker; non-cloneable values are dropped with a warning → create per-process things in
  `BeforeWorker`. Inline pool: BeforeWorker/AfterWorker run once (after BeforeAll / before AfterAll).
- Feature/rule/group hooks run in each process that runs a member, so with N processes a BeforeFeature may run up to N
  times; After* hooks run when the scope's LAST member (globally) is done, so dependents still start after AfterGroup.
  `ctx.feature` / `ctx.groups` stores are per process. Shared state across processes: `ctx.export`/`ctx.from` (synced
  by the parent) or an external system (file, DB). Module-level variables are per process.
- A scenario's attempts (scenario retry) stay in one process; group retry is decided by the parent and may re-run members
  on any lane. Attempt numbers and "failed before" (flaky) travel with each request.
- Worker crash (exit / kill) → that scenario fails with `WorkerCrashedError`; with `retry.workerCrash` it is retried on
  a fresh process, otherwise the lane respawns on its next node. Worker init failure (support code throws, plan mismatch) → `WorkerInitError`,
  the run stops scheduling and fails.
- Env in workers: `BDDR_WORKER_ID` (`w1`…), `BDDR_WORKER_INDEX` (1…), e.g. for per-worker ports or test accounts.
- `--dry-run` always uses the inline pool. Ctrl+C aborts the run, flushes hooks/reporters where possible, kills process
  workers, and exits 130; a worker also exits when the parent disconnects.

## 2c-quater. Real Playwright project

`examples/playwright-showcase` is a standalone TypeScript consumer project rather than a framework package. It depends
on the local built `@bddr/*` packages and uses bddr for discovery, planning, execution, retries and reporting;
Playwright supplies only Chromium and `APIRequestContext`.

- `BeforeWorker` launches one browser and creates one API request context in each process-local run store.
- `Before('@ui')` creates an isolated browser context and page in scenario state; reverse-ordered `After` hooks attach
  selected screenshots before closing the context.
- `concurrent:false` protects every browser step; API steps opt into concurrent `@repeat` safely.
- A serial health group gates separate UI/API groups. The process-pool plan uses four workers, with independent group
  caps and time budgets. Scenario dependencies consume health exports across processes.
- The project covers 125 scenarios / 523 steps across 13 feature files against public demo targets. Its single plan
  intentionally mixes serial SauceDemo/DummyJSON groups with parallel The Internet/JSONPlaceholder/TodoMVC groups,
  plus six ungrouped Playwright documentation and HTTPBin checks.
  Because those targets and the Chromium
  download require network access, its `npm run verify` is intentionally independent of the repository's offline root
  verification.

This proves the Phase 1 real-project gate and provides the reference implementation for a future reusable Playwright
plugin. Automatic failure-only trace capture still belongs to that package-level Phase 6 work.

## 2g. Reporting v2 and run history (Phase 5)

| Piece | Where |
| --- | --- |
| `HistoryRecorder` (events → `HistoryRun`), `loadHistory`, `saveHistory` (keep N), `scenarioHistory`, `rankScenarios` | `core/src/history.ts` |
| Timeline / dependency graph / history views (inline SVG + CSS) | `reporters/src/html-views.ts` |
| HTML reporter: collects attempt intervals (scenarioStarted/Finished by `id#attempt`), `workerStarted` start-ups, option `history` (previous runs) | `reporters/src/html.ts` |
| `history` config, write after the run, previous runs injected into `html` reporters, `bddr history` | `cli/src/run.ts` (`historySettings`, `withHistory`, `historyReport`), `cli/src/main.ts` |
| `workerStarted` event (fork → ready) | `runtime/src/pool.ts` |

- **Record** (`HistoryRun` v1): runId, startedAt, durationMs, success, workers, and per scenario id the final status,
  duration, attempts, flaky flag and name. Final attempts only (`willRetry` attempts are ignored).
- **Score** (`scenarioHistory`): over runs where the scenario passed or failed; run i is unstable if flaky or its
  pass/fail outcome differs from the previous such run; score = unstable / runs (0 with < 2 runs).
- **Timeline**: an attempt is drawn as "retried" (hatched) when it did not pass and a later attempt of the same
  scenario exists (scenario or group retry). Lane label shows busy % (sum of bars / wall time). Group rows span first
  member start → last member end. `workerId: 'scheduler'` (skipped before starting) is not drawn.
- **Graph**: nodes = scenarios with `@dependsOn` edges and groups with `dependsOn` (or `group:` targets); layer =
  longest path; capped at 150 nodes. Opened by default for plans of ≤ 60 scenarios.
- **Anchors**: scenario cards have `id="sc-<plan index>"`; a click on a bar/node opens and scrolls to the card.

**HTML report v3 (statistics + redesign).** `html-stats.ts` holds `computeStats` (pass rate = passed / executed, nearest-rank
percentiles, duration histogram, failure clusters keyed by the first error line with digits normalised, breakdowns by
feature/tag/group, delta vs the previous history run) and the Overview renderers. `html.ts` lays the page out as tabs and
embeds the results as JSON (`#bddr-data`, `<` escaped) that the share buttons use. View state (tab, search, hidden
statuses) is kept in `location.hash` so a link reproduces the view. No external assets. JUnit also reports failed
non-scenario hooks as errored cases in a `Hooks` suite.

**Data-driven display.** `html-data.ts` groups outline/data rows by `uri|baseId|Examples name` and renders each group as a
dataset (header with source, counts and status bar; template with `<placeholders>`; grid rows). The planned steps now
carry the step argument (`arg`: data table or doc string; optional, additive) so tables can be drawn.

## 2d. Configuration sources and precedence

Lowest → highest: built-in defaults → `bddr.config.*` → `--profile <p>` (merged; tags ANDed, params/groups merged by
key) → `--set path=value` (repeatable, JSON-typed, unknown top-level keys rejected; `applySetOverrides`) → dedicated CLI
flags (`-t`, `-w`, `-D`, `--log-level`, `--fail-fast`, …). Orchestration facts per scenario come from tags in specs.

## 2e. Logging

- API: `ctx.log(msg)` (= info), `ctx.log.debug|info|warn|error(msg, data?)`, `ctx.log.image(msg, bytes, {level,
  mediaType, name})`; bytes (Uint8Array/Buffer) passed as `data` also become an image on that log line. Media type is
  sniffed (png, jpeg, gif, webp, svg, pdf). Global `log` from `@bddr/runtime` for code outside steps (page objects,
  API clients). `runtime/src/logger.ts`. Playwright: `ctx.log.image('after login', await page.screenshot())`.
- Attribution: steps and hooks run inside `withLogger(ctx.log, …)` (AsyncLocalStorage), so the global `log` resolves to
  the scenario/step/hook running in the current async context, correct under concurrency. Outside: the run-level
  logger (`setFallbackLogger`), else warn/error go to stderr.
- Every call → a `log` event `{level, source:'user', message, data?, scenarioId?, stepId?}`; Error data is normalised to
  `{name, message, stack}`. The framework emits `source:'bddr'` debug diagnostics (plan summary, `start <id> on wN after
  … holding …`, `skip <id>: reason`). The CLI writes its own pre-run diagnostics (config, --set, counts, support code) to
  stderr as `[bddr:debug]` at `--log-level debug`.
- Log events may carry `attachment {mediaType, encoding:'base64', body, name?, bytes}` (the image).
- Display: console reporters show logs at or above `logLevel` (default `info`; `silent` hides all); image logs are
  marked `[🖼 image: name]`. Scenario logs are
  buffered and printed under the scenario's result line (stable with concurrency); run-level logs print immediately.
  NDJSON always contains every log at every level.
- File reports (`reporters/src/logs.ts`: `LogIndex`, `formatLogLine`), each with its own `logLevel` option:
  | Reporter | Where logs go | Default level | Framework logs |
  | --- | --- | --- | --- |
  | `html` | under each step / scenario, images inline, level dropdown + search in the page | debug (page shows info+) | yes, toggle |
  | `junit` | `<system-out>` (debug/info), `<system-err>` (warn/error), prefixed by step text, CDATA-safe | info | no |
  | `cucumber-json` | step `output` lines; log images + attachments as step `embeddings`; hook logs in `before[].output` | info | no |
  | `ndjson` | every event | all | yes |

## 3. Event stream (schema v1)

Order for a normal run:

```
runStarted → specParsed* → planReady → … → runFinished

In between, with workers = 1 and no priorities, the order is as in Phase 1:
  (featureStarted → hook* → (scenarioStarted → hook* → (stepStarted → hook* → stepFinished)* → hook* →
  scenarioFinished)* → featureFinished)*
With workers > 1, events of different scenarios interleave; every scenario/step event carries `scenarioId`, and
`scenarioStarted.workerId` names the slot. `groupStarted`/`groupFinished` wrap each named group's members.
```

`log` and `attachment` can appear anywhere inside a scenario. Skipped-by-hook scenarios emit
`scenarioStarted` + `scenarioFinished` (with `reason`) and no step events.

## 4. Conformance suite

`conformance/features/*.feature` + `*.expected.json`, run by `conformance/ts/conformance.test.ts` with the shared step
vocabulary in `conformance/ts/steps.ts`. See `conformance/README.md`. The Java engine must pass the same files.

## 5. How to add things

- **A new step argument type / parameter type**: `SupportRegistry.defineParameterType`; add a conformance case.
- **A new hook level**: extend `HookLevel` in `core/events.ts`, add API in `runtime/api.ts`, call `runHooks` at the
  right place in `executor.ts`, document failure semantics in both places, add conformance coverage.
- **A new reporter**: implement `Reporter` in `packages/reporters/src`, register it in `builtInReporters`, add a test
  that drives it with a real `Executor` run.
- **A new CLI option**: `main.ts` (parseArgs + help text) → `RunRequest` in `run.ts` → `BddrOptions` in `config.ts`
  if it should also be configurable; add a CLI end-to-end test.
