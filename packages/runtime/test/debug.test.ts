import { describe, expect, it } from 'vitest';
import { SupportRegistry, type DebugController, type StepContext } from '@bddr/runtime';
import { run, scenariosOf } from './helpers.js';

const SRC = `Feature: Dbg
  Scenario: flaky
    Given a counter
    When it is bumped
    Then it is 2
`;

function steps(r: SupportRegistry) {
  r.defineStep('a counter', (ctx: StepContext) => void ctx.state.set('n', 0));
  r.defineStep('it is bumped', (ctx: StepContext) => void ctx.state.set('n', ctx.state.get<number>('n') + 1));
  r.defineStep('it is {int}', (ctx: StepContext, n: number) => {
    if (ctx.state.get('n') !== n) throw new Error(`expected ${n}, got ${ctx.state.get('n')}`);
  });
}

describe('executor: debug controller', () => {
  it('beforeStep is called for every step that runs, in order, with scenario and step info', async () => {
    const r = new SupportRegistry();
    steps(r);
    const seen: string[] = [];
    const debug: DebugController = {
      async beforeStep(v) {
        seen.push(`${v.step.index}/${v.step.total}:${v.step.text}`);
        return 'run';
      },
    };
    const { result } = await run(r, scenariosOf(SRC.replace('is 2', 'is 1')), { debug });
    expect(seen).toEqual(['1/3:a counter', '2/3:it is bumped', '3/3:it is 1']);
    expect(result.success).toBe(true);
  });

  it("'quit' before a step skips it", async () => {
    const r = new SupportRegistry();
    steps(r);
    const debug: DebugController = { beforeStep: async (v) => (v.step.index === 2 ? 'quit' : 'run') };
    const { stepStatuses } = await run(r, scenariosOf(SRC), { debug });
    expect(stepStatuses('f1.feature::flaky')[1]).toBe('skipped');
  });

  it('onFailure can fix state and retry the failed step, which then passes', async () => {
    const r = new SupportRegistry();
    steps(r);
    let calls = 0;
    const debug: DebugController = {
      async onFailure(v) {
        calls++;
        v.ctx.state.set('n', 2); // what you would do from the prompt: e ctx.state.set('n', 2)
        return 'retry';
      },
    };
    const { result, stepStatuses } = await run(r, scenariosOf(SRC), { debug });
    expect(calls).toBe(1);
    expect(stepStatuses('f1.feature::flaky')).toEqual(['passed', 'passed', 'passed']);
    expect(result.success).toBe(true);
  });

  it("onFailure 'continue' accepts the failure and does not retry", async () => {
    const r = new SupportRegistry();
    steps(r);
    let calls = 0;
    const debug: DebugController = { onFailure: async () => (calls++, 'continue') };
    const { result, stepStatuses } = await run(r, scenariosOf(SRC), { debug });
    expect(calls).toBe(1);
    expect(result.success).toBe(false);
    expect(stepStatuses('f1.feature::flaky')).toEqual(['passed', 'passed', 'failed']);
  });

  it('keeps asking while the retried step keeps failing', async () => {
    const r = new SupportRegistry();
    steps(r);
    const actions: Array<'retry' | 'continue'> = ['retry', 'retry', 'continue'];
    const debug: DebugController = { onFailure: async () => actions.shift()! };
    const { stepStatuses } = await run(r, scenariosOf(SRC), { debug });
    expect(actions).toEqual([]);
    expect(stepStatuses('f1.feature::flaky')[2]).toBe('failed');
  });

  it('never retries scenarios and ignores step timeouts while debugging', async () => {
    const r = new SupportRegistry();
    r.defineStep('a slow step', async () => {
      await new Promise((res) => setTimeout(res, 60));
    }, { timeoutMs: 5 });
    r.defineStep('a failing step', () => {
      throw new Error('boom');
    });
    const src = `Feature: X\n  Scenario: s\n    Given a slow step\n    Then a failing step\n`;
    const { of } = await run(r, scenariosOf(src), { debug: {}, retry: { scenario: 3 } });
    expect(of('scenarioStarted')).toHaveLength(1);
    expect(of('stepFinished').map((e) => e.status)).toEqual(['passed', 'failed']);
  });
});
