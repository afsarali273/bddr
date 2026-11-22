/**
 * ADAPTER: Gherkin (.feature, .feature.md) via Cucumber's open-source parser and pickle compiler.
 *
 * This is the ONLY file in bddr that imports @cucumber/gherkin or @cucumber/messages. Everything it
 * produces is our own model (ScenarioInstance). To replace the parser, write another SpecParser
 * (see ../ports.ts) and register it; nothing else changes.
 */
import {
  AstBuilder,
  compile,
  GherkinClassicTokenMatcher,
  GherkinInMarkdownTokenMatcher,
  Parser,
} from '@cucumber/gherkin';
import {
  IdGenerator,
  PickleStepType,
  type Background,
  type Examples,
  type GherkinDocument,
  type Pickle,
  type Rule,
  type Scenario,
  type Tag as GherkinTag,
} from '@cucumber/messages';
import { slugify } from '../ids.js';
import type {
  ExampleRef,
  FeatureInfo,
  ParsedSpec,
  ParseErrorInfo,
  RuleRef,
  ScenarioInstance,
  StepInstance,
  StepKeywordType,
  Tag,
} from '../model.js';
import { parseTag, tagsToMeta } from '../tags.js';
import { parseDataRef, type DataLoader } from '../data/loader.js';
import { extractStepTags, scenarioStepDefaults } from '../step-tags.js';
import type { SpecParser } from '../ports.js';

export interface ParseOptions {
  /** Default Gherkin language when the file has no `# language:` header. Default 'en'. */
  language?: string;
  /** Force a format. Default: '.md' files are Markdown-with-Gherkin (MDG), everything else plain Gherkin. */
  format?: 'gherkin' | 'markdown';
}

interface StepAstInfo {
  line: number;
  keyword: string;
  fromBackground: boolean;
}

interface ScenarioAstInfo {
  scenario: Scenario;
  rule?: RuleRef;
}

interface RowAstInfo {
  example: ExampleRef;
}

/** Row AST id -> where an injected data row came from. */
type RowSources = Map<string, { source: string; number: number }>;

/** Index of AST nodes by id, so pickles can be mapped back to lines/keywords/rules. */
interface AstIndex {
  steps: Map<string, StepAstInfo>;
  scenarios: Map<string, ScenarioAstInfo>;
  rows: Map<string, RowAstInfo>;
  tagLines: Map<string, number>;
}

function indexTags(tags: readonly GherkinTag[], index: AstIndex) {
  for (const t of tags) index.tagLines.set(t.id, t.location.line);
}

function indexBackground(bg: Background, index: AstIndex) {
  for (const s of bg.steps) {
    index.steps.set(s.id, { line: s.location.line, keyword: s.keyword, fromBackground: true });
  }
}

function indexScenario(sc: Scenario, rule: RuleRef | undefined, index: AstIndex, rowSources: RowSources) {
  index.scenarios.set(sc.id, rule ? { scenario: sc, rule } : { scenario: sc });
  indexTags(sc.tags, index);
  for (const s of sc.steps) {
    index.steps.set(s.id, { line: s.location.line, keyword: s.keyword, fromBackground: false });
  }
  let rowIndex = 0;
  for (const ex of sc.examples) {
    indexTags(ex.tags, index);
    const header = ex.tableHeader?.cells.map((c) => c.value) ?? [];
    for (const row of ex.tableBody) {
      rowIndex += 1;
      const values: Record<string, string> = {};
      row.cells.forEach((c, i) => {
        const key = header[i];
        if (key !== undefined) values[key] = c.value;
      });
      const example: ExampleRef = { name: ex.name, index: rowIndex, line: row.location.line, values };
      const src = rowSources.get(row.id);
      if (src) {
        example.source = src.source;
        example.sourceRow = src.number;
      }
      index.rows.set(row.id, { example });
    }
  }
}

function buildIndex(doc: GherkinDocument, rowSources: RowSources): AstIndex {
  const index: AstIndex = { steps: new Map(), scenarios: new Map(), rows: new Map(), tagLines: new Map() };
  const feature = doc.feature;
  if (!feature) return index;
  indexTags(feature.tags, index);
  for (const child of feature.children) {
    if (child.background) indexBackground(child.background, index);
    if (child.scenario) indexScenario(child.scenario, undefined, index, rowSources);
    if (child.rule) indexRule(child.rule, index, rowSources);
  }
  return index;
}

function indexRule(rule: Rule, index: AstIndex, rowSources: RowSources) {
  indexTags(rule.tags, index);
  const ref: RuleRef = {
    id: rule.id,
    name: rule.name,
    line: rule.location.line,
    tags: rule.tags.map((t) => parseTag(t.name, t.location.line)),
  };
  for (const child of rule.children) {
    if (child.background) indexBackground(child.background, index);
    if (child.scenario) indexScenario(child.scenario, ref, index, rowSources);
  }
}

