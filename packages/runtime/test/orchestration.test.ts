import { describe, expect, it } from 'vitest';
import { EventBus, buildPlan, parseSpec, type PlanOptions } from '@bddr/core';
import { Executor, SupportRegistry, type StepContext } from '@bddr/runtime';

/** Steps that record timing so tests can assert overlap / ordering. */
function timingSteps(r: SupportRegistry) {
  const live = { active: 0, max: 0 };
  const intervals = new Map<string, [number, number]>();
  const order: string[] = [];
  r.defineStep('work {int}ms', async (ctx: StepContext, ms: number) => {
    live.active++;
    live.max = Math.max(live.max, live.active);
    const start = performance.now();
    order.push(ctx.scenario.name);
    await new Promise((res) => setTimeout(res, ms));
    intervals.set(ctx.scenario.name, [start, performance.now()]);
    live.active--;
  });
  r.defineStep('fail', () => {
    throw new Error('boom');
  });
  r.defineStep('ok', () => {});
  const overlap = (a: string, b: string) => {
    const [a0, a1] = intervals.get(a)!;
    const [b0, b1] = intervals.get(b)!;
    return a0 < b1 && b0 < a1;
  };
  return { live, intervals, order, overlap };
}

/** Max number of intervals open at the same instant. */
function peak(intervals: Array<[number, number]>): number {
  const points = intervals.flatMap(([a, b]) => [
    [a, 1],
    [b, -1],
  ]) as Array<[number, number]>;
  points.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of points) max = Math.max(max, (cur += d));
  return max;
}

async function run(r: SupportRegistry, src: string, options: PlanOptions = {}, extra: { failFast?: boolean; dryRun?: boolean } = {}) {
  const scenarios = parseSpec(src, 'o.feature').scenarios;
  const plan = buildPlan(scenarios, scenarios, options);
  expect(plan.errors).toEqual([]);
  const bus = new EventBus({ keepHistory: true });
  const result = await new Executor({ registry: r, bus, plan, ...extra }).execute(scenarios);
  const status = (name: string) => result.scenarioStatuses.get(scenarios.find((s) => s.name === name)!.id);
  const reason = (name: string) =>
    bus.history!.find((e) => e.type === 'scenarioFinished' && e.scenarioId === scenarios.find((s) => s.name === name)!.id && 'reason' in e) as
      | { reason?: string }
      | undefined;
  return { result, events: bus.history!, status, reason: (n: string) => reason(n)?.reason };
}

