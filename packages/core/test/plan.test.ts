import { describe, expect, it } from 'vitest';
import { buildPlan, explainNode, parseSpec, planToJSON, renderPlanMermaid, renderPlanText, selectScenarios } from '@bddr/core';

const SHOP = `Feature: Shop
  @id:login @group:setup
  Scenario: log in
    Given ok

  @id:create-order @dependsOn:login
  Scenario: create order
    Given ok

  @dependsOn:create-order @lock:payments-db @priority:2
  Scenario: pay
    Given ok

  @dependsOn:create-order:soft @group:reports
  Scenario: report
    Given ok

  @id:rows @group:checkout
  Scenario Outline: row <n>
    Given ok
    Examples:
      | n |
      | 1 |
      | 2 |

  @dependsOn:rows @dependsOn:group:setup @exclusive
  Scenario: after rows
    Given ok
`;

const all = () => parseSpec(SHOP, 'shop.feature').scenarios;

describe('buildPlan', () => {
  it('resolves scenario, outline-family and group dependencies with hard/soft flags', () => {
    const plan = buildPlan(all(), all(), { groups: { checkout: { mode: 'serial', workers: 1, priority: 5 } } });
    expect(plan.errors).toEqual([]);
    const deps = (id: string) => plan.byId.get(id)!.deps.map((d) => `${d.target}${d.soft ? '~' : ''}`);
    expect(deps('create-order')).toEqual(['login']);
    expect(deps('shop.feature::report')).toEqual(['create-order~']);
    expect(deps('shop.feature::after-rows')).toEqual(['rows[1]', 'rows[2]', 'login']);
    const pay = plan.byId.get('shop.feature::pay')!;
    expect(pay).toMatchObject({ locks: ['payments-db'], priority: 2 });
    expect(plan.byId.get('rows[1]')!.priority).toBe(5); // group priority
    expect(plan.byId.get('shop.feature::after-rows')!.exclusive).toBe(true);
    expect(plan.groups.get('checkout')).toMatchObject({ mode: 'serial', members: ['rows[1]', 'rows[2]'], configured: true });
    expect(plan.groups.get('setup')).toMatchObject({ configured: false, members: ['login'] });
  });

  it('pulls in hard dependencies of selected scenarios (withDeps) but not soft ones', () => {
    const selected = selectScenarios(all(), { name: '^(pay|report)$' });
    const plan = buildPlan(all(), selected, {});
    expect(plan.nodes.map((n) => n.id)).toEqual(['login', 'create-order', 'shop.feature::pay', 'shop.feature::report']);
    expect(plan.byId.get('login')!.pulledInBy).toEqual(['create-order']);
    expect(plan.byId.get('create-order')!.pulledInBy).toEqual(['shop.feature::pay']);
    const noDeps = buildPlan(all(), selected, { withDeps: false });
    expect(noDeps.nodes.map((n) => n.id)).toEqual(['shop.feature::pay', 'shop.feature::report']);
    expect(noDeps.byId.get('shop.feature::pay')!.deps).toEqual([]); // target not in plan
  });

  it('applies config groups: match, dependsOn, locks, onDependencyFailure', () => {
    const src = `Feature: G
  @smoke
  Scenario: a
    Given ok
  @api
  Scenario: b
    Given ok
`;
    const s = parseSpec(src, 'g.feature').scenarios;
    const plan = buildPlan(s, s, {
      groups: {
        smoke: { match: '@smoke', mode: 'serial', timeout: '2s' },
        api: { match: '@api', dependsOn: ['smoke'], onDependencyFailure: 'run', locks: ['env'] },
      },
    });
    expect(plan.errors).toEqual([]);
    expect(plan.byId.get('g.feature::b')!).toMatchObject({ groups: ['api'], locks: ['env'] });
    expect(plan.byId.get('g.feature::b')!.deps).toEqual([{ target: 'g.feature::a', soft: true, via: 'group-config:api->smoke' }]);
    expect(plan.groups.get('smoke')!.timeoutMs).toBe(2000);
    expect(renderPlanText(plan)).toContain('timeout 2000ms');
  });

  it('validates group time budgets', () => {
    const s = all();
    expect(buildPlan(s, s, { groups: { setup: { timeout: 'soon' } } }).errors.map((e) => e.message)).toEqual([
      'groups.setup.timeout: "soon" is not a duration (use e.g. 500ms, 2s, 1m)',
    ]);
  });

  it('reports unknown targets, unknown groups, bad priority, bad workers and cycles', () => {
    const src = `Feature: Bad
  @id:a @dependsOn:c
  Scenario: a
    Given ok
  @id:b @dependsOn:a
  Scenario: b
    Given ok
  @id:c @dependsOn:b @dependsOn:nope @dependsOn:group:ghost @priority:high
  Scenario: c
    Given ok
`;
    const s = parseSpec(src, 'bad.feature').scenarios;
    const plan = buildPlan(s, s, { workers: 0, groups: { x: { dependsOn: ['y'], workers: -1 } } });
    expect(plan.errors.map((e) => e.message)).toEqual([
      '@priority:high is not a number',
      'groups.x.dependsOn: unknown group "y"',
      'groups.x.workers must be a positive integer',
      '@dependsOn:nope: no scenario has this id (use @id:<name> on the target)',
      '@dependsOn:group:ghost: unknown group "ghost"',
      'Dependency cycle: a -> c -> b -> a',
      'workers must be a positive integer (got 0)',
    ]);
  });

  it('renders text, mermaid, JSON and explanations', () => {
    const plan = buildPlan(all(), selectScenarios(all(), { name: '^pay$' }), { workers: 2 });
    expect(renderPlanText(plan)).toContain('Plan: 3 scenario(s), 1 group(s), workers=2');
    expect(renderPlanText(plan)).toContain('<- create-order');
    expect(renderPlanMermaid(plan)).toContain('subgraph setup["setup (parallel)"]');
    expect(renderPlanMermaid(plan)).toContain('n1 --> n2');
    expect(planToJSON(plan).nodes[0]).toMatchObject({ id: 'login', pulledInBy: ['create-order'] });
    const why = explainNode(plan, 'shop.feature::pay');
    expect(why).toContain('included: selected');
    expect(why).toContain('- create-order [hard: skipped if it does not pass] via create-order');
    expect(why).toContain('locks: payments-db');
    expect(explainNode(plan, 'create')).toContain('Did you mean:\n  create-order');
  });
});

