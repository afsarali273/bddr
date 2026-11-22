/**
 * Fixtures: named, lazily created values that steps and hooks receive instead of wiring things up by hand.
 *
 *   defineFixture('browser', () => chromium.launch(), { scope: 'worker', teardown: (b) => b.close() });
 *   defineFixture('page', async ({ browser }) => browser.newPage(), { teardown: (p) => p.close() });
 *   defineFixture('login', ({ page }) => new LoginPage(page));
 *
 *   Given('I log in as {string}', ({ login }, user: string) => login.as(user));
 *
 * Scopes:
 *   'scenario' (default)  one value per scenario attempt (a retry gets a fresh one); torn down when it ends.
 *   'feature'             one value per feature in a worker process, created on first use, torn down when the feature
 *                         ends (after AfterFeature hooks). Share a browser session across a @serial feature with it;
 *                         a @serial feature always runs in one worker process. In a parallel feature, scenarios
 *                         running at the same time get the same value: only share things that tolerate that.
 *   'worker'              one value per worker PROCESS, created on first use, torn down after AfterWorker hooks.
 *                         With pool 'inline' the run is one process, so concurrent scenarios share it (a browser,
 *                         a connection pool); with pool 'process' every worker process has its own.
 * Fixtures never change scheduling: groups, dependencies, locks, retries, sharding and the process pool behave exactly
 * as before. A fixture is only created when something asks for it.
 *
 * How a fixture is requested:
 *   - destructure it in the first parameter of a step, hook or fixture setup: `async ({ page }, text) => ...`
 *     (bddr reads the parameter list, like Playwright Test, and creates those fixtures before calling the function);
 *   - `await ctx.fixture('page')` anywhere;
 *   - `inject('page')` in a class field or constructor (`@Steps()` classes, page objects created by `inject(Class)`).
 * Reading `ctx.page` without requesting it works for fixtures whose setup is synchronous or already created;
 * otherwise it throws an error that says how to request it.
 */
import type { RunContext, StepContext } from './types.js';

/** Fixture name -> type. Augment it to type your fixtures on `ctx` and `inject()`:
 *    declare module '@bddr/runtime' { interface Fixtures { page: import('playwright').Page } } */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Fixtures {}

export type FixtureScope = 'scenario' | 'feature' | 'worker';

export interface FixtureOptions<T> {
  scope?: FixtureScope;
  /** Runs when the scope ends (LIFO: dependents are torn down before what they depend on). */
  teardown?: (value: T, ctx: FixtureTeardownContext) => unknown | Promise<unknown>;
  /**
   * Feature and worker fixtures: called at the end of every scenario that used the fixture, with that scenario's
   * status and context (e.g. a screenshot of a shared page when the scenario failed). Runs before scenario teardowns.
   */
  afterScenario?: (value: T, ctx: FixtureTeardownContext) => unknown | Promise<unknown>;
}

export interface FixtureTeardownContext {
  /** The scenario's final status (scenario fixtures only), e.g. to keep a screenshot or trace only when it failed. */
  status?: 'passed' | 'failed' | 'skipped' | 'pending' | 'undefined' | 'ambiguous';
  error?: unknown;
  /** The context the fixture was created with: `ctx.attach(...)` / `ctx.log(...)` land in the scenario (or the run). */
  ctx: RunContext | StepContext;
}

export type ScenarioFixtureSetup<T> = (ctx: StepContext & Fixtures) => T | Promise<T>;
export type WorkerFixtureSetup<T> = (ctx: RunContext & Fixtures) => T | Promise<T>;

export interface FixtureDefinition {
  name: string;
  scope: FixtureScope;
  setup: (ctx: never) => unknown;
  teardown?: (value: never, ctx: FixtureTeardownContext) => unknown;
  afterScenario?: (value: never, ctx: FixtureTeardownContext) => unknown;
  /** Fixtures destructured in the setup's first parameter. */
  deps: string[];
  location?: string;
}

/** Names that are already properties of the step context. */
export const RESERVED = new Set([
  'run', 'params', 'signal', 'log', 'attach', 'defer', 'feature', 'featureInfo', 'rule', 'scenario', 'state', 'groups',
  'export', 'from', 'step', 'soft', 'pending', 'skip', 'fixture', 'group', 'groupName', 'then', 'constructor',
]);

