/** `bddr steps`: the step catalogue that editors, tools and the other language ports read. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLocation, type StepCatalogue } from '../src/catalogue.js';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const project = fileURLToPath(new URL('./fixtures/catalogue-project/', import.meta.url));
const built = existsSync(bin);

function bddr(...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: project, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('parseLocation', () => {
  it('makes paths project-relative with forward slashes and leaves outside paths alone', () => {
    expect(parseLocation('/p/steps/a.ts:12', '/p')).toEqual({ file: 'steps/a.ts', line: 12 });
    expect(parseLocation('file:///p/steps/a.ts:3', '/p')).toEqual({ file: 'steps/a.ts', line: 3 });
    expect(parseLocation('/other/x.ts:9', '/p')).toEqual({ file: '/other/x.ts', line: 9 });
    expect(parseLocation(undefined, '/p')).toBeUndefined();
    expect(parseLocation('no-line', '/p')).toBeUndefined();
  });
});

describe.skipIf(!built)('bddr steps (built)', () => {
  it('--json describes steps, hooks and fixtures', () => {
    const r = bddr('steps', '--json');
    expect(r.code).toBe(0);
    const c = JSON.parse(r.out) as StepCatalogue;
    expect(c.schemaVersion).toBe(1);
    expect(c.language).toBe('typescript');
    expect(c.steps.map((s) => [s.kind, s.pattern])).toEqual([
      ['expression', 'a plain step'],
      ['expression', 'I have {int} apples'],
      ['regex', '^I eat (\\d+) of them$'],
      ['expression', 'a slow step'],
    ]);
    expect(c.steps[2]!.flags).toBe('i');
    expect(c.steps[3]).toMatchObject({ tags: '@slow', timeoutMs: 5000 });
    expect(c.steps[0]!.location).toEqual({ file: 'steps/main.steps.ts', line: 3 });
    expect(c.hooks).toHaveLength(1);
    expect(c.hooks[0]).toMatchObject({ kind: 'before', level: 'scenario', tags: '@db' });
    expect(c.fixtures.map((f) => [f.name, f.scope, f.deps])).toEqual([
      ['db', 'worker', []],
      ['repo', 'scenario', ['db']],
    ]);
  });

  it('never leaks absolute paths (hook names, locations)', () => {
    const r = bddr('steps', '--json');
    expect(r.out).not.toContain(project);
    expect(r.out).not.toMatch(/"(?:file|name)": "[^"]*(?:\/Users\/|\/home\/|\/sessions\/|[A-Z]:\\\\)/);
  });

  it('prints a readable list without --json', () => {
    const r = bddr('steps');
    expect(r.code).toBe(0);
    expect(r.out).toContain('4 step(s)');
    expect(r.out).toContain('I have {int} apples  steps/main.steps.ts:4');
    expect(r.out).toContain('/^I eat (\\d+) of them$/i');
    expect(r.out).toContain('1 fixture(s)'.replace('1', '2'));
  });

  it('exits 2 with a message when the support code cannot load', () => {
    const r = bddr('steps', '--config', 'does-not-exist.ts');
    expect(r.code).toBe(2);
    expect(r.err).toContain('bddr:');
  });
});

describe.skipIf(!built)('@requires through the CLI', () => {
  const dir = fileURLToPath(new URL('./fixtures/requires-project/', import.meta.url));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('skips a feature whose required file failed, but runs a soft requirement', () => {
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('↷ place an order');
    expect(r.out).toContain('dependency failed: features/a-setup.feature::seed-the-database (failed)');
    expect(r.out).toContain('✔ runs whatever setup did');
  });

  it('selecting only the dependent feature still runs the required file first', () => {
    const r = run('features/b-orders.feature');
    expect(r.out).toContain('seed the database');
    expect(r.out.indexOf('seed the database')).toBeLessThan(r.out.indexOf('place an order'));
  });

  it('shows the requirement in the plan', () => {
    const r = run('plan', '--plan-format', 'json');
    expect(r.code).toBe(0);
    expect(r.out).toContain('requires:a-setup.feature');
  });
});
