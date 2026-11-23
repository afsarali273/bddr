/**
 * Executor: runs a Plan (Phase 3) — features, rules, groups, scenarios, steps, hooks — and emits events.
 *
 * Execution order comes from the Scheduler (scheduler.ts): dependencies, priorities, locks, group modes and
 * `workers` decide what runs when. Feature / rule / group scopes are OPENED lazily by their first scenario
 * (Before* hooks run then) and CLOSED when their last scenario finishes or is skipped (After* hooks), using
 * reference counts, so they work with any order and with concurrency.
 *
 * Without an explicit plan, `execute()` builds one from the scenarios' tags with workers = 1, which keeps the
 * Phase 1 behaviour (serial, features together, file order).
 *
 * FAILURE SEMANTICS (keep docs/IMPLEMENTATION.md in sync):
 *  - BeforeAll fails      -> every scenario skipped (reason names the hook); AfterAll still runs; run fails.
 *  - BeforeGroup fails    -> the group's scenarios skipped; AfterGroup still runs; run fails.
 *  - BeforeFeature fails  -> the feature's scenarios skipped; AfterFeature still runs; run fails.
 *  - BeforeRule fails     -> the rule's scenarios skipped; AfterRule still runs; run fails.
 *  - Hard dependency did not pass -> scenario skipped "dependency failed: <id> (<status>)". Soft: runs anyway.
 *  - Before (scenario) fails -> later before-hooks skipped unless `alwaysRun`; steps skipped;
 *                            After hooks still run; scenario 'failed'.
 *  - A step fails         -> remaining steps 'skipped'; After hooks run; scenario 'failed'.
 *  - BeforeStep fails     -> that step 'failed' (body not run); AfterStep still runs.
 *  - After/AfterStep fails -> scenario/step becomes 'failed' even if steps passed.
 *  - defer() cleanup throws -> owning scenario/feature/group becomes 'failed'.
 *  - ctx.pending()        -> step 'pending', remaining steps skipped, scenario 'pending'.
 *  - ctx.skip(reason)     -> step 'skipped', remaining skipped, scenario 'skipped' with reason.
 *  - undefined / ambiguous step -> that status, remaining steps skipped.
 *  - cancellation / run or group timeout -> in-flight cancellable work fails; queued work is skipped; After hooks run.
 */
import {
  BDDR_VERSION,
  EVENT_SCHEMA_VERSION,
  buildPlan,
  parseDuration,
  compileTagExpression,
  emptySummary,
  toErrorInfo,
  worstStatus,
  type ErrorInfo,
  type EventBus,
  type FeatureInfo,
  type HookLevel,
  type ParsedSpec,
  type Plan,
  type PlanNode,
  type RuleRef,
  type RunSummary,
  type ScenarioInstance,
  type Status,
  type StepInstance,
} from '@bddr/core';
import { randomUUID } from 'node:crypto';
import { Scope, Store } from './context.js';
import { DataTable, DocString } from './datatable.js';
import type { SupportRegistry } from './registry.js';
import { schedule } from './scheduler.js';
import { WorkerCrashedError, WorkerInitError, type CloseResult, type NodeRequest, type NodeResult, type RemotePool, type ScopeRef, type WorkerExecutor } from './pool.js';
import { createLogger, setFallbackLogger, withLogger } from './logger.js';
import type { DebugController, DebugStepView } from './debug.js';
import { callWithFixtures, FixtureCache, installFixtures, type FixtureHost } from './fixtures.js';
import { abortError, abortableSleep, PendingSignal, SkipSignal, TimeoutError, withTimeout } from './signals.js';
import type {
  CurrentStepInfo,
  FeatureContext,
  GroupContext,
  HookDefinition,
  RunContext,
  RunContextBase,
  SoftAssert,
  StepContext,
  StepRetryOption,
} from './types.js';

export interface ExecuteOptions {
  /** Interactive debugging: pause before steps / after failures. Disables scenario and group retries. */
  debug?: DebugController;
  registry: SupportRegistry;
  bus: EventBus;
  /** Execution plan (groups, dependencies, workers). Default: built from scenario tags, workers = 1. */
  plan?: Plan;
  /** Parsed specs, only used to emit `specParsed` events. */
  specs?: ParsedSpec[];
  dryRun?: boolean;
  /** Stop starting new scenarios after the first failure. */
  failFast?: boolean;
  /** When true (default) pending/undefined/ambiguous scenarios fail the run. */
  strict?: boolean;
  params?: Record<string, string>;
  runId?: string;
  /** Cancels pending work and interrupts cancellable hooks/steps. Exposed to user code as `ctx.signal`. */
  signal?: AbortSignal;
  /** Scenario retry defaults (tags @retry:N / group scenarioRetry override `scenario`). */
  retry?: RetryOptions;
  /** Default time budget per scenario attempt (ms); `@timeout:<dur>` on a scenario overrides. 0/undefined = none. */
  scenarioTimeoutMs?: number;
  /**
   * Coordinator mode (`pool: 'process'`): nodes run in worker processes through this pool. The coordinator runs
   * BeforeAll/AfterAll, scheduling, retries, the summary and feature/group lifecycle EVENTS; workers run everything else.
   */
  pool?: RemotePool;
  /** Worker mode: this Executor lives in a worker process and is driven by serveWorker (initWorker/runAssigned/…). */
  remoteWorker?: boolean;
}

export interface RetryOptions {
  /** Extra attempts for failed scenarios. Default 0. */
  scenario?: number;
  /** Pause before a retry (ms). */
  delayMs?: number;
  /** Multiply the delay after each failed attempt. 1 = fixed delay. Default 1. */
  backoff?: number;
  /** Extra attempts when a process worker crashes while running a scenario. Default 0. */
  workerCrash?: number;
  /** Only retry when the error name or message matches one of these (strings match name exactly or message substring). */
  on?: Array<string | RegExp>;
  /** A scenario that passed only after a retry fails the run. Default false. */
  failOnFlaky?: boolean;
}

export interface ExecuteResult {
  success: boolean;
  summary: RunSummary;
  scenarioStatuses: Map<string, Status>;
}

interface HookOutcome {
  status: Status;
  error?: unknown;
  skipReason?: string;
}

interface Emitters {
  scenarioId?: string;
  stepId?: string;
}

/** A lazily opened, reference-counted scope (feature, rule or group). */
interface OpenScope {
  scope: Scope;
  opened: Promise<string | undefined>; // resolves to a fatal reason when its Before* hooks failed
  remaining: number;
  hookFailed: boolean;
  members: string[];
  /** Features: feature-scoped fixtures of this process. */
  fixtures?: FixtureCache;
}

export class Executor implements WorkerExecutor {
  private readonly summary = emptySummary();
  private readonly statuses = new Map<string, Status>();
  private readonly params: Readonly<Record<string, string>>;
  private runFailed = false;
  private runError: unknown;
  private stopReason: string | undefined;
  private readonly exportsById = new Map<string, Record<string, unknown>>();
  /** Step statuses of each scenario's LAST attempt (for the summary). */
  private readonly lastStepStatuses = new Map<string, Status[]>();
  /** Scenarios that had a non-passed attempt (scenario or group retry) — a later pass is flaky. */
  private readonly failedBefore = new Set<string>();
  private readonly attemptsUsed = new Map<string, number>();
  /** Scheduler wait per node, reported on its first scenarioStarted (see ScenarioStarted.waitedForMs). */
  private readonly waitedFor = new Map<string, number>();
  private readonly flaky = new Set<string>();
  private readonly groupAttempts = new Map<string, number>();
  // populated per run
  private runScope = new Scope('run');
  /** Worker-scoped fixtures of this process. */
  private readonly workerFixtures = new FixtureCache('worker');
  private workerFixtureCtx: RunContext | undefined;
  private readonly fixtureHost: FixtureHost;
  private plan!: Plan;
  private readonly features = new Map<string, OpenScope>();
  private readonly rules = new Map<string, OpenScope>();
  private readonly groups = new Map<string, OpenScope>();
  private readonly remaining = { features: new Map<string, number>(), rules: new Map<string, number>(), groups: new Map<string, number>() };
  /** Coordinator mode: which workers may have opened each scope ('feature:<uri>', 'rule:<key>', 'group:<name>'). */
  private readonly touchedBy = new Map<string, Set<string>>();
  /** Worker mode: BeforeWorker failed, so every node assigned here is skipped with this reason. */
  private workerFatal: string | undefined;
  /** BeforeWorker failed in this process: its AfterWorker hooks must not run (they would only cascade the error). */
  private workerBeforeFailed = false;
  private readonly signal: AbortSignal;

  constructor(private readonly opts: ExecuteOptions) {
    this.params = Object.freeze({ ...(opts.params ?? {}) });
    this.signal = opts.signal ?? new AbortController().signal;
    this.fixtureHost = {
      definitions: opts.registry.fixtureDefinitions,
      worker: this.workerFixtures,
      workerContext: () => (this.workerFixtureCtx ??= this.makeRunContext(this.runScope, {})),
    };
  }

