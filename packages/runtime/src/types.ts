import type { FeatureInfo, HookKind, HookLevel, RuleRef } from '@bddr/core';
import type { Cleanup, Store } from './context.js';
import type { Logger } from './logger.js';
import type { Fixtures } from './fixtures.js';

export interface ScenarioInfo {
  id: string;
  name: string;
  uri: string;
  line: number;
  featureName: string;
  ruleName?: string;
  /** Tag names as written, e.g. ['@smoke', '@owner:payments']. */
  tags: string[];
  /** Key/value view of tags. */
  meta: Record<string, string>;
  /** Outline row values, when the scenario came from Examples. */
  example?: Record<string, string>;
  /** 1 for the first attempt; increases with retries (phase 4). */
  attempt: number;
  /** Set when the scenario runs in file order within its feature (@serial Feature, featureMode) or rule (@serial Rule). */
  serial?: 'feature' | 'rule';
}

export interface CurrentStepInfo {
  id: string;
  keyword: string;
  /** Step text for this attempt ({{i}}/{{n}} already substituted). */
  text: string;
  line: number;
  /** 1-based repetition (@repeat) or attempt (@retry) number; 1 for normal steps. */
  attempt: number;
  /** Total repetitions, or max attempts for @retry; 1 for normal steps. */
  of: number;
  mode?: 'repeat' | 'retry';
}

/** Retry default on a step definition: a number of extra attempts, or the full form. Step tags override it. */
export type StepRetryOption = number | { attempts: number; delay?: number | string; backoff?: number };

/** Context for run-level hooks (BeforeAll / AfterAll). */
/** Context for run-level hooks, plus every fixture (`ctx.page` ...; see `Fixtures`). */
export interface RunContext extends RunContextBase, Fixtures {}

/** The run context without fixtures. */
export interface RunContextBase {
  /** Run-scoped store, shared by everything in this process. */
  run: Store;
  /** User data from config `params` and CLI `-D key=value`. */
  params: Readonly<Record<string, string>>;
  /** Aborted when the run, group or current scenario is cancelled. Pass to cancellable user APIs. */
  signal: AbortSignal;
  /** Levelled logger: ctx.log(msg) = info; ctx.log.debug/info/warn/error(msg, data?). */
  log: Logger;
  attach(body: string | Uint8Array, mediaType?: string, name?: string): void;
  /** Register cleanup for the current scope (LIFO, runs even after failures). */
  defer(fn: Cleanup): void;
  /** Create (or get) a fixture by name. Usually you destructure it instead: `async ({ page }) => ...`. */
  fixture<K extends keyof Fixtures>(name: K): Promise<Fixtures[K]>;
  fixture<T = unknown>(name: string): Promise<T>;
}

/** Context for group-level hooks (BeforeGroup / AfterGroup). */
export interface GroupContext extends RunContext {
  /** Group-scoped store, shared by the group's hooks and visible to members as ctx.groups[name]. */
  group: Store;
  groupName: string;
}

export interface SoftAssert {
  /** Record a failure when `condition` is falsy. */
  check(condition: unknown, message: string): void;
  /** Run an assertion; a thrown error is recorded instead of failing immediately. */
  run(fn: () => unknown): void | Promise<void>;
  /** Failures recorded so far in this step. */
  readonly failures: readonly Error[];
}

/** Input to a custom retry decision (TestNG IRetryAnalyzer style). */
export interface RetryContext {
  scenario: ScenarioInfo;
  /** The attempt that just failed (1-based). */
  attempt: number;
  maxRetries: number;
  error?: { name?: string; message: string };
}

/** Return false to stop retrying. Called only when a retry is otherwise allowed. */
export type RetryAnalyzer = (failure: RetryContext) => boolean | Promise<boolean>;

/** Read-only view of another scenario's exports. */
export interface ExportsView {
  get<T = unknown>(key: string): T;
  has(key: string): boolean;
  keys(): string[];
}

/** Context for feature- and rule-level hooks. */
export interface FeatureContext extends RunContext {
  /** Feature-scoped store, cleared after the feature. */
  feature: Store;
  featureInfo: FeatureInfo;
  rule?: RuleRef;
}

/** Context for steps and scenario/step hooks. Always the FIRST argument of a step function. */
export interface StepContext extends FeatureContext {
  scenario: ScenarioInfo;
  /** Scenario-scoped store (the "world"). Fresh for every scenario and every attempt. */
  state: Store;
  /** Stores of the named groups this scenario belongs to. */
  groups: Readonly<Record<string, Store>>;
  /** Publish a value for scenarios that depend on this one (deep-copied; plain data only). */
  export(key: string, value: unknown): void;
  /** Read the exports of a FINISHED scenario (declare @dependsOn:<id> so it finishes first). */
  from(scenarioId: string): ExportsView;
  /** The current step (only inside steps and step hooks). */
  step?: CurrentStepInfo;
  /**
   * Soft assertions: failures are collected and the step fails at its end with all of them.
   *   ctx.soft.check(total === 10, 'total is 10');
   *   ctx.soft.run(() => assert.equal(a, b));          // any assertion library
   *   await ctx.soft.run(async () => expect(...));
   */
  soft: SoftAssert;
  /** Mark the current step pending. */
  pending(reason?: string): never;
  /** Skip the rest of the scenario. */
  skip(reason?: string): never;
}

export type StepFn = (ctx: StepContext, ...args: any[]) => unknown | Promise<unknown>;

export interface StepOptions {
  /** Tag expression: the definition only matches in scenarios whose tags satisfy it. */
  tags?: string;
  timeoutMs?: number;
  /** Default retry for this step (retry until it passes): `3` or `{ attempts: 3, delay: '1s', backoff: 2 }`. */
  retry?: StepRetryOption;
  /**
   * Set false for steps that must never run in parallel with themselves (e.g. they drive a browser page or a
   * Selenium session, which are not safe for concurrent calls). `@concurrency` on such a step is an error.
   * Default true (allowed, but steps still run one at a time unless `@concurrency` is used).
   */
  concurrent?: boolean;
}

export interface HookOptions {
  name?: string;
  /** Tag expression filter (scenario/step hooks: scenario tags; feature hooks: feature tags; rule hooks: rule tags). */
  tags?: string;
  /** Lower runs first for before-hooks; after-hooks run in reverse order. Default 0. */
  order?: number;
  /** Before-hooks only: run even when an earlier before-hook at this level failed. */
  alwaysRun?: boolean;
  /** Step hooks only: run around EVERY repetition/attempt of @repeat/@retry steps (default: once per step). */
  eachAttempt?: boolean;
  timeoutMs?: number;
}

export type RunHookFn = (ctx: RunContext) => unknown | Promise<unknown>;
export type FeatureHookFn = (ctx: FeatureContext) => unknown | Promise<unknown>;
export type GroupHookFn = (ctx: GroupContext) => unknown | Promise<unknown>;
export type ScenarioHookFn = (ctx: StepContext) => unknown | Promise<unknown>;

export type AnyHookFn = RunHookFn | GroupHookFn | FeatureHookFn | ScenarioHookFn;

export interface HookDefinition {
  id: string;
  name: string;
  level: HookLevel;
  kind: HookKind;
  tags?: string;
  order: number;
  alwaysRun: boolean;
  eachAttempt?: boolean;
  timeoutMs?: number;
  fn: AnyHookFn;
  location?: string;
  /** Registration sequence, used as tie-breaker. */
  seq: number;
}
