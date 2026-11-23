import { buildPlan, compileTagExpression, parseDuration, type Plan, type ScenarioInstance } from '@bddr/core';
import type { HookDefinition, StepDefinition, SupportRegistry } from '@bddr/runtime';
import { loadSupportCode, prepareRun, type RunRequest } from './run.js';

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationDiagnostic {
  severity: ValidationSeverity;
  code: string;
  message: string;
  uri?: string;
  line?: number;
  location?: string;
}

export interface ValidationResult {
  diagnostics: ValidationDiagnostic[];
  errors: number;
  warnings: number;
  scenarios: number;
  steps: number;
  definitions: number;
}

/** Static project validation. Loads and compiles support code but never executes hooks, steps or transformers. */
export async function validateProject(req: RunRequest = {}): Promise<ValidationResult> {
  const prepared = await prepareRun({ ...req, quiet: true });
  const registry = await loadSupportCode(prepared.rootDir, prepared.opts, true);
  const diagnostics: ValidationDiagnostic[] = [];
  const add = (d: ValidationDiagnostic) => diagnostics.push(d);

  for (const spec of prepared.specs) {
    for (const e of spec.errors) add({ severity: 'error', code: 'parse', message: e.message, uri: e.uri, ...(e.line ? { line: e.line } : {}) });
  }
  validateConfig(prepared.opts, add);

  const plan = buildPlan(prepared.all, prepared.all, {
    workers: prepared.opts.workers ?? 1,
    withDeps: true,
    ...(prepared.opts.groups ? { groups: prepared.opts.groups } : {}),
    ...(prepared.opts.defaultMode ? { defaultMode: prepared.opts.defaultMode } : {}),
    ...(prepared.opts.featureMode ? { featureMode: prepared.opts.featureMode } : {}),
  });
  for (const e of plan.errors) {
    add({ severity: 'error', code: 'plan', message: e.message, ...(e.uri ? { uri: e.uri } : {}), ...(e.line ? { line: e.line } : {}) });
  }

  const ids = new Map<string, ScenarioInstance[]>();
  for (const s of prepared.all) ids.set(s.id, [...(ids.get(s.id) ?? []), s]);
  for (const [id, scenarios] of ids) {
    if (scenarios.length < 2) continue;
    const locations = scenarios.map((s) => `${s.uri}:${s.line}`).join(', ');
    add({ severity: 'error', code: 'duplicate-id', message: `Scenario id "${id}" is duplicated at ${locations}`, uri: scenarios[0]!.uri, line: scenarios[0]!.line });
  }

  const allowedTags = prepared.opts.validation?.allowedTagKeys;
  if (allowedTags) {
    const allowed = new Set([...BUILT_IN_TAG_KEYS, ...allowedTags]);
    const seen = new Set<string>();
    for (const s of prepared.all) {
      for (const tag of s.tags) {
        const key = `${s.uri}:${tag.line ?? s.line}:${tag.name}`;
        if (!allowed.has(tag.key) && !seen.has(key)) {
          seen.add(key);
          add({ severity: 'warning', code: 'unknown-tag', message: `Tag key "${tag.key}" is not listed in validation.allowedTagKeys`, uri: s.uri, line: tag.line ?? s.line });
        }
      }
    }
  }

  try {
    registry.finalize();
  } catch (e) {
    add({ severity: 'error', code: 'support', message: e instanceof Error ? e.message : String(e) });
    return summarise(diagnostics, prepared.all, registry);
  }

  const used = new Set<string>();
  for (const s of prepared.all) {
    const tags = s.tags.map((t) => t.name);
    for (const step of s.steps) {
      const match = registry.analyzeMatch(step.text, tags);
      if (match.kind === 'match') {
        used.add(match.definition.id);
      } else if (match.kind === 'undefined') {
        add({ severity: 'error', code: 'undefined-step', message: `Undefined step: ${step.keyword}${step.text}`, uri: s.uri, line: step.line });
      } else {
        for (const d of match.candidates) used.add(d.id);
        add({
          severity: 'error',
          code: 'ambiguous-step',
          message: `Ambiguous step "${step.text}": ${match.candidates.map(definitionLabel).join(', ')}`,
          uri: s.uri,
          line: step.line,
        });
      }
    }
  }
  for (const def of registry.stepDefinitions) {
    if (!used.has(def.id)) {
      add({ severity: 'warning', code: 'unused-step', message: `Unused step definition: ${String(def.pattern)}`, ...(def.location ? { location: def.location } : {}) });
    }
  }

  for (const hook of registry.hookDefinitions) {
    if (!hookMatches(hook, prepared.all, plan)) {
      add({ severity: 'warning', code: 'unmatched-hook', message: `Hook never matches: ${hook.name}${hook.tags ? ` [${hook.tags}]` : ''}`, ...(hook.location ? { location: hook.location } : {}) });
    }
  }

  return summarise(diagnostics, prepared.all, registry);
}

export function formatValidation(result: ValidationResult): string {
  const lines: string[] = [];
  for (const d of result.diagnostics) {
    const where = d.uri ? `${d.uri}:${d.line ?? '?'}` : d.location;
    lines.push(`${d.severity === 'error' ? 'ERROR' : 'WARN '} [${d.code}]${where ? ` ${where}` : ''} ${d.message}`);
  }
  lines.push(
    `Validated ${result.scenarios} scenario(s), ${result.steps} step(s), ${result.definitions} definition(s): ` +
      `${result.errors} error(s), ${result.warnings} warning(s)`,
  );
  return `${lines.join('\n')}\n`;
}

