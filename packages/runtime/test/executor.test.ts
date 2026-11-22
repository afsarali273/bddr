import { describe, expect, it } from 'vitest';
import { DataTable, SupportRegistry, type StepContext } from '@bddr/runtime';
import { run, scenariosOf } from './helpers.js';

const BASIC = `Feature: Calc
  Scenario: add
    Given I have 2
    When I add 3
    Then I get 5
`;

function calcSteps(r: SupportRegistry) {
  r.defineStep('I have {int}', (ctx: StepContext, n: number) => void ctx.state.set('v', n));
  r.defineStep('I add {int}', (ctx: StepContext, n: number) => void ctx.state.set('v', ctx.state.get<number>('v') + n));
  r.defineStep('I get {int}', (ctx: StepContext, n: number) => {
    if (ctx.state.get('v') !== n) throw new Error(`expected ${n}, got ${ctx.state.get('v')}`);
  });
}

describe('executor: steps', () => {
  it('runs steps with typed Cucumber Expression args and a scenario store', async () => {
    const r = new SupportRegistry();
    calcSteps(r);
    const { result, stepStatuses } = await run(r, scenariosOf(BASIC));
    expect(result.success).toBe(true);
    expect(stepStatuses('f1.feature::add')).toEqual(['passed', 'passed', 'passed']);
    expect(result.summary.scenarios).toMatchObject({ passed: 1, total: 1 });
  });

  it('marks the failing step failed and skips the rest', async () => {
    const r = new SupportRegistry();
    calcSteps(r);
    r.defineStep('I add {int}', () => {}, { tags: '@never' }); // out of scope, ignored
    const src = BASIC.replace('Then I get 5', 'Then I get 6\n    And I get 5');
    const { result, stepStatuses, of } = await run(r, scenariosOf(src));
    expect(result.success).toBe(false);
    expect(stepStatuses('f1.feature::add')).toEqual(['passed', 'passed', 'failed', 'skipped']);
    expect(of('scenarioFinished')[0]!.error!.message).toBe('expected 6, got 5');
  });

  it('reports undefined steps with a snippet, and ambiguous steps with candidates', async () => {
    const r = new SupportRegistry();
    r.defineStep('I have {int}', () => {});
    r.defineStep(/^I have (\d+)$/, () => {});
    const src = `Feature: x
  Scenario: u
    Given I order 3 "apples"
  Scenario: a
    Given I have 1
`;
    const { statusOf, of, result } = await run(r, scenariosOf(src));
    expect(statusOf('f1.feature::u')).toBe('undefined');
    expect(statusOf('f1.feature::a')).toBe('ambiguous');
    const und = of('stepFinished').find((e) => e.status === 'undefined')!;
    expect(und.snippet).toContain(`Given('I order {int} {string}', async (ctx, int: number, string: string) => {`);
    expect(of('stepFinished').find((e) => e.status === 'ambiguous')!.candidates).toHaveLength(2);
    expect(result.success).toBe(false);
    const lenient = await run(r, scenariosOf(src), { strict: false });
    expect(lenient.result.success).toBe(true);
  });

  it('prefers a scoped definition over an unscoped one', async () => {
    const r = new SupportRegistry();
    const used: string[] = [];
    r.defineStep('I log in', () => void used.push('generic'));
    r.defineStep('I log in', () => void used.push('api'), { tags: '@api' });
    await run(r, scenariosOf(`Feature: x\n  @api\n  Scenario: a\n    Given I log in\n  Scenario: b\n    Given I log in\n`));
    expect(used).toEqual(['api', 'generic']);
  });

  it('passes data tables, doc strings and custom parameter types', async () => {
    const r = new SupportRegistry();
    r.defineParameterType({ name: 'color', regexp: /red|blue/, transformer: (s) => s.toUpperCase() });
    let got: unknown[] = [];
    r.defineStep('a {color} ball with:', (_ctx: StepContext, color: string, table: DataTable) => {
      got = [color, table.hashes()];
    });
    r.defineStep('the note', (_ctx: StepContext, doc: string) => {
      got.push(String(doc));
    });
    await run(
      r,
      scenariosOf(`Feature: x
  Scenario: s
    Given a red ball with:
      | size | weight |
      | 5    | 10     |
    And the note
      """
      hello
      """
`),
    );
    expect(got).toEqual(['RED', [{ size: '5', weight: '10' }], 'hello']);
  });

  it('supports pending, skip and timeouts', async () => {
    const r = new SupportRegistry();
    r.defineStep('todo', (ctx: StepContext) => ctx.pending());
    r.defineStep('not today', (ctx: StepContext) => ctx.skip('feature flag off'));
    r.defineStep('slow', () => new Promise((res) => setTimeout(res, 200)), { timeoutMs: 20 });
    r.defineStep('fine', () => {});
    const { statusOf, of } = await run(
      r,
      scenariosOf(`Feature: x
  Scenario: p
    Given todo
    Then fine
  Scenario: k
    Given not today
    Then fine
  Scenario: t
    Given slow
`),
    );
    expect(statusOf('f1.feature::p')).toBe('pending');
    expect(statusOf('f1.feature::k')).toBe('skipped');
    expect(of('scenarioFinished').find((e) => e.scenarioId === 'f1.feature::k')!.reason).toBe('feature flag off');
    expect(statusOf('f1.feature::t')).toBe('failed');
    expect(of('scenarioFinished').find((e) => e.scenarioId === 'f1.feature::t')!.error!.message).toMatch(/timed out after 20 ms/);
  });

  it('dry run matches steps without executing anything', async () => {
    const r = new SupportRegistry();
    let calls = 0;
    r.defineStep('I have {int}', () => void calls++);
    r.defineHook('scenario', 'before', {}, () => void calls++);
    const { stepStatuses, statusOf } = await run(r, scenariosOf(`Feature: x\n  Scenario: d\n    Given I have 1\n    Then nothing\n`), {
      dryRun: true,
    });
    expect(calls).toBe(0);
    expect(stepStatuses('f1.feature::d')).toEqual(['skipped', 'undefined']);
    expect(statusOf('f1.feature::d')).toBe('undefined');
  });
});

