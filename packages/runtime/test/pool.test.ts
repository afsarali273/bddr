/**
 * Coordinator ↔ worker protocol without processes: a fake RemotePool whose lanes are worker-mode Executors in this
 * process (each with its own scopes and stores, like a real worker). Real processes are covered by the CLI e2e tests.
 */
import { describe, expect, it } from 'vitest';
import { EventBus, buildPlan, parseSpec, type BddrEvent, type Plan, type PlanOptions, type Status } from '@bddr/core';
import {
  Executor,
  SupportRegistry,
  WorkerCrashedError,
  type CloseResult,
  type NodeRequest,
  type NodeResult,
  type RemotePool,
  type ScopeRef,
  type StepContext,
} from '@bddr/runtime';

class FakePool implements RemotePool {
  readonly lanes = new Map<string, Executor>();
  private readonly log: Array<[string, Status, Record<string, unknown> | undefined]> = [];
  private readonly synced = new Map<string, number>();
  private seed: Record<string, unknown> = {};
  crashOn = new Set<string>();

  constructor(
    private readonly registry: SupportRegistry,
    private readonly plan: Plan,
    private readonly bus: EventBus,
  ) {}

  async start(seed: Record<string, unknown>) {
    this.seed = seed;
  }
  publish(id: string, status: Status, exports: Record<string, unknown> | undefined) {
    this.log.push([id, status, exports]);
  }
  private async lane(w: string) {
    let ex = this.lanes.get(w);
    if (!ex) {
      const bus = new EventBus();
      bus.on((e) => void this.bus.emit(e));
      ex = new Executor({ registry: this.registry, bus, plan: this.plan, remoteWorker: true });
      await ex.initWorker(structuredClone(this.seed));
      this.lanes.set(w, ex);
      this.synced.set(w, 0);
    }
    return ex;
  }
  async run(req: NodeRequest): Promise<NodeResult> {
    if (this.crashOn.delete(req.nodeId)) {
      this.lanes.delete(req.workerId);
      throw new WorkerCrashedError(`worker ${req.workerId} exited unexpectedly (code 1)`);
    }
    const ex = await this.lane(req.workerId);
    const finished = this.log.slice(this.synced.get(req.workerId));
    this.synced.set(req.workerId, this.log.length);
    return structuredClone(await ex.runAssigned({ ...req, finished }));
  }
  async close(workerIds: readonly string[], scopes: readonly ScopeRef[]): Promise<CloseResult> {
    const out: CloseResult = { failed: [], runFailed: false };
    for (const w of workerIds) {
      const r = await this.lanes.get(w)?.closeScopes(scopes);
      if (r) {
        out.failed.push(...r.failed);
        out.runFailed ||= r.runFailed;
      }
    }
    return out;
  }
  async stop() {
    let runFailed = false;
    for (const ex of this.lanes.values()) runFailed ||= (await ex.shutdownWorker()).runFailed;
    return { runFailed };
  }
}

async function runPooled(r: SupportRegistry, src: string, plan: PlanOptions = {}, crashOn: string[] = [], execute: Partial<ConstructorParameters<typeof Executor>[0]> = {}) {
  const spec = parseSpec(src, 'x.feature');
  expect(spec.errors).toEqual([]);
  const p = buildPlan(spec.scenarios, spec.scenarios, plan);
  expect(p.errors).toEqual([]);
  const bus = new EventBus({ keepHistory: true });
  const pool = new FakePool(r, p, bus);
  for (const c of crashOn) pool.crashOn.add(c);
  const result = await new Executor({ registry: r, bus, plan: p, pool, ...execute }).execute(spec.scenarios);
  const of = <T extends BddrEvent['type']>(t: T) => bus.history!.filter((e): e is Extract<BddrEvent, { type: T }> => e.type === t);
  return { result, of, pool, status: (id: string) => result.scenarioStatuses.get(id) };
}

