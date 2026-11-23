/** `scenarioStarted.waitedForMs`: how long a ready scenario waited for a worker, lock or group slot. */
import { describe, expect, it } from 'vitest';
import { EventBus, buildPlan, parseSpec } from '@bddr/core';
import { Executor, SupportRegistry } from '@bddr/runtime';

async function startedEvents(src: string, workers: number) {
  const r = new SupportRegistry();
  r.defineStep('work {int}ms', (_ctx, ms: number) => new Promise((res) => setTimeout(res, ms)));
  r.defineStep('fail', () => {
    throw new Error('boom');
  });
  const { scenarios, errors } = parseSpec(src, 'w.feature');
  expect(errors).toEqual([]);
  const plan = buildPlan(scenarios, scenarios, { workers });
  const bus = new EventBus({ keepHistory: true });
  await new Executor({ registry: r, bus, plan }).execute(scenarios);
  const byName = new Map(scenarios.map((s) => [s.id, s.name]));
  return new Map(
    bus.history!.flatMap((e) => (e.type === 'scenarioStarted' ? [[byName.get(e.scenarioId)!, e] as const] : [])),
  );
}

describe('waitedForMs', () => {
  it('is small for scenarios that start at once and large for one held back by a @lock', async () => {
    const started = await startedEvents(
      `Feature: L
  @lock:db
  Scenario: a
    Given work 80ms
  @lock:db
  Scenario: b
    Given work 10ms
  Scenario: c
    Given work 10ms
`,
      3,
    );
    expect(started.get('a')!.waitedForMs).toBeLessThan(40);
    expect(started.get('c')!.waitedForMs).toBeLessThan(40);
    expect(started.get('b')!.waitedForMs).toBeGreaterThanOrEqual(60);
  });

  it('counts waiting for a free worker', async () => {
    const started = await startedEvents(
      `Feature: W
  Scenario: a
    Given work 80ms
  Scenario: b
    Given work 10ms
`,
      1,
    );
    expect(started.get('a')!.waitedForMs).toBeLessThan(40);
    expect(started.get('b')!.waitedForMs).toBeGreaterThanOrEqual(60);
  });

  it('does not count time spent waiting for a dependency (the scenario was not ready yet)', async () => {
    const started = await startedEvents(
      `Feature: D
  @id:first
  Scenario: first
    Given work 80ms
  @dependsOn:first
  Scenario: second
    Given work 10ms
`,
      2,
    );
    expect(started.get('second')!.waitedForMs).toBeLessThan(40);
  });

  it('is only reported on the first attempt', async () => {
    const r = new SupportRegistry();
    let n = 0;
    r.defineStep('flaky', () => {
      if (++n < 2) throw new Error('first try fails');
    });
    const { scenarios } = parseSpec('Feature: R\n  Scenario: a\n    Given flaky\n', 'r.feature');
    const plan = buildPlan(scenarios, scenarios, { workers: 1 });
    const bus = new EventBus({ keepHistory: true });
    await new Executor({ registry: r, bus, plan, retry: { scenario: 1 } }).execute(scenarios);
    const starts = bus.history!.filter((e) => e.type === 'scenarioStarted');
    expect(starts.map((e) => e.attempt)).toEqual([1, 2]);
    expect(starts[0]!.waitedForMs).toBeDefined();
    expect(starts[1]!.waitedForMs).toBeUndefined();
  });
});
