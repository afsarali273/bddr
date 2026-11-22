/**
 * Event-stream utilities for reruns and merged reports.
 *
 *   bddr run                                 -> reports/events.ndjson   (run 1)
 *   bddr run --rerun-failed reports/events.ndjson -f ndjson:reports/rerun.ndjson   (run 2: only what did not pass)
 *   bddr report reports/events.ndjson reports/rerun.ndjson -f html:reports/report.html -f junit:reports/junit.xml
 *
 * mergeEventStreams keeps, for every scenario, the events of the LAST stream that ran it, marks scenarios that passed
 * only in a later stream as flaky, and recomputes the summary.
 */
import { emptySummary, type BddrEvent, type PlannedScenario, type RunSummary, type ScenarioFinished } from './events.js';
import type { Status } from './model.js';

export function parseNdjson(text: string): BddrEvent[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as BddrEvent;
      } catch {
        throw new Error(`Invalid NDJSON at line ${i + 1}`);
      }
    });
}

/** Final (non-retried) scenarioFinished per scenario id. */
export function finalResults(events: readonly BddrEvent[]): Map<string, ScenarioFinished> {
  const out = new Map<string, ScenarioFinished>();
  for (const e of events) if (e.type === 'scenarioFinished' && !e.willRetry) out.set(e.scenarioId, e);
  return out;
}

/** Ids whose final status is not 'passed' (failed, skipped by a failed dependency, pending, undefined…). */
export function idsToRerun(events: readonly BddrEvent[]): string[] {
  return [...finalResults(events).values()].filter((r) => r.status !== 'passed').map((r) => r.scenarioId);
}

const SCENARIO_EVENTS = new Set<BddrEvent['type']>([
  'scenarioStarted',
  'stepStarted',
  'stepFinished',
  'stepAttemptFinished',
  'scenarioFinished',
  'attachment',
  'log',
  'hookStarted',
  'hookFinished',
]);

export function mergeEventStreams(streams: readonly (readonly BddrEvent[])[], options: { strict?: boolean } = {}): BddrEvent[] {
  if (!streams.length) return [];
  const strict = options.strict ?? true;
  // which stream owns each scenario: the last one with a final result for it
  const owner = new Map<string, number>();
  const everNotPassed = new Set<string>();
  streams.forEach((events, i) => {
    for (const r of finalResults(events).values()) {
      if (owner.has(r.scenarioId) && r.status !== 'passed') everNotPassed.add(r.scenarioId);
      owner.set(r.scenarioId, i);
      if (r.status !== 'passed') everNotPassed.add(r.scenarioId);
    }
  });

  const first = streams[0]!;
  const out: BddrEvent[] = [];
  const runStarted = first.find((e) => e.type === 'runStarted');
  if (runStarted) out.push(runStarted);
  for (const e of first) if (e.type === 'specParsed') out.push(e);

  // union plan, first-seen order
  const planned = new Map<string, PlannedScenario>();
  let planMeta: Extract<BddrEvent, { type: 'planReady' }> | undefined;
  for (const events of streams) {
    for (const e of events) {
      if (e.type !== 'planReady') continue;
      planMeta ??= e;
      for (const s of e.scenarios) if (!planned.has(s.id)) planned.set(s.id, s);
    }
  }
  if (planMeta) out.push({ ...planMeta, scenarios: [...planned.values()] });

  // run-level logs/hook failures from every stream
  for (const events of streams) {
    for (const e of events) if ((e.type === 'log' || e.type === 'hookFinished') && !('scenarioId' in e && e.scenarioId)) out.push(e);
  }

  const summary: RunSummary = emptySummary();
  let bad = 0;
  for (const id of planned.keys()) {
    const idx = owner.get(id);
    if (idx === undefined) continue;
    const events = streams[idx]!;
    const final = finalResults(events).get(id)!;
    for (const e of events) {
      if (!SCENARIO_EVENTS.has(e.type) || !('scenarioId' in e) || e.scenarioId !== id) continue;
      if (e === final) {
        const flaky = final.status === 'passed' && (final.flaky || (everNotPassed.has(id) && idx > 0));
        out.push({ ...final, ...(flaky ? { flaky: true } : {}) });
        if (flaky) summary.flaky = (summary.flaky ?? 0) + 1;
      } else out.push(e);
    }
    summary.scenarios[final.status] += 1;
    summary.scenarios.total += 1;
    if (final.quarantined) summary.quarantined = (summary.quarantined ?? 0) + 1;
    const isBad = final.status === 'failed' || (strict && (['pending', 'undefined', 'ambiguous'] as Status[]).includes(final.status));
    if (isBad && !final.quarantined) bad++;
    // steps of the final attempt
    const lastStart = events.reduce((acc, e, i) => (e.type === 'scenarioStarted' && e.scenarioId === id ? i : acc), -1);
    for (const e of events.slice(lastStart)) {
      if (e.type === 'stepFinished' && e.scenarioId === id) {
        summary.steps[e.status] += 1;
        summary.steps.total += 1;
      }
    }
  }
  const durations = streams.map((s) => s.find((e) => e.type === 'runFinished')).filter(Boolean) as Array<
    Extract<BddrEvent, { type: 'runFinished' }>
  >;
  summary.durationMs = durations.reduce((a, r) => a + r.summary.durationMs, 0);
  const runError = durations.find((r) => r.error)?.error;
  out.push({
    type: 'runFinished',
    ts: durations.at(-1)?.ts ?? Date.now(),
    success: bad === 0 && !runError,
    summary,
    ...(runError ? { error: runError } : {}),
  });
  return out;
}
