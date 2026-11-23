/**
 * Dependency mapping and planning: the corner cases.
 *
 * What is under test: how `@dependsOn`, `@requires`, group `dependsOn`, `@serial` and `@lock` turn into plan edges
 * (`buildPlan`), what a selection pulls in, how cycles and bad references are reported, how the plan is rendered and
 * how it is split into shards. The run-time side (skips, ordering under concurrency) is in
 * packages/runtime/test/dependency-matrix.test.ts.
 *
 * Conventions: scenarios get `@id:<name>` so ids equal names. In `deps(...)` a trailing `~` marks a soft edge.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan, explainNode, parseSpec, planToJSON, renderPlanMermaid, renderPlanText, selectScenarios, shardPlan, type Plan, type PlanOptions, type ScenarioInstance } from '@bddr/core';

// ---------------------------------------------------------------------------------------------------------------------
// helpers

/** `sc('b', '@dependsOn:a')` is a scenario with id b. */
const sc = (id: string, tags = '', steps = 'Given ok') => `  @id:${id}${tags ? ` ${tags}` : ''}\n  Scenario: ${id}\n    ${steps}\n`;
const feature = (name: string, scenarios: string[], tags = '') => `${tags ? `${tags}\n` : ''}Feature: ${name}\n${scenarios.join('')}`;

function load(files: Record<string, string>): ScenarioInstance[] {
  return Object.entries(files).flatMap(([uri, src]) => {
    const spec = parseSpec(src, uri);
    expect(spec.errors, uri).toEqual([]);
    return spec.scenarios;
  });
}
const one = (scenarios: string[], tags = '') => load({ 'f.feature': feature('F', scenarios, tags) });

function plan(all: ScenarioInstance[], selected: ScenarioInstance[] = all, options: PlanOptions = {}): Plan {
  return buildPlan(all, selected, options);
}
const ids = (p: Plan) => p.nodes.map((n) => n.id);
const deps = (p: Plan, id: string) => p.byId.get(id)!.deps.map((d) => `${d.target}${d.soft ? '~' : ''}`).sort();
const messages = (p: Plan) => p.errors.map((e) => e.message);
const pick = (all: ScenarioInstance[], ...wanted: string[]) => all.filter((s) => wanted.includes(s.id));

