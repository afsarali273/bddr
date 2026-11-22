import { describe, expect, it } from 'vitest';
import { EventBus, parseSpec, type BddrEvent, type StepAttemptFinished, type StepFinished } from '@bddr/core';
import { Executor, SupportRegistry, log, type DataTable, type StepContext } from '@bddr/runtime';

async function run(r: SupportRegistry, body: string, tags = '') {
  const src = `Feature: R\n  ${tags}\n  Scenario: s\n${body}`;
  const spec = parseSpec(src, 'r.feature');
  expect(spec.errors).toEqual([]);
  const bus = new EventBus({ keepHistory: true });
  const result = await new Executor({ registry: r, bus }).execute(spec.scenarios);
  const ev = bus.history!;
  const of = <T extends BddrEvent['type']>(t: T) => ev.filter((e): e is Extract<BddrEvent, { type: T }> => e.type === t);
  return { result, ev, of, status: result.scenarioStatuses.get('r.feature::s') };
}

describe('@repeat', () => {
  it('runs N times with {{i}}/{{n}} in text, tables and doc strings; ctx.step knows the iteration', async () => {
    const r = new SupportRegistry();
    const created: string[] = [];
    r.defineStep('I create user {string}', (ctx: StepContext, name: string, table: DataTable) => {
      created.push(`${name}|${table.hashes()[0]!['email']}|${ctx.step!.attempt}/${ctx.step!.of}`);
    });
    const { status, of } = await run(
      r,
      `    Given I create user "user-{{i}}" @repeat:3
      | email               |
      | u{{i}}-of-{{n}}@x.io |
`,
    );
    expect(status).toBe('passed');
    expect(created).toEqual(['user-1|u1-of-3@x.io|1/3', 'user-2|u2-of-3@x.io|2/3', 'user-3|u3-of-3@x.io|3/3']);
    expect(of('stepFinished')[0]).toMatchObject({ status: 'passed', mode: 'repeat', attempts: 3 });
    expect(of('stepAttemptFinished').map((a) => a.text)).toEqual(['I create user "user-1"', 'I create user "user-2"', 'I create user "user-3"']);
  });

  it('stops at the first failing repetition', async () => {
    const r = new SupportRegistry();
    const seen: number[] = [];
    r.defineStep('step', (ctx: StepContext) => {
      seen.push(ctx.step!.attempt);
      if (ctx.step!.attempt === 3) throw new Error('third broke');
    });
    const { status, of } = await run(r, '    Given step @repeat:10\n');
    expect(status).toBe('failed');
    expect(seen).toEqual([1, 2, 3]);
    expect(of('stepFinished')[0]).toMatchObject({ attempts: 3, error: { message: 'third broke' } });
  });

  it('@concurrency runs repetitions in parallel (100 users, 10 at a time)', async () => {
    const r = new SupportRegistry();
    let active = 0;
    let peak = 0;
    const users = new Set<string>();
    r.defineStep('I create user {string}', async (_ctx: StepContext, name: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((res) => setTimeout(res, 5));
      users.add(name);
      log.debug(`created ${name}`);
      active--;
    });
    const t0 = Date.now();
    const { status, of } = await run(r, '    Given I create user "user-{{i}}" @repeat:100 @concurrency:10\n');
    expect(status).toBe('passed');
    expect(users.size).toBe(100);
    expect(peak).toBe(10);
    expect(Date.now() - t0).toBeLessThan(400); // 100 x 5ms sequential would be >= 500ms
    // logs are attributed to the right repetition even when concurrent
    const logs = of('log').filter((l) => l.source === 'user');
    expect(logs.find((l) => l.message === 'created user-57')!.attempt).toBe(57);
  });
});

describe('concurrent: false guard', () => {
  it('rejects @concurrency on steps marked concurrent:false; plain @repeat still works sequentially', async () => {
    const r = new SupportRegistry();
    let active = 0;
    let peak = 0;
    r.defineStep('I click {string}', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((res) => setTimeout(res, 2));
      active--;
    }, { concurrent: false });
    const bad = await run(r, '    When I click "Load more" @repeat:5 @concurrency:5\n');
    expect(bad.status).toBe('failed');
    expect(bad.of('stepFinished')[0]!.error!.message).toMatch(/not allowed .* marked \{ concurrent: false \}/);
    const ok = await run(r, '    When I click "Load more" @repeat:5\n');
    expect(ok.status).toBe('passed');
    expect(peak).toBe(1);
  });
});