/** Thrown by `inject('name')` / `ctx.name` when an async fixture is not ready; the class wrapper creates it and retries. */
export class FixtureNotReady extends Error {
  constructor(readonly fixture: string) {
    super(
      `Fixture "${fixture}" is asynchronous and was not requested before use. Request it by destructuring it in the ` +
        `parameter list (({ ${fixture} }) => ...), with "await ctx.fixture('${fixture}')", or with inject('${fixture}') in a @Steps() class.`,
    );
    this.name = 'FixtureNotReady';
  }
}

// ------------------------------------------------------------------ reading parameter lists

const cache = new WeakMap<object, string[]>();

/**
 * Fixture names a function asks for through its FIRST parameter:
 *   `async ({ page, login: l, x = 1 }, a) => ...`  -> page, login, x   (destructuring)
 *   `async (ctx) => ctx.page.goto(...)`             -> page             (property reads on the parameter)
 *   `(ctx) => { const { page } = ctx; ... }`        -> page
 * Only names that are defined fixtures are used, so `ctx.state` and friends are ignored. A fixture read inside an
 * `if` is created even when the branch does not run.
 */
export function destructuredNames(fn: (...a: never[]) => unknown): string[] {
  const hit = cache.get(fn);
  if (hit) return hit;
  const names = parse(Function.prototype.toString.call(fn));
  cache.set(fn, names);
  return names;
}

function parse(src: string): string[] {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const open = s.indexOf('(');
  const arrow = s.indexOf('=>');
  // `ctx => ...` (no parentheses)
  if (open < 0 || (arrow >= 0 && arrow < open)) {
    const m = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(s);
    return m ? uses(s.slice(arrow + 2), m[1]!) : [];
  }
  const rest = s.slice(open + 1);
  const first = rest.trimStart();
  if (first.startsWith('{')) {
    const end = matching(first, 0);
    return end < 0 ? [] : keysOf(first.slice(1, end));
  }
  // `(ctx, a) => ...` / `function (ctx)`: look for ctx.name and `const { name } = ctx` in the body
  const m = /^([A-Za-z_$][\w$]*)/.exec(first);
  if (!m) return [];
  const close = matching(s, open);
  return close < 0 ? [] : uses(s.slice(close + 1), m[1]!);
}

