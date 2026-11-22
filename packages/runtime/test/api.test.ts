import { afterEach, describe, expect, it } from 'vitest';
import { Before, Given, getGlobalRegistry, resetGlobalRegistry, setDefaultTimeout, DataTable } from '@bddr/runtime';

afterEach(() => {
  resetGlobalRegistry();
});

describe('global API', () => {
  it('registers steps and hooks on the global registry with source locations', () => {
    resetGlobalRegistry();
    Given('I am here', () => {});
    Given('scoped', { tags: '@api', timeoutMs: 5 }, () => {});
    Before('@db', () => {});
    Before({ name: 'named', order: -1 }, () => {});
    setDefaultTimeout(1234);
    const reg = getGlobalRegistry();
    expect(reg.stepDefinitions.map((s) => s.pattern)).toEqual(['I am here', 'scoped']);
    expect(reg.stepDefinitions[1]).toMatchObject({ tags: '@api', timeoutMs: 5 });
    expect(reg.stepDefinitions[0]!.location).toMatch(/api\.test\.ts:\d+$/);
    expect(reg.hooksFor('scenario', 'before').map((h) => h.name)[0]).toBe('named');
    expect(reg.hooksFor('scenario', 'before')[1]!.tags).toBe('@db');
    expect(reg.defaultTimeoutMs).toBe(1234);
  });

  it('shares one registry through globalThis', () => {
    const a = getGlobalRegistry();
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('bddr.registry.v1')]).toBe(a);
  });

  it('rejects invalid hook tag expressions at registration time', () => {
    expect(() => Before('@a and', () => {})).toThrow(/Invalid tag expression/);
  });
});

describe('DataTable', () => {
  const t = new DataTable([
    ['name', 'age'],
    ['ann', '30'],
    ['bob', '41'],
  ]);
  it('offers raw, rows, hashes, typed objects and transpose', () => {
    expect(t.rows()).toEqual([
      ['ann', '30'],
      ['bob', '41'],
    ]);
    expect(t.asObjects((r) => ({ name: r['name'], age: Number(r['age']) }))).toEqual([
      { name: 'ann', age: 30 },
      { name: 'bob', age: 41 },
    ]);
    expect(t.transpose().raw()[0]).toEqual(['name', 'ann', 'bob']);
    expect(t.rowsHash()).toEqual({ name: 'age', ann: '30', bob: '41' });
    expect(() => new DataTable([['a', 'b', 'c']]).rowsHash()).toThrow(/2-column/);
  });
});
