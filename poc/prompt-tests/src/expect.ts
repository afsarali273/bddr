import { AssertionError } from './errors.js';

const show = (v: unknown) => JSON.stringify(v);

/** A small expect(), enough for the POC. Every failure is an AssertionError with expected/actual. */
export function expect(actual: unknown) {
  const fail = (what: string, expected: unknown): never => {
    throw new AssertionError(`expected ${show(actual)} ${what} ${show(expected)}`, expected, actual);
  };
  const api = {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) fail('to be', expected);
    },
    toEqual(expected: unknown) {
      if (show(actual) !== show(expected)) fail('to equal', expected);
    },
    toBeCloseTo(expected: number, digits = 2) {
      if (typeof actual !== 'number' || Math.abs(actual - expected) >= 10 ** -digits / 2) fail('to be close to', expected);
    },
    toContain(item: unknown) {
      const ok = typeof actual === 'string' ? actual.includes(String(item)) : Array.isArray(actual) && actual.includes(item);
      if (!ok) fail('to contain', item);
    },
    toHaveLength(n: number) {
      const len = (actual as { length?: number } | null)?.length;
      if (len !== n) fail('to have length', n);
    },
    not: {
      toContain(item: unknown) {
        const has = typeof actual === 'string' ? actual.includes(String(item)) : Array.isArray(actual) && actual.includes(item);
        if (has) fail('not to contain', item);
      },
      toBe(expected: unknown) {
        if (Object.is(actual, expected)) fail('not to be', expected);
      },
    },
  };
  return api;
}
