import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Attachment, BddrEvent, PlannedScenario, ScenarioFinished, StepFinished } from '@bddr/core';
import type { Reporter, ReporterOptions } from './types.js';
import { formatLogLine, LogIndex, type ReportLogLevel } from './logs.js';

/**
 * Cucumber JSON (the legacy `--format json` shape), for dashboards and plugins that
 * only understand it (Jenkins cucumber-reports, multiple-cucumber-html-reporter, Xray...).
 * Durations are in nanoseconds, as Cucumber-JVM/JS emit them.
 */
export function cucumberJsonReporter(raw: ReporterOptions = {}): Reporter {
  const outputFile = String(raw['outputFile'] ?? 'reports/cucumber.json');
  const plan: PlannedScenario[] = [];
  const steps = new Map<string, StepFinished>();
  const attachments = new Map<string, Attachment[]>();
  const scenarios = new Map<string, ScenarioFinished>();
  const logs = new LogIndex((raw['logLevel'] as ReportLogLevel | undefined) ?? 'info');
  let json = '';

  return {
    name: 'cucumber-json',
    onEvent(e: BddrEvent) {
      switch (e.type) {
        case 'planReady':
          plan.push(...e.scenarios);
          break;
        case 'stepFinished':
          steps.set(`${e.scenarioId}|${e.stepId}`, e);
          break;
        case 'attachment':
          if (e.scenarioId && e.stepId) {
            const k = `${e.scenarioId}|${e.stepId}`;
            attachments.set(k, [...(attachments.get(k) ?? []), e]);
          }
          break;
        case 'scenarioFinished':
          scenarios.set(e.scenarioId, e);
          break;
        case 'log':
          logs.add(e);
          break;
        case 'runFinished':
          json = JSON.stringify(render(plan, steps, attachments, scenarios, logs), null, 2);
          break;
        default:
          break;
      }
    },
    async close() {
      if (!json) return;
      mkdirSync(dirname(outputFile), { recursive: true });
      writeFileSync(outputFile, json, 'utf8');
    },
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function render(
  plan: PlannedScenario[],
  steps: Map<string, StepFinished>,
  attachments: Map<string, Attachment[]>,
  scenarios: Map<string, ScenarioFinished>,
  logs: LogIndex = new LogIndex('silent'),
): unknown[] {
  const features = new Map<string, { feature: Record<string, unknown>; elements: unknown[] }>();
  for (const s of plan) {
    let f = features.get(s.uri);
    if (!f) {
      const fi = s.feature ?? { name: s.featureName, description: '', line: 1, tags: [], language: 'en' };
      f = {
        feature: {
          uri: s.uri,
          id: slug(fi.name),
          keyword: 'Feature',
          name: fi.name,
          description: fi.description,
          line: fi.line,
          tags: fi.tags.map((name) => ({ name, line: fi.line - 1 })),
        },
        elements: [],
      };
      features.set(s.uri, f);
    }
    const featureTags = new Set(s.feature?.tags ?? []);
    const result = scenarios.get(s.id);
    f.elements.push({
      id: `${f.feature['id']};${slug(s.name)}${s.example ? `;;${s.example.index}` : ''}`,
      keyword: s.keyword ?? 'Scenario',
      name: s.name,
      description: s.description ?? '',
      line: s.line,
      type: 'scenario',
      tags: s.tags.filter((t) => !featureTags.has(t)).map((name) => ({ name, line: s.line - 1 })),
      ...(logs.scenarioOnly(s.id).length
        ? {
            before: [
              {
                match: { location: 'bddr: scenario logs (hooks)' },
                result: { status: 'passed', duration: 0 },
                output: logs.scenarioOnly(s.id).map((l) => formatLogLine(l)),
              },
            ],
          }
        : {}),
      steps: s.steps.map((st) => {
        const r = steps.get(`${s.id}|${st.id}`);
        const status = r?.status ?? 'skipped';
        const res: Record<string, unknown> = { status, duration: Math.round((r?.durationMs ?? 0) * 1e6) };
        if (r?.error) res['error_message'] = r.error.stack ?? r.error.message;
        else if (status === 'skipped' && result?.reason) res['error_message'] = result.reason;
        const step: Record<string, unknown> = {
          keyword: st.keyword,
          name: st.text,
          line: st.line,
          match: { location: r?.definition?.location ?? r?.definition?.pattern ?? 'undefined' },
          result: res,
        };
        const att = attachments.get(`${s.id}|${st.id}`) ?? [];
        const stepLogs = logs.forStep(s.id, st.id);
        const embeddings = [
          ...att.map((a) => ({
            mime_type: a.mediaType,
            data: a.encoding === 'base64' ? a.body : Buffer.from(a.body, 'utf8').toString('base64'),
            ...(a.name ? { name: a.name } : {}),
          })),
          ...stepLogs.flatMap((l) =>
            l.attachment ? [{ mime_type: l.attachment.mediaType, data: l.attachment.body, name: l.attachment.name ?? l.message }] : [],
          ),
        ];
        if (embeddings.length) step['embeddings'] = embeddings;
        if (stepLogs.length) step['output'] = stepLogs.map((l) => formatLogLine(l));
        return step;
      }),
    });
  }
  return [...features.values()].map((f) => ({ ...f.feature, elements: f.elements }));
}
