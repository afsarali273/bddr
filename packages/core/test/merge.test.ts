import { describe, expect, it } from 'vitest';
import { EventBus, idsToRerun, mergeEventStreams, parseNdjson, parseSpec, selectScenarios, type BddrEvent } from '@bddr/core';
import { Executor, SupportRegistry, type StepContext } from '@bddr/runtime';

const SRC = `Feature: M
  Scenario: a
    Given ok
  @id:b
  Scenario: b
    Given flaky
  @id:c @dependsOn:b
  Scenario: c
    Given ok
`;

async function runOnce(failB: boolean, onlyIds?: string[]): Promise<BddrEvent[]> {
  const r = new SupportRegistry();
  r.defineStep('ok', () => {});
  r.defineStep('flaky', (_c: StepContext) => {
    if (failB) throw new Error('b broke');
  });
  let scenarios = parseSpec(SRC, 'm.feature').scenarios;
  if (onlyIds) scenarios = selectScenarios(scenarios, { ids: onlyIds });
  const bus = new EventBus({ keepHistory: true });
  await new Executor({ registry: r, bus }).execute(scenarios);
  return JSON.parse(JSON.stringify(bus.history)) as BddrEvent[];
}

describe('rerun + merge', () => {
  it('idsToRerun lists everything that did not pass (incl. skipped dependents)', async () => {
    const first = await runOnce(true);
    expect(idsToRerun(first)).toEqual(['b', 'c']);
    expect(parseNdjson(first.map((e) => JSON.stringify(e)).join('\n'))).toHaveLength(first.length);
  });

  it('merges runs: later results win, recovered scenarios are flaky, summary recomputed', async () => {
    const first = await runOnce(true);
    const second = await runOnce(false, idsToRerun(first));
    const merged = mergeEventStreams([first, second]);
    const finals = merged.filter((e) => e.type === 'scenarioFinished');
    expect(finals.map((e) => [e.scenarioId, e.status, !!e.flaky])).toEqual([
      ['m.feature::a', 'passed', false],
      ['b', 'passed', true],
      ['c', 'passed', true],
    ]);
    const end = merged.at(-1)!;
    expect(end.type).toBe('runFinished');
    if (end.type === 'runFinished') {
      expect(end.success).toBe(true);
      expect(end.summary.scenarios).toMatchObject({ passed: 3, total: 3 });
      expect(end.summary.flaky).toBe(2);
    }
    expect(merged.filter((e) => e.type === 'planReady')).toHaveLength(1);
  });
});