describe('defaultMode', () => {
  const src = `Feature: D
  Scenario: a
    Given ok
  Scenario: b
    Given ok
  @group:g
  Scenario: c
    Given ok
`;
  it('puts ungrouped scenarios in an implicit default group with that mode', () => {
    const s = parseSpec(src, 'd.feature').scenarios;
    const plan = buildPlan(s, s, { defaultMode: 'serial' });
    expect(plan.groups.get('default')).toMatchObject({ mode: 'serial', implicit: true, members: ['d.feature::a', 'd.feature::b'] });
    expect(plan.byId.get('d.feature::c')!.groups).toEqual(['g']);
    expect(renderPlanText(plan)).toContain('group default (ungrouped scenarios): serial');
  });
  it('a configured groups.default is a normal group and also collects ungrouped scenarios', () => {
    const s = parseSpec(src, 'd.feature').scenarios;
    const plan = buildPlan(s, s, { groups: { default: { mode: 'parallel', workers: 2 } } });
    expect(plan.groups.get('default')).toMatchObject({ workers: 2, configured: true });
    expect(plan.groups.get('default')!.implicit).toBeUndefined();
  });
  it('without defaultMode ungrouped scenarios have no group', () => {
    const s = parseSpec(src, 'd.feature').scenarios;
    expect(buildPlan(s, s, {}).byId.get('d.feature::a')!.groups).toEqual([]);
  });
});

