import type { DataTable, StepContext, SupportRegistry } from '@bddr/runtime';

/** Reference implementation of the shared conformance step vocabulary (see ../README.md). */
export function registerConformanceSteps(r: SupportRegistry, trace: string[]): void {
  r.defineStep('a passing step', () => {});
  r.defineStep('a failing step', () => {
    throw new Error('boom');
  });
  r.defineStep('a pending step', (ctx: StepContext) => ctx.pending());
  r.defineStep('a skipping step', (ctx: StepContext) => ctx.skip('skipped on purpose'));
  r.defineStep('I record {string}', (_ctx: StepContext, text: string) => void trace.push(text));
  r.defineStep('I record the row value {string}', (ctx: StepContext, name: string) => {
    trace.push(`${name}=${ctx.scenario.example?.[name] ?? '<none>'}`);
  });
  r.defineStep('the table has {int} rows', (_ctx: StepContext, n: number, table: DataTable) => {
    if (table.rows().length !== n) throw new Error(`expected ${n} rows, got ${table.rows().length}`);
  });
  r.defineStep('the doc string says {string}', (_ctx: StepContext, text: string, doc: string) => {
    if (String(doc) !== text) throw new Error(`doc string was "${String(doc)}"`);
  });
  r.defineStep('a step that passes on attempt {int}', (ctx: StepContext, n: number) => {
    trace.push(`attempt ${ctx.step!.attempt}`);
    if (ctx.step!.attempt < n) throw new Error(`attempt ${ctx.step!.attempt} < ${n}`);
  });
  r.defineStep('a step that passes on scenario attempt {int}', (ctx: StepContext, n: number) => {
    trace.push(`scenario attempt ${ctx.scenario.attempt}`);
    if (ctx.scenario.attempt < n) throw new Error(`scenario attempt ${ctx.scenario.attempt} < ${n}`);
  });
  r.defineStep('a step that fails on repetition {int}', (ctx: StepContext, n: number) => {
    trace.push(`repetition ${ctx.step!.attempt}`);
    if (ctx.step!.attempt === n) throw new Error(`repetition ${n} fails`);
  });
  r.defineStep('a step that sleeps {int} ms', (_ctx: StepContext, ms: number) => new Promise((res) => setTimeout(res, ms)));

  r.defineHook('feature', 'before', { tags: '@trace-hooks' }, () => void trace.push('beforeFeature'));
  r.defineHook('feature', 'after', { tags: '@trace-hooks' }, () => void trace.push('afterFeature'));
  r.defineHook('scenario', 'before', { tags: '@trace-hooks' }, (ctx) => void trace.push(`before ${ctx.scenario.name}`));
  r.defineHook('scenario', 'after', { tags: '@trace-hooks' }, (ctx) => void trace.push(`after ${ctx.scenario.name}`));
  r.defineHook('scenario', 'before', { tags: '@fail-before' }, () => {
    throw new Error('before failed');
  });
  r.defineHook('feature', 'before', { tags: '@fail-feature' }, () => {
    throw new Error('feature setup failed');
  });
}