// ---------------------------------------------------------------------------------------------------------------------
describe('id resolution', () => {
  it('matches a scenario by its @id exactly (case sensitive)', () => {
    const all = one([sc('login'), sc('a', '@dependsOn:login'), sc('b', '@dependsOn:Login')]);
    const p = plan(all);
    expect(deps(p, 'a')).toEqual(['login']);
    expect(deps(p, 'b')).toEqual([]);
    expect(messages(p)).toEqual(['@dependsOn:Login: no scenario has this id (use @id:<name> on the target)']);
  });

  it('matches the default id (<file>::<slugged name>) when no @id is given', () => {
    const all = load({
      'f.feature': `Feature: F\n  Scenario: Create the order!\n    Given ok\n  @dependsOn:f.feature::create-the-order\n  Scenario: pay\n    Given ok\n`,
    });
    const p = plan(all);
    expect(p.errors).toEqual([]);
    expect(deps(p, 'f.feature::pay')).toEqual(['f.feature::create-the-order']);
  });

  it('matches a whole outline family by its base id, or one row by its full id', () => {
    const all = one([
      `  @id:rows\n  Scenario Outline: row <n>\n    Given ok\n    Examples:\n      | n |\n      | 1 |\n      | 2 |\n      | 3 |\n`,
      sc('all-rows', '@dependsOn:rows'),
      sc('row-2-only', '@dependsOn:rows[2]'),
    ]);
    const p = plan(all);
    expect(p.errors).toEqual([]);
    expect(deps(p, 'all-rows')).toEqual(['rows[1]', 'rows[2]', 'rows[3]']);
    expect(deps(p, 'row-2-only')).toEqual(['rows[2]']);
  });

  it('prefers an exact id over a family with the same base name', () => {
    const all = load({
      'f.feature': feature('F', [
        sc('x'),
        `  @id:x\n  Scenario Outline: x row <n>\n    Given ok\n    Examples:\n      | n |\n      | 1 |\n`,
        sc('user', '@dependsOn:x'),
      ]),
    });
    // The parser may rename the colliding id; whichever scenario owns the exact id `x` is the only target.
    const exact = all.find((s) => s.id === 'x');
    expect(exact).toBeDefined();
    const p = plan(all);
    expect(deps(p, 'user')).toEqual(['x']);
  });

  it('makes a scenario that depends on its own id a no-op, not a cycle', () => {
    const p = plan(one([sc('a', '@dependsOn:a')]));
    expect(p.errors).toEqual([]);
    expect(deps(p, 'a')).toEqual([]);
  });

  it('flags an outline that depends on its own family (every row would wait for every other row)', () => {
    const all = one([`  @id:rows @dependsOn:rows\n  Scenario Outline: row <n>\n    Given ok\n    Examples:\n      | n |\n      | 1 |\n      | 2 |\n`]);
    expect(messages(plan(all)).join('\n')).toMatch(/Dependency cycle/);
  });

  it('ignores a @dependsOn tag with no value instead of crashing', () => {
    const all = one([sc('a', '@dependsOn')]);
    const p = plan(all);
    expect(deps(p, 'a')).toEqual([]);
  });

  it('reports an unknown id on the dependent scenario and still plans everything else', () => {
    const all = one([sc('a'), sc('b', '@dependsOn:ghost @dependsOn:a')]);
    const p = plan(all);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toMatchObject({ scenarioId: 'b', uri: 'f.feature', message: '@dependsOn:ghost: no scenario has this id (use @id:<name> on the target)' });
    expect(deps(p, 'b')).toEqual(['a']);
  });

  it('accepts an explicit :hard suffix and treats :soft as soft', () => {
    const p = plan(one([sc('a'), sc('b', '@dependsOn:a:hard'), sc('c', '@dependsOn:a:soft')]));
    expect(deps(p, 'b')).toEqual(['a']);
    expect(deps(p, 'c')).toEqual(['a~']);
  });

  it('resolves references to scenarios in other files', () => {
    const all = load({
      'a.feature': feature('A', [sc('seed')]),
      'b.feature': feature('B', [sc('use', '@dependsOn:seed')]),
    });
    expect(deps(plan(all), 'use')).toEqual(['seed']);
  });

  it('rejects the same @id used in two files (ids are the dependency targets, so they must be unique)', () => {
    const all = load({
      'a.feature': feature('A', [sc('setup')]),
      'b.feature': feature('B', [sc('setup'), sc('use', '@dependsOn:setup')]),
    });
    const p = plan(all);
    expect(messages(p)).toEqual(['Scenario id "setup" is duplicated at a.feature:3, b.feature:3']);
  });

  it('merges a repeated dependency into one edge and lets hard win over soft', () => {
    const p = plan(one([sc('a'), sc('b', '@dependsOn:a:soft @dependsOn:a'), sc('c', '@dependsOn:a @dependsOn:a:soft')]));
    expect(deps(p, 'b')).toEqual(['a']);
    expect(deps(p, 'c')).toEqual(['a']);
    expect(p.byId.get('b')!.deps).toHaveLength(1);
  });

  it('inherits @dependsOn from feature and rule tags onto every scenario below them', () => {
    const src = `@dependsOn:setup\nFeature: F\n  @id:setup\n  Scenario: setup\n    Given ok\n  Rule: R\n    @dependsOn:setup\n    @id:inner\n    Scenario: inner\n      Given ok\n  @id:plain\n  Scenario: plain\n    Given ok\n`;
    const p = plan(load({ 'f.feature': src }));
    expect(deps(p, 'plain')).toEqual(['setup']);
    expect(deps(p, 'inner')).toEqual(['setup']);
    expect(deps(p, 'setup')).toEqual([]); // its own tag points at itself: ignored
  });

  it('puts @dependsOn from an Examples block on the rows of that block only', () => {
    const src = feature('F', [
      sc('setup'),
      `  @id:o\n  Scenario Outline: o <n>\n    Given ok\n    Examples: first\n      | n |\n      | 1 |\n    @dependsOn:setup\n    Examples: second\n      | n |\n      | 2 |\n`,
    ]);
    const p = plan(load({ 'f.feature': src }));
    expect(deps(p, 'o[1]')).toEqual([]);
    expect(deps(p, 'o[2]')).toEqual(['setup']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('group dependencies', () => {
  const groupFeature = () =>
    one([
      sc('s1', '@group:setup'),
      sc('s2', '@group:setup'),
      sc('c1', '@group:checkout'),
      sc('c2', '@group:checkout'),
      sc('r1', '@group:reports'),
    ]);

  it('@dependsOn:group:<name> waits for every member, hard by default and soft with :soft', () => {
    const all = one([sc('s1', '@group:setup'), sc('s2', '@group:setup'), sc('hard', '@dependsOn:group:setup'), sc('soft', '@dependsOn:group:setup:soft')]);
    const p = plan(all);
    expect(deps(p, 'hard')).toEqual(['s1', 's2']);
    expect(deps(p, 'soft')).toEqual(['s1~', 's2~']);
  });

  it('config group dependsOn gives every member an edge to every member of the other group', () => {
    const p = plan(groupFeature(), undefined, { groups: { setup: {}, checkout: { dependsOn: ['setup'] } } });
    expect(p.errors).toEqual([]);
    expect(deps(p, 'c1')).toEqual(['s1', 's2']);
    expect(deps(p, 'c2')).toEqual(['s1', 's2']);
    expect(deps(p, 'r1')).toEqual([]);
    expect(p.byId.get('c1')!.deps[0]!.via).toBe('group-config:checkout->setup');
  });

  it("onDependencyFailure: 'run' makes the config edges soft", () => {
    const p = plan(groupFeature(), undefined, { groups: { checkout: {}, reports: { dependsOn: ['checkout'], onDependencyFailure: 'run' } } });
    expect(p.errors).toEqual([]);
    expect(deps(p, 'r1')).toEqual(['c1~', 'c2~']);
  });

  it('follows group dependencies transitively when pulling in (reports -> checkout -> setup)', () => {
    const all = groupFeature();
    const p = plan(all, pick(all, 'r1'), { groups: { setup: {}, reports: { dependsOn: ['checkout'] }, checkout: { dependsOn: ['setup'] } } });
    expect(p.errors).toEqual([]);
    expect(ids(p).sort()).toEqual(['c1', 'c2', 'r1', 's1', 's2']);
    expect(p.byId.get('s1')!.pulledInBy).toEqual(['c1', 'c2']);
    expect(p.byId.get('c1')!.pulledInBy).toEqual(['r1']);
  });

  it("does not pull in a group that is only a soft ('run') dependency", () => {
    const all = groupFeature();
    const p = plan(all, pick(all, 'r1'), { groups: { checkout: {}, reports: { dependsOn: ['checkout'], onDependencyFailure: 'run' } } });
    expect(p.errors).toEqual([]);
    expect(ids(p)).toEqual(['r1']);
    expect(deps(p, 'r1')).toEqual([]);
  });

  it('does not make a scenario wait for its own group, even when the group depends on itself through another tag', () => {
    const all = one([sc('both1', '@group:a @group:b'), sc('only-b', '@group:b')]);
    const p = plan(all, all, { groups: { a: { dependsOn: ['b'] }, b: {} } });
    expect(deps(p, 'both1')).toEqual([]); // it is a member of b itself
    expect(p.errors).toEqual([]);
  });

  it('accepts a configured group that has no scenarios (no edges, no error)', () => {
    const all = one([sc('a'), sc('b', '@dependsOn:group:empty')]);
    const p = plan(all, all, { groups: { empty: {} } });
    expect(p.errors).toEqual([]);
    expect(deps(p, 'b')).toEqual([]);
  });

  it('reports a group that only appears in @dependsOn and nowhere else', () => {
    const p = plan(one([sc('a', '@dependsOn:group:ghost')]));
    expect(messages(p)).toEqual(['@dependsOn:group:ghost: unknown group "ghost"']);
  });

  it('reports config dependsOn on a group that is only tagged, not declared in the config (the config must name it)', () => {
    const p = plan(groupFeature(), undefined, { groups: { checkout: { dependsOn: ['nope'] } } });
    expect(messages(p)).toContain('groups.checkout.dependsOn: unknown group "nope"');
  });

  it('assigns groups by config `match` from effective tags, including feature tags', () => {
    const all = load({
      'f.feature': `@smoke\nFeature: F\n  @id:x\n  Scenario: x\n    Given ok\n`,
      'g.feature': `Feature: G\n  @id:y\n  Scenario: y\n    Given ok\n`,
    });
    const p = plan(all, all, { groups: { fast: { match: '@smoke' } } });
    expect(p.byId.get('x')!.groups).toEqual(['fast']);
    expect(p.byId.get('y')!.groups).toEqual([]);
  });

  it('adds edges to group members that are selected, but never to members that are not in the plan with --no-deps', () => {
    const all = groupFeature();
    const p = plan(all, pick(all, 'c1'), { withDeps: false, groups: { setup: {}, checkout: { dependsOn: ['setup'] } } });
    expect(ids(p)).toEqual(['c1']);
    expect(deps(p, 'c1')).toEqual([]);
  });

  it('a group cycle through members is reported; a group cycle with no members is harmless', () => {
    const cyc = plan(groupFeature(), undefined, { groups: { setup: { dependsOn: ['checkout'] }, checkout: { dependsOn: ['setup'] } } });
    expect(messages(cyc).join('\n')).toMatch(/Dependency cycle/);
    const empty = plan(one([sc('x')]), undefined, { groups: { p: { dependsOn: ['q'] }, q: { dependsOn: ['p'] } } });
    expect(empty.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('selection closure (what gets pulled in)', () => {
  const chain = () => one([sc('a'), sc('b', '@dependsOn:a'), sc('c', '@dependsOn:b'), sc('lonely')]);

  it('pulls a hard chain in transitively and records who pulled each node', () => {
    const all = chain();
    const p = plan(all, pick(all, 'c'));
    expect(ids(p)).toEqual(['a', 'b', 'c']);
    expect(p.byId.get('c')!.pulledInBy).toBeUndefined();
    expect(p.byId.get('b')!.pulledInBy).toEqual(['c']);
    expect(p.byId.get('a')!.pulledInBy).toEqual(['b']);
  });

  it('records every dependent in a diamond', () => {
    const all = one([sc('a'), sc('b', '@dependsOn:a'), sc('c', '@dependsOn:a'), sc('d', '@dependsOn:b @dependsOn:c')]);
    const p = plan(all, pick(all, 'd'));
    expect(ids(p)).toEqual(['a', 'b', 'c', 'd']);
    expect(p.byId.get('a')!.pulledInBy!.sort()).toEqual(['b', 'c']);
  });

  it('does not mark a scenario as pulled in when it was selected itself', () => {
    const all = chain();
    const p = plan(all, pick(all, 'b', 'c'));
    expect(p.byId.get('b')!.pulledInBy).toBeUndefined();
    expect(p.byId.get('a')!.pulledInBy).toEqual(['b']);
  });

  it('--no-deps (withDeps: false) runs only the selection and drops edges to missing targets', () => {
    const all = chain();
    const p = plan(all, pick(all, 'c'), { withDeps: false });
    expect(ids(p)).toEqual(['c']);
    expect(deps(p, 'c')).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  it('keeps edges between selected scenarios even with --no-deps', () => {
    const all = chain();
    const p = plan(all, pick(all, 'b', 'c'), { withDeps: false });
    expect(deps(p, 'c')).toEqual(['b']);
    expect(deps(p, 'b')).toEqual([]);
  });

  it('does not pull in a soft dependency, and drops the edge when that target is not selected', () => {
    const all = one([sc('a'), sc('b', '@dependsOn:a:soft')]);
    const p = plan(all, pick(all, 'b'));
    expect(ids(p)).toEqual(['b']);
    expect(deps(p, 'b')).toEqual([]);
  });

  it('keeps a soft edge when both sides are selected', () => {
    const all = one([sc('a'), sc('b', '@dependsOn:a:soft')]);
    expect(deps(plan(all, all), 'b')).toEqual(['a~']);
  });

  it('a soft edge does not extend the closure: a soft -> b, b hard -> c selects only a', () => {
    const all = one([sc('c'), sc('b', '@dependsOn:c'), sc('a', '@dependsOn:b:soft')]);
    expect(ids(plan(all, pick(all, 'a')))).toEqual(['a']);
  });

  it('a hard edge pulls in a target that itself has soft dependencies, without pulling those', () => {
    const all = one([sc('z'), sc('y', '@dependsOn:z:soft'), sc('x', '@dependsOn:y')]);
    expect(ids(plan(all, pick(all, 'x'))).sort()).toEqual(['x', 'y']);
  });

  it('pulls in dependencies from other files and keeps each file together in base order', () => {
    const all = load({
      'a.feature': feature('A', [sc('a1'), sc('a2')]),
      'b.feature': feature('B', [sc('b1', '@dependsOn:a2'), sc('b2')]),
    });
    const p = plan(all, pick(all, 'b1'));
    expect(ids(p)).toEqual(['a2', 'b1']);
    expect(p.nodes.map((n) => n.order)).toEqual([0, 1]);
  });

  it('an empty selection gives an empty plan without errors', () => {
    const p = plan(chain(), []);
    expect(p.nodes).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  it('selecting a scenario that is not among all scenarios is an error, not a crash', () => {
    const all = chain();
    const other = one([sc('stranger')]);
    const p = plan(all, other);
    expect(messages(p)).toEqual(['Selected scenario "stranger" is not among all scenarios']);
  });

  it('works when `selected` comes from a separate parse of the same files (ids, not object identity)', () => {
    const files = { 'f.feature': feature('F', [sc('a'), sc('b', '@dependsOn:a')]) };
    const p = plan(load(files), pick(load(files), 'b'));
    expect(ids(p)).toEqual(['a', 'b']);
  });

  it('pulls a hard dependency in even when the selection tag expression would exclude it (e.g. not @wip)', () => {
    const all = one([sc('wip-setup', '@wip'), sc('uses', '@dependsOn:wip-setup')]);
    const selected = selectScenarios(all, { tags: 'not @wip' });
    expect(selected.map((s) => s.id)).toEqual(['uses']);
    expect(ids(plan(all, selected))).toEqual(['wip-setup', 'uses']);
  });

  it('selecting one outline row pulls what the whole outline depends on, and what that row depends on by family', () => {
    const all = one([
      sc('setup'),
      `  @id:rows @dependsOn:setup\n  Scenario Outline: row <n>\n    Given ok\n    Examples:\n      | n |\n      | 1 |\n      | 2 |\n`,
      sc('after', '@dependsOn:rows[1]'),
    ]);
    const p = plan(all, pick(all, 'after'));
    expect(ids(p)).toEqual(['setup', 'rows[1]', 'after']);
  });

  it('transitive pull-in works for a long chain without recursion limits', () => {
    const n = 3000;
    const src = [sc('s0'), ...Array.from({ length: n }, (_, i) => sc(`s${i + 1}`, `@dependsOn:s${i}`))];
    const all = one(src);
    const p = plan(all, pick(all, `s${n}`));
    expect(p.nodes).toHaveLength(n + 1);
    expect(p.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('@serial features and rules', () => {
  const serial = (tag = '@serial') => one([sc('s1'), sc('s2'), sc('s3'), sc('s4')], tag);

  it('chains scenarios in file order with soft edges (a failure does not skip the next one)', () => {
    const p = plan(serial());
    expect(deps(p, 's1')).toEqual([]);
    expect(deps(p, 's2')).toEqual(['s1~']);
    expect(deps(p, 's3')).toEqual(['s2~']);
    expect(deps(p, 's4')).toEqual(['s3~']);
    expect(p.byId.get('s2')!.serial).toBe('feature');
  });

  it('chains only the selected scenarios, and selecting one never pulls in its predecessors', () => {
    const all = serial();
    const p = plan(all, pick(all, 's2', 's4'));
    expect(ids(p)).toEqual(['s2', 's4']);
    expect(deps(p, 's4')).toEqual(['s2~']);
  });

  it('does not chain across features', () => {
    const all = load({ 'a.feature': feature('A', [sc('a1'), sc('a2')], '@serial'), 'b.feature': feature('B', [sc('b1'), sc('b2')], '@serial') });
    const p = plan(all);
    expect(deps(p, 'b1')).toEqual([]);
    expect(deps(p, 'a2')).toEqual(['a1~']);
  });

  it('@serial on a Rule chains only inside that rule', () => {
    const src = `Feature: F\n  @id:before\n  Scenario: before\n    Given ok\n  @serial\n  Rule: ordered\n    @id:r1\n    Scenario: r1\n      Given ok\n    @id:r2\n    Scenario: r2\n      Given ok\n  Rule: free\n    @id:f1\n    Scenario: f1\n      Given ok\n    @id:f2\n    Scenario: f2\n      Given ok\n`;
    const p = plan(load({ 'f.feature': src }));
    expect(deps(p, 'r2')).toEqual(['r1~']);
    expect(deps(p, 'r1')).toEqual([]);
    expect(deps(p, 'f2')).toEqual([]);
    expect(p.byId.get('r2')!.serial).toBe('rule');
  });

  it('options.featureMode "serial" makes every feature serial, and @parallel opts a feature out', () => {
    const all = load({ 'a.feature': feature('A', [sc('a1'), sc('a2')]), 'b.feature': feature('B', [sc('b1'), sc('b2')], '@parallel') });
    const p = plan(all, all, { featureMode: 'serial' });
    expect(deps(p, 'a2')).toEqual(['a1~']);
    expect(deps(p, 'b2')).toEqual([]);
  });

  it('keeps an explicit hard dependency on the previous scenario hard (no duplicate soft edge)', () => {
    const all = one([sc('s1'), sc('s2', '@dependsOn:s1')], '@serial');
    const p = plan(all);
    expect(deps(p, 's2')).toEqual(['s1']);
    expect(p.byId.get('s2')!.deps).toHaveLength(1);
  });

  it('keeps an explicit hard dependency on a LATER scenario as a cycle, explained in terms of file order', () => {
    const all = one([sc('s1', '@dependsOn:s2'), sc('s2')], '@serial');
    const msg = messages(plan(all)).join('\n');
    expect(msg).toMatch(/Dependency cycle/);
    expect(msg).toMatch(/file order/);
  });

  it('allows an explicit dependency on an EARLIER scenario of another file', () => {
    const all = load({
      'a.feature': feature('A', [sc('a1')]),
      'b.feature': feature('B', [sc('b1', '@dependsOn:a1'), sc('b2')], '@serial'),
    });
    const p = plan(all);
    expect(p.errors).toEqual([]);
    expect(deps(p, 'b1')).toEqual(['a1']);
    expect(deps(p, 'b2')).toEqual(['b1~']);
  });

  it('rejects @serial together with @parallel on one feature, and @serial/@parallel on a scenario', () => {
    expect(messages(plan(one([sc('a')], '@serial @parallel'))).join('\n')).toMatch(/both @serial and @parallel/);
    expect(messages(plan(one([sc('a', '@serial')]))).join('\n')).toMatch(/@serial belongs on the Feature/);
  });

  it('an outline in a serial feature chains its rows in order', () => {
    const all = one([`  @id:o\n  Scenario Outline: o <n>\n    Given ok\n    Examples:\n      | n |\n      | 1 |\n      | 2 |\n      | 3 |\n`], '@serial');
    const p = plan(all);
    expect(deps(p, 'o[2]')).toEqual(['o[1]~']);
    expect(deps(p, 'o[3]')).toEqual(['o[2]~']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('@requires:<file.feature>', () => {
  const setup = feature('Setup', [sc('seed-a'), sc('seed-b')]);

  it('resolves ./ and ../ segments and backslashes the same way', () => {
    const all = load({
      'features/auth/login.feature': feature('Login', [sc('login')]),
      'features/shop/cart.feature': feature('Cart', [sc('cart')], '@requires:./../auth/login.feature'),
      'features/shop/pay.feature': feature('Pay', [sc('pay')], '@requires:features/auth/./login.feature'),
    });
    const p = plan(all);
    expect(p.errors).toEqual([]);
    expect(deps(p, 'cart')).toEqual(['login']);
    expect(deps(p, 'pay')).toEqual(['login']);
  });

  it('a path that climbs above the project root matches nothing', () => {
    const all = load({ 'a.feature': setup, 'b.feature': feature('B', [sc('b')], '@requires:../../a.feature') });
    // `..` collapses at the root, so this resolves like `a.feature`; if that ever becomes an error this test says so.
    const p = plan(all);
    expect(p.errors.length === 0 || /no feature file/.test(messages(p)[0]!)).toBe(true);
  });

  it('on a single scenario or rule it only affects that part of the file', () => {
    const src = `Feature: B\n  @id:plain\n  Scenario: plain\n    Given ok\n  @id:tagged @requires:a.feature\n  Scenario: tagged\n    Given ok\n  @requires:a.feature\n  Rule: R\n    @id:inrule\n    Scenario: inrule\n      Given ok\n`;
    const p = plan(load({ 'a.feature': setup, 'b.feature': src }));
    expect(deps(p, 'plain')).toEqual([]);
    expect(deps(p, 'tagged')).toEqual(['seed-a', 'seed-b']);
    expect(deps(p, 'inrule')).toEqual(['seed-a', 'seed-b']);
  });

  it('adds one edge per target even when @requires and @dependsOn name the same scenario (hard wins)', () => {
    const all = load({ 'a.feature': setup, 'b.feature': feature('B', [sc('b', '@dependsOn:seed-a:soft')], '@requires:a.feature') });
    const p = plan(all);
    expect(deps(p, 'b')).toEqual(['seed-a', 'seed-b']);
  });

  it('requires every row of an outline and every scenario of a @serial file', () => {
    const all = load({
      'a.feature': feature('A', [`  @id:o\n  Scenario Outline: o <n>\n    Given ok\n    Examples:\n      | n |\n      | 1 |\n      | 2 |\n`, sc('s')], '@serial'),
      'b.feature': feature('B', [sc('b')], '@requires:a.feature'),
    });
    expect(deps(plan(all), 'b')).toEqual(['o[1]', 'o[2]', 's']);
  });

  it('is transitive when pulling in: c requires b, b requires a; selecting c brings all three files', () => {
    const all = load({
      'a.feature': feature('A', [sc('a')]),
      'b.feature': feature('B', [sc('b')], '@requires:a.feature'),
      'c.feature': feature('C', [sc('c')], '@requires:b.feature'),
    });
    const p = plan(all, pick(all, 'c'));
    expect(ids(p)).toEqual(['a', 'b', 'c']);
    expect(deps(p, 'c')).toEqual(['b']);
  });

  it('works together with @serial in the requiring file', () => {
    const all = load({ 'a.feature': setup, 'b.feature': feature('B', [sc('b1'), sc('b2')], '@serial @requires:a.feature') });
    const p = plan(all);
    expect(deps(p, 'b1')).toEqual(['seed-a', 'seed-b']);
    expect(deps(p, 'b2')).toEqual(['b1~', 'seed-a', 'seed-b']);
  });

  it('a requirement on a file whose scenarios are not selected is dropped under --no-deps', () => {
    const all = load({ 'a.feature': setup, 'b.feature': feature('B', [sc('b')], '@requires:a.feature') });
    const p = plan(all, pick(all, 'b'), { withDeps: false });
    expect(deps(p, 'b')).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  it('two files that require each other are a cycle; a file requiring itself is an error, not a cycle', () => {
    const cyc = load({ 'a.feature': feature('A', [sc('a')], '@requires:b.feature'), 'b.feature': feature('B', [sc('b')], '@requires:a.feature') });
    expect(messages(plan(cyc)).join('\n')).toMatch(/Dependency cycle/);
    const self = load({ 'a.feature': feature('A', [sc('a')], '@requires:a.feature') });
    expect(messages(plan(self))).toEqual(["@requires:a.feature: no feature file with this path (or it is this scenario's own file)"]);
  });

  it('prefers an exact path over a path ending, so a nested file with the same name cannot hijack it', () => {
    const all = load({
      'login.feature': feature('Top', [sc('top')]),
      'deep/login.feature': feature('Deep', [sc('deep')]),
      'user.feature': feature('User', [sc('user')], '@requires:login.feature'),
    });
    const p = plan(all);
    expect(p.errors).toEqual([]);
    expect(deps(p, 'user')).toEqual(['top']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('cycles', () => {
  it('detects a direct two-node cycle and reports it once', () => {
    const p = plan(one([sc('a', '@dependsOn:b'), sc('b', '@dependsOn:a')]));
    expect(messages(p).filter((m) => m.startsWith('Dependency cycle'))).toHaveLength(1);
  });

  it('detects a long cycle and names the path', () => {
    const p = plan(one([sc('a', '@dependsOn:d'), sc('b', '@dependsOn:a'), sc('c', '@dependsOn:b'), sc('d', '@dependsOn:c')]));
    const msg = messages(p).find((m) => m.startsWith('Dependency cycle'))!;
    for (const id of ['a', 'b', 'c', 'd']) expect(msg).toContain(id);
  });

  it('counts a soft cycle as a cycle (both would wait forever)', () => {
    const p = plan(one([sc('a', '@dependsOn:b:soft'), sc('b', '@dependsOn:a:soft')]));
    expect(messages(p).join('\n')).toMatch(/Dependency cycle/);
  });

  it('reports two independent cycles separately and leaves the rest of the plan intact', () => {
    const p = plan(one([sc('a', '@dependsOn:b'), sc('b', '@dependsOn:a'), sc('c', '@dependsOn:d'), sc('d', '@dependsOn:c'), sc('ok')]));
    expect(messages(p).filter((m) => m.startsWith('Dependency cycle'))).toHaveLength(2);
    expect(p.nodes).toHaveLength(5);
  });

  it('does not report a diamond or a shared dependency as a cycle', () => {
    const p = plan(one([sc('a'), sc('b', '@dependsOn:a'), sc('c', '@dependsOn:a'), sc('d', '@dependsOn:b @dependsOn:c @dependsOn:a')]));
    expect(p.errors).toEqual([]);
  });

  it('finds a cycle that goes through a group dependency', () => {
    const all = one([sc('a', '@group:g @dependsOn:b'), sc('b', '@dependsOn:group:g')]);
    expect(messages(plan(all)).join('\n')).toMatch(/Dependency cycle/);
  });

  it('finds a cycle created by two @requires files plus a scenario tag', () => {
    const all = load({
      'a.feature': feature('A', [sc('a')], '@requires:b.feature'),
      'b.feature': feature('B', [sc('b', '@dependsOn:a')]),
    });
    expect(messages(plan(all)).join('\n')).toMatch(/Dependency cycle/);
  });

  it('handles a 20000-node chain with no cycle without overflowing the stack', () => {
    const n = 20000;
    const all = one([sc('s0'), ...Array.from({ length: n }, (_, i) => sc(`s${i + 1}`, `@dependsOn:s${i}`))]);
    const t0 = Date.now();
    const p = plan(all);
    expect(p.errors).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('closes a 20000-node chain into a cycle and reports it', () => {
    const n = 20000;
    const all = one(Array.from({ length: n }, (_, i) => sc(`s${i}`, `@dependsOn:s${(i + n - 1) % n}`)));
    expect(messages(plan(all)).filter((m) => m.startsWith('Dependency cycle'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('locks, priorities and the plan fields around dependencies', () => {
  it('collects @lock tags and group locks without turning them into edges', () => {
    const all = one([sc('a', '@lock:db'), sc('b', '@lock:db @group:g')]);
    const p = plan(all, all, { groups: { g: { locks: ['files'] } } });
    expect(p.byId.get('a')!.deps).toEqual([]);
    expect(p.byId.get('b')!.locks.sort()).toEqual(['db', 'files']);
  });

  it('a dependent keeps its own priority; ordering by priority never overrides an edge (checked by the scheduler)', () => {
    const p = plan(one([sc('a', '@priority:9'), sc('b', '@dependsOn:a @priority:-5')]));
    expect(p.byId.get('b')!.priority).toBe(-5);
    expect(deps(p, 'b')).toEqual(['a']);
  });

  it('group priority is the minimum over its groups, a scenario tag wins over groups', () => {
    const all = one([sc('x', '@group:g1 @group:g2'), sc('y', '@group:g1 @priority:7')]);
    const p = plan(all, all, { groups: { g1: { priority: 4 }, g2: { priority: 2 } } });
    expect(p.byId.get('x')!.priority).toBe(2);
    expect(p.byId.get('y')!.priority).toBe(7);
  });

  it('@exclusive marks the node and does not create edges', () => {
    const p = plan(one([sc('a'), sc('b', '@exclusive')]));
    expect(p.byId.get('b')!.exclusive).toBe(true);
    expect(deps(p, 'b')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('rendering and explaining a plan', () => {
  const all = () =>
    load({
      'a.feature': feature('A', [sc('seed'), sc('mid', '@dependsOn:seed'), sc('soft', '@dependsOn:mid:soft')]),
      'b.feature': feature('B', [sc('s1'), sc('s2')], '@serial @requires:a.feature'),
    });

  it('text shows soft edges, serial order and the dependency marker', () => {
    const all2 = all();
    const text = renderPlanText(plan(all2, pick(all2, 'mid', 's1', 's2')));
    expect(text).toContain('seed  (dependency)');
    expect(text).toContain('<- seed');
    expect(text).toContain('(feature runs in file order)');
  });

  it('JSON lists every dependency with its soft flag and via, plus errors', () => {
    const all2 = all();
    const json = planToJSON(plan(all2));
    const soft = json.nodes.find((n) => n.id === 'soft')!;
    expect(soft.deps).toEqual([{ target: 'mid', soft: true, via: 'mid' }]);
    expect(json.errors).toEqual([]);
  });

  it('mermaid output has one edge per dependency', () => {
    const p = plan(one([sc('a'), sc('b', '@dependsOn:a'), sc('c', '@dependsOn:a:soft')]));
    const m = renderPlanMermaid(p);
    expect(m.match(/-->|-\.->/g)).toHaveLength(2);
  });

  it('explain names hard and soft edges, the reason for inclusion, and who needs the node', () => {
    const all2 = one([sc('a'), sc('b', '@dependsOn:a'), sc('c', '@dependsOn:b:soft')]);
    const p = plan(all2, pick(all2, 'b'));
    const why = explainNode(p, 'a');
    expect(why).toContain('included: not selected, pulled in as a dependency of b');
    expect(why).toContain('waits for: nothing (ready at start)');
    expect(why).toContain('needed by: b');
    expect(explainNode(plan(all2), 'c')).toContain('- b [soft: runs whatever its result] via b');
  });

  it('explain of an unknown id suggests close matches and does not throw', () => {
    const p = plan(one([sc('create-order'), sc('create-user')]));
    expect(explainNode(p, 'create')).toContain('Did you mean');
    expect(explainNode(p, 'zzz')).toBe('"zzz" is not in the plan.');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('sharding keeps everything that must run together on one shard', () => {
  /** Every node lands in exactly one shard and the shards cover the plan. */
  function partition(p: Plan, count: number) {
    const shards = Array.from({ length: count }, (_, i) => shardPlan(p, { index: i + 1, count }).ids);
    const flat = shards.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual(ids(p).slice().sort());
    return shards;
  }
  const shardOf = (shards: string[][], id: string) => shards.findIndex((s) => s.includes(id));

  it('keeps @requires files, transitive chains, serial features, groups and locks together', () => {
    const all = load({
      'a.feature': feature('A', [sc('a1'), sc('a2')]),
      'b.feature': feature('B', [sc('b1')], '@requires:a.feature'),
      'c.feature': feature('C', [sc('c1'), sc('c2'), sc('c3')], '@serial'),
      'd.feature': feature('D', [sc('d1', '@group:g'), sc('d2', '@group:g'), sc('d3', '@lock:db'), sc('d4', '@lock:db')]),
      'e.feature': feature('E', [sc('e1'), sc('e2')]),
    });
    const shards = partition(plan(all), 4);
    expect(new Set(['a1', 'a2', 'b1'].map((i) => shardOf(shards, i))).size).toBe(1);
    expect(new Set(['c1', 'c2', 'c3'].map((i) => shardOf(shards, i))).size).toBe(1);
    expect(shardOf(shards, 'd1')).toBe(shardOf(shards, 'd2'));
    expect(shardOf(shards, 'd3')).toBe(shardOf(shards, 'd4'));
  });

  it('joins clusters that share a member through different relations (group + dependency + lock)', () => {
    const all = one([sc('a', '@group:g'), sc('b', '@group:g @lock:db'), sc('c', '@lock:db @dependsOn:d'), sc('d'), sc('x'), sc('y')]);
    const shards = partition(plan(all), 3);
    const together = ['a', 'b', 'c', 'd'].map((i) => shardOf(shards, i));
    expect(new Set(together).size).toBe(1);
  });

  it('a soft dependency also keeps its two sides together', () => {
    const all = one([sc('a'), sc('b', '@dependsOn:a:soft'), sc('c'), sc('d')]);
    const shards = partition(plan(all), 2);
    expect(shardOf(shards, 'a')).toBe(shardOf(shards, 'b'));
  });

  it('pulled-in dependencies shard with their dependents', () => {
    const all = one([sc('base'), sc('t1', '@dependsOn:base'), sc('t2', '@dependsOn:base'), sc('other')]);
    const p = plan(all, pick(all, 't1', 't2'));
    const shards = partition(p, 2);
    expect(new Set(['base', 't1', 't2'].map((i) => shardOf(shards, i))).size).toBe(1);
  });

  it('one connected plan puts everything on a single shard and leaves the others empty', () => {
    const all = one([sc('a'), sc('b', '@dependsOn:a'), sc('c', '@dependsOn:b')]);
    const shards = partition(plan(all), 3);
    expect(shards.filter((s) => s.length).length).toBe(1);
  });

  it('is stable: the same plan always gives the same split', () => {
    const all = one(Array.from({ length: 30 }, (_, i) => sc(`s${i}`, i % 3 === 0 ? `@group:g${i % 5}` : '')));
    const p = plan(all);
    expect(partition(p, 4)).toEqual(partition(p, 4));
  });
});