/** Index of the bracket closing the one at `from`, or -1. */
function matching(s: string, from: number): number {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Property names in a destructuring pattern body: `page, login: l, x = 1, ...rest` -> page, login, x. */
function keysOf(body: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  for (const c of body) {
    if (c === '{' || c === '[' || c === '(') depth++;
    if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('...'))
    .map((p) => p.split(/[:=]/)[0]!.trim().replace(/^['"]|['"]$/g, ''))
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
}

/** `ctx.page`, `ctx?.page`, `const { page } = ctx` in a function body. */
function uses(body: string, param: string): string[] {
  const names = new Set<string>();
  const id = param.replace(/\$/g, '\\$');
  for (const m of body.matchAll(new RegExp(`(?<![\\w$.])${id}\\??\\.([A-Za-z_$][\\w$]*)`, 'g'))) names.add(m[1]!);
  for (const m of body.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${id}(?![\\w$])`, 'g'))) for (const k of keysOf(m[1]!)) names.add(k);
  return [...names];
}

// ------------------------------------------------------------------ caches

interface Entry {
  value?: unknown;
  ready: boolean;
  promise?: Promise<unknown>;
}

/** Values of one scope (one scenario attempt, or one worker process). */
export class FixtureCache {
  private readonly entries = new Map<string, Entry>();
  private readonly order: Array<{ def: FixtureDefinition; value: unknown; ctx: RunContext | StepContext }> = [];
  private closed = false;
  /** Scenario caches: longer-lived fixtures this scenario used that want an afterScenario call. */
  private readonly touched = new Map<string, { def: FixtureDefinition; value: unknown }>();

  /** @param context  for feature caches: the feature context their setups and teardowns receive. */
  constructor(readonly scope: FixtureScope, readonly context?: RunContext) {}

  touch(def: FixtureDefinition, value: unknown): void {
    if (def.afterScenario && !this.touched.has(def.name)) this.touched.set(def.name, { def, value });
  }

  has(name: string): boolean {
    return !!this.entries.get(name)?.ready;
  }

  peek(name: string): unknown {
    return this.entries.get(name)?.value;
  }

  get(def: FixtureDefinition, ctx: RunContext | StepContext, create: () => unknown): unknown {
    if (this.closed) throw new Error(`Fixture "${def.name}" requested after its ${this.scope} scope ended`);
    const e = this.entries.get(def.name);
    if (e?.ready) return e.value;
    if (e?.promise) return e.promise;
    const entry: Entry = { ready: false };
    this.entries.set(def.name, entry);
    let out: unknown;
    try {
      out = create();
    } catch (err) {
      this.entries.delete(def.name);
      throw err;
    }
    if (out instanceof Promise) {
      entry.promise = out.then(
        (v) => {
          entry.value = v;
          entry.ready = true;
          delete entry.promise;
          this.order.push({ def, value: v, ctx });
          return v;
        },
        (err: unknown) => {
          this.entries.delete(def.name);
          throw err;
        },
      );
      return entry.promise;
    }
    entry.value = out;
    entry.ready = true;
    this.order.push({ def, value: out, ctx });
    return out;
  }

  /** Tear down in reverse creation order. Returns the errors. */
  async close(info: Omit<FixtureTeardownContext, 'ctx'> = {}, scenarioCtx?: RunContext | StepContext): Promise<unknown[]> {
    this.closed = true;
    // wait for setups still in flight, so nothing leaks
    await Promise.allSettled([...this.entries.values()].flatMap((e) => (e.promise ? [e.promise] : [])));
    const errors: unknown[] = [];
    if (scenarioCtx) {
      for (const { def, value } of this.touched.values()) {
        try {
          await def.afterScenario!(value as never, { ...info, ctx: scenarioCtx });
        } catch (e) {
          errors.push(e);
        }
      }
      this.touched.clear();
    }
    for (const { def, value, ctx } of this.order.reverse()) {
      if (!def.teardown) continue;
      try {
        await def.teardown(value as never, { ...info, ctx });
      } catch (e) {
        errors.push(e);
      }
    }
    this.order.length = 0;
    this.entries.clear();
    return errors;
  }
}

// ------------------------------------------------------------------ resolution

export interface FixtureHost {
  definitions: ReadonlyMap<string, FixtureDefinition>;
  worker: FixtureCache;
  /** Context handed to worker fixture setups (run-level logger, run store, run signal). */
  workerContext: () => RunContext;
}

const HOST = Symbol.for('bddr.fixtures.host');
const SCENARIO = Symbol.for('bddr.fixtures.scenario');
const FEATURE = Symbol.for('bddr.fixtures.feature');

type Ctx = (RunContext | StepContext) & { [HOST]?: FixtureHost; [SCENARIO]?: FixtureCache; [FEATURE]?: FixtureCache };

function host(ctx: Ctx): FixtureHost {
  const h = ctx[HOST];
  if (!h) throw new Error('Fixtures are not available here (no bddr context)');
  return h;
}

function definition(h: FixtureHost, name: string, chain: string[]): FixtureDefinition {
  const def = h.definitions.get(name);
  if (!def) {
    const known = [...h.definitions.keys()];
    throw new Error(`Unknown fixture "${name}"${chain.length ? ` (needed by ${chain.join(' -> ')})` : ''}. Defined fixtures: [${known.join(', ')}]`);
  }
  return def;
}

const SCOPE_RANK: Record<FixtureScope, number> = { worker: 0, feature: 1, scenario: 2 };

/** Create (or get) a fixture and everything it depends on. Returns a value or a promise. */
export function resolveFixture(ctx: Ctx, name: string, chain: string[] = [], from?: FixtureScope): unknown {
  const h = host(ctx);
  const def = definition(h, name, chain);
  if (chain.includes(name)) throw new Error(`Fixture cycle: ${[...chain, name].join(' -> ')}`);
  if (from && SCOPE_RANK[def.scope] > SCOPE_RANK[from]) {
    throw new Error(`Fixture "${name}" is ${def.scope}-scoped and cannot be used by the ${from} fixture ${chain.join(' -> ')}`);
  }
  const target = def.scope === 'worker' ? h.worker : def.scope === 'feature' ? ctx[FEATURE] : ctx[SCENARIO];
  if (!target) {
    throw new Error(
      `Fixture "${name}" is ${def.scope}-scoped and cannot be used here (${def.scope === 'scenario' ? 'run, worker, group or feature hook' : 'run, worker or group hook'})`,
    );
  }
  const scenarioCache = ctx[SCENARIO];
  const touch = (v: unknown) => {
    if (scenarioCache && def.scope !== 'scenario') scenarioCache.touch(def, v);
    return v;
  };
  if (target.has(name)) return touch(target.peek(name));
  const setupCtx: Ctx = def.scope === 'worker' ? h.workerContext() : def.scope === 'feature' ? ((target.context as Ctx | undefined) ?? ctx) : ctx;
  const out = target.get(def, setupCtx as RunContext, () => {
    const deps = def.deps.filter((d) => h.definitions.has(d));
    const pending = deps.map((d) => resolveFixture(setupCtx, d, [...chain, name], def.scope));
    const run = () => (def.setup as (c: unknown) => unknown)(setupCtx);
    return pending.some((p) => p instanceof Promise) ? Promise.all(pending).then(run) : run();
  });
  return out instanceof Promise ? out.then(touch) : touch(out);
}

/** Before calling `fn(ctx, ...)`: create the fixtures it destructures. Returns undefined when nothing needs awaiting. */
export function prepareFixtures(ctx: Ctx, fn: (...a: never[]) => unknown): Promise<void> | undefined {
  const h = ctx[HOST];
  if (!h || !h.definitions.size) return undefined;
  const names = destructuredNames(fn).filter((n) => h.definitions.has(n));
  if (!names.length) return undefined;
  const out = names.map((n) => resolveFixture(ctx, n));
  return out.some((v) => v instanceof Promise) ? Promise.all(out).then(() => undefined) : undefined;
}

/** Synchronous read for `ctx.name` and `inject('name')`. Throws FixtureNotReady for async fixtures that are not ready. */
export function readFixture(ctx: Ctx, name: string): unknown {
  const v = resolveFixture(ctx, name);
  if (v instanceof Promise) {
    v.catch(() => undefined); // surfaced when it is awaited properly
    throw new FixtureNotReady(name);
  }
  return v;
}

/**
 * Give a context access to fixtures: `ctx.<name>` getters, `ctx.fixture(name)`.
 * Step contexts get the scenario and feature caches; feature-hook contexts the feature cache; run/worker/group none.
 */
export function installFixtures(ctx: RunContext | StepContext, h: FixtureHost, scenario?: FixtureCache, feature?: FixtureCache): void {
  Object.defineProperty(ctx, HOST, { value: h, enumerable: false, configurable: true });
  if (scenario) Object.defineProperty(ctx, SCENARIO, { value: scenario, enumerable: false, configurable: true });
  if (feature) Object.defineProperty(ctx, FEATURE, { value: feature, enumerable: false, configurable: true });
  Object.defineProperty(ctx, 'fixture', {
    enumerable: false,
    configurable: true,
    value: (name: string) => Promise.resolve(resolveFixture(ctx as Ctx, name)),
  });
  for (const name of h.definitions.keys()) {
    if (Object.prototype.hasOwnProperty.call(ctx, name) && !Object.getOwnPropertyDescriptor(ctx, name)?.get) continue;
    Object.defineProperty(ctx, name, { enumerable: false, configurable: true, get: () => readFixture(ctx as Ctx, name) });
  }
}

/** Call `fn(ctx, ...args)` after creating the fixtures its first parameter destructures. */
export function callWithFixtures(ctx: RunContext | StepContext, fn: (...a: never[]) => unknown, args: unknown[]): unknown {
  const ready = prepareFixtures(ctx as Ctx, fn);
  const call = () => (fn as (...a: unknown[]) => unknown)(ctx, ...args);
  return ready ? ready.then(call) : call();
}

/** Run `call` again after creating fixtures it was not ready for (class constructors using inject('x')). */
export async function withFixtureRetry<T>(ctx: Ctx, call: () => T): Promise<Awaited<T>> {
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof FixtureNotReady) || i > 64) throw e;
      await resolveFixture(ctx, e.fixture);
    }
  }
}
