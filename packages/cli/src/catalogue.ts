import { relative, resolve, isAbsolute } from 'node:path';
import type { SupportRegistry } from '@bddr/runtime';

/**
 * The step catalogue: everything the loaded support code registered, as plain data.
 * Editors (go to definition, completion), AI assistants and the other language ports read this
 * instead of parsing source code. Bump `schemaVersion` on any breaking change.
 */
export interface StepCatalogue {
  schemaVersion: 1;
  /** Language of the runtime that produced it ('typescript', later 'java' and 'python'). */
  language: string;
  steps: CatalogueStep[];
  hooks: CatalogueHook[];
  fixtures: CatalogueFixture[];
}

export interface CatalogueLocation {
  /** Path relative to the project root, forward slashes. Absolute when the file is outside the root. */
  file: string;
  line: number;
}

export interface CatalogueStep {
  id: string;
  /** The Cucumber Expression text, or the regular expression source. */
  pattern: string;
  kind: 'expression' | 'regex';
  /** Regex flags (only for kind 'regex'). */
  flags?: string;
  /** Tag expression that limits the scenarios this step applies to. */
  tags?: string;
  timeoutMs?: number;
  concurrent?: boolean;
  location?: CatalogueLocation;
}

export interface CatalogueHook {
  name: string;
  level: string;
  kind: string;
  order: number;
  alwaysRun: boolean;
  tags?: string;
  timeoutMs?: number;
  location?: CatalogueLocation;
}

export interface CatalogueFixture {
  name: string;
  scope: string;
  /** Names of the fixtures this one uses. */
  deps: string[];
  location?: CatalogueLocation;
}

/** "file:line" (also "C:\x\y.ts:12" and "file:///x.ts:12") to a project-relative location. */
export function parseLocation(raw: string | undefined, rootDir: string): CatalogueLocation | undefined {
  if (!raw) return undefined;
  const m = /^(.*):(\d+)$/.exec(raw);
  if (!m) return undefined;
  let file = m[1]!.replace(/^file:\/\//, '');
  if (isAbsolute(file)) {
    const rel = relative(resolve(rootDir), file);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) file = rel;
  }
  return { file: file.replace(/\\/g, '/'), line: Number(m[2]) };
}

export function buildStepCatalogue(registry: SupportRegistry, rootDir: string): StepCatalogue {
  const loc = (raw: string | undefined) => {
    const l = parseLocation(raw, rootDir);
    return l ? { location: l } : {};
  };
  return {
    schemaVersion: 1,
    language: 'typescript',
    steps: registry.stepDefinitions.map((d) => ({
      id: d.id,
      pattern: typeof d.pattern === 'string' ? d.pattern : d.pattern.source,
      kind: typeof d.pattern === 'string' ? ('expression' as const) : ('regex' as const),
      ...(typeof d.pattern === 'string' || !d.pattern.flags ? {} : { flags: d.pattern.flags }),
      ...(d.tags ? { tags: d.tags } : {}),
      ...(d.timeoutMs !== undefined ? { timeoutMs: d.timeoutMs } : {}),
      ...(d.concurrent !== undefined ? { concurrent: d.concurrent } : {}),
      ...loc(d.location),
    })),
    hooks: registry.hookDefinitions.map((h) => ({
      // Auto-generated names end in " (<absolute file>:<line>)"; the location is its own field.
      name: h.location && h.name.endsWith(` (${h.location})`) ? h.name.slice(0, -` (${h.location})`.length) : h.name,
      level: h.level,
      kind: h.kind,
      order: h.order,
      alwaysRun: h.alwaysRun,
      ...(h.tags ? { tags: h.tags } : {}),
      ...(h.timeoutMs !== undefined ? { timeoutMs: h.timeoutMs } : {}),
      ...loc(h.location),
    })),
    fixtures: [...registry.fixtureDefinitions.values()].map((f) => ({
      name: f.name,
      scope: f.scope,
      deps: [...f.deps],
      ...loc(f.location),
    })),
  };
}

export function formatStepCatalogue(c: StepCatalogue): string {
  const lines: string[] = [];
  const where = (l?: CatalogueLocation) => (l ? `  ${l.file}:${l.line}` : '');
  lines.push(`${c.steps.length} step(s)`);
  for (const s of c.steps) {
    lines.push(`  ${s.kind === 'regex' ? `/${s.pattern}/${s.flags ?? ''}` : s.pattern}${s.tags ? `  [${s.tags}]` : ''}${where(s.location)}`);
  }
  if (c.hooks.length) {
    lines.push('', `${c.hooks.length} hook(s)`);
    for (const h of c.hooks) lines.push(`  ${h.kind} ${h.level}${h.tags ? `  [${h.tags}]` : ''}${where(h.location)}`);
  }
  if (c.fixtures.length) {
    lines.push('', `${c.fixtures.length} fixture(s)`);
    for (const f of c.fixtures) lines.push(`  ${f.name} (${f.scope})${where(f.location)}`);
  }
  return lines.join('\n') + '\n';
}
