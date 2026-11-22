/**
 * Class-based step definitions with dependency injection.
 *
 *   import { Steps, Given, When, Then, Before, CONTEXT } from '@bddr/runtime';
 *
 *   class ApiClient {                      // any plain class can be injected
 *     static inject = [CONTEXT] as const;
 *     constructor(private ctx: StepContext) {}
 *   }
 *
 *   @Steps()
 *   class BasketSteps {
 *     static inject = [ApiClient, CONTEXT] as const;
 *     constructor(private api: ApiClient, private ctx: StepContext) {}
 *
 *     @Given('I add {int} {string}')
 *     add(qty: number, product: string) { ... }       // NO ctx parameter: use this.ctx
 *
 *     @Before({ tags: '@db' })
 *     reset() { ... }
 *   }
 *
 * Lifecycle: ONE instance per class per scenario attempt, created lazily on first use and
 * shared by every step class that injects it. Instances live in the scenario store, so they
 * vanish with the scenario. If an instance has a `dispose()` method it is called (LIFO) when
 * the scenario ends.
 *
 * The decorators ARE the normal API functions: `Given(pattern, fn)` registers a function step,
 * `Given(pattern)` (no function) returns a method decorator. Same for Before/After/BeforeStep/AfterStep.
 *
 * Uses TC39 standard decorators (TypeScript 5+, no `experimentalDecorators`). Method decorators
 * run before the class decorator during class definition, so `@Steps()` collects them from a
 * pending list. That is why `@Steps()` is REQUIRED on classes that declare steps or hooks.
 *
 * NEVER export anything named `then` from this package: a module namespace with a `then`
 * export is "thenable", and `await import('@bddr/runtime')` would hang forever.
 */
import { callerLocation, getGlobalRegistry } from './registry.js';
import type { HookOptions, StepContext, StepOptions } from './types.js';
import { readFixture, withFixtureRetry, type Fixtures } from './fixtures.js';
import type { HookLevel } from '@bddr/core';

/** Injection token for the current StepContext. */
export const CONTEXT: unique symbol = Symbol.for('bddr.inject.context');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = unknown> = new (...args: any[]) => T;
export type InjectToken = Constructor | typeof CONTEXT;

type Pending =
  | { kind: 'step'; pattern: string | RegExp; options: StepOptions; method: string | symbol; location?: string }
  | { kind: 'hook'; level: 'scenario' | 'step'; when: 'before' | 'after'; options: HookOptions; method: string | symbol; location?: string };

let pending: Pending[] = [];

export type MethodDecorator = (value: (...args: never[]) => unknown, context: ClassMethodDecoratorContext) => void;

/** Used by Given/When/Then when called without a function. */
export function stepDecorator(pattern: string | RegExp, options: StepOptions = {}, location = callerLocation()): MethodDecorator {
  return (_value, context) => {
    if (context.static || context.private) throw new Error(`@Given/@When/@Then must decorate a public instance method (${String(context.name)})`);
    pending.push({ kind: 'step', pattern, options, method: context.name, ...(location ? { location } : {}) });
  };
}

/**
 * Hooks on STATIC methods: registered immediately (no @Steps() needed, no instance). The method
 * receives the hook context as its argument. Works for every level, TestNG style:
 *
 *   class Lifecycle {
 *     @BeforeSuite() static async startServer(ctx: RunContext) { ... }
 *     @BeforeFeature('@db') static seed(ctx: FeatureContext) { ... }
 *   }
 */
export function staticHookDecorator(level: HookLevel, when: 'before' | 'after', opts: HookOptions, location = callerLocation()): MethodDecorator {
  return (value, context) => {
    if (!context.static) {
      throw new Error(
        `${String(context.name)}: ${when}${level[0]!.toUpperCase()}${level.slice(1)} hooks on instance methods are only supported for scenario/step level; make it static`,
      );
    }
    context.addInitializer(function (this: unknown) {
      const cls = this as { name?: string };
      const name = opts.name ?? `${cls.name ?? 'anonymous'}.${String(context.name)}`;
      getGlobalRegistry().defineHook(level, when, { ...opts, name }, ((ctx: unknown) => (value as (c: unknown) => unknown).call(this, ctx)) as never, location);
    });
  };
}

/** Used by Before/After/BeforeStep/AfterStep when called without a function. */
export function hookDecorator(level: 'scenario' | 'step', when: 'before' | 'after', opts: HookOptions, location = callerLocation()): MethodDecorator {
  {
    return (_value, context) => {
      if (context.private) throw new Error(`hook decorators must decorate a public method (${String(context.name)})`);
      if (context.static) return staticHookDecorator(level, when, opts, location)(_value, context);
      pending.push({ kind: 'hook', level, when, options: opts, method: context.name, ...(location ? { location } : {}) });
    };
  }
}

