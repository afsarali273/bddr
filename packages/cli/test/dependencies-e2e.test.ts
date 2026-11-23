/**
 * The same dependency graph through the real CLI: inline pool and real worker processes must agree on every result.
 * Graph (fixtures/deps-project): a @requires file, a chain, a lock shared across a dependency, a failing scenario with a hard
 * and a soft dependent, an export read through a dependency, and group dependsOn.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const project = fileURLToPath(new URL('./fixtures/deps-project/', import.meta.url));
const dupProject = fileURLToPath(new URL('./fixtures/dup-id-project/', import.meta.url));
const built = existsSync(bin);

function bddr(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

interface Outcome {
  status: Record<string, string>;
  reason: Record<string, string>;
  order: string[];
}

function runWithEvents(...args: string[]): Outcome & { code: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'bddr-deps-'));
  const file = join(dir, 'events.ndjson');
  const r = bddr(project, ...args, '-f', `ndjson:${file}`);
  const status: Record<string, string> = {};
  const reason: Record<string, string> = {};
  const order: string[] = [];
  // A shard with nothing to run exits 0 and writes no events file.
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  for (const line of lines) {
    const e = JSON.parse(line) as { type: string; scenarioId?: string; status?: string; reason?: string; willRetry?: boolean };
    if (e.type === 'scenarioStarted') order.push(`start:${e.scenarioId}`);
    if (e.type === 'scenarioFinished' && !e.willRetry) {
      status[e.scenarioId!] = e.status!;
      if (e.reason) reason[e.scenarioId!] = e.reason;
      order.push(`end:${e.scenarioId}`);
    }
  }
  return { code: r.code, status, reason, order };
}

const EXPECTED: Record<string, string> = {
  'seed-users': 'passed',
  'seed-catalogue': 'passed',
  'place-order': 'passed',
  'cancel-order': 'passed',
  'take-payment': 'passed',
  refund: 'passed',
  broken: 'failed',
  'uses-broken': 'skipped',
  'soft-uses-broken': 'passed',
  report: 'passed',
  'report-after-broken': 'skipped',
};

const before = (o: Outcome, a: string, b: string) => o.order.indexOf(`end:${a}`) !== -1 && o.order.indexOf(`end:${a}`) < o.order.indexOf(`start:${b}`);

describe.skipIf(!built)('dependencies through the CLI', () => {
  it('inline pool: every scenario ends with the expected status and the right skip reason', () => {
    const o = runWithEvents('run', '--pool', 'inline', '-w', '4');
    expect(o.code).toBe(1); // the deliberately broken scenario
    expect(o.status).toEqual(EXPECTED);
    expect(o.reason['uses-broken']).toBe('dependency failed: broken (failed)');
    expect(o.reason['report-after-broken']).toBe('dependency failed: broken (failed)');
  });

  it('worker processes give exactly the same results as the inline pool', () => {
    const inline = runWithEvents('run', '--pool', 'inline', '-w', '4');
    const proc = runWithEvents('run', '--pool', 'process', '-w', '4');
    expect(proc.code).toBe(1);
    expect(proc.status).toEqual(inline.status);
    expect(proc.reason).toEqual(inline.reason);
  });

  for (const pool of ['inline', 'process']) {
    it(`${pool} pool: dependencies finish before their dependents start (requires, chain, lock, group)`, () => {
      const o = runWithEvents('run', '--pool', pool, '-w', '4');
      for (const dependent of ['place-order', 'cancel-order']) for (const seed of ['seed-users', 'seed-catalogue']) {
        if (dependent === 'place-order') expect(before(o, seed, dependent), `${seed} -> ${dependent}`).toBe(true);
      }
      expect(before(o, 'place-order', 'cancel-order')).toBe(true);
      expect(before(o, 'place-order', 'take-payment')).toBe(true);
      expect(before(o, 'take-payment', 'refund')).toBe(true);
      expect(before(o, 'seed-users', 'report')).toBe(true);
      expect(before(o, 'seed-catalogue', 'report')).toBe(true);
      expect(before(o, 'broken', 'soft-uses-broken')).toBe(true);
    });
  }

  it('selecting one scenario pulls in everything it needs, and nothing else', () => {
    const o = runWithEvents('run', 'features/03-payments.feature:3', '--pool', 'inline'); // take a payment
    expect(Object.keys(o.status).sort()).toEqual(['place-order', 'seed-catalogue', 'seed-users', 'take-payment']);
    expect(o.code).toBe(0);
  });

  it('--no-deps runs only the selection and does not skip it for missing dependencies', () => {
    const o = runWithEvents('run', 'features/03-payments.feature:3', '--no-deps');
    expect(Object.keys(o.status)).toEqual(['take-payment']);
    expect(o.status['take-payment']).toBe('passed');
  });

  it('a tag selection pulls in dependencies that do not carry the tag', () => {
    const o = runWithEvents('run', '-t', '@group:reports and not @dependsOn:broken', '--pool', 'inline');
    expect(o.status['report']).toBe('passed');
    expect(o.status['seed-users']).toBe('passed'); // group reports dependsOn setup
  });

  it('bddr plan lists the edges, and --explain says why a scenario was included', () => {
    const json = JSON.parse(bddr(project, 'plan', '--plan-format', 'json').out) as { nodes: Array<{ id: string; deps: Array<{ target: string; soft: boolean; via: string }> }> };
    const node = (id: string) => json.nodes.find((n) => n.id === id)!;
    // cancel-order inherits the feature's @requires (both seed scenarios) and adds its own dependency
    expect(node('cancel-order').deps.map((d) => d.target).sort()).toEqual(['place-order', 'seed-catalogue', 'seed-users']);
    expect(node('soft-uses-broken').deps).toEqual([{ target: 'broken', soft: true, via: 'broken' }]);
    expect(node('place-order').deps.map((d) => d.target).sort()).toEqual(['seed-catalogue', 'seed-users']);
    expect(node('report').deps.map((d) => `${d.target}:${d.via}`).sort()).toEqual(['seed-catalogue:group-config:reports->setup', 'seed-users:group-config:reports->setup']);
    const why = bddr(project, 'plan', '--explain', 'refund').out;
    expect(why).toContain('- take-payment [hard: skipped if it does not pass] via take-payment');
  });

  it('--shard keeps every connected scenario on one shard (all of this graph is connected through setup); the other shards have nothing to run', () => {
    const shards = [1, 2, 3].map((i) => {
      const o = runWithEvents('run', '--shard', `${i}/3`, '--pool', 'inline');
      return Object.keys(o.status);
    });
    const nonEmpty = shards.filter((s) => s.length > 0);
    expect(nonEmpty).toHaveLength(1);
    expect(nonEmpty[0]!.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('refuses to run when two scenarios share an @id, and says where', () => {
    const r = bddr(dupProject, 'run');
    expect(r.code).toBe(2);
    expect(r.err).toContain('Scenario id "setup" is duplicated at features/a.feature:3, features/b.feature:3');
  });

  it('bddr validate reports the duplicate id once', () => {
    const r = bddr(dupProject, 'validate');
    expect(r.code).not.toBe(0);
    expect(r.out.match(/is duplicated at/g)).toHaveLength(1);
  });
});