describe('executor: hooks and context', () => {
  const TWO_FEATURES = [
    `@db
Feature: A
  Scenario: a1
    Given ok
  Rule: R
    Scenario: a2
      Given ok
`,
    `Feature: B
  @ui
  Scenario: b1
    Given ok
`,
  ];

  it('fires hooks in lifecycle order with tag filters', async () => {
    const r = new SupportRegistry();
    const log: string[] = [];
    r.defineStep('ok', (ctx: StepContext) => void log.push(`step ${ctx.scenario.name}`));
    r.defineHook('run', 'before', {}, () => void log.push('beforeAll'));
    r.defineHook('run', 'after', {}, () => void log.push('afterAll'));
    r.defineHook('feature', 'before', {}, (c) => void log.push(`beforeFeature ${c.featureInfo.name}`));
    r.defineHook('feature', 'after', { tags: '@db' }, () => void log.push('afterFeature @db'));
    r.defineHook('rule', 'before', {}, (c) => void log.push(`beforeRule ${c.rule?.name}`));
    r.defineHook('rule', 'after', {}, () => void log.push('afterRule'));
    r.defineHook('scenario', 'before', { order: 2 }, () => void log.push('before o2'));
    r.defineHook('scenario', 'before', { order: 1 }, () => void log.push('before o1'));
    r.defineHook('scenario', 'after', { tags: '@ui' }, () => void log.push('after @ui'));
    r.defineHook('step', 'before', { tags: '@ui' }, () => void log.push('beforeStep @ui'));
    await run(r, scenariosOf(...TWO_FEATURES));
    expect(log).toEqual([
      'beforeAll',
      'beforeFeature A',
      'before o1',
      'before o2',
      'step a1',
      'beforeRule R',
      'before o1',
      'before o2',
      'step a2',
      'afterRule',
      'afterFeature @db',
      'beforeFeature B',
      'before o1',
      'before o2',
      'beforeStep @ui',
      'step b1',
      'after @ui',
      'afterAll',
    ]);
  });

  it('BeforeFeature failure skips that feature only, with a reason', async () => {
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    let afterFeatureRan = false;
    r.defineHook('feature', 'before', { name: 'seed db', tags: '@db' }, () => {
      throw new Error('db down');
    });
    r.defineHook('feature', 'after', {}, () => {
      afterFeatureRan = true;
    });
    const { statusOf, of, result } = await run(r, scenariosOf(...TWO_FEATURES));
    expect(statusOf('f1.feature::a1')).toBe('skipped');
    expect(statusOf('f2.feature::b1')).toBe('passed');
    expect(of('scenarioFinished')[0]!.reason).toBe('BeforeFeature hook "seed db" failed');
    expect(of('hookFinished').find((h) => h.status === 'failed')!.error!.message).toBe('db down');
    expect(afterFeatureRan).toBe(true);
    expect(result.success).toBe(false);
  });

  it('Before (scenario) failure skips steps, honours alwaysRun, still runs After', async () => {
    const r = new SupportRegistry();
    const log: string[] = [];
    r.defineStep('ok', () => void log.push('step'));
    r.defineHook('scenario', 'before', { order: 1 }, () => {
      throw new Error('login failed');
    });
    r.defineHook('scenario', 'before', { order: 2 }, () => void log.push('normal before'));
    r.defineHook('scenario', 'before', { order: 3, alwaysRun: true }, () => void log.push('alwaysRun before'));
    r.defineHook('scenario', 'after', {}, () => void log.push('after'));
    const { stepStatuses, statusOf } = await run(r, scenariosOf(`Feature: x\n  Scenario: s\n    Given ok\n`));
    expect(log).toEqual(['alwaysRun before', 'after']);
    expect(stepStatuses('f1.feature::s')).toEqual(['skipped']);
    expect(statusOf('f1.feature::s')).toBe('failed');
  });

  it('defer() cleanups run LIFO per scope, even after failures', async () => {
    const r = new SupportRegistry();
    const log: string[] = [];
    r.defineStep('open {word}', (ctx: StepContext, name: string) => {
      log.push(`open ${name}`);
      ctx.defer(() => void log.push(`close ${name}`));
    });
    r.defineStep('boom', () => {
      throw new Error('boom');
    });
    r.defineHook('feature', 'before', {}, (ctx) => ctx.defer(() => void log.push('feature cleanup')));
    await run(r, scenariosOf(`Feature: x\n  Scenario: s\n    Given open a\n    And open b\n    Then boom\n`));
    expect(log).toEqual(['open a', 'open b', 'close b', 'close a', 'feature cleanup']);
  });

  it('shares state across scopes: run > feature > scenario', async () => {
    const r = new SupportRegistry();
    const seen: unknown[] = [];
    r.defineHook('run', 'before', {}, (ctx) => void ctx.run.set('token', 'T1'));
    r.defineHook('feature', 'before', {}, (ctx) => void ctx.feature.set('fx', 1));
    r.defineStep('check', (ctx: StepContext) => {
      seen.push(ctx.run.get('token'), ctx.feature.get('fx'), ctx.state.has('mine'), ctx.params['env']);
      ctx.state.set('mine', true);
    });
    await run(r, scenariosOf(`Feature: x\n  Scenario: a\n    Given check\n  Scenario: b\n    Given check\n`), { params: { env: 'qa' } });
    expect(seen).toEqual(['T1', 1, false, 'qa', 'T1', 1, false, 'qa']);
  });

  it('emits logs and attachments tagged with scenario and step', async () => {
    const r = new SupportRegistry();
    r.defineStep('note', (ctx: StepContext) => {
      ctx.log('hello');
      ctx.attach(new Uint8Array([1, 2, 3]), 'application/octet-stream', 'bytes');
    });
    const { of } = await run(r, scenariosOf(`Feature: x\n  Scenario: s\n    Given note\n`));
    expect(of('log').filter((l) => l.source === 'user')[0]).toMatchObject({ message: 'hello', level: 'info', scenarioId: 'f1.feature::s' });
    expect(of('attachment')[0]).toMatchObject({ encoding: 'base64', body: 'AQID', name: 'bytes' });
    expect(of('attachment')[0]!.stepId).toBeDefined();
  });

  it('fail-fast skips scenarios after the first failure', async () => {
    const r = new SupportRegistry();
    r.defineStep('fail', () => {
      throw new Error('x');
    });
    r.defineStep('ok', () => {});
    const { statusOf } = await run(
      r,
      scenariosOf(`Feature: x\n  Scenario: a\n    Given fail\n  Scenario: b\n    Given ok\n`),
      { failFast: true },
    );
    expect(statusOf('f1.feature::b')).toBe('skipped');
  });

  it('emits a well-ordered event stream', async () => {
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    const { events } = await run(r, scenariosOf(`Feature: x\n  Scenario: s\n    Given ok\n`));
    expect(events.filter((e) => e.type !== 'log').map((e) => e.type)).toEqual([
      'runStarted',
      'planReady',
      'featureStarted',
      'scenarioStarted',
      'stepStarted',
      'stepFinished',
      'scenarioFinished',
      'featureFinished',
      'runFinished',
    ]);
  });
});
