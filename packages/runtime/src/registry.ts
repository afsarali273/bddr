import { createCucumberExpressionEngine } from './adapters/cucumber-expressions.js';
import { destructuredNames, RESERVED, type FixtureDefinition, type FixtureOptions } from './fixtures.js';
import type { CompiledStepPattern, ParameterTypeOptions, StepExpressionEngine } from './ports.js';
import { compileTagExpression, createIdGenerator, type HookKind, type HookLevel, type StepInstance, type TagPredicate } from '@bddr/core';
import type {
  AnyHookFn,
  FeatureHookFn,
  GroupHookFn,
  HookDefinition,
  HookOptions,
  RunHookFn,
  ScenarioHookFn,
  StepFn,
  StepOptions,
  StepRetryOption,
  RetryAnalyzer,
} from './types.js';

export interface StepDefinition {
  id: string;
  pattern: string | RegExp;
  fn: StepFn;
  tags?: string;
  timeoutMs?: number;
  retry?: StepRetryOption;
  concurrent?: boolean;
  location?: string;
  seq: number;
}

export type { ParameterTypeOptions };

export type MatchResult =
  | { kind: 'match'; definition: StepDefinition; values: unknown[] }
  | { kind: 'undefined' }
  | { kind: 'ambiguous'; candidates: StepDefinition[] };

export type DefinitionMatchResult =
  | { kind: 'match'; definition: StepDefinition }
  | { kind: 'undefined' }
  | { kind: 'ambiguous'; candidates: StepDefinition[] };

interface CompiledStep {
  def: StepDefinition;
  expression: CompiledStepPattern;
  scope?: TagPredicate;
}

/**
 * Holds everything users register from support code: steps, hooks, parameter types.
 *
 * Expressions are compiled lazily (on first match / `finalize()`), so parameter types
 * may be defined after the steps that use them, in any file load order.
 */
export class SupportRegistry {
  /** Pattern language (default: Cucumber Expressions). Swap via the constructor. */
  readonly engine: StepExpressionEngine;
  private readonly steps: StepDefinition[] = [];
  private readonly hooks: HookDefinition[] = [];
  private compiled: CompiledStep[] | undefined;
  private seq = 0;
  private nextStepId = createIdGenerator('step-def-');
  private nextHookId = createIdGenerator('hook-');
  defaultTimeoutMs = 30_000;
  /** Custom scenario-retry decision (see setRetryAnalyzer). */
  retryAnalyzer: RetryAnalyzer | undefined;

  constructor(options: { engine?: StepExpressionEngine } = {}) {
    this.engine = options.engine ?? createCucumberExpressionEngine();
  }

  defineStep(pattern: string | RegExp, fn: StepFn, options: StepOptions = {}, location?: string): StepDefinition {
    if (typeof fn !== 'function') throw new Error(`Step "${String(pattern)}" needs a function`);
    const def: StepDefinition = { id: this.nextStepId(), pattern, fn, seq: this.seq++ };
    if (options.tags) def.tags = options.tags;
    if (options.timeoutMs !== undefined) def.timeoutMs = options.timeoutMs;
    if (options.retry !== undefined) def.retry = options.retry;
    if (options.concurrent !== undefined) def.concurrent = options.concurrent;
    if (location) def.location = location;
    this.steps.push(def);
    this.compiled = undefined;
    return def;
  }