function toKeywordType(t: PickleStepType | undefined): StepKeywordType {
  switch (t) {
    case PickleStepType.CONTEXT:
      return 'context';
    case PickleStepType.ACTION:
      return 'action';
    case PickleStepType.OUTCOME:
      return 'outcome';
    default:
      return 'unknown';
  }
}

function dedupeTags(tags: Tag[]): Tag[] {
  const seen = new Set<string>();
  const out: Tag[] = [];
  for (const t of tags) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(t);
  }
  return out;
}

function pickleToInstance(pickle: Pickle, feature: FeatureInfo, index: AstIndex, errors: ParseErrorInfo[]): ScenarioInstance {
  const [scenarioNodeId, rowNodeId] = pickle.astNodeIds;
  const scInfo = scenarioNodeId ? index.scenarios.get(scenarioNodeId) : undefined;
  const row = rowNodeId ? index.rows.get(rowNodeId) : undefined;

  const tags = dedupeTags(pickle.tags.map((t) => parseTag(t.name, index.tagLines.get(t.astNodeId))));

  const defaults = scenarioStepDefaults(tags);
  for (const message of defaults.errors) errors.push({ uri: pickle.uri, line: pickle.location?.line ?? 0, message });
  const steps: StepInstance[] = pickle.steps.map((ps) => {
    const ast = index.steps.get(ps.astNodeIds[0] ?? '');
    const extracted = extractStepTags(ps.text);
    const line = ast?.line ?? 0;
    for (const message of extracted.errors) errors.push({ uri: pickle.uri, line, message: `${message} (step "${ps.text}")` });
    const step: StepInstance = {
      id: ps.id,
      keyword: ast?.keyword ?? '* ',
      keywordType: toKeywordType(ps.type),
      text: extracted.text,
      line,
      fromBackground: ast?.fromBackground ?? false,
    };
    if (extracted.tags.length) step.tags = extracted.tags;
    const run = { ...defaults.run, ...extracted.run };
    if (run.repeat !== undefined) delete run.retry; // an explicit @repeat wins over a scenario-level @stepRetry
    if (Object.keys(run).length) step.run = run;
    if (ps.argument?.dataTable) {
      step.argument = { kind: 'dataTable', rows: ps.argument.dataTable.rows.map((r) => r.cells.map((c) => c.value)) };
    } else if (ps.argument?.docString) {
      const ds = ps.argument.docString;
      step.argument = { kind: 'docString', content: ds.content, ...(ds.mediaType ? { mediaType: ds.mediaType } : {}) };
    }
    return step;
  });

  const instance: ScenarioInstance = {
    id: '', // assigned later, needs all siblings for collision handling
    pickleId: pickle.id,
    keyword: scInfo?.scenario.keyword ?? 'Scenario',
    name: pickle.name,
    description: scInfo?.scenario.description.trim() ?? '',
    uri: pickle.uri,
    line: row?.example.line ?? scInfo?.scenario.location.line ?? pickle.location?.line ?? 0,
    feature,
    tags,
    meta: tagsToMeta(tags),
    steps,
  };
  if (scInfo?.rule) instance.rule = scInfo.rule;
  if (row) instance.example = row.example;
  return instance;
}

/**
 * Ids use the scenario's TEMPLATE name (before <placeholder> substitution), so editing a data
 * value never changes a test's id.
 */
function assignStableIds(instances: ScenarioInstance[], templateNames: Map<ScenarioInstance, string>): void {
  const used = new Map<string, number>();
  for (const inst of instances) {
    const explicit = inst.meta['id'];
    const base = explicit && explicit !== 'true' ? explicit : `${inst.uri}::${slugify(templateNames.get(inst) ?? inst.name)}`;
    let id = inst.example
      ? inst.example.source
        ? `${base}[${inst.example.source}#${inst.example.sourceRow}]`
        : `${base}[${inst.example.index}]`
      : base;
    if (used.has(id)) id = `${id}@${inst.line}`;
    used.set(id, (used.get(id) ?? 0) + 1);
    inst.id = id;
  }
}

type Parsed = { ok: true; doc: GherkinDocument; newId: () => string } | { ok: false; spec: ParsedSpec };

