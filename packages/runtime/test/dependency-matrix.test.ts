/**
 * Dependency semantics at run time: ordering under concurrency, what is skipped and why, soft vs hard, retries, groups,
 * serial features, outline families, exports, locks, and a few scale checks. The plan side (how tags become edges, what a
 * selection pulls in) is in packages/core/test/plan-corners.test.ts.
 *
 * Ordering is asserted on a trace of start/end hooks, never on wall-clock time, so the tests do not depend on machine speed.
 */
import { describe, expect, it } from 'vitest';
import { EventBus, buildPlan, parseSpec, type BddrEvent, type PlanOptions, type ScenarioInstance, type Status } from '@bddr/core';
import { Executor, SupportRegistry, schedule, type ExecuteOptions, type StepContext } from '@bddr/runtime';

// ---------------------------------------------------------------------------------------------------------------------
// harness

const sc = (id: string, tags = '', steps = 'Given work 5ms') => `  @id:${id}${tags ? ` ${tags}` : ''}\n  Scenario: ${id}\n    ${steps}\n`;
const feature = (name: string, scenarios: string[], tags = '') => `${tags ? `${tags}\n` : ''}Feature: ${name}\n${scenarios.join('')}`;

interface Opts {
  workers?: number;
  groups?: PlanOptions['groups'];
  select?: string[];
  withDeps?: boolean;
  featureMode?: PlanOptions['featureMode'];
  retry?: number;
  dryRun?: boolean;
  failFast?: boolean;
  strict?: boolean;
  /** Keep going when the plan has errors (to test the scheduler's safety net). */
  allowPlanErrors?: boolean;
  setup?: (r: SupportRegistry, trace: string[]) => void;
}