/** Class decorator: registers every decorated method of the class on the global registry. */
export function Steps() {
  return (cls: Constructor, context: ClassDecoratorContext): void => {
    const mine = pending;
    pending = [];
    const registry = getGlobalRegistry();
    const className = String(context.name ?? cls.name);
    for (const p of mine) {
      const call = async (ctx: StepContext, args: unknown[]) => {
        // Construction may ask for async fixtures through inject('x'): create them and construct again.
        const instance = (await withFixtureRetry(ctx, () => resolve(ctx, cls))) as Record<string | symbol, (...a: unknown[]) => unknown>;
        const fn = instance[p.method];
        if (typeof fn !== 'function') throw new Error(`${className}.${String(p.method)} is not a method`);
        return fn.apply(instance, args);
      };
      if (p.kind === 'step') {
        registry.defineStep(p.pattern, (ctx, ...args) => call(ctx, args), p.options, p.location);
      } else {
        const name = p.options.name ?? `${className}.${String(p.method)}`;
        registry.defineHook(p.level, p.when, { ...p.options, name }, (ctx: StepContext) => call(ctx, []), p.location);
      }
    }
  };
}

// ------------------------------------------------------------------ container

const CONTAINER = Symbol.for('bddr.container');

interface Container {
  instances: Map<Constructor, unknown>;
  resolving: Constructor[];
}

function containerOf(ctx: StepContext): Container {
  return ctx.state.getOrSet<Container>(CONTAINER as unknown as string, () => {
    const c: Container = { instances: new Map(), resolving: [] };
    ctx.defer(async () => {
      for (const inst of [...c.instances.values()].reverse()) {
        const d = (inst as { dispose?: () => unknown }).dispose;
        if (typeof d === 'function') await d.call(inst);
      }
    });
    return c;
  });
}

/**
 * Get (or create) the per-scenario instance of `cls`, resolving `static inject` recursively.
 * Throws a readable error on cycles and on classes needing constructor args without `inject`.
 */
export function resolve<T>(ctx: StepContext, cls: Constructor<T>): T {
  const c = containerOf(ctx);
  const existing = c.instances.get(cls);
  if (existing !== undefined) return existing as T;
  if (c.resolving.includes(cls)) {
    throw new Error(`Dependency cycle: ${[...c.resolving, cls].map((k) => k.name).join(' -> ')}`);
  }
  c.resolving.push(cls);
  try {
    const tokens = ((cls as unknown as { inject?: readonly InjectToken[] }).inject ?? []) as readonly InjectToken[];
    if (cls.length > tokens.length) {
      throw new Error(`${cls.name} has ${cls.length} constructor parameter(s) but declares ${tokens.length} in "static inject"`);
    }
    const args = tokens.map((t) => (t === CONTEXT ? ctx : resolve(ctx, t as Constructor)));
    const previous = constructing;
    constructing = ctx;
    let instance: T;
    try {
      instance = new cls(...args);
    } finally {
      constructing = previous;
    }
    c.instances.set(cls, instance);
    return instance;
  } finally {
    c.resolving.pop();
  }
}

/** The scenario whose class is being constructed right now (construction is synchronous). */
let constructing: StepContext | undefined;

/**
 * Field / constructor injection, no `static inject` list needed:
 *
 *   @Steps()
 *   class LoginSteps {
 *     private login = inject(LoginPage);   // a class: one instance per scenario, shared with other step classes
 *     private page = inject('page');       // a fixture by name
 *     private ctx = inject(CONTEXT);       // the scenario context, if you need it
 *   }
 *
 * Works in classes bddr creates (step classes, and classes they inject). Page objects can use it too:
 *   class LoginPage { private page = inject('page'); }
 */
export function inject<T>(cls: Constructor<T>): T;
export function inject(token: typeof CONTEXT): StepContext;
export function inject<K extends keyof Fixtures>(fixture: K): Fixtures[K];
export function inject<T = unknown>(fixture: string): T;
export function inject(token: InjectToken | string): unknown {
  const ctx = constructing;
  if (!ctx) {
    throw new Error(
      `inject(${typeof token === 'string' ? `'${token}'` : typeof token === 'function' ? token.name : 'CONTEXT'}) can only be used in a field initializer or constructor ` +
        'of a class bddr creates (a @Steps() class or a class injected into one). In function steps destructure instead: ({ page }) => ...',
    );
  }
  if (token === CONTEXT) return ctx;
  if (typeof token === 'string') return readFixture(ctx as never, token);
  return resolve(ctx, token);
}
