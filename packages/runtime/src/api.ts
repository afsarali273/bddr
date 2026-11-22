/**
 * The public, global registration API used in step files:
 *
 *   import { Given, When, Then, Before, defineParameterType } from '@bddr/runtime';
 *
 *   Given('I have {int} cukes', async (ctx, count: number) => {
 *     ctx.state.set('cukes', count);
 *   });
 *
 * Every function writes to the global SupportRegistry (see registry.ts).
 */
import { callerLocation, getGlobalRegistry, type ParameterTypeOptions } from './registry.js';
import type { Fixtures, FixtureOptions } from './fixtures.js';
import { hookDecorator, staticHookDecorator, stepDecorator, type MethodDecorator } from './decorators.js';
import type {
  FeatureHookFn,
  GroupHookFn,
  RetryAnalyzer,
  HookOptions,
  RunHookFn,
  ScenarioHookFn,
  StepFn,
  StepOptions,
  RunContext,
  StepContext,
  FeatureContext,
} from './types.js';
import type { HookKind, HookLevel } from '@bddr/core';

type StepRegistrar = {
  (pattern: string | RegExp, fn: StepFn): void;
  (pattern: string | RegExp, options: StepOptions, fn: StepFn): void;
  /** Without a function: a method decorator for `@Steps()` classes. */
  (pattern: string | RegExp, options?: StepOptions): MethodDecorator;
};

function makeStepRegistrar(): StepRegistrar {
  return ((pattern: string | RegExp, a?: StepOptions | StepFn, b?: StepFn) => {
    const location = callerLocation();
    const [options, fn] = typeof a === 'function' ? [{}, a] : [a ?? {}, b];
    if (!fn) return stepDecorator(pattern, options, location);
    getGlobalRegistry().defineStep(pattern, fn, options, location);
    return undefined;
  }) as StepRegistrar;
}

/** Given / When / Then / Step are interchangeable for matching (like Cucumber). */
export const Given = makeStepRegistrar();
export const When = makeStepRegistrar();
export const Then = makeStepRegistrar();
export const Step = makeStepRegistrar();

type HookArg = HookOptions | string | undefined;

function normalise(opts: HookArg): HookOptions {
  if (opts === undefined) return {};
  return typeof opts === 'string' ? { tags: opts } : opts;
}

function makeHook<F>(level: HookLevel, kind: HookKind) {
  function register(fn: F): void;
  function register(options: HookOptions | string, fn: F): void;
  /** Without a function: a method decorator (static methods: any level; instance methods in @Steps classes: scenario/step). */
  function register(options?: HookOptions | string): MethodDecorator;
  function register(a?: F | HookOptions | string, b?: F): void | MethodDecorator {
    const location = callerLocation();
    const [opts, fn] = typeof a === 'function' ? [undefined, a as F] : [a as HookArg, b];
    if (!fn) {
      return level === 'scenario' || level === 'step'
        ? hookDecorator(level, kind, normalise(opts), location)
        : staticHookDecorator(level, kind, normalise(opts), location);
    }
    getGlobalRegistry().defineHook(level, kind, normalise(opts), fn as never, location);
  }
  return register;
}

/** Once per run, before anything else. */
export const BeforeAll = makeHook<RunHookFn>('run', 'before');
/** Once per run, after everything (always runs). */
export const AfterAll = makeHook<RunHookFn>('run', 'after');
/**
 * Before the first member of a group starts / after its last member finishes.
 * `tags` filter sees `@group:<name>` (e.g. BeforeGroup('@group:checkout', fn)); none = every group.
 */
export const BeforeGroup = makeHook<GroupHookFn>('group', 'before');
export const AfterGroup = makeHook<GroupHookFn>('group', 'after');
/** Before the first scenario of each feature. `tags` filters on FEATURE tags. */
export const BeforeFeature = makeHook<FeatureHookFn>('feature', 'before');
export const AfterFeature = makeHook<FeatureHookFn>('feature', 'after');
/** Before the first scenario of each Rule. `tags` filters on rule tags. */
export const BeforeRule = makeHook<FeatureHookFn>('rule', 'before');
export const AfterRule = makeHook<FeatureHookFn>('rule', 'after');
/** Before every scenario (every attempt). `tags` filters on scenario tags. */
export const Before = makeHook<ScenarioHookFn>('scenario', 'before');
export const After = makeHook<ScenarioHookFn>('scenario', 'after');
/** Around every step. */
export const BeforeStep = makeHook<ScenarioHookFn>('step', 'before');
export const AfterStep = makeHook<ScenarioHookFn>('step', 'after');