  async execute(scenarios: readonly ScenarioInstance[]): Promise<ExecuteResult> {
    const { bus, registry } = this.opts;
    const started = Date.now();
    registry.finalize();
    const plan = this.opts.plan ?? buildPlan(scenarios, scenarios, { workers: 1, withDeps: false });
    if (plan.errors.length) {
      throw new Error(`Invalid plan:\n${plan.errors.map((e) => `  ${e.uri ? `${e.uri}:${e.line} ` : ''}${e.message}`).join('\n')}`);
    }
    this.plan = plan;

    bus.emit({
      type: 'runStarted',
      runId: this.opts.runId ?? randomUUID(),
      schemaVersion: EVENT_SCHEMA_VERSION,
      framework: { name: 'bddr', version: BDDR_VERSION },
      runtime: { name: 'node', version: process.version },
      dryRun: !!this.opts.dryRun,
    });
    for (const spec of this.opts.specs ?? []) {
      bus.emit({
        type: 'specParsed',
        uri: spec.uri,
        ...(spec.feature ? { featureName: spec.feature.name } : {}),
        scenarioCount: spec.scenarios.length,
        errors: spec.errors,
      });
    }
    bus.emit({
      type: 'planReady',
      workers: plan.workers,
      groups: [...plan.groups.values()].map((g) => ({
        name: g.name,
        mode: g.mode,
        ...(g.workers !== undefined ? { workers: g.workers } : {}),
        ...(g.timeoutMs !== undefined ? { timeoutMs: g.timeoutMs } : {}),
        dependsOn: g.dependsOn,
        members: g.members,
      })),
      scenarios: plan.nodes.map((n) => plannedScenario(n)),
    });

    // reference counts for lazily opened scopes
    for (const n of plan.nodes) {
      const s = n.scenario;
      inc(this.remaining.features, s.uri);
      if (s.rule) inc(this.remaining.rules, ruleKey(s));
      for (const g of this.realGroups(n)) inc(this.remaining.groups, g);
    }

    const runCtx = this.makeRunContext(this.runScope, {});
    setFallbackLogger(runCtx.log);
    this.debug(
      `plan: ${plan.nodes.length} scenario(s), workers=${plan.workers}, groups=[${[...plan.groups.keys()].join(', ')}]` +
        `${plan.nodes.some((n) => n.pulledInBy) ? `, ${plan.nodes.filter((n) => n.pulledInBy).length} pulled in as dependencies` : ''}`,
    );
    if (!this.opts.dryRun) {
      const outcome = await this.runHooks('run', 'before', runCtx, () => true, {});
      if (outcome.status === 'failed') {
        this.workerBeforeFailed = true; // no worker was started, so there is nothing for AfterWorker to tear down
        this.stopReason = `BeforeAll hook "${outcome.hookName}" failed`;
        this.runFailed = true;
        this.runError ??= outcome.error;
      }
      if (this.opts.pool) {
        if (!this.stopReason) await this.opts.pool.start(this.runStoreSeed());
      } else if (!this.stopReason) {
        // inline pool: this process is the only worker
        const w = await this.runHooks('worker', 'before', runCtx, () => true, {});
        if (w.status === 'failed') {
          this.workerBeforeFailed = true;
          this.stopReason = `BeforeWorker hook "${w.hookName}" failed`;
          this.runFailed = true;
          this.runError ??= w.error;
        }
      }
    }

    await schedule(
      plan,
      {
        runNode: (node, workerId, signal, waited) =>
          this.opts.pool ? this.runRemote(node, workerId, signal, waited) : this.runNode(node, workerId, signal, waited),
        skipNode: async (node, reason) => {
          this.debug(`skip ${node.id}: ${reason}`, { scenarioId: node.id });
          this.skipScenario(node.scenario, reason, 'scheduler');
          await this.release(node);
        },
        stopReason: () => this.stopReason ?? this.cancellationReason(),
        settleGroup: (group) => this.settleGroup(group),
      },
      { ignoreDependencyResults: !!this.opts.dryRun, affinity: !!this.opts.pool },
    );

    if (!this.opts.dryRun) {
      if (this.opts.pool) {
        const stopped = await this.opts.pool.stop();
        if (stopped.runFailed) this.runFailed = true;
      } else {
        if (!this.workerBeforeFailed) {
          const w = await this.runHooks('worker', 'after', runCtx, () => true, {});
          if (w.status === 'failed') {
            this.runFailed = true;
            this.runError ??= w.error;
          }
        }
        const fx = await this.closeWorkerFixtures();
        if (fx) {
          this.runFailed = true;
          this.runError ??= fx;
        }
      }
      const after = await this.runHooks('run', 'after', runCtx, () => true, {});
      if (after.status === 'failed') {
        this.runFailed = true;
        this.runError ??= after.error;
      }
      const cleanupErrors = await this.runScope.close();
      if (cleanupErrors.length) {
        this.runFailed = true;
        this.runError ??= cleanupErrors[0];
      }
    }

    setFallbackLogger(undefined);
    this.summary.durationMs = Date.now() - started;
    // Summary from FINAL attempts only.
    const strict = this.opts.strict ?? true;
    let bad = 0;
    for (const n of plan.nodes) {
      const st = this.statuses.get(n.id) ?? 'skipped';
      this.summary.scenarios[st] += 1;
      this.summary.scenarios.total += 1;
      if (n.quarantined) this.summary.quarantined! += 1;
      if ((this.attemptsUsed.get(n.id) ?? 1) > 1) this.summary.retried! += 1;
      const isBad = st === 'failed' || (strict && (st === 'pending' || st === 'undefined' || st === 'ambiguous'));
      if (isBad && !n.quarantined) bad++;
      for (const ss of this.lastStepStatuses.get(n.id) ?? []) {
        this.summary.steps[ss] += 1;
        this.summary.steps.total += 1;
      }
    }
    this.summary.flaky = this.flaky.size;
    const flakyFails = !!this.opts.retry?.failOnFlaky && this.flaky.size > 0;
    if (flakyFails) this.runError ??= new Error(`${this.flaky.size} flaky scenario(s) and failOnFlaky is on`);
    const success = !this.runFailed && bad === 0 && !flakyFails;
    bus.emit({
      type: 'runFinished',
      success,
      summary: this.summary,
      ...(this.runError !== undefined ? { error: toErrorInfo(this.runError) } : {}),
    });
    return { success, summary: this.summary, scenarioStatuses: this.statuses };
  }

  // ---------------------------------------------------------------- one plan node

  /** Framework diagnostics: `log` events with source 'bddr', level 'debug' (shown with --log-level debug). */
  private debug(message: string, ids: Emitters = {}): void {
    this.opts.bus.emit({ type: 'log', level: 'debug', source: 'bddr', message, ...(ids.scenarioId ? { scenarioId: ids.scenarioId } : {}) });
  }

  private cancellationReason(): string | undefined {
    if (!this.signal.aborted) return undefined;
    const error = abortError(this.signal);
    this.runFailed = true;
    this.runError ??= error;
    return `cancelled: ${error.message}`;
  }

  private combineSignal(signal?: AbortSignal): AbortSignal {
    if (!signal || signal === this.signal) return this.signal;
    return AbortSignal.any([this.signal, signal]);
  }

  private async runNode(node: PlanNode, workerId: string, nodeSignal?: AbortSignal, waitedForMs?: number): Promise<Status> {
    const s = node.scenario;
    if (waitedForMs !== undefined) this.waitedFor.set(node.id, waitedForMs);
    const signal = this.combineSignal(nodeSignal);
    const waited = node.deps.length ? ` after ${node.deps.map((d) => `${d.target}${d.soft ? '~' : ''}`).join(', ')}` : '';
    this.debug(`start ${node.id} on ${workerId}${waited}${node.locks.length ? ` holding ${node.locks.join(', ')}` : ''}`, { scenarioId: node.id });
    try {
      const groupStores: Record<string, Store> = {};
      for (const g of this.realGroups(node)) {
        const og = this.openGroup(g, signal);
        const fatal = await og.opened;
        if (fatal) return this.skipScenario(s, fatal, workerId);
        groupStores[g] = og.scope.store;
      }
      const of = this.openFeature(s, signal);
      const ffatal = await of.opened;
      if (ffatal) return this.skipScenario(s, ffatal, workerId);
      if (s.rule) {
        const rfatal = await this.openRule(s, of.scope, signal).opened;
        if (rfatal) return this.skipScenario(s, rfatal, workerId);
      }
      let attempt = this.attemptsUsed.get(node.id) ?? 0;
      let status: Status;
      for (;;) {
        attempt++;
        this.attemptsUsed.set(node.id, attempt);
        const r = await this.runScenario(s, this.runScope, of.scope, attempt, workerId, groupStores, node, signal);
        status = r.status;
        if (!r.willRetry) break;
        if (this.opts.retry?.delayMs) {
          const backoff = this.opts.retry.backoff ?? 1;
          try {
            await abortableSleep(this.opts.retry.delayMs * Math.pow(backoff, Math.max(0, attempt - 1)), signal);
          } catch (e) {
            attempt++;
            this.attemptsUsed.set(node.id, attempt);
            this.lastStepStatuses.set(node.id, []);
            this.opts.bus.emit({ type: 'scenarioStarted', scenarioId: s.id, attempt, workerId });
            this.finishScenario(s, attempt, 'failed', 0, e, undefined, { quarantined: !!node.quarantined });
            status = 'failed';
            break;
          }
        }
      }
      if (status === 'failed' && this.opts.failFast && !node.quarantined) this.stopReason ??= 'fail-fast: an earlier scenario failed';
      return status;
    } finally {
      await this.release(node);
    }
  }