describe('coordinator + worker mode (fake pool)', () => {
  it('BeforeAll once in the coordinator, BeforeWorker per lane, feature hooks per lane, events once', async () => {
    const r = new SupportRegistry();
    const trace: string[] = [];
    r.defineHook('run', 'before', {}, (ctx) => {
      trace.push('beforeAll');
      ctx.run.set('seed', 42);
    });
    r.defineHook('run', 'after', {}, () => void trace.push('afterAll'));
    r.defineHook('worker', 'before', {}, (ctx) => void trace.push(`beforeWorker seed=${ctx.run.get('seed')}`));
    r.defineHook('worker', 'after', {}, () => void trace.push('afterWorker'));
    r.defineHook('feature', 'before', {}, () => void trace.push('beforeFeature'));
    r.defineHook('feature', 'after', {}, () => void trace.push('afterFeature'));
    r.defineStep('wait', () => new Promise((res) => setTimeout(res, 20)));
    const { result, of } = await runPooled(
      r,
      `Feature: F\n  Scenario: a\n    Given wait\n  Scenario: b\n    Given wait\n  Scenario: c\n    Given wait\n`,
      { workers: 2 },
    );
    expect(result.success).toBe(true);
    expect(trace.filter((t) => t === 'beforeAll')).toHaveLength(1);
    expect(trace.filter((t) => t === 'beforeWorker seed=42')).toHaveLength(2);
    expect(trace.filter((t) => t === 'afterWorker')).toHaveLength(2);
    expect(trace.filter((t) => t === 'beforeFeature')).toHaveLength(2);
    expect(trace.filter((t) => t === 'afterFeature')).toHaveLength(2);
    expect(trace.at(-1)).toBe('afterAll');
    expect(of('featureStarted')).toHaveLength(1);
    expect(of('featureFinished').map((e) => e.status)).toEqual(['passed']);
    expect(of('scenarioFinished')).toHaveLength(3);
    expect(new Set(of('scenarioStarted').map((e) => e.workerId))).toEqual(new Set(['w1', 'w2']));
  });

  it('exports cross lanes (ctx.from) and AfterGroup runs before dependents start', async () => {
    const r = new SupportRegistry();
    const order: string[] = [];
    r.defineStep('export {int}', (ctx: StepContext, n: number) => ctx.export('n', n));
    r.defineStep('read {string} = {int}', (ctx: StepContext, id: string, n: number) => {
      order.push('read');
      expect(ctx.from(id).get('n')).toBe(n);
    });
    r.defineHook('group', 'after', {}, (ctx) => void order.push(`afterGroup ${ctx.groupName}`));
    const { result } = await runPooled(
      r,
      `Feature: F
  @id:p1 @group:setup
  Scenario: p1
    Given export 1
  @id:p2 @group:setup
  Scenario: p2
    Given export 2
  @dependsOn:group:setup
  Scenario: c
    Then read "p1" = 1
    And read "p2" = 2
`,
      { workers: 2 },
    );
    expect(result.success).toBe(true);
    expect(order.indexOf('read')).toBeGreaterThan(order.lastIndexOf('afterGroup setup'));
  });

  it('scenario retry happens in the worker; group retry is decided by the coordinator', async () => {
    const r = new SupportRegistry();
    let warm = 0;
    r.defineStep('flaky until attempt {int}', (ctx: StepContext, n: number) => {
      if (ctx.scenario.attempt < n) throw new Error('flaky');
    });
    r.defineStep('warm after {int}', (_c: StepContext, n: number) => {
      if (++warm < n) throw new Error('cold');
    });
    const { result, of, status } = await runPooled(
      r,
      `Feature: F
  @id:s @retry:2
  Scenario: s
    Given flaky until attempt 2
  @id:g @group:warm
  Scenario: g
    Given warm after 2
`,
      { workers: 2, groups: { warm: { retry: 1 } } },
    );
    expect(status('s')).toBe('passed');
    expect(status('g')).toBe('passed');
    expect(of('groupRetrying').map((e) => e.group)).toEqual(['warm']);
    expect(result.summary).toMatchObject({ flaky: 2, retried: 2 });
    expect(of('scenarioFinished').filter((e) => e.scenarioId === 'g').map((e) => [e.attempt, e.status])).toEqual([
      [1, 'failed'],
      [2, 'passed'],
    ]);
  });

  it('a crashed worker fails that scenario only', async () => {
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    const { result, status, of } = await runPooled(r, `Feature: F\n  @id:a\n  Scenario: a\n    Given ok\n  @id:b\n  Scenario: b\n    Given ok\n`, { workers: 1 }, ['a']);
    expect(status('a')).toBe('failed');
    expect(status('b')).toBe('passed');
    expect(of('scenarioFinished').find((e) => e.scenarioId === 'a')?.error?.message).toContain('exited unexpectedly');
    expect(result.success).toBe(false);
  });

  it('can retry a scenario on a fresh lane after a worker crash', async () => {
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    const { result, status, of } = await runPooled(
      r,
      `Feature: F\n  @id:a\n  Scenario: a\n    Given ok\n`,
      { workers: 1 },
      ['a'],
      { retry: { workerCrash: 1 } },
    );
    expect(status('a')).toBe('passed');
    expect(of('scenarioFinished').map((e) => [e.attempt, e.status, !!e.willRetry, !!e.flaky])).toEqual([
      [1, 'failed', true, false],
      [2, 'passed', false, true],
    ]);
    expect(result.success).toBe(true);
  });

  it('BeforeWorker failure skips that lane’s scenarios and fails the run', async () => {
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    r.defineHook('worker', 'before', {}, () => {
      throw new Error('no browser');
    });
    const { result, of } = await runPooled(r, `Feature: F\n  Scenario: a\n    Given ok\n`, { workers: 1 });
    expect(of('scenarioFinished')[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/^BeforeWorker hook .* failed$/) });
    expect(result.success).toBe(false);
  });

  it('AfterWorker does not run in a worker whose BeforeWorker failed', async () => {
    const r = new SupportRegistry();
    const calls: string[] = [];
    r.defineStep('ok', () => {});
    r.defineHook('worker', 'before', {}, () => {
      throw new Error('no browser');
    });
    r.defineHook('worker', 'after', {}, () => {
      calls.push('after');
    });
    await runPooled(r, `Feature: F\n  Scenario: a\n    Given ok\n`, { workers: 1 });
    expect(calls).toEqual([]);
  });
});