  defineHook(level: 'run' | 'worker', kind: HookKind, options: HookOptions, fn: RunHookFn, location?: string): HookDefinition;
  defineHook(level: 'group', kind: HookKind, options: HookOptions, fn: GroupHookFn, location?: string): HookDefinition;
  defineHook(level: 'feature' | 'rule', kind: HookKind, options: HookOptions, fn: FeatureHookFn, location?: string): HookDefinition;
  defineHook(level: 'scenario' | 'step', kind: HookKind, options: HookOptions, fn: ScenarioHookFn, location?: string): HookDefinition;
  defineHook(level: HookLevel, kind: HookKind, options: HookOptions, fn: AnyHookFn, location?: string): HookDefinition;
  defineHook(level: HookLevel, kind: HookKind, options: HookOptions, fn: AnyHookFn, location?: string): HookDefinition {
    if (typeof fn !== 'function') throw new Error(`${kind} ${level} hook needs a function`);
    const id = this.nextHookId();
    const hook: HookDefinition = {
      id,
      name: options.name ?? `${kind}${level[0]!.toUpperCase()}${level.slice(1)}${location ? ` (${location})` : ` #${id}`}`,
      level,
      kind,
      order: options.order ?? 0,
      alwaysRun: options.alwaysRun ?? false,
      fn,
      seq: this.seq++,
    };
    if (options.tags) {
      compileTagExpression(options.tags); // validate early
      hook.tags = options.tags;
    }
    if (options.timeoutMs !== undefined) hook.timeoutMs = options.timeoutMs;
    if (options.eachAttempt) {
      if (level !== 'step') throw new Error(`eachAttempt only applies to BeforeStep/AfterStep hooks (got ${kind} ${level})`);
      hook.eachAttempt = true;
    }
    if (location) hook.location = location;
    this.hooks.push(hook);
    return hook;
  }

  readonly fixtureDefinitions = new Map<string, FixtureDefinition>();

