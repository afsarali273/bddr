/**
 * Phase 0/1 gate: bddr's parser must accept every feature in the official Cucumber Compatibility Kit
 * and compile to the same number of pickles as the kit's reference message streams.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSpec } from '@bddr/core';

const require = createRequire(import.meta.url);
const featuresRoot = join(dirname(require.resolve('@cucumber/compatibility-kit/package.json')), 'features');

function specFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.feature') || f.endsWith('.feature.md')).sort();
}

function expectedPickles(dir: string): number {
  const nd = readdirSync(dir).find((f) => f.endsWith('.ndjson'));
  if (!nd) return -1;
  return readFileSync(join(dir, nd), 'utf8')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((m) => 'pickle' in m).length;
}

const cases = readdirSync(featuresRoot).filter((d) => existsSync(join(featuresRoot, d)) && specFiles(join(featuresRoot, d)).length > 0);

describe('Cucumber Compatibility Kit: parsing', () => {
  it('finds the kit', () => {
    expect(cases.length).toBeGreaterThan(40);
  });

  for (const name of cases) {
    const dir = join(featuresRoot, name);
    it(`${name}: parses without errors and yields the reference pickle count`, () => {
      let total = 0;
      for (const file of specFiles(dir)) {
        const spec = parseSpec(readFileSync(join(dir, file), 'utf8'), `${name}/${file}`);
        expect(spec.errors, `${name}/${file}`).toEqual([]);
        total += spec.scenarios.length;
      }
      expect(total).toBe(expectedPickles(dir));
    });
  }
});
