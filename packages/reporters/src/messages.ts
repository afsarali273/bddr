import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { generateMessages } from '@cucumber/gherkin';
import {
  AttachmentContentEncoding,
  IdGenerator,
  SourceMediaType,
  StepDefinitionPatternType,
  TestStepResultStatus,
  type Envelope,
  type GherkinDocument,
  type Pickle,
  type Timestamp,
} from '@cucumber/messages';
import type { BddrEvent, ErrorInfo, PlannedScenario, Status } from '@bddr/core';
import type { Reporter, ReporterOptions } from './types.js';

/**
 * Cucumber Messages (ADR-007): the standard NDJSON envelope stream, so tools from the Cucumber ecosystem
 * (HTML formatter, Cucumber Reports, Xray/Zephyr importers ...) can read bddr runs.
 *
 * The bddr event stream stays the source of truth; this reporter only translates it.
 *   source / gherkinDocument / pickle   regenerated from the feature files (`sourceRoot`, default: cwd)
 *   testRunStarted, testCase*, testStep*, attachment, testRunFinished   from the run events
 * Scenarios that cannot be tied to a pickle are left out and counted in `droppedScenarios` (see below):
 *   - rows generated from data files (`@data`), because Gherkin never sees them,
 *   - features whose file cannot be read from `sourceRoot`.
 * bddr-only concepts (groups, locks, hook levels, worker lanes) have no Messages equivalent and are not emitted.
 */
export function messagesReporter(raw: ReporterOptions = {}): Reporter {
  const outputFile = String(raw['outputFile'] ?? 'reports/messages.ndjson');
  const sourceRoot = String(raw['sourceRoot'] ?? process.cwd());
  const run = new MessagesBuilder(sourceRoot);
  let text = '';
  return {
    name: 'messages',
    onEvent(e) {
      run.onEvent(e);
      if (e.type === 'runFinished') text = run.render();
    },
    async close() {
      if (!text) return;
      mkdirSync(dirname(outputFile), { recursive: true });
      writeFileSync(outputFile, text, 'utf8');
    },
  };
}

const toTimestamp = (ms: number): Timestamp => ({ seconds: Math.floor(ms / 1000), nanos: Math.round((ms % 1000) * 1e6) });
const toDuration = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: Math.round((ms % 1000) * 1e6) });

const STATUS: Record<Status, TestStepResultStatus> = {
  passed: TestStepResultStatus.PASSED,
  failed: TestStepResultStatus.FAILED,
  skipped: TestStepResultStatus.SKIPPED,
  pending: TestStepResultStatus.PENDING,
  undefined: TestStepResultStatus.UNDEFINED,
  ambiguous: TestStepResultStatus.AMBIGUOUS,
};

interface Mapped {
  planned: PlannedScenario;
  pickle: Pickle;
  testCaseId: string;
  stepIds: string[]; // testStep ids, parallel to planned.steps
  definitions: Array<string | undefined>; // step definition ids, parallel
}

interface Attempt {
  id: string;
  seen: Set<string>; // stepIds that already have a finished message
  started: Set<string>;
}

export class MessagesBuilder {
  private readonly newId = IdGenerator.incrementing();
  private readonly plan: PlannedScenario[] = [];
  private readonly exec: Envelope[] = [];
  private readonly mapped = new Map<string, Mapped>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly defIds = new Map<string, string>();
  private readonly defs: Envelope[] = [];
  private startTs = Date.now();
  private endTs = Date.now();
  private success = true;
  private meta: { name: string; version: string; runtime: { name: string; version: string } } = {
    name: 'bddr',
    version: '0.0.0',
    runtime: { name: 'node', version: process.versions.node },
  };
  /** Planned scenarios that could not be represented. */
  droppedScenarios = 0;

  constructor(private readonly sourceRoot: string) {}

  private static_: Envelope[] = [];