  defineFixture<T>(name: string, setup: (ctx: never) => T | Promise<T>, options: FixtureOptions<T> = {}, location?: string): FixtureDefinition {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Fixture name "${name}" must be a valid identifier (it becomes ctx.${name})`);
    if (RESERVED.has(name)) throw new Error(`Fixture name "${name}" is reserved: ctx.${name} already exists`);
    if (typeof setup !== 'function') throw new Error(`Fixture "${name}" needs a setup function`);
    const scope = options.scope ?? 'scenario';
    if (scope !== 'scenario' && scope !== 'feature' && scope !== 'worker') {
      throw new Error(`Fixture "${name}": scope must be 'scenario', 'feature' or 'worker' (got "${String(scope)}")`);
    }
    if (options.afterScenario && scope === 'scenario') throw new Error(`Fixture "${name}": afterScenario is for feature and worker fixtures (use teardown)`);
    const existing = this.fixtureDefinitions.get(name);
    if (existing) {
      throw new Error(`Fixture "${name}" is defined twice${existing.location ? ` (first at ${existing.location})` : ''}${location ? ` (again at ${location})` : ''}`);
    }
    const def: FixtureDefinition = {
      name,
      scope,
      setup: setup as FixtureDefinition['setup'],
      deps: destructuredNames(setup as never),
      ...(options.teardown ? { teardown: options.teardown as FixtureDefinition['teardown'] } : {}),
      ...(options.afterScenario ? { afterScenario: options.afterScenario as FixtureDefinition['afterScenario'] } : {}),
      ...(location ? { location } : {}),
    };
    this.fixtureDefinitions.set(name, def);
    return def;
  }

  defineParameterType<T>(opts: ParameterTypeOptions<T>): void {
    this.engine.defineParameterType(opts);
    this.compiled = undefined;
  }

  /** Compile all expressions now. Throws on the first invalid expression with its location. */
  finalize(): void {
    if (this.compiled) return;
    this.compiled = this.steps.map((def) => {
      let expression: CompiledStepPattern;
      try {
        expression = this.engine.compile(def.pattern);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid step pattern "${String(def.pattern)}"${def.location ? ` at ${def.location}` : ''}: ${msg}`);
      }
      const c: CompiledStep = { def, expression };
      if (def.tags) c.scope = compileTagExpression(def.tags);
      return c;
    });
  }

  /**
   * Find the definition for a step.
   * Scoping rule: definitions whose `tags` scope matches the scenario beat unscoped ones;
   * definitions whose scope does NOT match are ignored. Two winners = ambiguous.
   */
  async match(text: string, scenarioTags: readonly string[]): Promise<MatchResult> {
    const winners = this.matching(text, scenarioTags);
    if (winners.length === 0) return { kind: 'undefined' };
    if (winners.length > 1) return { kind: 'ambiguous', candidates: winners.map((w) => w.c.def) };
    const { c, args } = winners[0]!;
    const values = await args.values();
    return { kind: 'match', definition: c.def, values };
  }

  /** Match without evaluating parameter transformers. Used by static validation and editor tooling. */
  analyzeMatch(text: string, scenarioTags: readonly string[]): DefinitionMatchResult {
    const winners = this.matching(text, scenarioTags);
    if (winners.length === 0) return { kind: 'undefined' };
    if (winners.length > 1) return { kind: 'ambiguous', candidates: winners.map((w) => w.c.def) };
    return { kind: 'match', definition: winners[0]!.c.def };
  }

  private matching(text: string, scenarioTags: readonly string[]) {
    this.finalize();
    const hits: Array<{ c: CompiledStep; args: NonNullable<ReturnType<CompiledStepPattern['match']>> }> = [];
    for (const c of this.compiled!) {
      if (c.scope && !c.scope(scenarioTags)) continue;
      const args = c.expression.match(text);
      if (args) hits.push({ c, args });
    }
    const scoped = hits.filter((h) => h.c.scope);
    return scoped.length ? scoped : hits;
  }

  hooksFor(level: HookLevel, kind: HookKind): HookDefinition[] {
    const list = this.hooks.filter((h) => h.level === level && h.kind === kind);
    // before: order asc, then registration order. after: exact reverse.
    list.sort((a, b) => a.order - b.order || a.seq - b.seq);
    return kind === 'after' ? list.reverse() : list;
  }

  get stepDefinitions(): readonly StepDefinition[] {
    return this.steps;
  }

  get hookDefinitions(): readonly HookDefinition[] {
    return this.hooks;
  }

  /** Ready-to-paste TypeScript for an undefined step. */
  snippetFor(step: Pick<StepInstance, 'text' | 'keywordType' | 'argument'>): string {
    const best = this.engine.suggest(step.text);
    const keyword = step.keywordType === 'action' ? 'When' : step.keywordType === 'outcome' ? 'Then' : 'Given';
    const pattern = best ? best.pattern : step.text;
    const params: string[] = ['ctx', ...(best?.parameters.map((p) => `${p.name}: ${p.type}`) ?? [])];
    if (step.argument?.kind === 'dataTable') params.push('table: DataTable');
    if (step.argument?.kind === 'docString') params.push('docString: string');
    const quoted = `'${pattern.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return `${keyword}(${quoted}, async (${params.join(', ')}) => {\n  ctx.pending();\n});`;
  }
}

const GLOBAL_KEY = Symbol.for('bddr.registry.v1');
type GlobalWithRegistry = typeof globalThis & { [GLOBAL_KEY]?: SupportRegistry };

/**
 * The process-wide registry that the global API (Given/When/Then/Before…) writes to.
 * Stored on globalThis so two copies of this package (e.g. CLI + project) still share it.
 */
export function getGlobalRegistry(): SupportRegistry {
  const g = globalThis as GlobalWithRegistry;
  return (g[GLOBAL_KEY] ??= new SupportRegistry());
}

/** Replace the global registry with an empty one (tests, watch mode). */
export function resetGlobalRegistry(): SupportRegistry {
  const g = globalThis as GlobalWithRegistry;
  g[GLOBAL_KEY] = new SupportRegistry();
  return g[GLOBAL_KEY];
}

/** Best-effort "file:line" of the user code that called a registration function. */
export function callerLocation(): string | undefined {
  const stack = new Error().stack?.split('\n').slice(1) ?? [];
  for (const frame of stack) {
    if (/[\\/](runtime)[\\/](src|dist)[\\/]/.test(frame) || frame.includes('node:internal')) continue;
    const m = /\(?((?:file:\/\/)?[^()\s]+):(\d+):\d+\)?\s*$/.exec(frame);
    if (m) return `${m[1]!.replace(/^file:\/\//, '')}:${m[2]}`;
  }
  return undefined;
}