  /** Decrement scope counters; close scopes whose last member is done (rule, feature, then groups). */
  private async release(node: PlanNode): Promise<void> {
    if (this.opts.remoteWorker) return; // the coordinator decides when scopes close (closeScopes)
    if (this.opts.pool) return this.releaseRemote(node);
    const s = node.scenario;
    if (s.rule && dec(this.remaining.rules, ruleKey(s)) === 0) await this.closeRule(s);
    if (dec(this.remaining.features, s.uri) === 0) await this.closeFeature(s.feature);
    for (const g of this.realGroups(node)) if (dec(this.remaining.groups, g) === 0) await this.closeGroup(g);
  }

  /** Groups with hooks, stores and events (the implicit `default` group only affects scheduling). */
  private realGroups(node: PlanNode): string[] {
    return node.groups.filter((g) => !this.plan.groups.get(g)?.implicit);
  }

  // ---------------------------------------------------------------- lazily opened scopes

  private openFeature(s: ScenarioInstance, signal: AbortSignal = this.signal): OpenScope {
    let f = this.features.get(s.uri);
    if (f) return f;
    const scope = new Scope('feature');
    const fixtureCtx = this.makeFeatureContext(this.runScope, scope, s.feature, undefined, {}, this.signal);
    const fixtures = new FixtureCache('feature', fixtureCtx);
    installFixtures(fixtureCtx, this.fixtureHost, undefined, fixtures);
    const entry: OpenScope = { scope, remaining: 0, hookFailed: false, members: [], opened: Promise.resolve(undefined), fixtures };
    this.features.set(s.uri, entry);
    entry.opened = (async () => {
      if (!this.opts.remoteWorker) this.opts.bus.emit({ type: 'featureStarted', uri: s.uri, name: s.feature.name });
      if (this.opts.dryRun) return undefined;
      const ctx = this.makeFeatureContext(this.runScope, scope, s.feature, undefined, {}, signal);
      installFixtures(ctx, this.fixtureHost, undefined, fixtures);
      const before = await this.runHooks('feature', 'before', ctx, tagFilter(s.feature.tags.map((t) => t.name)), { uri: s.uri });
      if (before.status === 'failed') {
        entry.hookFailed = true;
        return `BeforeFeature hook "${before.hookName}" failed`;
      }
      return undefined;
    })();
    return entry;
  }

  private async closeFeature(feature: FeatureInfo): Promise<void> {
    const f = this.features.get(feature.uri);
    if (!f) return; // never opened (all its scenarios were skipped before starting)
    await f.opened;
    if (!this.opts.dryRun) {
      const ctx = this.makeFeatureContext(this.runScope, f.scope, feature, undefined, {});
      if (f.fixtures) installFixtures(ctx, this.fixtureHost, undefined, f.fixtures);
      const after = await this.runHooks('feature', 'after', ctx, tagFilter(feature.tags.map((t) => t.name)), { uri: feature.uri });
      if (after.status === 'failed') f.hookFailed = true;
      const cleanupErrors = await f.scope.close();
      if (cleanupErrors.length) {
        f.hookFailed = true;
        this.emitHookLikeError('feature', 'after', 'feature cleanup (defer)', cleanupErrors[0], { uri: feature.uri });
      }
      const fixtureErrors = (await f.fixtures?.close()) ?? [];
      if (fixtureErrors.length) {
        f.hookFailed = true;
        this.emitHookLikeError('feature', 'after', 'feature fixture teardown', fixtureErrors[0], { uri: feature.uri });
      }
    }
    if (f.hookFailed) this.runFailed = true;
    if (this.opts.remoteWorker) return;
    const members = this.plan.nodes.filter((n) => n.scenario.uri === feature.uri).map((n) => this.statuses.get(n.id) ?? 'skipped');
    this.opts.bus.emit({
      type: 'featureFinished',
      uri: feature.uri,
      name: feature.name,
      status: f.hookFailed ? 'failed' : worstStatus(members),
    });
  }

  private openRule(s: ScenarioInstance, featureScope: Scope, signal: AbortSignal = this.signal): OpenScope {
    const key = ruleKey(s);
    let r = this.rules.get(key);
    if (r) return r;
    const entry: OpenScope = { scope: featureScope, remaining: 0, hookFailed: false, members: [], opened: Promise.resolve(undefined) };
    this.rules.set(key, entry);
    entry.opened = (async () => {
      if (this.opts.dryRun) return undefined;
      const ctx = this.makeFeatureContext(this.runScope, featureScope, s.feature, s.rule, {}, signal);
      const before = await this.runHooks('rule', 'before', ctx, tagFilter(ruleTags(s.rule!)), { uri: s.uri });
      if (before.status === 'failed') {
        entry.hookFailed = true;
        this.runFailed = true;
        return `BeforeRule hook "${before.hookName}" failed`;
      }
      return undefined;
    })();
    return entry;
  }

  private async closeRule(s: ScenarioInstance): Promise<void> {
    const r = this.rules.get(ruleKey(s));
    if (!r) return;
    await r.opened;
    if (this.opts.dryRun) return; // AfterRule runs even when BeforeRule failed
    const ctx = this.makeFeatureContext(this.runScope, r.scope, s.feature, s.rule, {});
    const after = await this.runHooks('rule', 'after', ctx, tagFilter(ruleTags(s.rule!)), { uri: s.uri });
    if (after.status === 'failed') this.runFailed = true;
  }

  private openGroup(name: string, signal: AbortSignal = this.signal): OpenScope {
    let g = this.groups.get(name);
    if (g) return g;
    const scope = new Scope('group');
    const entry: OpenScope = { scope, remaining: 0, hookFailed: false, members: [], opened: Promise.resolve(undefined) };
    this.groups.set(name, entry);
    entry.opened = (async () => {
      if (!this.opts.remoteWorker) this.opts.bus.emit({ type: 'groupStarted', group: name, ...this.groupAttempt(name) });
      if (this.opts.dryRun) return undefined;
      const ctx = this.makeGroupContext(scope, name, signal);
      const before = await this.runHooks('group', 'before', ctx, groupFilter(name), {});
      if (before.status === 'failed') {
        entry.hookFailed = true;
        return `BeforeGroup hook "${before.hookName}" failed (group ${name})`;
      }
      return undefined;
    })();
    return entry;
  }

  private async closeGroup(name: string): Promise<void> {
    const g = this.groups.get(name);
    if (!g) return;
    await g.opened;
    if (!this.opts.dryRun) {
      const after = await this.runHooks('group', 'after', this.makeGroupContext(g.scope, name), groupFilter(name), {});
      if (after.status === 'failed') g.hookFailed = true;
      const cleanupErrors = await g.scope.close();
      if (cleanupErrors.length) {
        g.hookFailed = true;
        this.emitHookLikeError('group', 'after', `group ${name} cleanup (defer)`, cleanupErrors[0], {});
      }
    }
    if (g.hookFailed) this.runFailed = true;
    if (this.opts.remoteWorker) return;
    const members = (this.plan.groups.get(name)?.members ?? []).map((id) => this.statuses.get(id) ?? 'skipped');
    this.opts.bus.emit({ type: 'groupFinished', group: name, status: g.hookFailed ? 'failed' : worstStatus(members), ...this.groupAttempt(name) });
  }

  private groupAttempt(name: string): { attempt?: number } {
    const a = this.groupAttempts.get(name);
    return a && a > 1 ? { attempt: a } : {};
  }

  // ---------------------------------------------------------------- coordinator mode (pool: 'process')