function parseDocument(source: string, uri: string, options: ParseOptions): Parsed {
  const language = options.language ?? 'en';
  const format = options.format ?? (uri.endsWith('.md') ? 'markdown' : 'gherkin');
  const newId = IdGenerator.incrementing();
  const matcher =
    format === 'markdown' ? new GherkinInMarkdownTokenMatcher(language) : new GherkinClassicTokenMatcher(language);
  const parser = new Parser(new AstBuilder(newId), matcher);
  try {
    return { ok: true, doc: { ...parser.parse(source), uri }, newId };
  } catch (err) {
    return { ok: false, spec: { uri, scenarios: [], errors: toParseErrors(err, uri) } };
  }
}

function compileDocument(doc: GherkinDocument, uri: string, newId: () => string, rowSources: RowSources, errors: ParseErrorInfo[]): ParsedSpec {
  if (!doc.feature) return { uri, scenarios: [], errors };
  const f = doc.feature;
  const feature: FeatureInfo = {
    uri,
    name: f.name,
    description: f.description.trim(),
    language: f.language,
    line: f.location.line,
    tags: f.tags.map((t) => parseTag(t.name, t.location.line)),
  };
  const index = buildIndex(doc, rowSources);
  const pickles = compile(doc, uri, newId);
  const templateNames = new Map<ScenarioInstance, string>();
  const scenarios = pickles.map((p) => {
    const inst = pickleToInstance(p, feature, index, errors);
    const template = index.scenarios.get(p.astNodeIds[0] ?? '')?.scenario.name;
    if (template !== undefined) templateNames.set(inst, template);
    return inst;
  });
  assignStableIds(scenarios, templateNames);
  return { uri, feature, scenarios, errors };
}

/**
 * Parse one spec file into executable ScenarioInstances (synchronous, no external data).
 * Never throws for syntax errors: they are returned in `errors` with line numbers.
 * Scenarios with `@data:` tags are reported as errors here; use `parseSpecAsync` with a DataLoader.
 */
export function parseSpec(source: string, uri: string, options: ParseOptions = {}): ParsedSpec {
  const parsed = parseDocument(source, uri, options);
  if (!parsed.ok) return parsed.spec;
  const errors: ParseErrorInfo[] = [];
  for (const { scenario, tagLine } of dataTaggedScenarios(parsed.doc)) {
    errors.push({ uri, line: tagLine, message: `Scenario "${scenario.name}" uses @data but no data loader is configured (use parseSpecAsync)` });
  }
  return compileDocument(parsed.doc, uri, parsed.newId, new Map(), errors);
}

export interface AsyncParseOptions extends ParseOptions {
  /** Loads `@data:` sources. Without it, @data tags are errors. */
  dataLoader?: DataLoader;
}

/** Like parseSpec, plus `@data:` expansion (Phase 2). */
export async function parseSpecAsync(source: string, uri: string, options: AsyncParseOptions = {}): Promise<ParsedSpec> {
  const parsed = parseDocument(source, uri, options);
  if (!parsed.ok) return parsed.spec;
  const errors: ParseErrorInfo[] = [];
  const rowSources: RowSources = new Map();
  if (options.dataLoader) await injectData(parsed.doc, uri, parsed.newId, options.dataLoader, rowSources, errors);
  else {
    for (const { scenario, tagLine } of dataTaggedScenarios(parsed.doc)) {
      errors.push({ uri, line: tagLine, message: `Scenario "${scenario.name}" uses @data but no data loader is configured` });
    }
  }
  return compileDocument(parsed.doc, uri, parsed.newId, rowSources, errors);
}

// ------------------------------------------------------------------ @data injection

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };

interface Container {
  children: Array<{ scenario?: Scenario }>;
  tags: readonly GherkinTag[];
}

function containers(doc: GherkinDocument): Array<{ container: Container; inherited: readonly GherkinTag[] }> {
  const f = doc.feature;
  if (!f) return [];
  const out: Array<{ container: Container; inherited: readonly GherkinTag[] }> = [
    { container: f as unknown as Container, inherited: f.tags },
  ];
  for (const c of f.children) if (c.rule) out.push({ container: c.rule as unknown as Container, inherited: [...f.tags, ...c.rule.tags] });
  return out;
}

const isData = (t: GherkinTag) => parseTag(t.name).key === 'data';

function dataTaggedScenarios(doc: GherkinDocument): Array<{ scenario: Scenario; tagLine: number }> {
  const out: Array<{ scenario: Scenario; tagLine: number }> = [];
  for (const { container } of containers(doc)) {
    for (const child of container.children) {
      const sc = child.scenario;
      if (!sc) continue;
      const tag = sc.tags.find(isData) ?? sc.examples.flatMap((e) => e.tags).find(isData);
      if (tag) out.push({ scenario: sc, tagLine: tag.location.line });
    }
  }
  return out;
}

