import { logLevelEnabled, type Log, type LogLevel } from '@bddr/core';

/** Threshold option shared by reporters: logs below it are left out of that report. */
export type ReportLogLevel = LogLevel | 'silent';

/** One-line text form used by JUnit, Cucumber JSON and the console: `[warn] message {"data":1}`. */
export function formatLogLine(l: Log, maxData = 2000): string {
  const level = l.level ?? 'info';
  const tag = l.source === 'bddr' ? `bddr:${level}` : level;
  let data = '';
  if (l.data !== undefined) {
    const json = JSON.stringify(l.data) ?? String(l.data);
    data = ` ${json.length > maxData ? `${json.slice(0, maxData)}…` : json}`;
  }
  const att = l.attachment ? ` [${l.attachment.mediaType.startsWith('image/') ? 'image' : 'file'}: ${l.attachment.name ?? l.attachment.mediaType}, ${kb(l.attachment.bytes)}]` : '';
  return `[${tag}]${l.attempt ? ` #${l.attempt}` : ''} ${l.message}${data}${att}`;
}

function kb(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

/**
 * Collects logs by scenario and step, keeping only those at or above `threshold`.
 * Framework diagnostics (source 'bddr') are kept only when `includeFramework` (HTML report).
 */
export class LogIndex {
  readonly byScenario = new Map<string, Log[]>();
  readonly run: Log[] = [];

  constructor(
    private readonly threshold: ReportLogLevel = 'info',
    private readonly includeFramework = false,
  ) {}

  add(l: Log): void {
    if (l.source === 'bddr' && !this.includeFramework) return;
    if (!logLevelEnabled(l.level ?? 'info', this.threshold)) return;
    if (!l.scenarioId) {
      this.run.push(l);
      return;
    }
    const list = this.byScenario.get(l.scenarioId) ?? [];
    list.push(l);
    this.byScenario.set(l.scenarioId, list);
  }

  forStep(scenarioId: string, stepId: string): Log[] {
    return (this.byScenario.get(scenarioId) ?? []).filter((l) => l.stepId === stepId);
  }

  /** Logs of a scenario not tied to a step (hooks, before/after). */
  scenarioOnly(scenarioId: string): Log[] {
    return (this.byScenario.get(scenarioId) ?? []).filter((l) => !l.stepId);
  }

  all(scenarioId: string): Log[] {
    return this.byScenario.get(scenarioId) ?? [];
  }
}

/** "passed after 3 attempts" / "failed after 4 attempts" / "repeated 100×" / "stopped at repetition 7 of 100". */
export function attemptsNote(step: { status: string; mode?: 'repeat' | 'retry'; attempts?: number }, of?: number): string {
  if (!step.mode || step.attempts === undefined) return '';
  if (step.mode === 'retry') {
    if (step.attempts <= 1) return '';
    return `${step.status === 'passed' ? 'passed' : 'failed'} after ${step.attempts} attempts`;
  }
  if (step.status === 'passed') return `repeated ${step.attempts}×`;
  return `stopped at repetition ${step.attempts}${of ? ` of ${of}` : ''}`;
}