describe('scheduler: concurrency, locks, groups, priority', () => {
  it('runs up to `workers` scenarios at once', async () => {
    const r = new SupportRegistry();
    const t = timingSteps(r);
    const src = `Feature: P\n${['a', 'b', 'c', 'd'].map((n) => `  Scenario: ${n}\n    Given work 40ms\n`).join('')}`;
    await run(r, src, { workers: 3 });
    expect(t.live.max).toBe(3);
    expect(t.overlap('a', 'b')).toBe(true);
  });

  it('never overlaps scenarios holding the same @lock, even with free workers', async () => {
    const r = new SupportRegistry();
    const t = timingSteps(r);
    await run(
      r,
      `Feature: L
  @lock:db
  Scenario: a
    Given work 30ms
  @lock:db
  Scenario: b
    Given work 30ms
  Scenario: c
    Given work 30ms
`,
      { workers: 3 },
    );
    expect(t.overlap('a', 'b')).toBe(false);
    expect(t.overlap('a', 'c')).toBe(true);
  });

  it('serial groups run one member at a time; parallel groups respect their own worker cap', async () => {
    const r = new SupportRegistry();
    const t = timingSteps(r);
    await run(
      r,
      `Feature: G
  @group:s
  Scenario: s1
    Given work 30ms
  @group:s
  Scenario: s2
    Given work 30ms
  @group:p
  Scenario: p1
    Given work 30ms
  @group:p
  Scenario: p2
    Given work 30ms
  @group:p
  Scenario: p3
    Given work 30ms
`,
      { workers: 10, groups: { s: { mode: 'serial' }, p: { workers: 2 } } },
    );
    expect(t.overlap('s1', 's2')).toBe(false);
    expect(peak(['p1', 'p2', 'p3'].map((n) => t.intervals.get(n)!))).toBe(2);
    expect(t.overlap('s1', 'p1')).toBe(true);
  });

  it('defaultMode serial: ungrouped scenarios run one at a time but alongside groups; no group hooks for default', async () => {
    const r = new SupportRegistry();
    const t = timingSteps(r);
    const hooks: string[] = [];
    r.defineHook('group', 'before', {}, (c) => void hooks.push(c.groupName));
    await run(
      r,
      `Feature: DM
  Scenario: u1
    Given work 30ms
  Scenario: u2
    Given work 30ms
  @group:g
  Scenario: g1
    Given work 30ms
`,
      { workers: 3, defaultMode: 'serial' },
    );
    expect(t.overlap('u1', 'u2')).toBe(false);
    expect(t.overlap('u1', 'g1')).toBe(true);
    expect(hooks).toEqual(['g']);
  });

  it('exclusive scenarios run alone', async () => {
    const r = new SupportRegistry();
    const t = timingSteps(r);
    await run(
      r,
      `Feature: X
  Scenario: a
    Given work 30ms
  @exclusive
  Scenario: x
    Given work 30ms
  Scenario: b
    Given work 30ms
`,
      { workers: 3 },
    );
    expect(t.overlap('x', 'a')).toBe(false);
    expect(t.overlap('x', 'b')).toBe(false);
  });

  it('lower @priority starts first; ties keep file order', async () => {
    const r = new SupportRegistry();
    const t = timingSteps(r);
    await run(
      r,
      `Feature: Pr
  Scenario: last
    Given work 1ms
  @priority:-1
  Scenario: first
    Given work 1ms
  @priority:-1
  Scenario: second
    Given work 1ms
`,
    );
    expect(t.order).toEqual(['first', 'second', 'last']);
  });
});

describe('scheduler: dependencies', () => {
  const SRC = `Feature: D
  @id:login
  Scenario: login
    Given fail
  @id:order @dependsOn:login
  Scenario: order
    Given ok
  @dependsOn:order
  Scenario: pay
    Given ok
  @dependsOn:login:soft
  Scenario: report
    Given ok
`;

  it('skips hard dependents (cascading) with a reason; soft dependents still run', async () => {
    const r = new SupportRegistry();
    timingSteps(r);
    const { status, reason, result } = await run(r, SRC, { workers: 4 });
    expect(status('login')).toBe('failed');
    expect(status('order')).toBe('skipped');
    expect(reason('order')).toBe('dependency failed: login (failed)');
    expect(status('pay')).toBe('skipped');
    expect(reason('pay')).toBe('dependency failed: order (skipped)');
    expect(status('report')).toBe('passed');
    expect(result.success).toBe(false);
  });

  it('dependents start only after their dependency finished', async () => {
    const r = new SupportRegistry();
    const t = timingSteps(r);
    await run(
      r,
      `Feature: W
  @id:slow
  Scenario: slow
    Given work 40ms
  @dependsOn:slow
  Scenario: after
    Given work 1ms
  Scenario: free
    Given work 1ms
`,
      { workers: 3 },
    );
    expect(t.intervals.get('after')![0]).toBeGreaterThanOrEqual(t.intervals.get('slow')![1]);
    expect(t.order.indexOf('free')).toBeLessThan(t.order.indexOf('after'));
  });

  it('dry run ignores dependency results', async () => {
    const r = new SupportRegistry();
    timingSteps(r);
    const { status } = await run(r, SRC, {}, { dryRun: true });
    expect(status('pay')).toBe('skipped'); // dry-run "skipped" = matched, not "dependency failed"
  });

  it('exports flow from a dependency to its dependents; reading too early is an error', async () => {
    const r = new SupportRegistry();
    const got: unknown[] = [];
    r.defineStep('I create an order', (ctx: StepContext) => ctx.export('order', { id: 42, items: ['apple'] }));
    r.defineStep('I read the order', (ctx: StepContext) => {
      const o = ctx.from('create').get<{ id: number }>('order');
      got.push(o.id);
      (o as { id: number }).id = 0; // mutation must not leak back
      got.push(ctx.from('create').get<{ id: number }>('order').id);
    });
    r.defineStep('I read too early', (ctx: StepContext) => ctx.from('create').get('order'));
    r.defineStep('I export a function', (ctx: StepContext) => ctx.export('fn', () => 1));
    const { status, events } = await run(
      r,
      `Feature: E
  @id:early
  Scenario: early
    Given I read too early
  @id:create
  Scenario: create
    Given I create an order
  @dependsOn:create
  Scenario: read
    Given I read the order
  Scenario: bad export
    Given I export a function
`,
    );
    expect(got).toEqual([42, 42]);
    const errs = events.flatMap((e) => (e.type === 'stepFinished' && e.error ? [e.error.message] : []));
    expect(errs[0]).toMatch(/has not finished yet\. Add @dependsOn:create/);
    expect(errs[1]).toMatch(/must be serialisable/);
    expect(status('read')).toBe('passed');
  });

  it('fail-fast skips everything not yet started', async () => {
    const r = new SupportRegistry();
    timingSteps(r);
    const { status, reason } = await run(r, `Feature: F\n  Scenario: a\n    Given fail\n  Scenario: b\n    Given ok\n`, {}, { failFast: true });
    expect(status('b')).toBe('skipped');
    expect(reason('b')).toBe('fail-fast: an earlier scenario failed');
  });
});