  /** Run store values that survive structured clone; workers start with a copy. */
  private runStoreSeed(): Record<string, unknown> {
    const seed: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const key of this.runScope.store.keys()) {
      try {
        seed[key] = structuredClone(this.runScope.store.get(key));
      } catch {
        skipped.push(key);
      }
    }
    if (skipped.length) {
      this.opts.bus.emit({
        type: 'log',
        level: 'warn',
        source: 'bddr',
        message:
          `run store key(s) [${skipped.join(', ')}] set in BeforeAll cannot be copied to worker processes (not serialisable). ` +
          `Create per-process resources (browsers, connections) in BeforeWorker instead.`,
      });
    }
    return seed;
  }

  private touch(key: string, workerId: string): void {
    let set = this.touchedBy.get(key);
    if (!set) this.touchedBy.set(key, (set = new Set()));
    set.add(workerId);
  }

  private async runRemote(node: PlanNode, workerId: string, nodeSignal?: AbortSignal, waitedForMs?: number): Promise<Status> {
    const pool = this.opts.pool!;
    const s = node.scenario;
    const signal = this.combineSignal(nodeSignal);
    const cancel = () => pool.cancel?.(workerId);
    signal.addEventListener('abort', cancel, { once: true });
    const marker = (): OpenScope => ({ scope: this.runScope, remaining: 0, hookFailed: false, members: [], opened: Promise.resolve(undefined) });
    try {
      for (const g of this.realGroups(node)) {
        if (!this.groups.has(g)) {
          this.groups.set(g, marker());
          this.opts.bus.emit({ type: 'groupStarted', group: g, ...this.groupAttempt(g) });
        }
        this.touch(`group:${g}`, workerId);
      }
      if (!this.features.has(s.uri)) {
        this.features.set(s.uri, marker());
        this.opts.bus.emit({ type: 'featureStarted', uri: s.uri, name: s.feature.name });
      }
      this.touch(`feature:${s.uri}`, workerId);
      if (s.rule) this.touch(`rule:${ruleKey(s)}`, workerId);
      const groupAttempts: Record<string, number> = {};
      for (const g of node.groups) {
        const a = this.groupAttempts.get(g);
        if (a) groupAttempts[g] = a;
      }
      let res: NodeResult;
      let crashRetries = 0;
      for (;;) {
        try {
          res = await pool.run({
            nodeId: node.id,
            workerId,
            attemptBase: this.attemptsUsed.get(node.id) ?? 0,
            ...(waitedForMs !== undefined ? { waitedForMs } : {}),
            failedBefore: this.failedBefore.has(node.id),
            groupAttempts,
          });
          break;
        } catch (e) {
          if (e instanceof WorkerInitError) {
            this.stopReason ??= 'a worker process failed to start';
            this.runFailed = true;
            this.runError ??= e;
          }
          const attempt = (this.attemptsUsed.get(node.id) ?? 0) + 1;
          this.attemptsUsed.set(node.id, attempt);
          this.failedBefore.add(node.id);
          this.lastStepStatuses.set(node.id, []);
          const err = signal.aborted
            ? abortError(signal)
            : e instanceof WorkerCrashedError || e instanceof WorkerInitError
              ? e
              : new WorkerCrashedError(toErrorInfo(e).message);
          const retryCrash = e instanceof WorkerCrashedError && !signal.aborted && crashRetries < (this.opts.retry?.workerCrash ?? 0);
          this.finishScenario(s, attempt, 'failed', 0, err, undefined, { willRetry: retryCrash, quarantined: !!node.quarantined });
          if (retryCrash) {
            crashRetries++;
            this.debug(`worker crash while running ${node.id}; retrying on a fresh ${workerId} process (${crashRetries}/${this.opts.retry!.workerCrash})`, {
              scenarioId: node.id,
            });
            continue;
          }
          pool.publish(node.id, 'failed', undefined);
          if (this.opts.failFast && !node.quarantined) this.stopReason ??= 'fail-fast: an earlier scenario failed';
          return 'failed';
        }
      }
      this.attemptsUsed.set(node.id, res.attempts);
      this.lastStepStatuses.set(node.id, res.stepStatuses);
      this.statuses.set(node.id, res.status);
      if (res.failedBefore) this.failedBefore.add(node.id);
      if (res.flaky) this.flaky.add(node.id);
      else this.flaky.delete(node.id);
      if (res.exports) this.exportsById.set(node.id, res.exports);
      else this.exportsById.delete(node.id);
      if (res.runFailed) this.runFailed = true;
      pool.publish(node.id, res.status, res.exports);
      if (res.status === 'failed' && this.opts.failFast && !node.quarantined) this.stopReason ??= 'fail-fast: an earlier scenario failed';
      return res.status;
    } finally {
      signal.removeEventListener('abort', cancel);
      await this.release(node);
    }
  }

  /** Coordinator: when a scope's last member is done, close it in every worker that may have opened it. */
  private async releaseRemote(node: PlanNode): Promise<void> {
    const s = node.scenario;
    const refs: ScopeRef[] = [];
    if (s.rule && dec(this.remaining.rules, ruleKey(s)) === 0) refs.push({ kind: 'rule', key: ruleKey(s), scenarioId: s.id });
    if (dec(this.remaining.features, s.uri) === 0) refs.push({ kind: 'feature', key: s.uri, scenarioId: s.id });
    for (const g of this.realGroups(node)) if (dec(this.remaining.groups, g) === 0) refs.push({ kind: 'group', key: g });
    if (!refs.length) return;
    const workers = new Set<string>();
    for (const r of refs) {
      const k = `${r.kind}:${r.key}`;
      for (const w of this.touchedBy.get(k) ?? []) workers.add(w);
      this.touchedBy.delete(k);
    }
    const closed: CloseResult = workers.size ? await this.opts.pool!.close([...workers], refs) : { failed: [], runFailed: false };
    if (closed.runFailed || closed.failed.length) this.runFailed = true;
    for (const r of refs) {
      const failed = closed.failed.includes(r.key);
      if (r.kind === 'feature' && this.features.has(r.key)) {
        const members = this.plan.nodes.filter((n) => n.scenario.uri === r.key).map((n) => this.statuses.get(n.id) ?? 'skipped');
        this.opts.bus.emit({ type: 'featureFinished', uri: r.key, name: s.feature.name, status: failed ? 'failed' : worstStatus(members) });
      }
      if (r.kind === 'group' && this.groups.has(r.key)) {
        const members = (this.plan.groups.get(r.key)?.members ?? []).map((id) => this.statuses.get(id) ?? 'skipped');
        this.opts.bus.emit({ type: 'groupFinished', group: r.key, status: failed ? 'failed' : worstStatus(members), ...this.groupAttempt(r.key) });
      }
    }
  }

  /** Tear down worker fixtures (after AfterWorker hooks). Returns the first error, reported like a hook failure. */
  private async closeWorkerFixtures(): Promise<unknown> {
    const errors = await this.workerFixtures.close();
    if (errors.length) this.emitHookLikeError('worker', 'after', 'worker fixture teardown', errors[0], {});
    return errors[0];
  }

  // ---------------------------------------------------------------- worker mode (inside a worker process)

  /** Worker process start: seed the run store, BeforeWorker hooks. */
  async initWorker(seed: Record<string, unknown>): Promise<void> {
    this.opts.registry.finalize();
    this.plan = this.opts.plan!;
    for (const [k, v] of Object.entries(seed)) this.runScope.store.set(k, v);
    const runCtx = this.makeRunContext(this.runScope, {});
    setFallbackLogger(runCtx.log);
    const w = await this.runHooks('worker', 'before', runCtx, () => true, {});
    if (w.status === 'failed') {
      this.workerBeforeFailed = true;
      this.workerFatal = `BeforeWorker hook "${w.hookName}" failed`;
      this.runFailed = true;
    }
  }

  /** Run one plan node (all its scenario-retry attempts) as instructed by the coordinator. */
  async runAssigned(req: NodeRequest): Promise<NodeResult> {
    const node = this.plan.byId.get(req.nodeId);
    if (!node) throw new Error(`worker: unknown scenario id ${req.nodeId}`);
    for (const [id, st, ex] of req.finished ?? []) {
      this.statuses.set(id, st);
      if (ex) this.exportsById.set(id, ex);
      else this.exportsById.delete(id);
    }
    this.statuses.delete(node.id); // it is about to run (again)
    this.attemptsUsed.set(node.id, req.attemptBase);
    if (req.failedBefore) this.failedBefore.add(node.id);
    else this.failedBefore.delete(node.id);
    for (const [g, a] of Object.entries(req.groupAttempts)) this.groupAttempts.set(g, a);
    let status: Status;
    if (this.workerFatal) {
      this.attemptsUsed.set(node.id, req.attemptBase + 1);
      status = this.skipScenario(node.scenario, this.workerFatal, req.workerId);
    } else {
      status = await this.runNode(node, req.workerId, undefined, req.waitedForMs);
    }
    const exports = this.exportsById.get(node.id);
    return {
      status,
      attempts: this.attemptsUsed.get(node.id) ?? 1,
      stepStatuses: this.lastStepStatuses.get(node.id) ?? [],
      flaky: this.flaky.has(node.id),
      failedBefore: this.failedBefore.has(node.id),
      ...(exports ? { exports } : {}),
      runFailed: this.runFailed,
    };
  }

  /** Close scopes this process opened (After* hooks + cleanups). Unopened ones are ignored. */
  async closeScopes(scopes: readonly ScopeRef[]): Promise<CloseResult> {
    const failed: string[] = [];
    for (const ref of scopes) {
      if (ref.kind === 'group') {
        const g = this.groups.get(ref.key);
        if (!g) continue;
        await this.closeGroup(ref.key);
        if (g.hookFailed) failed.push(ref.key);
        this.groups.delete(ref.key);
        continue;
      }
      const s = this.plan.byId.get(ref.scenarioId ?? '')?.scenario;
      if (!s) continue;
      if (ref.kind === 'rule') {
        const r = this.rules.get(ref.key);
        if (!r) continue;
        await this.closeRule(s);
        if (r.hookFailed) failed.push(ref.key);
        this.rules.delete(ref.key);
      } else {
        const f = this.features.get(ref.key);
        if (!f) continue;
        await this.closeFeature(s.feature);
        if (f.hookFailed) failed.push(ref.key);
        this.features.delete(ref.key);
      }
    }
    return { failed, runFailed: this.runFailed };
  }

  /** Worker process end: close anything still open, AfterWorker hooks, run-scope cleanups. */
  async shutdownWorker(): Promise<{ runFailed: boolean }> {
    for (const key of [...this.rules.keys()]) {
      const id = this.plan.nodes.find((n) => n.scenario.rule && ruleKey(n.scenario) === key)?.id;
      await this.closeScopes([{ kind: 'rule', key, ...(id ? { scenarioId: id } : {}) }]);
    }
    for (const uri of [...this.features.keys()]) {
      const id = this.plan.nodes.find((n) => n.scenario.uri === uri)?.id;
      await this.closeScopes([{ kind: 'feature', key: uri, ...(id ? { scenarioId: id } : {}) }]);
    }
    for (const g of [...this.groups.keys()]) await this.closeScopes([{ kind: 'group', key: g }]);
    const runCtx = this.makeRunContext(this.runScope, {});
    if (!this.workerBeforeFailed) {
      const w = await this.runHooks('worker', 'after', runCtx, () => true, {});
      if (w.status === 'failed') this.runFailed = true;
    }
    if (await this.closeWorkerFixtures()) this.runFailed = true;
    const cleanupErrors = await this.runScope.close();
    if (cleanupErrors.length) {
      this.runFailed = true;
      this.emitHookLikeError('worker', 'after', 'worker cleanup (defer)', cleanupErrors[0], {});
    }
    setFallbackLogger(undefined);
    return { runFailed: this.runFailed };
  }

