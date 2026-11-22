import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BddrEvent, ErrorInfo, HookFinished, PlannedScenario, ScenarioFinished, StepFinished } from '@bddr/core';
import type { Reporter, ReporterOptions } from './types.js';
import { formatLogLine, LogIndex, type ReportLogLevel } from './logs.js';

/**
 * JUnit XML for CI systems. One <testsuite> per feature, one <testcase> per scenario.
 * failed / undefined / ambiguous -> <failure>; skipped / pending -> <skipped>.
 * Logs at or above `logLevel` (default 'info') go to <system-out> (debug/info) and <system-err> (warn/error),
 * which CI servers (Jenkins, GitLab, Azure DevOps…) show next to each test.
 */
export function junitReporter(raw: ReporterOptions = {}): Reporter {
  const outputFile = String(raw['outputFile'] ?? 'reports/junit.xml');
  const suiteName = String(raw['suiteName'] ?? 'bddr');
  const plan: PlannedScenario[] = [];
  const results = new Map<string, ScenarioFinished>();
  const earlier = new Map<string, ScenarioFinished[]>(); // failed attempts that were retried
  const failingStep = new Map<string, StepFinished>();
  const logs = new LogIndex((raw['logLevel'] as ReportLogLevel | undefined) ?? 'info');
  const hookFailures: HookFinished[] = [];
  let xml = '';

  return {
    name: 'junit',
    onEvent(e: BddrEvent) {
      if (e.type === 'planReady') plan.push(...e.scenarios);
      if (e.type === 'stepFinished' && e.status !== 'passed' && e.status !== 'skipped' && !failingStep.has(e.scenarioId)) {
        failingStep.set(e.scenarioId, e);
      }
      if (e.type === 'scenarioStarted' && !results.has(e.scenarioId)) failingStep.delete(e.scenarioId); // new attempt
      if (e.type === 'scenarioFinished') {
        const previous = results.get(e.scenarioId); // set again = group retry re-ran it
        if (previous && previous.status !== 'passed') earlier.set(e.scenarioId, [...(earlier.get(e.scenarioId) ?? []), previous]);
        if (e.willRetry) {
          earlier.set(e.scenarioId, [...(earlier.get(e.scenarioId) ?? []), e]);
          failingStep.delete(e.scenarioId);
        } else results.set(e.scenarioId, e);
      }
      if (e.type === 'hookFinished' && e.status === 'failed' && !e.scenarioId) hookFailures.push(e);
      if (e.type === 'log') logs.add(e);
      if (e.type === 'runFinished') xml = render(suiteName, plan, results, failingStep, e.summary.durationMs, logs, earlier, hookFailures);
    },
    async close() {
      if (!xml) return;
      mkdirSync(dirname(outputFile), { recursive: true });
      writeFileSync(outputFile, xml, 'utf8');
    },
  };
}

