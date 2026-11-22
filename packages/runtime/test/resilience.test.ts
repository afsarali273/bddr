import { describe, expect, it } from 'vitest';
import { EventBus, buildPlan, parseSpec, type BddrEvent, type PlanOptions } from '@bddr/core';
import { Executor, SupportRegistry, type ExecuteOptions, type StepContext } from '@bddr/runtime';

async function run(r: SupportRegistry, src: string, plan: PlanOptions = {}, opts: Partial<ExecuteOptions> = {}) {
  const spec = parseSpec(src, 'x.feature');
  expect(spec.errors).toEqual([]);
  const p = buildPlan(spec.scenarios, spec.scenarios, plan);
  expect(p.errors).toEqual([]);
  const bus = new EventBus({ keepHistory: true });
  const result = await new Executor({ registry: r, bus, plan: p, ...opts }).execute(spec.scenarios);
  const of = <T extends BddrEvent['type']>(t: T) => bus.history!.filter((e): e is Extract<BddrEvent, { type: T }> => e.type === t);
  const id = (name: string) => spec.scenarios.find((s) => s.name === name)!.id;
  return { result, of, status: (n: string) => result.scenarioStatuses.get(id(n)), id };
}

/** A step that fails until `ctx.scenario.attempt` reaches n. */
function flakySteps(r: SupportRegistry, log: string[] = []) {
  r.defineStep('passes on attempt {int}', (ctx: StepContext, n: number) => {
    log.push(`${ctx.scenario.name}#${ctx.scenario.attempt} state=${ctx.state.find('seen') ?? '-'}`);
    ctx.state.set('seen', 'yes');
    if (ctx.scenario.attempt < n) throw new Error(`NetworkError: attempt ${ctx.scenario.attempt}`);
  });
  r.defineStep('fails with {string}', (_c: StepContext, msg: string) => {
    throw new Error(msg);
  });
  r.defineStep('ok', () => {});
  return log;
}