// ---------------------------------------------------------------- scenarios

  /** Run one scenario (one attempt). Returns its final status. */
  async runScenario(
    scenario: ScenarioInstance,
    runScope: Scope,
    featureScope: Scope,
    attempt = 1,
    workerId = 'w1',
    groupStores: Record<string, Store> = {},
    node?: PlanNode,
    signal: AbortSignal = this.signal,
  ): Promise<{ status: Status; willRetry: boolean }> {
    const { bus } = this.opts;
    const started = Date.now();
    this.exportsById.delete(scenario.id); // exports belong to the attempt that produced them
    const timeoutMs = this.opts.debug ? undefined : (scenarioTimeout(scenario) ?? this.opts.scenarioTimeoutMs);
    const deadline = timeoutMs ? started + timeoutMs : undefined;
    const scope = new Scope('scenario');
    const tagNames = scenario.tags.map((t) => t.name);
    const ids: Emitters = { scenarioId: scenario.id };
    const waited = attempt === 1 && node ? this.waitedFor.get(node.id) : undefined;
    bus.emit({ type: 'scenarioStarted', scenarioId: scenario.id, attempt, workerId, ...(waited !== undefined ? { waitedForMs: waited } : {}) });

    const ctx = this.makeStepContext(runScope, featureScope, scope, scenario, attempt, ids, groupStores, signal);
    const fixtures = new FixtureCache('scenario');
    installFixtures(ctx, this.fixtureHost, fixtures, this.features.get(scenario.uri)?.fixtures);
    if (node?.serial) ctx.scenario.serial = node.serial;
    const statuses: Status[] = [];
    let error: unknown;
    let skipReason: string | undefined;
    let blocked = false;
    const dry = !!this.opts.dryRun;

    if (!dry) {
      const before = await this.runHooks('scenario', 'before', ctx, tagFilter(tagNames), ids);
      if (before.status !== 'passed') {
        statuses.push(before.status);
        blocked = true;
        error ??= before.error;
        skipReason ??= before.skipReason;
      }
    }

    const stepStatuses: Status[] = [];
    for (const step of scenario.steps) {
      if (signal.aborted && !blocked && !dry) {
        blocked = true;
        statuses.push('failed');
        error ??= abortError(signal);
      }
      if (deadline && !blocked && !dry && Date.now() >= deadline) {
        blocked = true;
        statuses.push('failed');
        error ??= new TimeoutError(`Scenario "${scenario.name}"`, timeoutMs!);
      }
      const result = await this.runStep(step, scenario, ctx, tagNames, blocked || dry, deadline, timeoutMs);
      statuses.push(result.status);
      stepStatuses.push(result.status);
      if (result.status !== 'passed' && !blocked) {
        blocked = true;
        error ??= result.error;
        skipReason ??= result.skipReason;
      }
    }
    ctx.step = undefined;
    delete ids.stepId;

    if (!dry) {
      const after = await this.runHooks('scenario', 'after', ctx, tagFilter(tagNames), ids);
      if (after.status === 'failed') {
        statuses.push('failed');
        error ??= after.error;
      }
      const cleanupErrors = await scope.close();
      if (cleanupErrors.length) {
        statuses.push('failed');
        error ??= cleanupErrors[0];
        this.emitHookLikeError('scenario', 'after', 'scenario cleanup (defer)', cleanupErrors[0], ids);
      }
    }
    // Fixtures outlive everything that may use them (steps, After hooks, ctx.defer, dispose()).
    const fixtureErrors = await fixtures.close({ status: worstStatus(statuses), ...(error !== undefined ? { error } : {}) }, ctx);
    if (fixtureErrors.length) {
      statuses.push('failed');
      error ??= fixtureErrors[0];
      this.emitHookLikeError('scenario', 'after', 'fixture teardown', fixtureErrors[0], ids);
    }

    // Dry run: every matched step is reported 'skipped', so the scenario is 'skipped' unless something is undefined/ambiguous.
    const status = worstStatus(statuses);
    this.lastStepStatuses.set(scenario.id, stepStatuses);
    const willRetry = !dry && status === 'failed' && (await this.shouldRetry(scenario, node, attempt, error));
    if (status !== 'passed') this.failedBefore.add(scenario.id);
    this.finishScenario(scenario, attempt, status, Date.now() - started, error, status === 'skipped' ? skipReason : undefined, {
      willRetry,
      quarantined: !!node?.quarantined || 'quarantine' in scenario.meta,
    });
    return { status, willRetry };
  }

  /** Scenario retry decision: attempts left (tag/group/config), error filter, custom analyzer. */
  private async shouldRetry(s: ScenarioInstance, node: PlanNode | undefined, attempt: number, error: unknown): Promise<boolean> {
    if (this.opts.debug) return false; // a debugging session never re-runs scenarios behind your back
    const max = node?.retry ?? this.opts.retry?.scenario ?? 0;
    if (attempt > max) return false;
    const info = error === undefined ? undefined : toErrorInfo(error);
    const on = this.opts.retry?.on;
    if (on?.length && info) {
      const hit = on.some((m) => (typeof m === 'string' ? info.name === m || info.message.includes(m) : m.test(`${info.name ?? ''}: ${info.message}`)));
      if (!hit) return false;
    }
    const analyzer = this.opts.registry.retryAnalyzer;
    if (analyzer) {
      try {
        return !!(await analyzer({
          scenario: {
            id: s.id,
            name: s.name,
            uri: s.uri,
            line: s.line,
            featureName: s.feature.name,
            tags: s.tags.map((t) => t.name),
            meta: { ...s.meta },
            attempt,
          },
          attempt,
          maxRetries: max,
          ...(info ? { error: { message: info.message, ...(info.name ? { name: info.name } : {}) } } : {}),
        }));
      } catch (e) {
        this.debug(`retry analyzer threw (${toErrorInfo(e).message}); not retrying`, { scenarioId: s.id });
        return false;
      }
    }
    return true;
  }

  /**
   * Group retry: called by the scheduler once every member of a retry group has a result.
   * Returns the member ids to run again (and re-opens the group / their feature & rule scopes), or undefined to settle.
   */
  private async settleGroup(name: string): Promise<string[] | undefined> {
    const g = this.plan.groups.get(name);
    if (!g || !g.retry || this.opts.debug) return undefined;
    const used = this.groupAttempts.get(name) ?? 1;
    const notPassed = g.members.filter((id) => this.statuses.get(id) !== 'passed');
    if (!notPassed.length || used > g.retry || this.stopReason) return undefined;
    const rerun = g.retryMembers === 'failed' ? notPassed : [...g.members];
    this.groupAttempts.set(name, used + 1);
    this.groups.delete(name); // BeforeGroup runs again
    for (const id of rerun) {
      const n = this.plan.byId.get(id)!;
      if (this.statuses.get(id) !== 'passed') this.failedBefore.add(id);
      this.statuses.delete(id);
      const s = n.scenario;
      if (inc(this.remaining.features, s.uri) === 1) this.features.delete(s.uri);
      if (s.rule && inc(this.remaining.rules, ruleKey(s)) === 1) this.rules.delete(ruleKey(s));
      for (const gg of this.realGroups(n)) if (inc(this.remaining.groups, gg) === 1) this.groups.delete(gg);
    }
    this.opts.bus.emit({ type: 'groupRetrying', group: name, attempt: used + 1, scenarioIds: rerun });
    this.debug(`group ${name}: attempt ${used + 1}/${g.retry + 1}, re-running ${rerun.length} scenario(s)`);
    return rerun;
  }

  private async runStep(
    step: StepInstance,
    scenario: ScenarioInstance,
    ctx: StepContext,
    tagNames: string[],
    blocked: boolean,
    deadline?: number,
    scenarioTimeoutMs?: number,
  ): Promise<{ status: Status; error?: unknown; skipReason?: string }> {
    const { bus, registry } = this.opts;
    const started = Date.now();
    const info: CurrentStepInfo = { id: step.id, keyword: step.keyword, text: step.text, line: step.line, attempt: 1, of: 1 };
    ctx.step = info;
    const ids: Emitters = { scenarioId: scenario.id, stepId: step.id };
    this.currentIds(ctx).stepId = step.id;
    bus.emit({ type: 'stepStarted', scenarioId: scenario.id, stepId: step.id, keyword: step.keyword, text: step.text, line: step.line });

    const match = await registry.match(step.text, tagNames).catch((e: unknown) => ({ kind: 'error' as const, error: e }));
    const finish = (
      status: Status,
      extra: {
        error?: unknown;
        definition?: { pattern: string; location?: string };
        candidates?: string[];
        snippet?: string;
        skipReason?: string;
        attempts?: number;
        mode?: 'repeat' | 'retry';
      } = {},
    ) => {
      bus.emit({
        type: 'stepFinished',
        scenarioId: scenario.id,
        stepId: step.id,
        status,
        durationMs: Date.now() - started,
        ...(extra.error !== undefined ? { error: toErrorInfo(extra.error) } : {}),
        ...(extra.definition ? { definition: extra.definition } : {}),
        ...(extra.candidates ? { candidates: extra.candidates } : {}),
        ...(extra.snippet ? { snippet: extra.snippet } : {}),
        ...(extra.mode ? { mode: extra.mode, attempts: extra.attempts! } : {}),
      });
      return { status, ...(extra.error !== undefined ? { error: extra.error } : {}), ...(extra.skipReason ? { skipReason: extra.skipReason } : {}) };
    };

    if (match.kind === 'error') return finish('failed', { error: match.error });
    if (match.kind === 'undefined') return finish('undefined', { snippet: registry.snippetFor(step) });
    if (match.kind === 'ambiguous') {
      return finish('ambiguous', {
        candidates: match.candidates.map((c) => `${String(c.pattern)}${c.location ? ` (${c.location})` : ''}`),
        error: new Error(
          `Ambiguous step "${step.text}" matches ${match.candidates.length} definitions:\n` +
            match.candidates.map((c) => `  - ${String(c.pattern)}${c.location ? ` at ${c.location}` : ''}`).join('\n'),
        ),
      });
    }
    const definition = { pattern: String(match.definition.pattern), ...(match.definition.location ? { location: match.definition.location } : {}) };
    if (blocked) return finish('skipped', { definition });
    if (this.opts.debug?.beforeStep && !this.signal.aborted) {
      const go = await this.opts.debug.beforeStep(this.debugView(step, scenario, ctx));
      if (go === 'quit') return finish('skipped', { definition, skipReason: 'debug session ended' });
    }

    // ---- repeat / retry policy: step tags (incl. scenario @stepRetry…) > step definition `retry` option
    const run = step.run ?? {};
    const defRetry = normaliseRetry(match.definition.retry);
    const repeat = run.repeat ?? 1;
    const retries = run.repeat !== undefined ? 0 : (run.retry ?? defRetry.attempts ?? 0);
    const mode: 'repeat' | 'retry' | undefined = run.repeat !== undefined ? 'repeat' : retries > 0 ? 'retry' : undefined;
    const baseDelay = run.delayMs ?? defRetry.delayMs ?? 0;
    const backoff = run.backoff ?? defRetry.backoff ?? 1;
    const stepTimeout = this.opts.debug ? 0 : (run.timeoutMs ?? match.definition.timeoutMs ?? registry.defaultTimeoutMs);
    // A scenario @timeout caps every attempt to the time left.
    const budget = () => (deadline ? Math.max(1, deadline - Date.now()) : Infinity);
    const timeoutFor = () => {
      const left = budget();
      return !stepTimeout || stepTimeout <= 0 ? (Number.isFinite(left) ? left : 0) : Math.min(stepTimeout, left);
    };
    const total = mode === 'repeat' ? repeat : retries + 1;

    // before-step hooks: once per step (eachAttempt hooks run around every attempt instead)
    const outer = (h: HookDefinition) => !h.eachAttempt && tagFilter(tagNames)(h);
    const inner = (h: HookDefinition) => !!h.eachAttempt && tagFilter(tagNames)(h);
    const before = await this.runHooks('step', 'before', ctx, outer, ids);
    let status: Status = 'passed';
    let error: unknown;
    let skipReason: string | undefined;
    let attemptsRun = 0;

    const attemptOnce = async (n: number): Promise<{ status: Status; error?: unknown; skipReason?: string }> => {
      const text = substituteIteration(step.text, n, total);
      const actx = this.attemptContext(ctx, scenario.id, step, text, n, total, mode);
      const aids: Emitters = { ...ids };
      const t0 = Date.now();
      let st: Status = 'passed';
      let err: unknown;
      let reason: string | undefined;
      const hb = await this.runHooks('step', 'before', actx, inner, aids);
      if (hb.status !== 'passed') {
        st = hb.status;
        err = hb.error;
        reason = hb.skipReason;
      } else {
        try {
          // Text with {{i}} changes per iteration: match again (same definition expected).
          const m = text === step.text ? match : await registry.match(text, tagNames);
          if (m.kind !== 'match') throw new Error(`Step text "${text}" (iteration ${n}) no longer matches exactly one definition (${m.kind})`);
          const args: unknown[] = [...m.values];
          if (step.argument?.kind === 'dataTable') {
            args.push(new DataTable(step.argument.rows.map((r) => r.map((c) => substituteIteration(c, n, total)))));
          }
          if (step.argument?.kind === 'docString') {
            args.push(new DocString(substituteIteration(step.argument.content, n, total), step.argument.mediaType));
          }
          const t = timeoutFor();
          const scenarioCapped = deadline !== undefined && t < (stepTimeout > 0 ? stepTimeout : Infinity);
          const ret = await withTimeout(
            scenarioCapped ? `Scenario "${scenario.name}" (time budget ${scenarioTimeoutMs} ms) at step "${text}"` : `Step "${text}"${mode ? ` (${mode} ${n}/${total})` : ''}`,
            t,
            () => withLogger(actx.log, () => callWithFixtures(actx, m.definition.fn as never, args)),
            actx.signal,
          );
          if (ret === 'pending') st = 'pending';
          const soft = actx.soft.failures;
          if (st === 'passed' && soft.length) {
            throw new Error(`${soft.length} soft assertion(s) failed:\n${soft.map((f, k) => `  ${k + 1}) ${f.message.split('\n').join('\n     ')}`).join('\n')}`);
          }
        } catch (e) {
          ({ status: st, skipReason: reason } = classify(e));
          err = e;
        }
      }
      const ha = await this.runHooks('step', 'after', actx, inner, aids);
      if (ha.status === 'failed' && st === 'passed') {
        st = 'failed';
        err = ha.error;
      }
      attemptsRun++;
      if (mode) {
        bus.emit({
          type: 'stepAttemptFinished',
          scenarioId: scenario.id,
          stepId: step.id,
          attempt: n,
          of: total,
          mode,
          text,
          status: st,
          durationMs: Date.now() - t0,
          ...(err !== undefined && st === 'failed' ? { error: toErrorInfo(err) } : {}),
        });
      }
      return { status: st, ...(err !== undefined ? { error: err } : {}), ...(reason ? { skipReason: reason } : {}) };
    };

    if (before.status !== 'passed') {
      status = before.status;
      error = before.error;
      skipReason = before.skipReason;
    } else if (mode === 'repeat' && (run.concurrency ?? 1) > 1 && match.definition.concurrent === false) {
      status = 'failed';
      error = new Error(
        `@concurrency:${run.concurrency} is not allowed on "${String(match.definition.pattern)}": its definition is marked ` +
          `{ concurrent: false } (e.g. it drives a browser). Remove @concurrency to repeat it sequentially.`,
      );
    } else if (mode === 'repeat') {
      try {
        const r = await runRepeat(repeat, run.concurrency ?? 1, baseDelay, attemptOnce, ctx.signal);
        status = r.status;
        error = r.error;
        skipReason = r.skipReason;
      } catch (e) {
        status = 'failed';
        error = e;
      }
    } else {
      // single run or retry-until-pass
      let delay = baseDelay;
      for (let n = 1; n <= total; n++) {
        const r = await attemptOnce(n);
        status = r.status;
        error = r.error;
        skipReason = r.skipReason;
        if (status !== 'failed' || n === total) break; // only failures are retried
        if (delay > 0) {
          try {
            await abortableSleep(delay, ctx.signal);
          } catch (e) {
            status = 'failed';
            error = e;
            break;
          }
        }
        delay = Math.round(delay * backoff);
      }
    }
    if (this.opts.debug?.onFailure && status === 'failed' && before.status === 'passed' && !this.signal.aborted) {
      for (;;) {
        const act = await this.opts.debug.onFailure({ ...this.debugView(step, scenario, ctx), status, error });
        if (act !== 'retry' || this.signal.aborted) break;
        const r = await attemptOnce(total);
        status = r.status;
        error = r.error;
        skipReason = r.skipReason;
        if (status !== 'failed') break;
      }
    }
    const after = await this.runHooks('step', 'after', ctx, outer, ids);
    if (after.status === 'failed' && status === 'passed') {
      status = 'failed';
      error = after.error;
    }
    return finish(status, {
      definition,
      ...(error !== undefined && status !== 'skipped' ? { error } : {}),
      ...(skipReason ? { skipReason } : {}),
      ...(mode ? { attempts: attemptsRun, mode } : {}),
    });
  }

  private debugView(step: StepInstance, scenario: ScenarioInstance, ctx: StepContext): DebugStepView {
    return {
      scenario: {
        id: scenario.id,
        name: scenario.name,
        uri: scenario.uri,
        line: scenario.line,
        tags: scenario.tags.map((t) => t.name),
        ...(scenario.example ? { example: scenario.example.values } : {}),
      },
      step: {
        index: scenario.steps.indexOf(step) + 1,
        total: scenario.steps.length,
        id: step.id,
        keyword: step.keyword,
        text: step.text,
        line: step.line,
        ...(step.argument ? { arg: step.argument } : {}),
      },
      ctx,
    };
  }

  /** A per-attempt view of the step context: own `step` info and a logger tagged with the attempt. */
  private attemptContext(
    ctx: StepContext,
    scenarioId: string,
    step: StepInstance,
    text: string,
    attempt: number,
    of: number,
    mode: 'repeat' | 'retry' | undefined,
  ): StepContext {
    const bus = this.opts.bus;
    const actx = Object.create(ctx) as StepContext;
    actx.step = { id: step.id, keyword: step.keyword, text, line: step.line, attempt, of, ...(mode ? { mode } : {}) };
    actx.soft = createSoftAssert();
    actx.log = createLogger((level, message, data, attachment) =>
      bus.emit({
        type: 'log',
        level,
        source: 'user',
        message,
        scenarioId,
        stepId: step.id,
        ...(mode ? { attempt } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(attachment ? { attachment } : {}),
      }),
    );
    return actx;
  }

  private skipScenario(scenario: ScenarioInstance, reason: string, workerId: string): Status {
    this.opts.bus.emit({ type: 'scenarioStarted', scenarioId: scenario.id, attempt: 1, workerId });
    this.lastStepStatuses.set(scenario.id, []);
    this.finishScenario(scenario, this.attemptsUsed.get(scenario.id) ?? 1, 'skipped', 0, undefined, reason, {
      quarantined: 'quarantine' in scenario.meta,
    });
    return 'skipped';
  }

  private finishScenario(
    scenario: ScenarioInstance,
    attempt: number,
    status: Status,
    durationMs: number,
    error?: unknown,
    reason?: string,
    extra: { willRetry?: boolean; quarantined?: boolean } = {},
  ) {
    const flaky = !extra.willRetry && status === 'passed' && this.failedBefore.has(scenario.id);
    if (flaky) this.flaky.add(scenario.id);
    else this.flaky.delete(scenario.id);
    if (!extra.willRetry) this.statuses.set(scenario.id, status);
    if (!this.lastStepStatuses.has(scenario.id)) this.lastStepStatuses.set(scenario.id, []);
    this.opts.bus.emit({
      type: 'scenarioFinished',
      scenarioId: scenario.id,
      attempt,
      status,
      durationMs,
      ...(error !== undefined && status !== 'skipped' ? { error: toErrorInfo(error) } : {}),
      ...(reason ? { reason } : {}),
      ...(extra.willRetry ? { willRetry: true } : {}),
      ...(flaky ? { flaky: true } : {}),
      ...(extra.quarantined ? { quarantined: true } : {}),
    });
  }

  // ---------------------------------------------------------------- hooks

  /**
   * Run every hook of (level, kind) whose tag filter passes.
   * Before-hooks stop at the first failure (except `alwaysRun` ones); after-hooks always all run.
   */
  private async runHooks(
    level: HookLevel,
    kind: 'before' | 'after',
    ctx: RunContext,
    filter: (hook: HookDefinition) => boolean,
    ids: Emitters & { uri?: string },
  ): Promise<HookOutcome & { hookName?: string }> {
    const { bus, registry } = this.opts;
    let result: HookOutcome & { hookName?: string } = { status: 'passed' };
    for (const hook of registry.hooksFor(level, kind)) {
      if (!filter(hook)) continue;
      if (kind === 'before' && result.status !== 'passed' && !hook.alwaysRun) continue;
      const started = Date.now();
      const base = {
        hookId: hook.id,
        hookName: hook.name,
        level,
        kind,
        ...(ids.scenarioId ? { scenarioId: ids.scenarioId } : {}),
        ...(ids.stepId ? { stepId: ids.stepId } : {}),
        ...(ids.uri ? { uri: ids.uri } : {}),
      };
      bus.emit({ type: 'hookStarted', ...base });
      let status: Status = 'passed';
      let error: unknown;
      let skipReason: string | undefined;
      try {
        await withTimeout(
          `Hook "${hook.name}"`,
          this.opts.debug ? 0 : (hook.timeoutMs ?? registry.defaultTimeoutMs),
          () => withLogger(ctx.log, () => callWithFixtures(ctx, hook.fn as never, [])),
          kind === 'before' ? ctx.signal : undefined,
        );
      } catch (e) {
        ({ status, skipReason } = classify(e));
        error = e;
      }
      bus.emit({
        type: 'hookFinished',
        ...base,
        status,
        durationMs: Date.now() - started,
        ...(error !== undefined && status === 'failed' ? { error: toErrorInfo(error) } : {}),
      });
      if (status !== 'passed' && result.status === 'passed') {
        result = { status, hookName: hook.name, ...(error !== undefined ? { error } : {}), ...(skipReason ? { skipReason } : {}) };
      }
    }
    return result;
  }

  private emitHookLikeError(level: HookLevel, kind: 'before' | 'after', name: string, error: unknown, ids: Emitters & { uri?: string }) {
    const base = {
      hookId: `cleanup-${level}`,
      hookName: name,
      level,
      kind,
      ...(ids.scenarioId ? { scenarioId: ids.scenarioId } : {}),
      ...(ids.uri ? { uri: ids.uri } : {}),
    };
    this.opts.bus.emit({ type: 'hookStarted', ...base });
    this.opts.bus.emit({ type: 'hookFinished', ...base, status: 'failed', durationMs: 0, error: toErrorInfo(error) });
  }

  // ---------------------------------------------------------------- contexts

  private readonly idsByCtx = new WeakMap<object, Emitters>();

  private currentIds(ctx: object): Emitters {
    return this.idsByCtx.get(ctx) ?? {};
  }

  private makeRunContext(scope: Scope, ids: Emitters, signal: AbortSignal = this.signal): RunContext {
    const bus = this.opts.bus;
    const base: RunContextBase = {
      run: scope.store,
      params: this.params,
      signal,
      log: createLogger((level, message, data, attachment) => {
        const cur = this.currentIds(ctx);
        bus.emit({
          type: 'log',
          level,
          source: 'user',
          message,
          ...(data !== undefined ? { data } : {}),
          ...(attachment ? { attachment } : {}),
          ...(cur.scenarioId ? { scenarioId: cur.scenarioId } : {}),
          ...(cur.stepId ? { stepId: cur.stepId } : {}),
        });
      }),
      attach: (body, mediaType = 'text/plain', name) => {
        const cur = this.currentIds(ctx);
        const binary = typeof body !== 'string';
        bus.emit({
          type: 'attachment',
          mediaType,
          encoding: binary ? 'base64' : 'identity',
          body: binary ? Buffer.from(body).toString('base64') : body,
          ...(name ? { name } : {}),
          ...(cur.scenarioId ? { scenarioId: cur.scenarioId } : {}),
          ...(cur.stepId ? { stepId: cur.stepId } : {}),
        });
      },
      defer: (fn) => scope.defer(fn),
      fixture: () => Promise.reject(new Error('fixtures not installed')), // replaced by installFixtures
    };
    // Fixture getters (ctx.page ...) are added by installFixtures.
    const ctx = base as RunContext;
    installFixtures(ctx, this.fixtureHost);
    this.idsByCtx.set(ctx, ids);
    return ctx;
  }

  private makeFeatureContext(
    runScope: Scope,
    featureScope: Scope,
    feature: FeatureInfo,
    rule: RuleRef | undefined,
    ids: Emitters,
    signal: AbortSignal = this.signal,
  ): FeatureContext {
    const base = this.makeRunContext(runScope, ids, signal);
    const ctx: FeatureContext = Object.assign(base, {
      feature: featureScope.store,
      featureInfo: feature,
      defer: (fn: () => unknown) => featureScope.defer(fn),
      ...(rule ? { rule } : {}),
    });
    this.idsByCtx.set(ctx, ids);
    return ctx;
  }

  private makeGroupContext(scope: Scope, name: string, signal: AbortSignal = this.signal): GroupContext {
    const base = this.makeRunContext(this.runScope, {}, signal);
    const ctx: GroupContext = Object.assign(base, {
      group: scope.store,
      groupName: name,
      defer: (fn: () => unknown) => scope.defer(fn),
    });
    return ctx;
  }

  private makeStepContext(
    runScope: Scope,
    featureScope: Scope,
    scope: Scope,
    s: ScenarioInstance,
    attempt: number,
    ids: Emitters,
    groupStores: Record<string, Store> = {},
    signal: AbortSignal = this.signal,
  ): StepContext {
    const base = this.makeFeatureContext(runScope, featureScope, s.feature, s.rule, ids, signal);
    const ctx: StepContext = Object.assign(base, {
      scenario: {
        id: s.id,
        name: s.name,
        uri: s.uri,
        line: s.line,
        featureName: s.feature.name,
        ...(s.rule ? { ruleName: s.rule.name } : {}),
        tags: s.tags.map((t) => t.name),
        meta: { ...s.meta },
        ...(s.example ? { example: { ...s.example.values } } : {}),
        attempt,
      },
      state: scope.store,
      soft: createSoftAssert(),
      groups: Object.freeze({ ...groupStores }),
      export: (key: string, value: unknown) => {
        let copy: unknown;
        try {
          copy = structuredClone(value);
        } catch {
          throw new Error(`ctx.export("${key}"): value must be serialisable (structured clone): plain data only`);
        }
        const bucket = this.exportsById.get(s.id) ?? {};
        bucket[key] = copy;
        this.exportsById.set(s.id, bucket);
      },
      from: (id: string) => {
        if (!this.statuses.has(id)) {
          const known = this.plan.byId.has(id);
          throw new Error(
            known
              ? `ctx.from("${id}"): that scenario has not finished yet. Add @dependsOn:${id} to wait for it.`
              : `ctx.from("${id}"): no scenario with this id in the plan`,
          );
        }
        const bucket = this.exportsById.get(id) ?? {};
        return {
          get: <T = unknown>(key: string): T => {
            if (!(key in bucket)) throw new Error(`Scenario "${id}" did not export "${key}". Exported: [${Object.keys(bucket).join(', ')}]`);
            return structuredClone(bucket[key]) as T;
          },
          has: (key: string) => key in bucket,
          keys: () => Object.keys(bucket),
        };
      },
      defer: (fn: () => unknown) => scope.defer(fn),
      pending: (reason?: string): never => {
        throw new PendingSignal(reason);
      },
      skip: (reason?: string): never => {
        throw new SkipSignal(reason);
      },
    });
    this.idsByCtx.set(ctx, ids);
    return ctx;
  }
}