  onEvent(e: BddrEvent): void {
    switch (e.type) {
      case 'runStarted':
        this.startTs = e.ts;
        this.meta = { name: e.framework.name, version: e.framework.version, runtime: e.runtime };
        break;
      case 'planReady':
        this.plan.push(...e.scenarios);
        this.prepare();
        break;
      case 'scenarioStarted': {
        const m = this.mapped.get(e.scenarioId);
        if (!m) break;
        const id = this.newId();
        this.attempts.set(e.scenarioId, { id, seen: new Set(), started: new Set() });
        this.exec.push({ testCaseStarted: { id, testCaseId: m.testCaseId, attempt: e.attempt - 1, workerId: e.workerId, timestamp: toTimestamp(e.ts) } });
        break;
      }
      case 'stepStarted': {
        const m = this.mapped.get(e.scenarioId);
        const a = this.attempts.get(e.scenarioId);
        const i = m?.planned.steps.findIndex((s) => s.id === e.stepId) ?? -1;
        if (!m || !a || i < 0) break;
        a.started.add(e.stepId);
        this.exec.push({ testStepStarted: { testCaseStartedId: a.id, testStepId: m.stepIds[i]!, timestamp: toTimestamp(e.ts) } });
        break;
      }
      case 'stepFinished': {
        const m = this.mapped.get(e.scenarioId);
        const a = this.attempts.get(e.scenarioId);
        const i = m?.planned.steps.findIndex((s) => s.id === e.stepId) ?? -1;
        if (!m || !a || i < 0) break;
        if (e.definition) m.definitions[i] = this.definitionId(e.definition.pattern, e.definition.location);
        this.finishStep(m, a, i, e.status, e.durationMs, e.ts, e.error);
        break;
      }
      case 'attachment': {
        const a = e.scenarioId ? this.attempts.get(e.scenarioId) : undefined;
        const m = e.scenarioId ? this.mapped.get(e.scenarioId) : undefined;
        if (!a || !m) break;
        const i = e.stepId ? m.planned.steps.findIndex((s) => s.id === e.stepId) : -1;
        this.exec.push({
          attachment: {
            body: e.body,
            contentEncoding: e.encoding === 'base64' ? AttachmentContentEncoding.BASE64 : AttachmentContentEncoding.IDENTITY,
            mediaType: e.mediaType,
            testCaseStartedId: a.id,
            ...(i >= 0 ? { testStepId: m.stepIds[i]! } : {}),
            ...(e.name ? { fileName: e.name } : {}),
            timestamp: toTimestamp(e.ts),
          },
        });
        break;
      }
      case 'log': {
        const a = e.scenarioId ? this.attempts.get(e.scenarioId) : undefined;
        const m = e.scenarioId ? this.mapped.get(e.scenarioId) : undefined;
        if (!a || !m || e.source === 'bddr') break;
        const i = e.stepId ? m.planned.steps.findIndex((s) => s.id === e.stepId) : -1;
        const base = { testCaseStartedId: a.id, ...(i >= 0 ? { testStepId: m.stepIds[i]! } : {}), timestamp: toTimestamp(e.ts) };
        if (e.attachment) {
          this.exec.push({
            attachment: {
              ...base,
              body: e.attachment.body,
              contentEncoding: AttachmentContentEncoding.BASE64,
              mediaType: e.attachment.mediaType,
              ...(e.attachment.name ? { fileName: e.attachment.name } : {}),
            },
          });
        } else {
          this.exec.push({ attachment: { ...base, body: e.message, contentEncoding: AttachmentContentEncoding.IDENTITY, mediaType: 'text/x-cucumber-log+plain' } });
        }
        break;
      }
      case 'scenarioFinished': {
        const m = this.mapped.get(e.scenarioId);
        const a = this.attempts.get(e.scenarioId);
        if (!m || !a) break;
        // Steps that never ran in this attempt are reported as skipped, as Cucumber implementations do.
        m.planned.steps.forEach((s, i) => {
          if (!a.seen.has(s.id)) this.finishStep(m, a, i, 'skipped', 0, e.ts);
        });
        this.exec.push({ testCaseFinished: { testCaseStartedId: a.id, timestamp: toTimestamp(e.ts), willBeRetried: !!e.willRetry } });
        this.attempts.delete(e.scenarioId);
        break;
      }
      case 'runFinished':
        this.endTs = e.ts;
        this.success = e.success;
        break;
      default:
        break;
    }
  }

  private finishStep(m: Mapped, a: Attempt, i: number, status: Status, durationMs: number, ts: number, error?: ErrorInfo): void {
    const step = m.planned.steps[i]!;
    if (a.seen.has(step.id)) return;
    a.seen.add(step.id);
    if (!a.started.has(step.id)) {
      this.exec.push({ testStepStarted: { testCaseStartedId: a.id, testStepId: m.stepIds[i]!, timestamp: toTimestamp(ts - durationMs) } });
    }
    this.exec.push({
      testStepFinished: {
        testCaseStartedId: a.id,
        testStepId: m.stepIds[i]!,
        testStepResult: {
          status: STATUS[status],
          duration: toDuration(durationMs),
          ...(error
            ? {
                message: error.stack ?? error.message,
                exception: { type: error.name ?? 'Error', message: error.message, ...(error.stack ? { stackTrace: error.stack } : {}) },
              }
            : {}),
        },
        timestamp: toTimestamp(ts),
      },
    });
  }

