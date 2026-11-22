import { describe, expect, it } from 'vitest';
import { parseSpec, parseTag, selectScenarios, parsePathWithLines, worstStatus, EventBus } from '@bddr/core';

const FEATURE = `@shop
Feature: Basket
  Customers can add items.

  Background:
    Given an empty basket

  @smoke @id:add-one
  Scenario: Add one item
    When I add 1 "apple"
    Then the basket has 1 item

  Scenario Outline: Add many
    When I add <n> "<item>"
    Then the basket has <n> items

    @fast
    Examples: small
      | n | item  |
      | 2 | pear  |
      | 3 | plum  |

    Examples: large
      | n  | item |
      | 50 | fig  |

  @owner:payments
  Rule: Discounts
    Background:
      Given a discount code "TEN"

    Scenario: Apply code
      When I apply the code
      Then I pay 10% less
        | before | after |
        | 100    | 90    |
`;

describe('parseSpec', () => {
  const spec = parseSpec(FEATURE, 'features/basket.feature');

  it('expands outlines into one instance per example row', () => {
    expect(spec.errors).toEqual([]);
    expect(spec.scenarios.map((s) => s.name)).toEqual([
      'Add one item',
      'Add many',
      'Add many',
      'Add many',
      'Apply code',
    ]);
    const rows = spec.scenarios.filter((s) => s.example);
    expect(rows.map((s) => s.example!.index)).toEqual([1, 2, 3]);
    expect(rows[2]!.example!.values).toEqual({ n: '50', item: 'fig' });
    expect(rows[0]!.steps[1]!.text).toBe('I add 2 "pear"');
  });

  it('assigns stable ids, honouring @id tags', () => {
    expect(spec.scenarios.map((s) => s.id)).toEqual([
      'add-one',
      'features/basket.feature::add-many[1]',
      'features/basket.feature::add-many[2]',
      'features/basket.feature::add-many[3]',
      'features/basket.feature::apply-code',
    ]);
  });

  it('inherits feature, rule and examples tags', () => {
    const [one, small1, , large] = spec.scenarios;
    expect(one!.tags.map((t) => t.name)).toEqual(['@shop', '@smoke', '@id:add-one']);
    expect(small1!.tags.map((t) => t.name)).toEqual(['@shop', '@fast']);
    expect(large!.tags.map((t) => t.name)).toEqual(['@shop']);
    const rule = spec.scenarios[4]!;
    expect(rule.rule?.name).toBe('Discounts');
    expect(rule.meta).toMatchObject({ shop: 'true', owner: 'payments' });
  });

  it('includes background steps with fromBackground and resolves keyword types', () => {
    const rule = spec.scenarios[4]!;
    expect(rule.steps.map((s) => [s.text, s.fromBackground, s.keywordType])).toEqual([
      ['an empty basket', true, 'context'],
      ['a discount code "TEN"', true, 'context'],
      ['I apply the code', false, 'action'],
      ['I pay 10% less', false, 'outcome'],
    ]);
    expect(rule.steps[3]!.argument).toEqual({ kind: 'dataTable', rows: [['before', 'after'], ['100', '90']] });
  });

  it('records lines for scenarios, rows and steps', () => {
    expect(spec.scenarios[0]!.line).toBe(9);
    expect(spec.scenarios[0]!.steps[1]!.line).toBe(10);
    expect(spec.scenarios[1]!.line).toBe(20); // example row line
  });

  it('returns syntax errors with line numbers instead of throwing', () => {
    const bad = parseSpec('Feature: x\n  Scenario: y\n    Given a\n  oops not gherkin\n', 'bad.feature');
    expect(bad.scenarios).toEqual([]);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.errors[0]!.line).toBe(4);
  });

  it('parses Markdown-with-Gherkin (.md) specs', () => {
    const md = parseSpec('# Feature: Docs\n\n## Scenario: Read\n\n* Given a doc\n* Then it reads well\n', 'docs/read.feature.md');
    expect(md.errors).toEqual([]);
    expect(md.scenarios.map((s) => s.steps.map((x) => x.text))).toEqual([['a doc', 'it reads well']]);
  });
});

describe('tags and selection', () => {
  it('splits key/value tags', () => {
    expect(parseTag('@smoke')).toEqual({ name: '@smoke', key: 'smoke' });
    expect(parseTag('@owner=payments')).toMatchObject({ key: 'owner', value: 'payments' });
    expect(parseTag('@data:users.csv#Admins')).toMatchObject({ key: 'data', value: 'users.csv#Admins' });
  });

  it('selects by tag expression, name and line', () => {
    const spec = parseSpec(FEATURE, 'f.feature');
    expect(selectScenarios(spec.scenarios, { tags: '@fast or @smoke' }).map((s) => s.id)).toEqual([
      'add-one',
      'f.feature::add-many[1]',
      'f.feature::add-many[2]',
    ]);
    expect(selectScenarios(spec.scenarios, { name: '^Apply' })).toHaveLength(1);
    expect(selectScenarios(spec.scenarios, { lines: { 'f.feature': [25] } }).map((s) => s.id)).toEqual([
      'f.feature::add-many[3]',
    ]);
    expect(() => selectScenarios(spec.scenarios, { tags: '@a and' })).toThrow(/Invalid tag expression/);
  });

  it('parses path:line arguments', () => {
    expect(parsePathWithLines('a/b.feature:12:30')).toEqual({ path: 'a/b.feature', lines: [12, 30] });
    expect(parsePathWithLines('a/b.feature')).toEqual({ path: 'a/b.feature', lines: [] });
  });
});

describe('status and events', () => {
  it('folds statuses worst-first', () => {
    expect(worstStatus(['passed', 'skipped'])).toBe('skipped');
    expect(worstStatus(['passed', 'undefined', 'failed'])).toBe('failed');
    expect(worstStatus([])).toBe('passed');
  });

  it('event bus keeps order, timestamps and survives failing listeners', async () => {
    const bus = new EventBus({ keepHistory: true });
    const seen: string[] = [];
    bus.on((e) => {
      seen.push(e.type);
    });
    bus.on(() => {
      throw new Error('listener boom');
    });
    bus.emit({ type: 'log', message: 'hi' });
    const errors = await bus.flush();
    expect(seen).toEqual(['log']);
    expect(bus.history![0]!.ts).toBeTypeOf('number');
    expect(errors).toHaveLength(1);
  });
});