// ------------------------------------------------------------------ helpers

function classify(e: unknown): { status: Status; skipReason?: string } {
  if (e instanceof PendingSignal) return { status: 'pending' };
  if (e instanceof SkipSignal) return { status: 'skipped', skipReason: e.reason };
  return { status: 'failed' };
}

function tagFilter(tagNames: readonly string[]) {
  return (hook: HookDefinition) => !hook.tags || compileTagExpression(hook.tags)(tagNames);
}

function ruleTags(rule: RuleRef): string[] {
  return rule.tags.map((t) => t.name);
}

function createSoftAssert(): SoftAssert {
  const failures: Error[] = [];
  const record = (e: unknown): void => {
    failures.push(e instanceof Error ? e : new Error(String(e)));
  };
  return {
    failures,
    check(condition, message) {
      if (!condition) failures.push(new Error(message));
    },
    run(fn) {
      try {
        const r = fn();
        if (r && typeof (r as Promise<unknown>).then === 'function') return (r as Promise<unknown>).then(() => undefined, record);
      } catch (e) {
        record(e);
      }
      return undefined;
    },
  };
}

/** `@timeout:<duration>` on a scenario (feature/rule tags inherited). */
function scenarioTimeout(s: ScenarioInstance): number | undefined {
  const v = s.meta['timeout'];
  if (!v || v === 'true') return undefined;
  try {
    return parseDuration(v);
  } catch {
    return undefined;
  }
}

