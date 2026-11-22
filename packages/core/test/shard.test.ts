import { describe, expect, it } from 'vitest';
import { buildPlan, parseShard, parseSpec, shardPlan } from '@bddr/core';

const SRC = `Feature: Shards
  @id:a
  Scenario: a
    Given ok
  @id:b @dependsOn:a
  Scenario: b
    Given ok
  @id:c @group:g
  Scenario: c
    Given ok
  @id:d @group:g
  Scenario: d
    Given ok
  @id:e @lock:db
  Scenario: e
    Given ok
  @id:f @lock:db
  Scenario: f
    Given ok
  @id:g
  Scenario: g
    Given ok
  @id:h
  Scenario: h
    Given ok
`;

function plan() {
  const spec = parseSpec(SRC, 's.feature');
  return buildPlan(spec.scenarios, spec.scenarios, {});
}
const idOf = (p: ReturnType<typeof plan>, short: string) => p.nodes.find((n) => n.scenario.name === short)!.id;

describe('parseShard', () => {
  it('parses i/n and rejects nonsense', () => {
    expect(parseShard('2/4')).toEqual({ index: 2, count: 4 });
    for (const bad of ['0/3', '4/3', '1', 'a/b', '1/0', '']) expect(() => parseShard(bad)).toThrow(/--shard expects/);
  });
});

describe('shardPlan', () => {
  it('shards are disjoint and together cover every scenario', () => {
    const p = plan();
    const all = [1, 2, 3].flatMap((i) => shardPlan(p, { index: i, count: 3 }).ids);
    expect([...all].sort()).toEqual(p.nodes.map((n) => n.id).sort());
  });

  it('keeps dependencies, group members and lock holders on one shard', () => {
    const p = plan();
    for (let i = 1; i <= 4; i++) {
      const ids = new Set(shardPlan(p, { index: i, count: 4 }).ids);
      for (const together of [['a', 'b'], ['c', 'd'], ['e', 'f']]) {
        const here = together.map((n) => ids.has(idOf(p, n)));
        expect(here.every(Boolean) || here.every((x) => !x)).toBe(true);
      }
    }
  });

  it('balances by duration: one slow scenario gets a shard of its own', () => {
    const p = plan();
    const durations = new Map<string, number>(p.nodes.map((n) => [n.id, 100] as const));
    durations.set(idOf(p, 'g'), 10_000);
    const s = shardPlan(p, { index: 1, count: 2 }, durations);
    const slow = [1, 2].map((i) => shardPlan(p, { index: i, count: 2 }, durations).ids).find((ids) => ids.includes(idOf(p, 'g')))!;
    expect(slow).toEqual([idOf(p, 'g')]);
    expect(s.loads[0]! + s.loads[1]!).toBe(10_000 + 700);
  });

  it('is deterministic and reports unknown durations', () => {
    const p = plan();
    const a = shardPlan(p, { index: 2, count: 3 });
    expect(shardPlan(p, { index: 2, count: 3 })).toEqual(a);
    expect(a.unknownDurations).toBe(8);
  });

  it('more shards than clusters leaves some shards empty', () => {
    const p = plan();
    const sizes = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => shardPlan(p, { index: i, count: 8 }).ids.length);
    expect(sizes.reduce((x, y) => x + y)).toBe(8);
    expect(sizes.filter((n) => n === 0).length).toBeGreaterThan(0);
  });
});