/** `@dataField:placeholder=column` tags (feature/rule < scenario < examples; later wins). */
function fieldMap(tags: readonly GherkinTag[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of tags) {
    const p = parseTag(t.name);
    if (p.key !== 'dataField' || !p.value) continue;
    const eq = p.value.indexOf('=');
    if (eq > 0) map[p.value.slice(0, eq)] = p.value.slice(eq + 1);
  }
  return map;
}

async function injectData(
  doc: GherkinDocument,
  uri: string,
  newId: () => string,
  loader: DataLoader,
  rowSources: RowSources,
  errors: ParseErrorInfo[],
): Promise<void> {
  for (const { container, inherited } of containers(doc)) {
    const keep: typeof container.children = [];
    for (const child of container.children) {
      const sc = child.scenario as Mutable<Scenario> | undefined;
      if (!sc) {
        keep.push(child);
        continue;
      }
      try {
        const scenarioFields = { ...fieldMap(inherited), ...fieldMap(sc.tags) };
        // 1. Examples blocks tagged @data: replace their body.
        for (const ex of sc.examples as Mutable<Examples>[]) {
          const tag = ex.tags.find(isData);
          if (!tag) continue;
          const fields = { ...scenarioFields, ...fieldMap(ex.tags) };
          const header = ex.tableHeader?.cells.map((c) => c.value);
          const block = await buildExamples(tag, header, fields, uri, newId, loader, rowSources);
          ex.tableHeader = block.tableHeader;
          ex.tableBody = [...block.tableBody];
        }
        // 2. Scenario tagged @data: append one synthetic Examples block per tag.
        for (const tag of sc.tags.filter(isData)) {
          sc.examples = [...sc.examples, await buildExamples(tag, undefined, scenarioFields, uri, newId, loader, rowSources)];
        }
        keep.push(child);
      } catch (err) {
        const tag = sc.tags.find(isData) ?? sc.examples.flatMap((e) => e.tags).find(isData);
        errors.push({ uri, line: tag?.location.line ?? sc.location.line, message: err instanceof Error ? err.message : String(err) });
        // Drop the scenario: running it with unresolved <placeholders> would be misleading.
      }
    }
    container.children = keep;
  }
}

async function buildExamples(
  tag: GherkinTag,
  header: string[] | undefined,
  fields: Record<string, string>,
  uri: string,
  newId: () => string,
  loader: DataLoader,
  rowSources: RowSources,
): Promise<Examples> {
  const ref = parseDataRef(parseTag(tag.name).value ?? '');
  const data = await loader.load(ref, { uri });
  if (!data.rows.length) throw new Error(`@data:${ref.raw} matched no rows`);
  const reverse: Record<string, string> = {};
  for (const [placeholder, column] of Object.entries(fields)) reverse[column] = placeholder;
  const columns = header ?? data.columns.map((c) => reverse[c] ?? c);
  const sourceColumn = (placeholder: string) => fields[placeholder] ?? placeholder;
  for (const col of columns) {
    if (!data.columns.includes(sourceColumn(col))) {
      throw new Error(`Column "${sourceColumn(col)}" not found in ${ref.source}. Columns: ${data.columns.join(', ')}`);
    }
  }
  const location = { line: tag.location.line, column: tag.location.column ?? 1 };
  const cell = (value: string) => ({ location, value });
  const tableBody = data.rows.map((r) => {
    const id = newId();
    rowSources.set(id, { source: ref.source + (ref.selector ? `#${ref.selector}` : ''), number: r.number });
    return { id, location, cells: columns.map((c) => cell(r.values[sourceColumn(c)] ?? '')) };
  });
  return {
    id: newId(),
    location,
    tags: [],
    keyword: 'Examples',
    name: ref.source,
    description: '',
    tableHeader: { id: newId(), location, cells: columns.map(cell) },
    tableBody,
  };
}

function toParseErrors(err: unknown, uri: string): ParseErrorInfo[] {
  const e = err as { errors?: Array<{ message: string; location?: { line: number; column?: number } }>; message?: string };
  const list = e.errors && e.errors.length ? e.errors : [{ message: e.message ?? String(err) }];
  return list.map((x) => {
    const info: ParseErrorInfo = { uri, message: x.message };
    const loc = (x as { location?: { line: number; column?: number } }).location;
    if (loc?.line !== undefined) info.line = loc.line;
    if (loc?.column !== undefined) info.column = loc.column;
    return info;
  });
}

/** The default spec parser for Gherkin files. */
export const cucumberGherkinParser: SpecParser = {
  name: 'gherkin (cucumber)',
  extensions: ['.feature', '.feature.md'],
  parse: (source, uri, options) => parseSpecAsync(source, uri, options),
};