/** `{{i}}` / `{{iteration}}` = 1-based repetition or attempt number; `{{n}}` / `{{total}}` = how many. */
export function substituteIteration(text: string, i: number, n: number): string {
  return text.replace(/\{\{\s*(i|iteration|n|total)\s*\}\}/g, (_, k: string) => String(k === 'i' || k === 'iteration' ? i : n));
}

function normaliseRetry(r: StepRetryOption | undefined): { attempts?: number; delayMs?: number; backoff?: number } {
  if (r === undefined) return {};
  if (typeof r === 'number') return { attempts: r };
  const delayMs = typeof r.delay === 'string' ? parseDuration(r.delay) : r.delay;
  return { attempts: r.attempts, ...(delayMs !== undefined ? { delayMs } : {}), ...(r.backoff !== undefined ? { backoff: r.backoff } : {}) };
}

/**
 * Run `attempt(1..n)` with up to `concurrency` in flight, `delayMs` between starts.
 * Stops starting new repetitions after the first non-passed result; returns the first such result.
 */
async function runRepeat(
  n: number,
  concurrency: number,
  delayMs: number,
  attempt: (i: number) => Promise<{ status: Status; error?: unknown; skipReason?: string }>,
  signal?: AbortSignal,
): Promise<{ status: Status; error?: unknown; skipReason?: string }> {
  let next = 1;
  let first: { status: Status; error?: unknown; skipReason?: string } | undefined;
  const inflight = new Set<Promise<void>>();
  try {
    while (next <= n && !first) {
      while (inflight.size < concurrency && next <= n && !first) {
        const i = next++;
        const p: Promise<void> = attempt(i).then((r) => {
          if (r.status !== 'passed' && !first) first = r;
          inflight.delete(p);
        });
        inflight.add(p);
        if (delayMs > 0 && next <= n) await abortableSleep(delayMs, signal);
      }
      if (inflight.size) await Promise.race(inflight);
    }
  } catch (e) {
    await Promise.all(inflight);
    throw e;
  }
  await Promise.all(inflight);
  return first ?? { status: 'passed' };
}