describe('inline pool worker hooks', () => {
  it('AfterWorker does not run after a failed BeforeWorker', async () => {
    const r = new SupportRegistry();
    const calls: string[] = [];
    r.defineStep('ok', () => {});
    r.defineHook('worker', 'before', {}, () => {
      throw new Error('no browser');
    });
    r.defineHook('worker', 'after', {}, () => {
      calls.push('after');
    });
    const spec = parseSpec(`Feature: F\n  Scenario: a\n    Given ok\n`, 'x.feature');
    const plan = buildPlan(spec.scenarios, spec.scenarios, { workers: 1 });
    const result = await new Executor({ registry: r, bus: new EventBus(), plan }).execute(spec.scenarios);
    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
  });

  it('BeforeWorker/AfterWorker run once, inside BeforeAll/AfterAll', async () => {
    const r = new SupportRegistry();
    const trace: string[] = [];
    r.defineHook('run', 'before', {}, () => void trace.push('beforeAll'));
    r.defineHook('worker', 'before', {}, () => void trace.push('beforeWorker'));
    r.defineHook('worker', 'after', {}, () => void trace.push('afterWorker'));
    r.defineHook('run', 'after', {}, () => void trace.push('afterAll'));
    r.defineStep('ok', () => void trace.push('step'));
    const spec = parseSpec(`Feature: F\n  Scenario: a\n    Given ok\n  Scenario: b\n    Given ok\n`, 'x.feature');
    const plan = buildPlan(spec.scenarios, spec.scenarios, { workers: 2 });
    await new Executor({ registry: r, bus: new EventBus(), plan }).execute(spec.scenarios);
    expect(trace).toEqual(['beforeAll', 'beforeWorker', 'step', 'step', 'afterWorker', 'afterAll']);
  });
});