/**
 * Once per process that runs scenarios: with `pool: 'process'` in every worker process (start / end), with the
 * default inline pool once per run (right after BeforeAll / before AfterAll). Put per-process resources here
 * (browser instances, DB connections, servers on BDDR_WORKER_INDEX-based ports); `ctx.run` is that process's store.
 */
export const BeforeWorker = makeHook<RunHookFn>('worker', 'before');
export const AfterWorker = makeHook<RunHookFn>('worker', 'after');

/** TestNG-style aliases. Suite = the whole run: BeforeAll runs once, in the parent process, even with worker processes. */
export const BeforeSuite = BeforeAll;
export const AfterSuite = AfterAll;
export const BeforeScenario = Before;
export const AfterScenario = After;

type FixtureType<K> = K extends keyof Fixtures ? Fixtures[K] : unknown;

/**
 * Define a fixture: a named value created on first use and torn down at the end of its scope.
 *   defineFixture('page', async ({ browser }) => browser.newPage(), { teardown: (p) => p.close() });
 *   defineFixture('browser', () => chromium.launch(), { scope: 'worker', teardown: (b) => b.close() });
 * See fixtures.ts for scopes and the ways to request one.
 */
export function defineFixture<K extends string, T = FixtureType<K>>(
  name: K,
  setup: (ctx: RunContext) => T | Promise<T>,
  options: FixtureOptions<T> & { scope: 'worker' },
): void;
export function defineFixture<K extends string, T = FixtureType<K>>(
  name: K,
  setup: (ctx: FeatureContext) => T | Promise<T>,
  options: FixtureOptions<T> & { scope: 'feature' },
): void;
export function defineFixture<K extends string, T = FixtureType<K>>(
  name: K,
  setup: (ctx: StepContext) => T | Promise<T>,
  options?: FixtureOptions<T> & { scope?: 'scenario' },
): void;
export function defineFixture(name: string, setup: (ctx: never) => unknown, options: FixtureOptions<unknown> = {}): void {
  getGlobalRegistry().defineFixture(name, setup, options, callerLocation());
}

/**
 * A plugin bundles fixtures, hooks, steps and parameter types (Playwright, Selenium, HTTP ...). bddr itself depends
 * on none of them. Enable one in the config: `plugins: ['@bddr/playwright', ['./support/my-plugin.ts', { opt: 1 }]]`.
 * `setup` runs once per process (the main process and every worker process) before the step files load.
 */
export interface BddrPlugin<O = Record<string, unknown>> {
  name: string;
  setup(options: O): void | Promise<void>;
}

export function definePlugin<O = Record<string, unknown>>(plugin: BddrPlugin<O>): BddrPlugin<O> {
  if (!plugin || typeof plugin.setup !== 'function' || !plugin.name) throw new Error('definePlugin needs { name, setup(options) }');
  return plugin;
}

export function defineParameterType<T>(options: ParameterTypeOptions<T>): void {
  getGlobalRegistry().defineParameterType(options);
}

/**
 * Custom scenario-retry decision, TestNG IRetryAnalyzer style. Called after a failed attempt when a retry is
 * allowed by @retry / config; return false to stop retrying (e.g. only retry network errors).
 */
export function setRetryAnalyzer(analyzer: RetryAnalyzer | undefined): void {
  getGlobalRegistry().retryAnalyzer = analyzer;
}

/** Default timeout (ms) for steps and hooks without their own `timeoutMs`. 0 disables. */
export function setDefaultTimeout(ms: number): void {
  getGlobalRegistry().defaultTimeoutMs = ms;
}