describe('scopes under concurrency', () => {
  it('feature, rule and group hooks run once per scope, around all members, with group stores', async () => {
    const r = new SupportRegistry();
    const log: string[] = [];
    r.defineStep('work {int}ms', async (ctx: StepContext, ms: number) => {
      log.push(`start ${ctx.scenario.name} token=${String(ctx.groups['api']?.find('token') ?? '-')}`);
      await new Promise((res) => setTimeout(res, ms));
    });
    r.defineHook('feature', 'before', {}, (c) => void log.push(`beforeFeature ${c.featureInfo.name}`));
    r.defineHook('feature', 'after', {}, (c) => void log.push(`afterFeature ${c.featureInfo.name}`));
    r.defineHook('group', 'before', {}, (c) => {
      log.push(`beforeGroup ${c.groupName}`);
      c.group.set('token', `T-${c.groupName}`);
    });
    r.defineHook('group', 'after', { tags: '@group:api' }, (c) => void log.push(`afterGroup ${c.groupName}`));
    await run(
      r,
      `Feature: Conc
  @group:api
  Scenario: a
    Given work 20ms
  @group:api
  Scenario: b
    Given work 30ms
  Scenario: c
    Given work 10ms
`,
      { workers: 3 },
    );
    expect(log.filter((l) => l.startsWith('beforeFeature'))).toEqual(['beforeFeature Conc']);
    expect(log.filter((l) => l.startsWith('beforeGroup'))).toEqual(['beforeGroup api']);
    // Both scopes end with scenario b: inner (feature) closes before outer (group).
    expect(log.slice(-2)).toEqual(['afterFeature Conc', 'afterGroup api']);
    expect(log.indexOf('afterFeature Conc')).toBeGreaterThan(log.findIndex((l) => l.startsWith('start c')));
    expect(log.indexOf('afterGroup api')).toBeGreaterThan(log.findIndex((l) => l.startsWith('start b')));
    expect(log.find((l) => l.startsWith('start a'))).toBe('start a token=T-api');
    expect(log.find((l) => l.startsWith('start c'))).toBe('start c token=-');
  });

  it('a failing BeforeGroup skips its members only', async () => {
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    r.defineHook('group', 'before', { name: 'seed', tags: '@group:db' }, () => {
      throw new Error('no db');
    });
    const { status, reason, events } = await run(r, `Feature: B\n  @group:db\n  Scenario: a\n    Given ok\n  Scenario: b\n    Given ok\n`);
    expect(status('a')).toBe('skipped');
    expect(reason('a')).toBe('BeforeGroup hook "seed" failed (group db)');
    expect(status('b')).toBe('passed');
    expect(events.filter((e) => e.type === 'groupFinished')).toMatchObject([{ group: 'db', status: 'failed' }]);
  });
});