describe('scenario retry', () => {
  it('@retry:N re-runs the whole scenario with fresh state and hooks; pass after failure = flaky', async () => {
    const r = new SupportRegistry();
    const log = flakySteps(r);
    let befores = 0;
    r.defineHook('scenario', 'before', {}, () => void befores++);
    const { result, of, status } = await run(r, `Feature: R\n  @retry:3\n  Scenario: s\n    Given passes on attempt 3\n`);
    expect(status('s')).toBe('passed');
    expect(log).toEqual(['s#1 state=-', 's#2 state=-', 's#3 state=-']);
    expect(befores).toBe(3);
    expect(of('scenarioFinished').map((e) => [e.attempt, e.status, !!e.willRetry, !!e.flaky])).toEqual([
      [1, 'failed', true, false],
      [2, 'failed', true, false],
      [3, 'passed', false, true],
    ]);
    expect(result.summary.scenarios).toMatchObject({ passed: 1, failed: 0, total: 1 });
    expect(result.summary.steps).toMatchObject({ passed: 1, total: 1 }); // final attempt only
    expect(result.summary).toMatchObject({ flaky: 1, retried: 1 });
    expect(result.success).toBe(true);
  });

  it('config default, @noRetry, retry.on filter and failOnFlaky', async () => {
    const r = new SupportRegistry();
    flakySteps(r);
    const src = `Feature: R
  Scenario: net
    Given passes on attempt 2
  Scenario: assertion
    Given fails with "expected 1 got 2"
  @noRetry
  Scenario: opted out
    Given passes on attempt 2
`;
    const { status, of, result } = await run(r, src, {}, { retry: { scenario: 2, on: ['NetworkError'] } });
    expect(status('net')).toBe('passed');
    expect(of('scenarioFinished').filter((e) => e.scenarioId.endsWith('assertion'))).toHaveLength(1); // filtered out
    expect(status('opted out')).toBe('failed');
    expect(result.success).toBe(false);
    const strict = await run(r, `Feature: F\n  Scenario: net\n    Given passes on attempt 2\n`, {}, { retry: { scenario: 1, failOnFlaky: true } });
    expect(strict.status('net')).toBe('passed');
    expect(strict.result.success).toBe(false);
  });

  it('custom retry analyzer decides (TestNG IRetryAnalyzer style)', async () => {
    const r = new SupportRegistry();
    flakySteps(r);
    const seen: string[] = [];
    r.retryAnalyzer = ({ attempt, error, scenario }) => {
      seen.push(`${scenario.name}:${attempt}:${error?.message}`);
      return attempt < 2;
    };
    const { status } = await run(r, `Feature: A\n  @retry:5\n  Scenario: s\n    Given passes on attempt 9\n`);
    expect(status('s')).toBe('failed');
    expect(seen).toEqual(['s:1:NetworkError: attempt 1', 's:2:NetworkError: attempt 2']);
  });

  it('applies exponential backoff between scenario attempts', async () => {
    const r = new SupportRegistry();
    flakySteps(r);
    const started = performance.now();
    const { status } = await run(r, `Feature: B\n  Scenario: s\n    Given passes on attempt 3\n`, {}, {
      retry: { scenario: 2, delayMs: 15, backoff: 2 },
    });
    expect(status('s')).toBe('passed');
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('dependents wait for the final attempt and see its exports only', async () => {
    const r = new SupportRegistry();
    r.defineStep('produce', (ctx: StepContext) => {
      ctx.export('attempt', ctx.scenario.attempt);
      if (ctx.scenario.attempt < 2) throw new Error('first try fails');
    });
    let got: unknown;
    r.defineStep('consume', (ctx: StepContext) => void (got = ctx.from('p').get('attempt')));
    const { status } = await run(r, `Feature: D\n  @id:p @retry:1\n  Scenario: p\n    Given produce\n  @dependsOn:p\n  Scenario: c\n    Given consume\n`, { workers: 2 });
    expect(status('c')).toBe('passed');
    expect(got).toBe(2);
  });
});

describe('quarantine', () => {
  it('@quarantine failures do not fail the run but are reported', async () => {
    const r = new SupportRegistry();
    flakySteps(r);
    const { result, of } = await run(r, `Feature: Q\n  @quarantine\n  Scenario: known broken\n    Given fails with "bug 123"\n  Scenario: fine\n    Given ok\n`);
    expect(result.success).toBe(true);
    expect(result.summary).toMatchObject({ quarantined: 1 });
    expect(result.summary.scenarios.failed).toBe(1);
    expect(of('scenarioFinished')[0]).toMatchObject({ status: 'failed', quarantined: true });
  });
});

describe('group retry', () => {
  const SRC = `Feature: G
  @group:setup @id:s1
  Scenario: s1
    Given passes on attempt 1
  @group:setup @id:s2
  Scenario: s2
    Given setup step
  @dependsOn:group:setup
  Scenario: after
    Given ok
`;
  it('re-runs the whole group (hooks included) until it passes; dependents wait for the group to settle', async () => {
    const r = new SupportRegistry();
    flakySteps(r);
    let groupRuns = 0;
    const order: string[] = [];
    r.defineStep('setup step', (ctx: StepContext) => {
      order.push(`s2 run ${groupRuns}`);
      if (groupRuns < 2) throw new Error('setup not ready');
    });
    r.defineHook('group', 'before', {}, (c) => {
      groupRuns++;
      order.push(`beforeGroup ${c.groupName} ${groupRuns}`);
    });
    r.defineHook('scenario', 'before', { tags: 'not @group:setup' }, (c) => void order.push(`start ${c.scenario.name}`));
    const { status, of, result } = await run(r, SRC, { workers: 3, groups: { setup: { retry: 2 } } });
    expect(status('s2')).toBe('passed');
    expect(status('after')).toBe('passed');
    expect(groupRuns).toBe(2);
    expect(order.indexOf('start after')).toBeGreaterThan(order.lastIndexOf('s2 run 2'));
    expect(of('groupRetrying')).toMatchObject([{ group: 'setup', attempt: 2, scenarioIds: ['s1', 's2'] }]);
    expect(result.summary.flaky).toBe(1); // s2 failed in group attempt 1, passed in 2
  });

  it('retryMembers: failed re-runs only failing members; exhausting retries skips dependents', async () => {
    const r = new SupportRegistry();
    flakySteps(r);
    let s1Runs = 0;
    r.defineStep('setup step', () => {
      throw new Error('never ready');
    });
    r.defineHook('scenario', 'before', { tags: '@id:s1' }, () => void s1Runs++);
    const { status, of } = await run(r, SRC, { groups: { setup: { retry: 2, retryMembers: 'failed' } } });
    expect(s1Runs).toBe(1);
    expect(of('groupRetrying').map((e) => e.scenarioIds)).toEqual([['s2'], ['s2']]);
    expect(status('s2')).toBe('failed');
    expect(status('after')).toBe('skipped');
  });

  it('scenarioRetry on a group is the default per-member retry', async () => {
    const r = new SupportRegistry();
    flakySteps(r);
    const { status } = await run(r, `Feature: S\n  @group:api\n  Scenario: a\n    Given passes on attempt 2\n`, { groups: { api: { scenarioRetry: 1 } } });
    expect(status('a')).toBe('passed');
  });
});

describe('soft assertions', () => {
  it('collects failures and fails the step at its end with all of them', async () => {
    const r = new SupportRegistry();
    const after: string[] = [];
    r.defineStep('checks', async (ctx: StepContext) => {
      ctx.soft.check(1 + 1 === 3, 'math is broken');
      ctx.soft.run(() => {
        throw new Error('assert A');
      });
      await ctx.soft.run(async () => {
        throw new Error('assert B');
      });
      after.push('kept going');
    });
    r.defineStep('fine soft', (ctx: StepContext) => ctx.soft.check(true, 'never'));
    const { of, status } = await run(r, `Feature: S\n  Scenario: s\n    Given fine soft\n    Then checks\n`);
    expect(after).toEqual(['kept going']);
    expect(status('s')).toBe('failed');
    expect(of('stepFinished')[1]!.error!.message).toBe('3 soft assertion(s) failed:\n  1) math is broken\n  2) assert A\n  3) assert B');
  });
});

describe('scenario timeout', () => {
  it('@timeout on a scenario caps the remaining steps; later steps are skipped', async () => {
    const r = new SupportRegistry();
    r.defineStep('wait {int}ms', (_c: StepContext, ms: number) => new Promise((res) => setTimeout(res, ms)));
    const { of, status } = await run(r, `Feature: T\n  @timeout:60ms\n  Scenario: s\n    Given wait 30ms\n    When wait 100ms\n    Then wait 1ms\n`);
    expect(status('s')).toBe('failed');
    const steps = of('stepFinished');
    expect(steps.map((e) => e.status)).toEqual(['passed', 'failed', 'skipped']);
    expect(steps[1]!.error!.message).toMatch(/Scenario "s" \(time budget 60 ms\) at step "wait 100ms" timed out/);
  });
});

describe('cancellation and broader time budgets', () => {
  it('cancels an in-flight step through ctx.signal and skips work not yet started', async () => {
    const r = new SupportRegistry();
    let exposed: AbortSignal | undefined;
    r.defineStep('wait for cancellation', (ctx: StepContext) => {
      exposed = ctx.signal;
      return new Promise<void>(() => undefined);
    });
    r.defineStep('ok', () => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('deployment cancelled')), 20);
    const { status, of } = await run(
      r,
      `Feature: C\n  Scenario: running\n    Given wait for cancellation\n  Scenario: queued\n    Given ok\n`,
      { workers: 1 },
      { signal: controller.signal },
    );
    expect(exposed).toBe(controller.signal);
    expect(status('running')).toBe('failed');
    expect(status('queued')).toBe('skipped');
    expect(of('scenarioFinished').find((e) => e.scenarioId.endsWith('running'))?.error?.message).toBe('deployment cancelled');
    expect(of('scenarioFinished').find((e) => e.scenarioId.endsWith('queued'))?.reason).toContain('cancelled: deployment cancelled');
  });

  it('enforces a group time budget and skips remaining members', async () => {
    const r = new SupportRegistry();
    r.defineStep('wait {int}ms', (_ctx: StepContext, ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    r.defineStep('ok', () => {});
    const { status, of } = await run(
      r,
      `Feature: G\n  @group:batch\n  Scenario: slow\n    Given wait 100ms\n  @group:batch\n  Scenario: queued\n    Given ok\n`,
      { workers: 1, groups: { batch: { timeout: '25ms' } } },
    );
    expect(status('slow')).toBe('failed');
    expect(status('queued')).toBe('skipped');
    expect(of('scenarioFinished').find((e) => e.scenarioId.endsWith('slow'))?.error?.message).toContain('Group "batch" timed out after 25 ms');
    expect(of('scenarioFinished').find((e) => e.scenarioId.endsWith('queued'))?.reason).toContain('group "batch" timed out after 25 ms');
  });
});
