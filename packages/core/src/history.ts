/**
 * Run history (Phase 5): one small JSON record per run, kept in a folder (default `.bddr/history`), used for
 * flakiness scores, trends in the HTML report and `bddr history`.
 *
 * Flakiness score of a scenario over the recorded runs where it passed or failed (other statuses ignored):
 *   a run is "unstable" when the scenario was flaky in it (passed after a retry) or its outcome (pass / fail) differs
 *   from the previous recorded run. score = unstable runs / runs, 0 with fewer than 2 runs.
 *   0 = always the same outcome (a consistently failing scenario is broken, not flaky); 1 = flips every run.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BddrEvent } from './events.js';
import type { Status } from './model.js';

export interface HistoryEntry {
  /** Final status. */
  s: Status;
  /** Duration of the final attempt (ms). */
  d: number;
  /** Attempts (only when > 1). */
  a?: number;
  /** Flaky (passed after a failed attempt). */
  f?: 1;
  /** Scenario name (for display). */
  n: string;
}

export interface HistoryRun {
  v: 1;
  runId: string;
  startedAt: number;
  durationMs: number;
  success: boolean;
  workers: number;
  scenarios: Record<string, HistoryEntry>;
}

/** Builds a HistoryRun from the event stream (feed every event, then call record()). */
export class HistoryRecorder {
  private run: Partial<HistoryRun> & { scenarios: Record<string, HistoryEntry> } = { scenarios: {} };
  private readonly names = new Map<string, string>();
  private done = false;

  onEvent(e: BddrEvent): void {
    switch (e.type) {
      case 'runStarted':
        this.run.runId = e.runId;
        this.run.startedAt = e.ts;
        break;
      case 'planReady':
        this.run.workers = e.workers ?? 1;
        for (const sc of e.scenarios) this.names.set(sc.id, sc.name);
        break;
      case 'scenarioFinished':
        if (e.willRetry) break;
        this.run.scenarios[e.scenarioId] = {
          s: e.status,
          d: e.durationMs,
          ...(e.attempt > 1 ? { a: e.attempt } : {}),
          ...(e.flaky ? { f: 1 as const } : {}),
          n: this.names.get(e.scenarioId) ?? e.scenarioId,
        };
        break;
      case 'runFinished':
        this.run.success = e.success;
        this.run.durationMs = e.summary.durationMs;
        this.done = true;
        break;
      default:
        break;
    }
  }

  /** The finished run, or undefined when the stream had no runFinished. */
  record(): HistoryRun | undefined {
    if (!this.done || !this.run.runId) return undefined;
    return {
      v: 1,
      runId: this.run.runId,
      startedAt: this.run.startedAt ?? Date.now(),
      durationMs: this.run.durationMs ?? 0,
      success: !!this.run.success,
      workers: this.run.workers ?? 1,
      scenarios: this.run.scenarios,
    };
  }
}

const FILE = /^\d+-[\w-]+\.json$/;
/** Record files oldest first (numeric timestamp prefix). */
const byTime = (a: string, b: string) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || a.localeCompare(b);

/** Previous runs, oldest first (at most `limit`, the most recent ones). Unreadable files are ignored. */
export function loadHistory(dir: string, limit = 50): HistoryRun[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => FILE.test(f));
  } catch {
    return [];
  }
  files.sort(byTime);
  const runs: HistoryRun[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as HistoryRun;
      if (r && r.v === 1 && r.scenarios) runs.push(r);
    } catch {
      // ignore broken files
    }
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt).slice(-limit);
}

/** Write one run and delete the oldest records beyond `keep`. Returns the file written. */
export function saveHistory(dir: string, run: HistoryRun, keep = 50): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${run.startedAt}-${run.runId.replace(/[^\w-]/g, '').slice(0, 12)}.json`);
  writeFileSync(file, JSON.stringify(run));
  const files = readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort(byTime);
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      rmSync(join(dir, f));
    } catch {
      // read-only folder: keeping extra history is harmless
    }
  }
  return file;
}

export interface ScenarioHistory {
  id: string;
  name: string;
  /** Runs where the scenario has a record. */
  runs: number;
  passed: number;
  failed: number;
  flaky: number;
  /** 0..1, see the module comment. */
  score: number;
  avgMs: number;
  /** Statuses oldest → newest (flaky passes as 'flaky'). */
  trend: Array<Status | 'flaky'>;
}

export function scenarioHistory(runs: readonly HistoryRun[], id: string): ScenarioHistory {
  let name = id;
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let total = 0;
  let durSum = 0;
  let durN = 0;
  let unstable = 0;
  let considered = 0;
  let prev: 'P' | 'F' | undefined;
  const trend: Array<Status | 'flaky'> = [];
  for (const r of runs) {
    const e = r.scenarios[id];
    if (!e) continue;
    total++;
    name = e.n || name;
    trend.push(e.f ? 'flaky' : e.s);
    if (e.s === 'passed') passed++;
    if (e.s === 'failed') failed++;
    if (e.f) flaky++;
    if (e.s === 'passed' || e.s === 'failed') {
      durSum += e.d;
      durN++;
      const outcome = e.s === 'passed' ? 'P' : 'F';
      considered++;
      if (e.f || (prev !== undefined && outcome !== prev)) unstable++;
      prev = outcome;
    }
  }
  return {
    id,
    name,
    runs: total,
    passed,
    failed,
    flaky,
    score: considered >= 2 ? unstable / considered : 0,
    avgMs: durN ? Math.round(durSum / durN) : 0,
    trend,
  };
}

/** Every scenario seen in the runs, flakiest first (ties: more failures, then name). */
export function rankScenarios(runs: readonly HistoryRun[]): ScenarioHistory[] {
  const ids = new Set<string>();
  for (const r of runs) for (const id of Object.keys(r.scenarios)) ids.add(id);
  return [...ids]
    .map((id) => scenarioHistory(runs, id))
    .sort((a, b) => b.score - a.score || b.failed - a.failed || a.name.localeCompare(b.name));
}
