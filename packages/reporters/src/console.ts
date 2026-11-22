import { attemptsNote } from './logs.js';
import { logLevelEnabled, type BddrEvent, type Log, type LogLevel, type PlannedScenario, type Status, type StepFinished } from '@bddr/core';
import type { Reporter, ReporterOptions } from './types.js';

const ICON: Record<Status, string> = {
  passed: '✔',
  failed: '✘',
  skipped: '↷',
  pending: '…',
  undefined: '?',
  ambiguous: '‼',
};

const COLOR: Record<Status, number> = { passed: 32, failed: 31, skipped: 36, pending: 33, undefined: 33, ambiguous: 35 };

export interface ConsoleReporterOptions {
  /** 'pretty' (one line per scenario, steps of failures) or 'progress' (one char per scenario). */
  style?: 'pretty' | 'progress';
  /** Print every step, not only for failing scenarios. */
  verbose?: boolean;
  colors?: boolean;
  write?: (text: string) => void;
  /** Show logs at or above this level: 'debug' | 'info' (default) | 'warn' | 'error' | 'silent'. */
  logLevel?: LogLevel | 'silent';
}

const LEVEL_COLOR: Record<LogLevel, number> = { debug: 90, info: 36, warn: 33, error: 31 };

/** Human-readable console output + final summary + failure details + snippets. */
export function consoleReporter(raw: ReporterOptions = {}): Reporter {
  const opts = raw as ConsoleReporterOptions;
  const write = opts.write ?? ((t: string) => void process.stdout.write(t));
  const useColor = opts.colors ?? (process.stdout.isTTY && !process.env['NO_COLOR']);
  const c = (status: Status, text: string) => (useColor ? `\x1b[${COLOR[status]}m${text}\x1b[0m` : text);
  const dim = (text: string) => (useColor ? `\x1b[2m${text}\x1b[0m` : text);
  const style = opts.style ?? 'pretty';
  const threshold = opts.logLevel ?? 'info';
  const scenarioLogs = new Map<string, Log[]>();
  const fmtLog = (l: Log, indent: string) => {
    const level = l.level ?? 'info';
    const tag = `[${l.source === 'bddr' ? `bddr:${level}` : level}]`;
    const head = useColor ? `\x1b[${LEVEL_COLOR[level]}m${tag}\x1b[0m` : tag;
    let data = '';
    if (l.data !== undefined) {
      const json = JSON.stringify(l.data);
      data = ` ${dim(json && json.length > 300 ? `${json.slice(0, 300)}…` : String(json))}`;
    }
    const att = l.attachment ? dim(` [${l.attachment.mediaType.startsWith('image/') ? '🖼 image' : '📎 file'}: ${l.attachment.name ?? l.attachment.mediaType}]`) : '';
    const nth = l.attempt ? dim(` #${l.attempt}`) : '';
    return `${indent}${head}${nth} ${l.message.split('\n').join(`\n${indent}  `)}${data}${att}\n`;
  };

  const plan = new Map<string, PlannedScenario>();
  const steps = new Map<string, StepFinished[]>();
  const failures: Array<{ scenario: PlannedScenario; message: string; stack?: string }> = [];
  const quarantinedFailures: Array<{ scenario: PlannedScenario; message: string }> = [];
  const snippets = new Set<string>();
  const hookErrors: string[] = [];
  const parseErrors: string[] = [];
  let currentFeature = '';

  return {
    name: 'console',
    onEvent(e: BddrEvent) {
      switch (e.type) {
        case 'specParsed':
          for (const err of e.errors) parseErrors.push(`${err.uri}${err.line ? `:${err.line}` : ''} ${err.message}`);
          break;
        case 'planReady':
          for (const s of e.scenarios) plan.set(s.id, s);
          break;
        case 'stepFinished': {
          const list = steps.get(e.scenarioId) ?? [];
          list.push(e);
          steps.set(e.scenarioId, list);
          if (e.snippet) snippets.add(e.snippet);
          break;
        }
        case 'log': {
          if (!logLevelEnabled(e.level ?? 'info', threshold)) break;
          if (e.scenarioId && style === 'pretty') {
            scenarioLogs.set(e.scenarioId, [...(scenarioLogs.get(e.scenarioId) ?? []), e]);
          } else if (!e.scenarioId || style === 'progress') {
            if (style === 'progress' && (e.level ?? 'info') !== 'warn' && e.level !== 'error') break;
            write(fmtLog(e, style === 'progress' ? '\n' : ''));
          }
          break;
        }
        case 'hookFinished':
          if (e.status === 'failed' && !e.scenarioId) {
            hookErrors.push(`${e.kind} ${e.level} hook "${e.hookName}"${e.uri ? ` (${e.uri})` : ''}: ${e.error?.message ?? ''}`);
          }
          break;
        case 'groupRetrying':
          // Members failed in the previous group attempt; they run again, so they are not (yet) failures.
          for (let i = failures.length - 1; i >= 0; i--) if (e.scenarioIds.includes(failures[i]!.scenario.id)) failures.splice(i, 1);
          if (style === 'pretty') write(c('pending', `\n↻ group ${e.group}: attempt ${e.attempt}, re-running ${e.scenarioIds.length} scenario(s)\n`));
          break;
        case 'scenarioFinished': {
          const s = plan.get(e.scenarioId);
          if (!s) break;
          if (e.willRetry) {
            if (style === 'progress') write(c('pending', 'r'));
            else {
              write(`  ${c('pending', '↻')} ${s.name} ${dim(`attempt ${e.attempt} failed${e.error ? `: ${e.error.message.split('\n')[0]}` : ''} — retrying`)}\n`);
              scenarioLogs.delete(e.scenarioId);
              steps.delete(e.scenarioId);
            }
            break;
          }
          if (e.error && (e.status === 'failed' || e.status === 'ambiguous')) {
            if (e.quarantined) quarantinedFailures.push({ scenario: s, message: e.error.message });
            else failures.push({ scenario: s, message: e.error.message, ...(e.error.stack ? { stack: e.error.stack } : {}) });
          }
          if (style === 'progress') {
            write(c(e.status, e.status === 'passed' ? (e.flaky ? 'f' : '.') : ICON[e.status]));
            break;
          }
          if (s.featureName !== currentFeature) {
            currentFeature = s.featureName;
            write(`\n${s.featureName}  ${dim(s.uri)}\n`);
          }
          const retried = (steps.get(e.scenarioId) ?? []).filter((x) => x.mode === 'retry' && (x.attempts ?? 1) > 1).length;
          const extra =
            (e.reason ? dim(` — ${e.reason}`) : '') +
            (retried ? dim(` (${retried} step${retried > 1 ? 's' : ''} retried)`) : '') +
            (e.flaky ? c('pending', ` flaky (passed on attempt ${e.attempt})`) : '') +
            (e.quarantined ? c('skipped', ' [quarantined]') : '');
          const ex = s.example;
          const row = !ex
            ? ''
            : dim(ex.source ? ` (${ex.source} row ${ex.sourceRow})` : ` (${ex.name ? `${ex.name} ` : ''}#${ex.index})`);
          write(`  ${c(e.status, ICON[e.status])} ${s.name}${row}${s.ruleName ? dim(` [${s.ruleName}]`) : ''} ${dim(`:${s.line} ${e.durationMs}ms`)}${extra}\n`);
          for (const l of scenarioLogs.get(e.scenarioId) ?? []) write(fmtLog(l, '      '));
          scenarioLogs.delete(e.scenarioId);
          if (opts.verbose || (e.status !== 'passed' && e.status !== 'skipped')) {
            const finished = new Map((steps.get(e.scenarioId) ?? []).map((x) => [x.stepId, x]));
            for (const st of s.steps) {
              const f = finished.get(st.id);
              const status: Status = f?.status ?? 'skipped';
              const note = f ? attemptsNote(f) : '';
              write(`      ${c(status, ICON[status])} ${st.keyword}${st.text}${note ? dim(` (${note})`) : ''}\n`);
              if (f?.error && status === 'failed') write(`        ${c('failed', f.error.message.split('\n').join('\n        '))}\n`);
            }
          }
          break;
        }
        case 'runFinished': {
          const { scenarios, steps: st, durationMs } = e.summary;
          if (style === 'progress') write('\n');
          if (parseErrors.length) write(`\n${c('failed', 'Parse errors:')}\n${parseErrors.map((p) => `  ${p}`).join('\n')}\n`);
          if (hookErrors.length) write(`\n${c('failed', 'Hook failures:')}\n${hookErrors.map((h) => `  ${h}`).join('\n')}\n`);
          if (failures.length) {
            write(`\n${c('failed', 'Failures:')}\n`);
            failures.forEach((f, i) => {
              write(`\n  ${i + 1}) ${f.scenario.name} ${dim(`${f.scenario.uri}:${f.scenario.line}`)}\n`);
              write(`     ${f.message.split('\n').join('\n     ')}\n`);
              const frame = f.stack?.split('\n').find((l) => l.includes(' at ') && !l.includes('node_modules') && !l.includes('node:'));
              if (frame) write(`     ${dim(frame.trim())}\n`);
            });
          }
          if (quarantinedFailures.length) {
            write(`\n${c('skipped', 'Quarantined failures (do not fail the run):')}\n`);
            for (const q of quarantinedFailures) write(`  - ${q.scenario.name} ${dim(`${q.scenario.uri}:${q.scenario.line}`)}: ${q.message.split('\n')[0]}\n`);
          }
          if (snippets.size) {
            write(`\n${c('undefined', 'Undefined steps. Implement them with:')}\n\n`);
            for (const s of snippets) write(`${s}\n\n`);
          }
          const extras = [
            e.summary.flaky ? c('pending', `${e.summary.flaky} flaky`) : '',
            e.summary.retried ? `${e.summary.retried} retried` : '',
            e.summary.quarantined ? c('skipped', `${e.summary.quarantined} quarantined`) : '',
          ].filter(Boolean);
          write(
            `\n${formatCounts('scenario', scenarios, c)}${extras.length ? ` · ${extras.join(', ')}` : ''}\n${formatCounts('step', st, c)}\n${dim(`${(durationMs / 1000).toFixed(2)}s`)}\n`,
          );
          if (e.error) write(`${c('failed', `Run error: ${e.error.message}`)}\n`);
          write(e.success ? c('passed', '\nPASSED\n') : c('failed', '\nFAILED\n'));
          break;
        }
        default:
          break;
      }
    },
  };
}

function formatCounts(noun: string, counts: Record<Status, number> & { total: number }, c: (s: Status, t: string) => string): string {
  const order: Status[] = ['passed', 'failed', 'pending', 'undefined', 'ambiguous', 'skipped'];
  const parts = order.filter((s) => counts[s] > 0).map((s) => c(s, `${counts[s]} ${s}`));
  return `${counts.total} ${noun}${counts.total === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}