describe('@requires:<file.feature>', () => {
  const files = (map: Record<string, string>) => Object.entries(map).flatMap(([uri, src]) => {
    const spec = parseSpec(src, uri);
    expect(spec.errors).toEqual([]);
    return spec.scenarios;
  });
  const SETUP = `Feature: Setup
  Scenario: seed users
    Given ok
  Scenario: seed products
    Given ok
`;

  it('makes every scenario of the tagged feature wait for every scenario of the required file', () => {
    const all = files({
      'features/setup.feature': SETUP,
      'features/orders.feature': `@requires:setup.feature\nFeature: Orders\n  Scenario: place\n    Given ok\n  Scenario: cancel\n    Given ok\n`,
    });
    const plan = buildPlan(all, all);
    expect(plan.errors).toEqual([]);
    for (const name of ['place', 'cancel']) {
      const node = plan.nodes.find((n) => n.scenario.name === name)!;
      expect(node.deps.map((d) => d.target).sort()).toEqual(plan.nodes.filter((n) => n.scenario.uri === 'features/setup.feature').map((n) => n.id).sort());
      expect(node.deps.every((d) => !d.soft && d.via === 'requires:setup.feature')).toBe(true);
    }
    expect(plan.nodes.find((n) => n.scenario.name === 'seed users')!.deps).toEqual([]);
  });

  it('pulls the required file in when only the dependent scenario is selected, unless --no-deps', () => {
    const all = files({
      'features/setup.feature': SETUP,
      'features/orders.feature': `Feature: Orders\n  @requires:setup.feature\n  Scenario: place\n    Given ok\n  Scenario: other\n    Given ok\n`,
    });
    const place = all.filter((s) => s.name === 'place');
    const withDeps = buildPlan(all, place);
    expect(withDeps.nodes.map((n) => n.scenario.name).sort()).toEqual(['place', 'seed products', 'seed users']);
    expect(withDeps.nodes.find((n) => n.scenario.name === 'seed users')!.pulledInBy).toEqual([place[0]!.id]);
    expect(buildPlan(all, place, { withDeps: false }).nodes.map((n) => n.scenario.name)).toEqual(['place']);
  });

  it('resolves the path relative to the requiring file, then the project root, then a unique path ending', () => {
    const all = files({
      'features/auth/login.feature': 'Feature: Login\n  Scenario: l\n    Given ok\n',
      'features/shop/cart.feature': '@requires:../auth/login.feature\nFeature: Cart\n  Scenario: c\n    Given ok\n',
      'features/shop/pay.feature': '@requires:features/auth/login.feature\nFeature: Pay\n  Scenario: p\n    Given ok\n',
      'features/shop/ship.feature': '@requires:login.feature\nFeature: Ship\n  Scenario: s\n    Given ok\n',
    });
    const plan = buildPlan(all, all);
    expect(plan.errors).toEqual([]);
    const login = plan.nodes.find((n) => n.scenario.name === 'l')!.id;
    for (const name of ['c', 'p', 's']) expect(plan.nodes.find((n) => n.scenario.name === name)!.deps.map((d) => d.target)).toEqual([login]);
  });

  it('supports :soft', () => {
    const all = files({
      'a.feature': 'Feature: A\n  Scenario: a\n    Given ok\n',
      'b.feature': '@requires:a.feature:soft\nFeature: B\n  Scenario: b\n    Given ok\n',
    });
    const plan = buildPlan(all, all);
    expect(plan.nodes.find((n) => n.scenario.name === 'b')!.deps).toMatchObject([{ soft: true }]);
  });

  it('reports a missing file, an ambiguous path ending and a file that requires itself', () => {
    const all = files({
      'x/dup.feature': 'Feature: D1\n  Scenario: d1\n    Given ok\n',
      'y/dup.feature': 'Feature: D2\n  Scenario: d2\n    Given ok\n',
      'z/user.feature': '@requires:nope.feature\nFeature: U\n  Scenario: u\n    Given ok\n',
      'z/amb.feature': '@requires:dup.feature\nFeature: M\n  Scenario: m\n    Given ok\n',
      'z/self.feature': '@requires:self.feature\nFeature: S\n  Scenario: s\n    Given ok\n',
    });
    const messages = buildPlan(all, all).errors.map((e) => e.message);
    expect(messages).toContainEqual(expect.stringContaining('@requires:nope.feature: no feature file'));
    expect(messages).toContainEqual(expect.stringContaining('@requires:dup.feature: matches several feature files (x/dup.feature, y/dup.feature)'));
    expect(messages).toContainEqual(expect.stringContaining('@requires:self.feature: no feature file'));
  });
});

describe('@requires cycles', () => {
  it('reports two files that require each other', () => {
    const all = [
      ...parseSpec('@requires:b.feature\nFeature: A\n  Scenario: a\n    Given ok\n', 'a.feature').scenarios,
      ...parseSpec('@requires:a.feature\nFeature: B\n  Scenario: b\n    Given ok\n', 'b.feature').scenarios,
    ];
    expect(buildPlan(all, all).errors.map((e) => e.message).join('\n')).toMatch(/cycle/i);
  });
});
