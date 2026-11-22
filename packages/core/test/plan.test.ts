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
