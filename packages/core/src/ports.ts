/**
 * PORTS: the interfaces bddr owns. Third-party libraries (today: Cucumber's parser and
 * tag-expression evaluator) are plugged in behind these through adapters in ./adapters/.
 * The runtime, planner and reporters depend only on these interfaces and on ./model.ts.
 *
 * Rule: no file outside ./adapters/ may import a third-party spec/expression library.
 */
import type { DataLoader } from './data/loader.js';
import type { ParsedSpec } from './model.js';

export interface SpecParseOptions {
  /** Default spec language (Gherkin `# language:`), when the format supports it. */
  language?: string;
  /** Loads `@data:` sources. */
  dataLoader?: DataLoader;
}

/** Turns one spec file into executable ScenarioInstances. Must never throw for content errors. */
export interface SpecParser {
  readonly name: string;
  /** File suffixes this parser handles, e.g. ['.feature']. The longest matching suffix wins. */
  readonly extensions: readonly string[];
  parse(source: string, uri: string, options: SpecParseOptions): Promise<ParsedSpec>;
}

export type TagPredicate = (tagNames: readonly string[]) => boolean;

/** Compiles a tag expression ("@smoke and not @wip") into a predicate. Throws on invalid input. */
export interface TagExpressionEngine {
  readonly name: string;
  compile(expression: string): TagPredicate;
}
