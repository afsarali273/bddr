import { describe, expect, it } from 'vitest';
import { EventBus, buildPlan, parseSpec, shardPlan, type PlanOptions } from '@bddr/core';
import { Executor, SupportRegistry, type StepContext } from '@bddr/runtime';

function steps() {
  const r = new SupportRegistry();
  const spans = new Map<string, [number, number]>();
  const order: string[] = [];
  r.defineStep('work {int}ms', async (ctx: StepContext, ms: number) => {
    const t0 = performance.now();
    order.push(ctx.scenario.name);
    await new Promise((res) => setTimeout(res, ms));
    spans.set(ctx.scenario.name, [t0, performance.now()]);
  });
  r.defineStep('fail', (ctx: StepContext) => {
    order.push(ctx.scenario.name);
    throw new Error('boom');
  });
  const overlap = (a: string, b: string) => {
    const [a0, a1] = spans.get(a)!;
    const [b0, b1] = spans.get(b)!;
    return a0 < b1 && b0 < a1;
  };
  return { r, order, overlap };
}

function parse(...features: string[]) {
  return features.flatMap((src, i) => parseSpec(src, `f${i + 1}.feature`).scenarios);
}

async function run(r: SupportRegistry, scenarios: ReturnType<typeof parse>, options: PlanOptions, selected = scenarios) {
  const plan = buildPlan(scenarios, selected, options);
  const bus = new EventBus({ keepHistory: true });
  const result = plan.errors.length ? undefined : await new Executor({ registry: r, bus, plan }).execute(plan.nodes.map((n) => n.scenario));
  return { plan, result };
}

const SERIAL = `@serial
Feature: Checkout
  Scenario: c1
    Given work 30ms
  Scenario: c2
    Given fail
  Scenario: c3
    Given work 10ms
  Scenario: c4
    Given work 10ms
`;
const OTHER = `Feature: Search
  Scenario: s1
    Given work 30ms
  Scenario: s2
    Given work 30ms
`;

describe('@serial features', () => {
  it('run in file order one at a time, keep going after a failure, and other features still run in parallel', async () => {
    const { r, order, overlap } = steps();
    const { plan, result } = await run(r, parse(SERIAL, OTHER), { workers: 4 });
    expect(plan.errors).toEqual([]);
    const mine = order.filter((n) => n.startsWith('c'));
    expect(mine).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(overlap('c3', 'c4')).toBe(false);
    expect(overlap('s1', 's2')).toBe(true); // the other feature is still parallel
    expect(overlap('c1', 's1')).toBe(true); // and runs alongside the serial one
    expect(result!.scenarioStatuses.get('f1.feature::c3')).toBe('passed'); // c2 failed, c3 still ran
    expect(plan.nodes.find((n) => n.id === 'f1.feature::c3')!.deps).toEqual([{ target: 'f1.feature::c2', soft: true, via: 'serial:feature' }]);
  });

  it('members keep their groups: a parallel group spanning two serial features runs the features side by side', async () => {
    const { r, overlap } = steps();
    const a = `@serial @group:payments\nFeature: A\n  Scenario: a1\n    Given work 30ms\n  Scenario: a2\n    Given work 30ms\n`;
    const b = `@serial @group:payments\nFeature: B\n  Scenario: b1\n    Given work 30ms\n  Scenario: b2\n    Given work 30ms\n`;
    const { plan } = await run(r, parse(a, b), { workers: 4, groups: { payments: { mode: 'parallel' } } });
    expect(plan.groups.get('payments')!.members).toHaveLength(4);
    expect(overlap('a1', 'a2')).toBe(false);
    expect(overlap('b1', 'b2')).toBe(false);
    expect(overlap('a1', 'b1')).toBe(true);
  });

  it("featureMode: 'serial' makes every feature serial; @parallel opts one out", async () => {
    const { r, overlap } = steps();
    const par = `@parallel\nFeature: P\n  Scenario: p1\n    Given work 30ms\n  Scenario: p2\n    Given work 30ms\n`;
    const plain = `Feature: Q\n  Scenario: q1\n    Given work 30ms\n  Scenario: q2\n    Given work 30ms\n`;
    const { plan } = await run(r, parse(par, plain), { workers: 4, featureMode: 'serial' });
    expect(overlap('p1', 'p2')).toBe(true);
    expect(overlap('q1', 'q2')).toBe(false);
    expect(plan.nodes.filter((n) => n.serial === 'feature').map((n) => n.scenario.name)).toEqual(['q1', 'q2']);
  });

  it('@serial on a Rule chains only that rule', async () => {
    const { r, overlap } = steps();
    const src = `Feature: R
  @serial
  Rule: ordered
    Scenario: r1
      Given work 30ms
    Scenario: r2
      Given work 30ms
  Rule: free
    Scenario: f1
      Given work 30ms
    Scenario: f2
      Given work 30ms
`;
    await run(r, parse(src), { workers: 4 });
    expect(overlap('r1', 'r2')).toBe(false);
    expect(overlap('f1', 'f2')).toBe(true);
  });

  it('selecting one scenario does not pull in the others (the chain is only among selected ones)', async () => {
    const { r, order } = steps();
    const all = parse(SERIAL);
    const { plan } = await run(r, all, { workers: 2 }, all.filter((s) => s.name === 'c3'));
    expect(plan.nodes.map((n) => n.scenario.name)).toEqual(['c3']);
    expect(order).toEqual(['c3']);
  });

  it('a serial feature is never split across shards', () => {
    const all = parse(SERIAL, OTHER, OTHER.replace('Search', 'Search2'));
    const plan = buildPlan(all, all, { workers: 2 });
    const serialIds = plan.nodes.filter((n) => n.serial).map((n) => n.id);
    for (let i = 1; i <= 3; i++) {
      const ids = new Set(shardPlan(plan, { index: i, count: 3 }).ids);
      const here = serialIds.filter((id) => ids.has(id)).length;
      expect([0, serialIds.length]).toContain(here);
    }
  });

  it('explains misuse: @serial on a scenario, @serial + @parallel, depending on a later scenario', () => {
    const onScenario = parse(`Feature: X\n  @serial\n  Scenario: a\n    Given work 1ms\n`);
    expect(buildPlan(onScenario, onScenario, {}).errors[0]!.message).toBe('@serial belongs on the Feature (or a Rule), not on a scenario');
    const both = parse(`@serial @parallel\nFeature: Y\n  Scenario: a\n    Given work 1ms\n`);
    expect(buildPlan(both, both, {}).errors[0]!.message).toContain('both @serial and @parallel');
    const later = parse(`@serial\nFeature: Z\n  @id:first @dependsOn:last\n  Scenario: a\n    Given work 1ms\n  @id:last\n  Scenario: b\n    Given work 1ms\n`);
    const msg = buildPlan(later, later, {}).errors[0]!.message;
    expect(msg).toContain('Dependency cycle');
    expect(msg).toContain('cannot depend on a later one');
  });
});