function summarise(diagnostics: ValidationDiagnostic[], scenarios: readonly ScenarioInstance[], registry: SupportRegistry): ValidationResult {
  return {
    diagnostics,
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
    scenarios: scenarios.length,
    steps: scenarios.reduce((n, s) => n + s.steps.length, 0),
    definitions: registry.stepDefinitions.length,
  };
}

function definitionLabel(def: StepDefinition): string {
  return `${String(def.pattern)}${def.location ? ` (${def.location})` : ''}`;
}

function hookMatches(hook: HookDefinition, scenarios: readonly ScenarioInstance[], plan: Plan): boolean {
  if (!scenarios.length) return false;
  if (hook.level === 'run' || hook.level === 'worker') return true;
  const matches = (tags: readonly string[]) => !hook.tags || compileTagExpression(hook.tags)(tags);
  if (hook.level === 'group') {
    return [...plan.groups.values()].some((g) => !g.implicit && matches([`@group:${g.name}`, `@${g.name}`]));
  }
  if (hook.level === 'feature') {
    const features = new Map(scenarios.map((s) => [s.uri, s.feature]));
    return [...features.values()].some((f) => matches(f.tags.map((t) => t.name)));
  }
  if (hook.level === 'rule') {
    const rules = new Map(scenarios.flatMap((s) => (s.rule ? [[`${s.uri}#${s.rule.id}`, s.rule] as const] : [])));
    return [...rules.values()].some((r) => matches(r.tags.map((t) => t.name)));
  }
  return scenarios.some((s) => matches(s.tags.map((t) => t.name)));
}

const BUILT_IN_TAG_KEYS = [
  'id', 'group', 'dependsOn', 'requires', 'lock', 'priority', 'exclusive', 'serial', 'parallel', 'data', 'dataField', 'retry', 'noRetry', 'quarantine', 'timeout',
  'stepRetry', 'stepDelay', 'stepTimeout',
] as const;

function validateConfig(opts: import('./config.js').BddrOptions, add: (d: ValidationDiagnostic) => void): void {
  const error = (message: string) => add({ severity: 'error', code: 'config', message });
  if (opts.pool !== undefined && opts.pool !== 'inline' && opts.pool !== 'process') error(`pool must be inline or process`);
  if (opts.defaultMode !== undefined && !['parallel', 'serial', 'exclusive'].includes(opts.defaultMode)) error(`defaultMode must be parallel, serial or exclusive`);
  if (opts.featureMode !== undefined && !['parallel', 'serial'].includes(opts.featureMode)) error(`featureMode must be parallel or serial`);
  if (opts.logLevel !== undefined && !['debug', 'info', 'warn', 'error', 'silent'].includes(opts.logLevel)) error(`logLevel must be debug, info, warn, error or silent`);
  for (const [name, value] of [['stepTimeoutMs', opts.stepTimeoutMs], ['scenarioTimeout', opts.scenarioTimeout], ['runTimeout', opts.runTimeout]] as const) {
    if (value === undefined) continue;
    try {
      const ms = typeof value === 'number' ? value : parseDuration(value);
      if (!Number.isFinite(ms) || ms < 0) throw new Error('must be a non-negative duration');
    } catch (e) {
      error(`${name}: ${(e as Error).message}`);
    }
  }
  if (opts.retry?.backoff !== undefined && (!Number.isFinite(opts.retry.backoff) || opts.retry.backoff < 1)) error(`retry.backoff must be a number >= 1`);
  if (opts.retry?.delay !== undefined) {
    try {
      const ms = typeof opts.retry.delay === 'number' ? opts.retry.delay : parseDuration(opts.retry.delay);
      if (!Number.isFinite(ms) || ms < 0) throw new Error('must be a non-negative duration');
    } catch (e) {
      error(`retry.delay: ${(e as Error).message}`);
    }
  }
  if (opts.retry?.on !== undefined && (!Array.isArray(opts.retry.on) || opts.retry.on.some((x) => typeof x !== 'string'))) {
    error(`retry.on must be an array of strings`);
  }
  for (const [name, value] of [['retry.scenario', opts.retry?.scenario], ['retry.workerCrash', opts.retry?.workerCrash]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) error(`${name} must be a whole number >= 0`);
  }
  for (const [name, group] of Object.entries(opts.groups ?? {})) {
    if (group.mode !== undefined && !['parallel', 'serial', 'exclusive'].includes(group.mode)) error(`groups.${name}.mode must be parallel, serial or exclusive`);
    if (group.onDependencyFailure !== undefined && !['skip', 'run'].includes(group.onDependencyFailure)) error(`groups.${name}.onDependencyFailure must be skip or run`);
    if (group.retryMembers !== undefined && !['all', 'failed'].includes(group.retryMembers)) error(`groups.${name}.retryMembers must be all or failed`);
  }
  if (opts.validation?.allowedTagKeys !== undefined && (!Array.isArray(opts.validation.allowedTagKeys) || opts.validation.allowedTagKeys.some((x) => typeof x !== 'string'))) {
    error(`validation.allowedTagKeys must be an array of strings`);
  }
}
