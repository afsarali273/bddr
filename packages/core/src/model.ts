/**
 * The bddr internal model.
 *
 * Every spec format (Gherkin today, Markdown later) is compiled into these types.
 * The runtime, planner and reporters only ever see this model, never a parser AST.
 *
 * Key idea: a ScenarioInstance is ONE executable test. A Scenario Outline with 3
 * example rows becomes 3 ScenarioInstances. External data (`@data:` tags, phase 2)
 * will expand the same way.
 */

import type { StepRunOptions } from './step-tags.js';

export type Status = 'passed' | 'failed' | 'skipped' | 'pending' | 'undefined' | 'ambiguous';

/** Gherkin keyword category. `conjunction` = And/But, resolved to the previous type by the compiler. */
export type StepKeywordType = 'context' | 'action' | 'outcome' | 'unknown';

export interface SourceLocation {
  uri: string;
  line: number;
  column?: number;
}

/**
 * A tag as written, plus its key/value split.
 *   `@smoke`              -> { name: '@smoke', key: 'smoke' }
 *   `@id:create-order`    -> { name: '@id:create-order', key: 'id', value: 'create-order' }
 *   `@owner=payments`     -> { name: '@owner=payments', key: 'owner', value: 'payments' }
 */
export interface Tag {
  name: string;
  key: string;
  value?: string;
  line?: number;
}

export interface DataTableArgument {
  kind: 'dataTable';
  rows: string[][];
}

export interface DocStringArgument {
  kind: 'docString';
  content: string;
  mediaType?: string;
}

export type StepArgument = DataTableArgument | DocStringArgument;

export interface StepInstance {
  /** Unique within the run (derived from the pickle step id). */
  id: string;
  /** Keyword as written, e.g. "Given ", "And ". */
  keyword: string;
  /** Resolved semantic type (And/But inherit the previous step's type). */
  keywordType: StepKeywordType;
  /** Step text with outline placeholders already substituted. */
  text: string;
  line: number;
  argument?: StepArgument;
  /** True when the step came from a Background block. */
  fromBackground: boolean;
  /** Step-level tags written at the end of the step (`@retry:3`), already removed from `text`. */
  tags?: Tag[];
  /** Repeat/retry/timeout options from step tags merged with scenario defaults (@stepRetry…). */
  run?: StepRunOptions;
}

export interface RuleRef {
  /** Unique within the feature. */
  id: string;
  name: string;
  line: number;
  tags: Tag[];
}

export interface ExampleRef {
  /** Name of the Examples block (may be empty). */
  name: string;
  /** 1-based row index across ALL example blocks of this outline. */
  index: number;
  line: number;
  values: Record<string, string>;
  /** For rows injected from `@data:` — the source (file[#selector]) and its 1-based data row. */
  source?: string;
  sourceRow?: number;
}

export interface FeatureInfo {
  uri: string;
  name: string;
  description: string;
  language: string;
  line: number;
  tags: Tag[];
}

export interface ScenarioInstance {
  /**
   * Stable, human-readable id. Rules:
   *  - `@id:<value>` tag wins (outline rows get `<value>[<row>]`).
   *  - otherwise `<uri>::<slug(name)>` (+ `[<row>]` for outline rows).
   *  - collisions inside one file get `@<line>` appended.
   * Ids are used for dependencies (phase 3), reruns and reports, so they must not
   * depend on execution order.
   */
  id: string;
  /** Original pickle id from the Gherkin compiler (unique per parse, not stable). */
  pickleId: string;
  /** Keyword as written: 'Scenario', 'Example', 'Scenario Outline', localised equivalents. */
  keyword: string;
  name: string;
  description: string;
  uri: string;
  line: number;
  feature: FeatureInfo;
  rule?: RuleRef;
  /** Effective tags: feature + rule + scenario + examples tags, de-duplicated. */
  tags: Tag[];
  /** Key/value view of tags. Key-only tags map to 'true'. Last one wins. */
  meta: Record<string, string>;
  steps: StepInstance[];
  /** Present when this instance came from a Scenario Outline row. */
  example?: ExampleRef;
}

export interface ParseErrorInfo {
  uri: string;
  line?: number;
  column?: number;
  message: string;
}

export interface ParsedSpec {
  uri: string;
  feature?: FeatureInfo;
  scenarios: ScenarioInstance[];
  errors: ParseErrorInfo[];
}

export interface ErrorInfo {
  name?: string;
  message: string;
  stack?: string;
}

/** Ordering used when folding step statuses into a scenario status. Worst first. */
export const STATUS_SEVERITY: readonly Status[] = [
  'failed',
  'ambiguous',
  'undefined',
  'pending',
  'skipped',
  'passed',
];

export function worstStatus(statuses: Iterable<Status>): Status {
  let worst = STATUS_SEVERITY.length - 1;
  let seen = false;
  for (const s of statuses) {
    seen = true;
    const i = STATUS_SEVERITY.indexOf(s);
    if (i < worst) worst = i;
  }
  return seen ? STATUS_SEVERITY[worst]! : 'passed';
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: typeof err === 'string' ? err : JSON.stringify(err) };
}