export function render(
  suiteName: string,
  plan: PlannedScenario[],
  results: Map<string, ScenarioFinished>,
  failingStep: Map<string, StepFinished>,
  durationMs: number,
  logs: LogIndex = new LogIndex('silent'),
  earlier: Map<string, ScenarioFinished[]> = new Map(),
  hookFailures: HookFinished[] = [],
): string {
  const byFeature = new Map<string, PlannedScenario[]>();
  for (const s of plan) {
    const list = byFeature.get(s.uri) ?? [];
    list.push(s);
    byFeature.set(s.uri, list);
  }
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  const suites: string[] = [];
  for (const [uri, scenarios] of byFeature) {
    let sFail = 0;
    let sSkip = 0;
    let sTime = 0;
    const cases = scenarios.map((s) => {
      const r = results.get(s.id);
      const status = r?.status ?? 'skipped';
      const time = (r?.durationMs ?? 0) / 1000;
      sTime += time;
      let body = '';
      if (r?.quarantined && status !== 'passed' && status !== 'skipped') {
        sSkip++;
        body = `\n      <skipped message="${esc(`quarantined: ${firstLine(r.error?.message ?? status)}`)}"/>\n    `;
      } else if (status === 'failed' || status === 'undefined' || status === 'ambiguous') {
        sFail++;
        const step = failingStep.get(s.id);
        const err: ErrorInfo | undefined = r?.error ?? step?.error;
        const note = step?.mode && step.attempts ? ` [${step.mode === 'retry' ? `after ${step.attempts} attempts` : `repetition ${step.attempts}`}]` : '';
        const message = (err?.message ?? (status === 'undefined' ? `Undefined step` : status)) + note;
        const detail = [step ? `Step: ${step.stepId}` : '', err?.stack ?? '', step?.snippet ?? ''].filter(Boolean).join('\n');
        body = `\n      <failure type="${status}" message="${esc(firstLine(message))}">${esc(detail || message)}</failure>\n    `;
      } else if (status === 'skipped' || status === 'pending') {
        sSkip++;
        body = `\n      <skipped message="${esc(r?.reason ?? status)}"/>\n    `;
      }
      // Surefire-style flaky markers (Jenkins JUnit plugin shows them): one per failed attempt before the pass.
      if (status === 'passed' && earlier.get(s.id)?.length) {
        body =
          '\n' +
          earlier
            .get(s.id)!
            .map((a) => `      <flakyFailure type="failed" message="${esc(firstLine(a.error?.message ?? 'failed'))}">${esc(a.error?.stack ?? a.error?.message ?? '')}</flakyFailure>\n`)
            .join('') +
          '    ';
      }
      const stepText = new Map(s.steps.map((st) => [st.id, `${st.keyword}${st.text}`]));
      const lines = (levels: string[]) =>
        logs
          .all(s.id)
          .filter((l) => levels.includes(l.level ?? 'info'))
          .map((l) => `${l.stepId ? `${stepText.get(l.stepId) ?? l.stepId}: ` : ''}${formatLogLine(l)}`);
      const out = lines(['debug', 'info']);
      const err = lines(['warn', 'error']);
      if (out.length || err.length) {
        if (!body) body = '\n    ';
        if (out.length) body += `  <system-out>${cdata(out.join('\n'))}</system-out>\n    `;
        if (err.length) body += `  <system-err>${cdata(err.join('\n'))}</system-err>\n    `;
      }
      return `    <testcase name="${esc(s.name)}" classname="${esc(s.featureName)}" file="${esc(uri)}" line="${s.line}" time="${time.toFixed(3)}">${body}</testcase>`;
    });
    tests += scenarios.length;
    failures += sFail;
    skipped += sSkip;
    suites.push(
      `  <testsuite name="${esc(scenarios[0]!.featureName)}" file="${esc(uri)}" tests="${scenarios.length}" failures="${sFail}" skipped="${sSkip}" errors="0" time="${sTime.toFixed(3)}">\n${cases.join('\n')}\n  </testsuite>`,
    );
  }
  // Failed run / worker / group / feature hooks belong to no scenario; report each as an errored testcase so CI goes red.
  if (hookFailures.length) {
    const cases = hookFailures.map((h) => {
      const message = h.error?.message ?? 'hook failed';
      return `    <testcase name="${esc(`${h.kind} ${h.level} hook: ${h.hookName}`)}" classname="hooks" time="${(h.durationMs / 1000).toFixed(3)}">\n      <error type="hook" message="${esc(firstLine(message))}">${esc(h.error?.stack ?? message)}</error>\n    </testcase>`;
    });
    tests += hookFailures.length;
    suites.push(`  <testsuite name="Hooks" tests="${hookFailures.length}" failures="0" skipped="0" errors="${hookFailures.length}" time="0.000">\n${cases.join('\n')}\n  </testsuite>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(suiteName)}" tests="${tests}" failures="${failures}" skipped="${skipped}" errors="${hookFailures.length}" time="${(durationMs / 1000).toFixed(3)}">\n${suites.join('\n')}\n</testsuites>\n`;
}

/** CDATA section; splits any "]]>" so the XML stays valid. Control characters are removed. */
function cdata(s: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return `<![CDATA[${clean.split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? '';
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}