function inc(m: Map<string, number>, k: string): number {
  const v = (m.get(k) ?? 0) + 1;
  m.set(k, v);
  return v;
}

function dec(m: Map<string, number>, k: string): number {
  const v = (m.get(k) ?? 0) - 1;
  m.set(k, v);
  return v;
}

function ruleKey(s: ScenarioInstance): string {
  return `${s.uri}#${s.rule?.id ?? ''}`;
}

/** Group hooks: no `tags` = every group; otherwise the expression sees `@group:<name>` and `@<name>`. */
function groupFilter(name: string) {
  return (hook: HookDefinition) => !hook.tags || compileTagExpression(hook.tags)([`@group:${name}`, `@${name}`]);
}

function plannedScenario(n: PlanNode) {
  const s = n.scenario;
  return {
    id: s.id,
    keyword: s.keyword,
    name: s.name,
    description: s.description,
    feature: {
      name: s.feature.name,
      description: s.feature.description,
      line: s.feature.line,
      tags: s.feature.tags.map((t) => t.name),
      language: s.feature.language,
    },
    uri: s.uri,
    line: s.line,
    featureName: s.feature.name,
    ...(s.rule ? { ruleName: s.rule.name } : {}),
    ...(s.example
      ? {
          example: {
            name: s.example.name,
            index: s.example.index,
            values: s.example.values,
            ...(s.example.source ? { source: s.example.source, sourceRow: s.example.sourceRow! } : {}),
          },
        }
      : {}),
    tags: s.tags.map((t) => t.name),
    steps: s.steps.map((st) => ({ id: st.id, keyword: st.keyword, text: st.text, line: st.line, ...(st.argument ? { arg: st.argument } : {}) })),
    groups: n.groups,
    dependsOn: n.deps.map((d) => ({ id: d.target, soft: d.soft })),
    locks: n.locks,
    priority: n.priority,
    exclusive: n.exclusive,
    ...(n.pulledInBy ? { pulledInBy: n.pulledInBy } : {}),
  };
}

/** Convenience wrapper: `await execute(scenarios, { registry, bus })`. */
export function execute(scenarios: readonly ScenarioInstance[], options: ExecuteOptions): Promise<ExecuteResult> {
  return new Executor(options).execute(scenarios);
}

export type { ErrorInfo };