  private definitionId(pattern: string, location?: string): string {
    const existing = this.defIds.get(pattern);
    if (existing) return existing;
    const id = this.newId();
    this.defIds.set(pattern, id);
    const loc = location ? /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(location) : null;
    this.defs.push({
      stepDefinition: {
        id,
        pattern: { source: pattern, type: StepDefinitionPatternType.CUCUMBER_EXPRESSION },
        sourceReference: {
          ...(loc?.[1] ? { uri: loc[1] } : {}),
          ...(loc?.[2] ? { location: { line: Number(loc[2]), ...(loc[3] ? { column: Number(loc[3]) } : {}) } } : {}),
        },
      },
    });
    return id;
  }

  /** On planReady: regenerate source/gherkinDocument/pickle from the files and tie each planned scenario to a pickle. */
  private prepare(): void {
    const byUri = new Map<string, PlannedScenario[]>();
    for (const s of this.plan) byUri.set(s.uri, [...(byUri.get(s.uri) ?? []), s]);
    for (const [uri, planned] of byUri) {
      const file = resolve(this.sourceRoot, uri);
      if (!existsSync(file)) {
        this.droppedScenarios += planned.length;
        continue;
      }
      const source = readFileSync(file, 'utf8');
      const markdown = /\.md$/i.test(uri);
      const envelopes = generateMessages(source, uri, markdown ? SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_MARKDOWN : SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
        includeSource: true,
        includeGherkinDocument: true,
        includePickles: true,
        newId: this.newId,
      });
      const doc = envelopes.find((x) => x.gherkinDocument)?.gherkinDocument;
      const pickles = envelopes.flatMap((x) => (x.pickle ? [x.pickle] : []));
      if (!doc) {
        this.droppedScenarios += planned.length;
        continue;
      }
      this.static_.push(...envelopes);
      const lines = astLines(doc);
      const byLine = new Map<number, Pickle[]>();
      for (const p of pickles) {
        const line = lines.get(p.astNodeIds[p.astNodeIds.length - 1]!) ?? lines.get(p.astNodeIds[0]!);
        if (line !== undefined) byLine.set(line, [...(byLine.get(line) ?? []), p]);
      }
      const used = new Set<Pickle>();
      for (const s of planned) {
        const candidates = (byLine.get(s.line) ?? []).filter((p) => !used.has(p) && p.name === s.name && p.steps.length === s.steps.length);
        const pickle = candidates[0];
        const sameLine = planned.filter((x) => x.line === s.line).length;
        if (!pickle || sameLine > 1) {
          this.droppedScenarios++;
          continue;
        }
        used.add(pickle);
        this.mapped.set(s.id, {
          planned: s,
          pickle,
          testCaseId: this.newId(),
          stepIds: s.steps.map(() => this.newId()),
          definitions: s.steps.map(() => undefined),
        });
      }
    }
  }

  render(): string {
    const testRunStartedId = this.newId();
    const out: Envelope[] = [
      {
        meta: {
          protocolVersion: '32.0.0',
          implementation: { name: this.meta.name, version: this.meta.version },
          runtime: { name: this.meta.runtime.name, version: this.meta.runtime.version },
          os: { name: platform(), version: release() },
          cpu: { name: arch() },
        },
      },
      ...this.static_,
      ...this.defs,
      { testRunStarted: { id: testRunStartedId, timestamp: toTimestamp(this.startTs) } },
      ...[...this.mapped.values()].map((m): Envelope => ({
        testCase: {
          id: m.testCaseId,
          pickleId: m.pickle.id,
          testRunStartedId,
          testSteps: m.pickle.steps.map((ps, i) => ({
            id: m.stepIds[i]!,
            pickleStepId: ps.id,
            ...(m.definitions[i] ? { stepDefinitionIds: [m.definitions[i]!] } : {}),
          })),
        },
      })),
      ...this.exec,
      { testRunFinished: { testRunStartedId, success: this.success, timestamp: toTimestamp(this.endTs) } },
    ];
    return `${out.map((x) => JSON.stringify(x)).join('\n')}\n`;
  }
}

/** astNodeId -> line, for scenarios and example rows. */
function astLines(doc: GherkinDocument): Map<string, number> {
  const lines = new Map<string, number>();
  const scenario = (sc: NonNullable<NonNullable<GherkinDocument['feature']>['children'][number]['scenario']>) => {
    lines.set(sc.id, sc.location.line);
    for (const ex of sc.examples) for (const row of ex.tableBody) lines.set(row.id, row.location.line);
  };
  for (const child of doc.feature?.children ?? []) {
    if (child.scenario) scenario(child.scenario);
    for (const rc of child.rule?.children ?? []) if (rc.scenario) scenario(rc.scenario);
  }
  return lines;
}