async function exec(source: string | Record<string, string>, o: Opts = {}) {
  const files = typeof source === 'string' ? { 'f.feature': source } : source;
  const all: ScenarioInstance[] = Object.entries(files).flatMap(([uri, src]) => {
    const spec = parseSpec(src, uri);
    expect(spec.errors, uri).toEqual([]);
    return spec.scenarios;
  });
  const selected = o.select ? all.filter((s) => o.select!.includes(s.id)) : all;
  const plan = buildPlan(all, selected, {
    workers: o.workers ?? 1,
    ...(o.groups ? { groups: o.groups } : {}),
    ...(o.withDeps !== undefined ? { withDeps: o.withDeps } : {}),
    ...(o.featureMode ? { featureMode: o.featureMode } : {}),
  });
  if (!o.allowPlanErrors) expect(plan.errors).toEqual([]);

  const r = new SupportRegistry();
  const trace: string[] = [];
  r.defineStep('ok', () => {});
  r.defineStep('fail', () => {
    throw new Error('boom');
  });
  r.defineStep('pend', (ctx: StepContext) => ctx.pending());
  r.defineStep('skipit', (ctx: StepContext) => ctx.skip('not today'));
  r.defineStep('dup', () => {});
  r.defineStep('dup', () => {});
  r.defineStep('work {int}ms', (_ctx: StepContext, ms: number) => new Promise((res) => setTimeout(res, ms)));
  r.defineStep('flaky {int}', (ctx: StepContext, n: number) => {
    if (ctx.scenario.attempt < n) throw new Error(`attempt ${ctx.scenario.attempt}`);
  });
  r.defineStep('export {string}', (ctx: StepContext, v: string) => ctx.export('v', v));
  r.defineStep('import from {string}', (ctx: StepContext, id: string) => void trace.push(`got:${ctx.scenario.id}=${ctx.from(id).get<string>('v')}`));
  r.defineHook('scenario', 'before', {}, (c) => void trace.push(`start:${c.scenario.id}`));
  r.defineHook('scenario', 'after', {}, (c) => void trace.push(`end:${c.scenario.id}`));
  o.setup?.(r, trace);

  const bus = new EventBus({ keepHistory: true });
  const opts: Partial<ExecuteOptions> = {
    ...(o.retry ? { retry: { scenario: o.retry } } : {}),
    ...(o.dryRun ? { dryRun: true } : {}),
    ...(o.failFast ? { failFast: true } : {}),
    ...(o.strict !== undefined ? { strict: o.strict } : {}),
  };
  const result = await new Executor({ registry: r, bus, plan, ...opts }).execute(selected);
  const events = bus.history!;
  const finished = (id: string) => events.filter((e): e is Extract<BddrEvent, { type: 'scenarioFinished' }> => e.type === 'scenarioFinished' && e.scenarioId === id && !e.willRetry);
  return {
    plan,
    result,
    events,
    trace,
    status: (id: string): Status | undefined => result.scenarioStatuses.get(id),
    reason: (id: string) => finished(id).at(-1)?.reason,
    ran: (id: string) => trace.includes(`start:${id}`),
    /** True when `a` finished before `b` started. */
    before: (a: string, b: string) => trace.indexOf(`end:${a}`) !== -1 && trace.indexOf(`end:${a}`) < trace.indexOf(`start:${b}`),
    overlapped: (a: string, b: string) => trace.indexOf(`start:${a}`) < trace.indexOf(`end:${b}`) && trace.indexOf(`start:${b}`) < trace.indexOf(`end:${a}`),
    peak: () => {
      let cur = 0;
      let max = 0;
      for (const t of trace) {
        if (t.startsWith('start:')) max = Math.max(max, ++cur);
        else if (t.startsWith('end:')) cur--;
      }
      return max;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
describe('ordering under concurrency', () => {
  it('runs a diamond in order while the two middle scenarios overlap', async () => {
    const t = await exec(feature('D', [sc('a'), sc('b', '@dependsOn:a', 'Given work 30ms'), sc('c', '@dependsOn:a', 'Given work 30ms'), sc('d', '@dependsOn:b @dependsOn:c')]), { workers: 4 });
    expect(t.before('a', 'b') && t.before('a', 'c')).toBe(true);
    expect(t.before('b', 'd') && t.before('c', 'd')).toBe(true);
    expect(t.overlapped('b', 'c')).toBe(true);
  });

  it('honours a dependency on a scenario that is later in the file, and in another file', async () => {
    const t = await exec(
      {
        'a.feature': feature('A', [sc('late-user', '@dependsOn:provider'), sc('x')]),
        'b.feature': feature('B', [sc('provider')]),
      },
      { workers: 1 },
    );
    expect(t.before('provider', 'late-user')).toBe(true);
    expect(t.result.success).toBe(true);
  });

  it('one provider feeding 12 scenarios, which feed one collector, with 6 workers', async () => {
    const mids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const t = await exec(feature('Fan', [sc('root'), ...mids.map((m) => sc(m, '@dependsOn:root', 'Given work 10ms')), sc('sink', mids.map((m) => `@dependsOn:${m}`).join(' '))]), { workers: 6 });
    for (const m of mids) {
      expect(t.before('root', m)).toBe(true);
      expect(t.before(m, 'sink')).toBe(true);
    }
    expect(t.peak()).toBeLessThanOrEqual(6);
    expect(t.peak()).toBeGreaterThan(1);
    expect(t.result.success).toBe(true);
  });

  it('a 100-scenario chain runs strictly in order even with 8 workers', async () => {
    const t = await exec(feature('Chain', [sc('s0', '', 'Given ok'), ...Array.from({ length: 99 }, (_, i) => sc(`s${i + 1}`, `@dependsOn:s${i}`, 'Given ok'))]), { workers: 8 });
    const order = t.trace.filter((x) => x.startsWith('start:')).map((x) => x.slice(6));
    expect(order).toEqual(Array.from({ length: 100 }, (_, i) => `s${i}`));
    expect(t.peak()).toBe(1);
  });

  it('priority never overrides a dependency: a high-priority dependent still waits', async () => {
    const t = await exec(feature('P', [sc('slow-first', '@priority:9'), sc('urgent', '@dependsOn:slow-first @priority:-10'), sc('other', '@priority:0')]), { workers: 1 });
    expect(t.before('slow-first', 'urgent')).toBe(true);
    // among ready scenarios the lower priority number goes first: other (0) before slow-first (9)
    expect(t.trace.indexOf('start:other')).toBeLessThan(t.trace.indexOf('start:slow-first'));
  });

  it('with one worker the plan order is the file order, except where a dependency pulls a scenario forward', async () => {
    const t = await exec(feature('O', [sc('first', '@dependsOn:third'), sc('second'), sc('third')]), { workers: 1 });
    expect(t.trace.filter((x) => x.startsWith('start:')).map((x) => x.slice(6))).toEqual(['second', 'third', 'first']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('what gets skipped, and why', () => {
  it('skips a hard dependent when its dependency fails, with the exact reason, and cascades', async () => {
    const t = await exec(feature('F', [sc('a', '', 'Given fail'), sc('b', '@dependsOn:a', 'Given ok'), sc('c', '@dependsOn:b', 'Given ok'), sc('free', '', 'Given ok')]), { workers: 2 });
    expect(t.status('a')).toBe('failed');
    expect(t.status('b')).toBe('skipped');
    expect(t.status('c')).toBe('skipped');
    expect(t.reason('b')).toBe('dependency failed: a (failed)');
    expect(t.reason('c')).toBe('dependency failed: b (skipped)');
    expect(t.status('free')).toBe('passed');
    expect(t.ran('b')).toBe(false);
  });

  for (const [kind, step, expected] of [
    ['pending', 'Given pend', 'pending'],
    ['skipped by the scenario', 'Given skipit', 'skipped'],
    ['undefined', 'Given nothing defines this', 'undefined'],
    ['ambiguous', 'Given dup', 'ambiguous'],
  ] as const) {
    it(`treats a ${kind} dependency as not passed: the hard dependent is skipped with (${expected}), a soft one runs`, async () => {
      const t = await exec(feature('S', [sc('dep', '', step), sc('hard', '@dependsOn:dep', 'Given ok'), sc('soft', '@dependsOn:dep:soft', 'Given ok')]), { workers: 2, strict: false });
      expect(t.status('dep')).toBe(expected);
      expect(t.status('hard')).toBe('skipped');
      expect(t.reason('hard')).toBe(`dependency failed: dep (${expected})`);
      expect(t.status('soft')).toBe('passed');
    });
  }

  it('a soft dependent runs after the dependency has finished, whatever the result, and after a skipped one', async () => {
    const t = await exec(feature('S', [sc('bad', '', 'Given fail'), sc('mid', '@dependsOn:bad', 'Given ok'), sc('soft', '@dependsOn:mid:soft', 'Given ok')]), { workers: 3 });
    expect(t.status('mid')).toBe('skipped');
    expect(t.status('soft')).toBe('passed');
    expect(t.trace.indexOf('start:soft')).toBeGreaterThanOrEqual(0);
  });

  it('hard wins when the same target is declared both hard and soft', async () => {
    const t = await exec(feature('S', [sc('bad', '', 'Given fail'), sc('x', '@dependsOn:bad:soft @dependsOn:bad', 'Given ok')]));
    expect(t.status('x')).toBe('skipped');
  });

  it('with several dependencies the reason names the first non-passing one in declaration order', async () => {
    const t = await exec(feature('S', [sc('ok1', '', 'Given ok'), sc('bad1', '', 'Given fail'), sc('bad2', '', 'Given fail'), sc('x', '@dependsOn:ok1 @dependsOn:bad2 @dependsOn:bad1', 'Given ok')]), { workers: 3 });
    expect(t.reason('x')).toBe('dependency failed: bad2 (failed)');
  });

  it('waits for ALL dependencies before deciding: a slow passing one does not let a fast failing one skip early', async () => {
    const t = await exec(feature('S', [sc('quick-fail', '', 'Given fail'), sc('slow-ok', '', 'Given work 40ms'), sc('x', '@dependsOn:quick-fail @dependsOn:slow-ok', 'Given ok')]), { workers: 3 });
    expect(t.status('x')).toBe('skipped');
    expect(t.before('slow-ok', 'x') || !t.ran('x')).toBe(true);
    expect(t.status('slow-ok')).toBe('passed');
  });

  it('a dependency that passes on a scenario retry lets the dependents run', async () => {
    const t = await exec(feature('R', [sc('flaky-dep', '', 'Given flaky 2'), sc('x', '@dependsOn:flaky-dep', 'Given ok')]), { retry: 2 });
    expect(t.status('flaky-dep')).toBe('passed');
    expect(t.status('x')).toBe('passed');
    expect(t.result.summary.flaky).toBe(1);
  });

  it('a dependency that fails every retry skips the dependents, and they never ran', async () => {
    const t = await exec(feature('R', [sc('dep', '', 'Given flaky 9'), sc('x', '@dependsOn:dep', 'Given ok')]), { retry: 2 });
    expect(t.status('dep')).toBe('failed');
    expect(t.reason('x')).toBe('dependency failed: dep (failed)');
    expect(t.ran('x')).toBe(false);
  });

  it('a dependent is not started between the attempts of its dependency', async () => {
    const t = await exec(feature('R', [sc('dep', '', 'Given flaky 3'), sc('x', '@dependsOn:dep', 'Given ok'), sc('y', '', 'Given work 5ms')]), { retry: 3, workers: 3 });
    const startsOfX = t.trace.indexOf('start:x');
    const lastEndOfDep = t.trace.lastIndexOf('end:dep');
    expect(startsOfX).toBeGreaterThan(lastEndOfDep);
  });

  it('a quarantined dependency that fails still counts as failed for its dependents (and cannot fail the run itself)', async () => {
    const t = await exec(feature('Q', [sc('dep', '@quarantine', 'Given fail'), sc('x', '@dependsOn:dep', 'Given ok')]));
    expect(t.status('dep')).toBe('failed');
    expect(t.status('x')).toBe('skipped');
    expect(t.reason('x')).toBe('dependency failed: dep (failed)');
    expect(t.result.summary.quarantined).toBe(1);
  });

  it('dry run ignores dependency results: nothing is skipped because a dependency would fail', async () => {
    const t = await exec(feature('Dry', [sc('a', '', 'Given fail'), sc('b', '@dependsOn:a', 'Given ok')]), { dryRun: true });
    expect(t.status('a')).toBe('skipped'); // a dry run reports every scenario as skipped
    expect(t.status('b')).toBe('skipped');
    expect(t.reason('b')).toBeUndefined(); // ...but not because of a failed dependency
    expect(t.trace.some((x) => x.startsWith('start:'))).toBe(false); // and nothing ran
  });

  it('fail-fast: after the first failure, later scenarios are skipped with the fail-fast reason, not a dependency reason', async () => {
    const t = await exec(feature('FF', [sc('a', '', 'Given fail'), sc('b', '@dependsOn:a', 'Given ok'), sc('c', '', 'Given ok')]), { failFast: true });
    expect(t.reason('b')).toBe('fail-fast: an earlier scenario failed');
    expect(t.reason('c')).toBe('fail-fast: an earlier scenario failed');
  });

  it('fail-fast also stops soft dependents of the failed scenario', async () => {
    const t = await exec(feature('FF', [sc('a', '', 'Given fail'), sc('s', '@dependsOn:a:soft', 'Given ok')]), { failFast: true });
    expect(t.status('s')).toBe('skipped');
  });

  it('the executor refuses a plan that has errors (unknown id, duplicate id, cycle) instead of running part of it', async () => {
    await expect(exec(feature('E', [sc('a', '@dependsOn:ghost', 'Given ok'), sc('b', '', 'Given ok')]), { allowPlanErrors: true })).rejects.toThrow(/Invalid plan:\n.*@dependsOn:ghost: no scenario has this id/);
    await expect(exec(feature('E', [sc('a', '@dependsOn:b', 'Given ok'), sc('b', '@dependsOn:a', 'Given ok')]), { allowPlanErrors: true })).rejects.toThrow(/Dependency cycle/);
    await expect(exec({ 'x.feature': feature('X', [sc('dup')]), 'y.feature': feature('Y', [sc('dup')]) }, { allowPlanErrors: true })).rejects.toThrow(/Scenario id "dup" is duplicated/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('groups', () => {
  const GROUPED = feature('G', [sc('s1', '@group:setup', 'Given ok'), sc('s2', '@group:setup', 'Given ok'), sc('c1', '@group:checkout', 'Given ok'), sc('r1', '@group:reports', 'Given ok')]);

  it('@dependsOn:group waits for every member and is skipped if any member fails', async () => {
    const src = feature('G', [sc('s1', '@group:setup', 'Given ok'), sc('s2', '@group:setup', 'Given fail'), sc('after', '@dependsOn:group:setup', 'Given ok'), sc('soft-after', '@dependsOn:group:setup:soft', 'Given ok')]);
    const t = await exec(src, { workers: 3 });
    expect(t.before('s1', 'soft-after') && t.before('s2', 'soft-after')).toBe(true);
    expect(t.status('after')).toBe('skipped');
    expect(t.reason('after')).toBe('dependency failed: s2 (failed)');
    expect(t.status('soft-after')).toBe('passed');
  });

  it("group dependsOn skips members when the other group has a failure, and runs them with onDependencyFailure: 'run'", async () => {
    const failing = (r: SupportRegistry) => r.defineStep('setup is broken', () => { throw new Error('x'); });
    const src = (g1: string) => feature('G', [sc('s1', '@group:setup', 'Given setup is broken'), sc('c1', `@group:${g1}`, 'Given ok')]);
    const skip = await exec(src('checkout'), { groups: { setup: {}, checkout: { dependsOn: ['setup'] } }, workers: 2, setup: failing });
    expect(skip.status('c1')).toBe('skipped');
    const run = await exec(src('checkout'), { groups: { setup: {}, checkout: { dependsOn: ['setup'], onDependencyFailure: 'run' } }, workers: 2, setup: failing });
    expect(run.status('c1')).toBe('passed');
    expect(run.before('s1', 'c1')).toBe(true);
  });

  it('a transitive group chain runs setup, then checkout, then reports', async () => {
    const t = await exec(GROUPED, { groups: { setup: {}, checkout: { dependsOn: ['setup'] }, reports: { dependsOn: ['checkout'] } }, workers: 4 });
    expect(t.before('s1', 'c1') && t.before('s2', 'c1') && t.before('c1', 'r1')).toBe(true);
  });

  it('selecting only the last group pulls in the whole chain, and --no-deps runs just the selection', async () => {
    const groups = { setup: {}, checkout: { dependsOn: ['setup'] }, reports: { dependsOn: ['checkout'] } };
    const pulled = await exec(GROUPED, { groups, select: ['r1'], workers: 2 });
    expect(pulled.ran('s1') && pulled.ran('c1') && pulled.ran('r1')).toBe(true);
    const alone = await exec(GROUPED, { groups, select: ['r1'], withDeps: false });
    expect(alone.ran('r1')).toBe(true);
    expect(alone.ran('s1') || alone.ran('c1')).toBe(false);
  });

  it('dependents of a retrying group wait until the group has settled, then run once', async () => {
    let groupRuns = 0;
    const src = feature('G', [sc('s1', '@group:setup', 'Given ok'), sc('s2', '@group:setup', 'Given setup step'), sc('after', '@dependsOn:group:setup', 'Given ok')]);
    const t = await exec(src, {
      groups: { setup: { retry: 2 } },
      workers: 3,
      setup: (r, trace) => {
        r.defineHook('group', 'before', {}, () => void groupRuns++);
        r.defineStep('setup step', () => {
          trace.push(`s2 attempt ${groupRuns}`);
          if (groupRuns < 2) throw new Error('not ready');
        });
      },
    });
    expect(groupRuns).toBe(2);
    expect(t.status('after')).toBe('passed');
    expect(t.trace.filter((x) => x === 'start:after')).toHaveLength(1);
    expect(t.trace.indexOf('start:after')).toBeGreaterThan(t.trace.lastIndexOf('s2 attempt 2'));
  });

  it('serial group mode runs members one at a time, still respecting dependencies between them', async () => {
    const t = await exec(feature('G', [sc('a', '@group:s @dependsOn:c', 'Given work 10ms'), sc('b', '@group:s', 'Given work 10ms'), sc('c', '@group:s', 'Given work 10ms')]), { groups: { s: { mode: 'serial' } }, workers: 4 });
    expect(t.peak()).toBe(1);
    expect(t.before('c', 'a')).toBe(true);
  });

  it('a group worker cap and a dependency together: the cap is respected and the order holds', async () => {
    const members = Array.from({ length: 6 }, (_, i) => sc(`m${i}`, `@group:cap @dependsOn:root`, 'Given work 15ms'));
    const t = await exec(feature('G', [sc('root', '', 'Given ok'), ...members]), { groups: { cap: { workers: 2 } }, workers: 6 });
    expect(t.peak()).toBeLessThanOrEqual(2);
    for (let i = 0; i < 6; i++) expect(t.before('root', `m${i}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('outline families and data rows', () => {
  const OUTLINE = (steps: string) => `  @id:rows\n  Scenario Outline: row <n>\n    ${steps}\n    Examples:\n      | n |\n      | 1 |\n      | 2 |\n      | 3 |\n`;

  it('a dependency on the base id waits for every row and is skipped when any row fails', async () => {
    const t = await exec(feature('O', [`  @id:rows\n  Scenario Outline: row <n>\n    Given <step>\n    Examples:\n      | n | step |\n      | 1 | ok   |\n      | 2 | fail |\n      | 3 | ok   |\n`, sc('after', '@dependsOn:rows', 'Given ok')]), { workers: 3 });
    expect(t.status('rows[2]')).toBe('failed');
    expect(t.status('after')).toBe('skipped');
    expect(t.reason('after')).toBe('dependency failed: rows[2] (failed)');
    expect(t.before('rows[1]', 'after') || !t.ran('after')).toBe(true);
  });

  it('a dependency on one row waits only for that row', async () => {
    const t = await exec(feature('O', [`  @id:rows\n  Scenario Outline: row <n>\n    Given <step>\n    Examples:\n      | n | step      |\n      | 1 | work 60ms |\n      | 2 | ok        |\n`, sc('after-two', '@dependsOn:rows[2]', 'Given ok')]), { workers: 3 });
    expect(t.status('after-two')).toBe('passed');
    expect(t.before('rows[2]', 'after-two')).toBe(true);
    expect(t.trace.indexOf('start:after-two')).toBeLessThan(t.trace.indexOf('end:rows[1]')); // did not wait for row 1
  });

  it('rows pulled in by selecting the dependent all run', async () => {
    const t = await exec(feature('O', [OUTLINE('Given ok'), sc('after', '@dependsOn:rows', 'Given ok')]), { select: ['after'] });
    expect(['rows[1]', 'rows[2]', 'rows[3]', 'after'].every((id) => t.ran(id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('@serial features and rules', () => {
  const SERIAL = (steps: string[], tags = '@serial') => feature('Ser', steps.map((s, i) => sc(`s${i + 1}`, '', s)), tags);

  it('runs in file order with many workers, and a failure does not skip the rest', async () => {
    const t = await exec(SERIAL(['Given work 10ms', 'Given fail', 'Given ok', 'Given ok']), { workers: 4 });
    expect(t.trace.filter((x) => x.startsWith('start:')).map((x) => x.slice(6))).toEqual(['s1', 's2', 's3', 's4']);
    expect(t.peak()).toBe(1);
    expect(t.status('s3')).toBe('passed');
    expect(t.status('s2')).toBe('failed');
  });

  it('an explicit hard dependency inside a serial feature still skips when that scenario fails', async () => {
    const src = feature('Ser', [sc('s1', '', 'Given fail'), sc('s2', '@dependsOn:s1', 'Given ok'), sc('s3', '', 'Given ok')], '@serial');
    const t = await exec(src, { workers: 2 });
    expect(t.status('s2')).toBe('skipped');
    expect(t.status('s3')).toBe('passed');
  });

  it('runs only the selected scenarios of a serial feature, still in file order', async () => {
    const t = await exec(SERIAL(['Given ok', 'Given ok', 'Given ok', 'Given ok']), { select: ['s4', 's2'], workers: 3 });
    expect(t.trace.filter((x) => x.startsWith('start:')).map((x) => x.slice(6))).toEqual(['s2', 's4']);
  });

  it('two serial features run in parallel with each other but each stays in order', async () => {
    const t = await exec({ 'a.feature': feature('A', [sc('a1', '', 'Given work 30ms'), sc('a2', '', 'Given work 30ms')], '@serial'), 'b.feature': feature('B', [sc('b1', '', 'Given work 30ms'), sc('b2', '', 'Given work 30ms')], '@serial') }, { workers: 4 });
    expect(t.before('a1', 'a2') && t.before('b1', 'b2')).toBe(true);
    expect(t.overlapped('a1', 'b1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('@requires at run time', () => {
  const files = (setupStep: string, tag: string) => ({
    'a.feature': feature('A', [sc('seed1', '', setupStep), sc('seed2', '', 'Given work 20ms')]),
    'b.feature': feature('B', [sc('b1', '', 'Given ok'), sc('b2', '', 'Given ok')], tag),
  });

  it('runs the whole required file first', async () => {
    const t = await exec(files('Given ok', '@requires:a.feature'), { workers: 4 });
    for (const b of ['b1', 'b2']) for (const a of ['seed1', 'seed2']) expect(t.before(a, b)).toBe(true);
  });

  it('skips every scenario of the requiring feature when one required scenario fails', async () => {
    const t = await exec(files('Given fail', '@requires:a.feature'), { workers: 4 });
    expect(t.status('b1')).toBe('skipped');
    expect(t.status('b2')).toBe('skipped');
    expect(t.reason('b1')).toBe('dependency failed: seed1 (failed)');
  });

  it(':soft runs the feature regardless', async () => {
    const t = await exec(files('Given fail', '@requires:a.feature:soft'), { workers: 4 });
    expect(t.status('b1')).toBe('passed');
    expect(t.before('seed2', 'b1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('exports between scenarios', () => {
  it('a dependent reads what its dependency exported, even when they run on different workers', async () => {
    const t = await exec(feature('X', [sc('producer', '', 'Given export "token-1"'), sc('consumer', '@dependsOn:producer', 'Given import from "producer"')]), { workers: 4 });
    expect(t.trace).toContain('got:consumer=token-1');
  });

  it('every row of a dependency family can be read by id', async () => {
    const outline = `  @id:rows\n  Scenario Outline: row <n>\n    Given export "<n>"\n    Examples:\n      | n |\n      | 1 |\n      | 2 |\n`;
    const t = await exec(feature('X', [outline, sc('consumer', '@dependsOn:rows', 'Given import from "rows[2]"')]), { workers: 3 });
    expect(t.trace).toContain('got:consumer=2');
  });

  it('a dependent of a failed producer never runs, so it can never read a half-written export', async () => {
    const t = await exec(feature('X', [sc('producer', '', 'Given fail'), sc('consumer', '@dependsOn:producer', 'Given import from "producer"')]));
    expect(t.trace.some((x) => x.startsWith('got:'))).toBe(false);
    expect(t.status('consumer')).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('locks, exclusive scenarios and dependencies together', () => {
  it('two scenarios with the same lock and a dependency between them do not deadlock', async () => {
    const t = await exec(feature('L', [sc('a', '@lock:db', 'Given work 10ms'), sc('b', '@lock:db @dependsOn:a', 'Given work 10ms')]), { workers: 3 });
    expect(t.result.success).toBe(true);
    expect(t.before('a', 'b')).toBe(true);
  });

  it('a lock holder waits for its dependency and for the other holder', async () => {
    const t = await exec(feature('L', [sc('prep', '', 'Given work 20ms'), sc('h1', '@lock:db', 'Given work 20ms'), sc('h2', '@lock:db @dependsOn:prep', 'Given work 20ms')]), { workers: 3 });
    expect(t.before('prep', 'h2')).toBe(true);
    expect(t.overlapped('h1', 'h2')).toBe(false);
  });

  it('an @exclusive dependent runs alone after its dependency', async () => {
    const t = await exec(feature('E', [sc('dep', '', 'Given work 10ms'), sc('solo', '@exclusive @dependsOn:dep', 'Given work 20ms'), sc('p1', '', 'Given work 30ms'), sc('p2', '', 'Given work 30ms')]), { workers: 4 });
    expect(t.before('dep', 'solo')).toBe(true);
    expect(t.overlapped('solo', 'p1')).toBe(false);
    expect(t.overlapped('solo', 'p2')).toBe(false);
  });

  it('a failing lock holder still releases the lock for the next holder', async () => {
    const t = await exec(feature('L', [sc('x', '@lock:db', 'Given fail'), sc('y', '@lock:db', 'Given ok')]), { workers: 2 });
    expect(t.status('y')).toBe('passed');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('events describe the dependencies', () => {
  it('planReady lists every dependency with its soft flag and what pulled a scenario in', async () => {
    const t = await exec(feature('Ev', [sc('a', '', 'Given ok'), sc('b', '@dependsOn:a', 'Given ok'), sc('c', '@dependsOn:b:soft', 'Given ok')]), { select: ['b', 'c'] });
    const ready = t.events.find((e) => e.type === 'planReady')!;
    const planned = (ready as Extract<BddrEvent, { type: 'planReady' }>).scenarios;
    expect(planned.find((s) => s.id === 'b')!.dependsOn).toEqual([{ id: 'a', soft: false }]);
    expect(planned.find((s) => s.id === 'c')!.dependsOn).toEqual([{ id: 'b', soft: true }]);
    expect(planned.find((s) => s.id === 'a')!.pulledInBy).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('safety net and scale', () => {
  it('the scheduler never hangs on a cyclic plan: the cycle members are skipped as not schedulable', async () => {
    const all = parseSpec(feature('Cy', [sc('a', '@dependsOn:b'), sc('b', '@dependsOn:a'), sc('free')]), 'cy.feature').scenarios;
    const plan = buildPlan(all, all, { workers: 2 });
    expect(plan.errors.some((e) => e.message.startsWith('Dependency cycle'))).toBe(true);
    const skipped = new Map<string, string>();
    const ran: string[] = [];
    const results = await schedule(plan, {
      runNode: async (node) => (ran.push(node.id), 'passed' as Status),
      skipNode: async (node, reason) => void skipped.set(node.id, reason),
      stopReason: () => undefined,
    });
    expect(ran).toEqual(['free']);
    expect(results.get('free')).toBe('passed');
    expect(skipped.get('a')).toBe('not schedulable (dependency cycle?)');
    expect(skipped.get('b')).toBe('not schedulable (dependency cycle?)');
  });

  it('300 scenarios in a chain and 200 scenarios each waiting for 200 others finish quickly', async () => {
    const chain = feature('Chain', [sc('c0', '', 'Given ok'), ...Array.from({ length: 299 }, (_, i) => sc(`c${i + 1}`, `@dependsOn:c${i}`, 'Given ok'))]);
    const t0 = Date.now();
    const a = await exec(chain, { workers: 4 });
    expect(a.result.success).toBe(true);
    const base = Array.from({ length: 200 }, (_, i) => `b${i}`);
    const wide = feature('Wide', [...base.map((b) => sc(b, '', 'Given ok')), ...Array.from({ length: 200 }, (_, i) => sc(`w${i}`, base.map((b) => `@dependsOn:${b}`).join(' '), 'Given ok'))]);
    const b = await exec(wide, { workers: 8 });
    expect(b.result.success).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 30_000);
});
