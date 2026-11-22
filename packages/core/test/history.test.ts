import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryRecorder, loadHistory, rankScenarios, saveHistory, scenarioHistory, type BddrEvent, type HistoryRun, type Status } from '@bddr/core';

const run = (n: number, scenarios: Record<string, Status | 'flaky'>): HistoryRun => ({
  v: 1,
  runId: `run-${n}`,
  startedAt: 1_000 + n,
  durationMs: 10,
  success: true,
  workers: 1,
  scenarios: Object.fromEntries(
    Object.entries(scenarios).map(([id, s]) => [id, { s: s === 'flaky' ? 'passed' : s, d: 5, n: id, ...(s === 'flaky' ? { f: 1 as const, a: 2 } : {}) }]),
  ),
});

describe('history', () => {
  it('flakiness score: flips and flaky passes are unstable; stable failures are not flaky', () => {
    const runs = [
      run(1, { stable: 'passed', broken: 'failed', flips: 'passed', retried: 'passed' }),
      run(2, { stable: 'passed', broken: 'failed', flips: 'failed', retried: 'flaky' }),
      run(3, { stable: 'passed', broken: 'failed', flips: 'passed', retried: 'passed' }),
      run(4, { stable: 'passed', broken: 'failed', flips: 'failed', retried: 'flaky' }),
    ];
    expect(scenarioHistory(runs, 'stable').score).toBe(0);
    expect(scenarioHistory(runs, 'broken')).toMatchObject({ score: 0, failed: 4, passed: 0 });
    expect(scenarioHistory(runs, 'flips').score).toBe(0.75); // runs 2, 3, 4 flipped
    expect(scenarioHistory(runs, 'retried')).toMatchObject({ score: 0.5, flaky: 2, trend: ['passed', 'flaky', 'passed', 'flaky'] });
    expect(scenarioHistory([runs[0]!], 'flips').score).toBe(0); // one run: no score
    expect(rankScenarios(runs).map((r) => r.id)).toEqual(['flips', 'retried', 'broken', 'stable']);
  });

  it('records the final attempt from events', () => {
    const rec = new HistoryRecorder();
    const ev = (e: Record<string, unknown>) => rec.onEvent({ ts: 100, ...e } as BddrEvent);
    expect(rec.record()).toBeUndefined();
    ev({ type: 'runStarted', runId: 'r1', schemaVersion: 1, framework: { name: 'bddr', version: '0' }, runtime: { name: 'node', version: 'x' }, dryRun: false });
    ev({ type: 'planReady', workers: 2, scenarios: [{ id: 'a', name: 'A', uri: 'x', line: 1, featureName: 'F', tags: [], steps: [] }] });
    ev({ type: 'scenarioFinished', scenarioId: 'a', attempt: 1, status: 'failed', durationMs: 3, willRetry: true });
    ev({ type: 'scenarioFinished', scenarioId: 'a', attempt: 2, status: 'passed', durationMs: 4, flaky: true });
    ev({ type: 'runFinished', success: true, summary: { durationMs: 9 } });
    expect(rec.record()).toMatchObject({ runId: 'r1', workers: 2, success: true, durationMs: 9, scenarios: { a: { s: 'passed', d: 4, a: 2, f: 1, n: 'A' } } });
  });

  it('saves, keeps the newest N, loads oldest first and ignores junk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-hist-'));
    for (let i = 1; i <= 5; i++) saveHistory(dir, run(i, { a: 'passed' }), 3);
    writeFileSync(join(dir, '999-broken.json'), '{not json');
    expect(readdirSync(dir).filter((f) => f !== '999-broken.json')).toHaveLength(3);
    expect(loadHistory(dir).map((r) => r.runId)).toEqual(['run-3', 'run-4', 'run-5']);
    expect(loadHistory(dir, 2).map((r) => r.runId)).toEqual(['run-4', 'run-5']);
    expect(loadHistory(join(dir, 'missing'))).toEqual([]);
  });
});