describe('@retry', () => {
  it('retries until the step passes, with delay and backoff', async () => {
    const r = new SupportRegistry();
    const times: number[] = [];
    r.defineStep('the order is shipped', () => {
      times.push(Date.now());
      if (times.length < 3) throw new Error(`not yet (${times.length})`);
    });
    const { status, of } = await run(r, '    Then the order is shipped @retry:5 @delay:20ms @backoff:2\n');
    expect(status).toBe('passed');
    expect(of('stepFinished')[0]).toMatchObject({ status: 'passed', mode: 'retry', attempts: 3 });
    expect(of('stepAttemptFinished').map((a) => [a.attempt, a.of, a.status, a.error?.message])).toEqual([
      [1, 6, 'failed', 'not yet (1)'],
      [2, 6, 'failed', 'not yet (2)'],
      [3, 6, 'passed', undefined],
    ]);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(18);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(38); // 20ms * 2
  });

  it('fails with the last error after all attempts; per-attempt timeout applies', async () => {
    const r = new SupportRegistry();
    r.defineStep('slow', () => new Promise((res) => setTimeout(res, 100)));
    const { status, of } = await run(r, '    Then slow @retry:2 @timeout:10ms\n');
    expect(status).toBe('failed');
    expect(of('stepFinished')[0]).toMatchObject({ attempts: 3, error: { message: expect.stringMatching(/timed out after 10 ms/) } });
  });

  it('never retries pending or skipped steps', async () => {
    const r = new SupportRegistry();
    let calls = 0;
    r.defineStep('todo', (ctx: StepContext) => {
      calls++;
      ctx.pending();
    });
    const { status } = await run(r, '    Given todo @retry:5\n');
    expect(status).toBe('pending');
    expect(calls).toBe(1);
  });

  it('step definition retry default; step tag and scenario @stepRetry override it', async () => {
    const r = new SupportRegistry();
    let n = 0;
    r.defineStep('eventually {int}', (_ctx: StepContext, ok: number) => {
      n++;
      if (n < ok) throw new Error('no');
    }, { retry: { attempts: 3, delay: '1ms' } });
    expect((await run(r, '    Given eventually 3\n')).status).toBe('passed');
    n = 0;
    expect((await run(r, '    Given eventually 3 @retry:1\n')).status).toBe('failed');
    n = 0;
    expect((await run(r, '    Given eventually 5\n', '@stepRetry:4')).status).toBe('passed');
  });
});

describe('step hooks around repeated/retried steps', () => {
  it('BeforeStep/AfterStep run once per step; eachAttempt hooks run around every attempt', async () => {
    const r = new SupportRegistry();
    const log: string[] = [];
    r.defineStep('poll', (ctx: StepContext) => {
      log.push(`body ${ctx.step!.attempt}`);
      if (ctx.step!.attempt < 2) throw new Error('again');
    });
    r.defineHook('step', 'before', {}, (ctx) => void log.push(`before ${ctx.step!.attempt}`));
    r.defineHook('step', 'after', {}, (ctx) => void log.push(`after ${ctx.step!.attempt}`));
    r.defineHook('step', 'before', { eachAttempt: true }, (ctx) => void log.push(`beforeEach ${ctx.step!.attempt}`));
    r.defineHook('step', 'after', { eachAttempt: true }, (ctx) => void log.push(`afterEach ${ctx.step!.attempt}`));
    await run(r, '    Then poll @retry:3\n');
    expect(log).toEqual(['before 1', 'beforeEach 1', 'body 1', 'afterEach 1', 'beforeEach 2', 'body 2', 'afterEach 2', 'after 1']);
    expect(() => r.defineHook('scenario', 'before', { eachAttempt: true }, () => {})).toThrow(/only applies to BeforeStep/);
  });
});

void (null as unknown as StepAttemptFinished | StepFinished);
