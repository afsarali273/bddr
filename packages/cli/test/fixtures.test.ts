import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const project = fileURLToPath(new URL('./fixtures/fixtures-project/', import.meta.url));

function runProject(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'bddr-fx-'));
  const log = join(dir, 'fx.log');
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: project, encoding: 'utf8', env: { ...process.env, BDDR_FX_LOG: log } });
  let lines: string[] = [];
  try {
    lines = readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    /* no fixture used */
  }
  rmSync(dir, { recursive: true, force: true });
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  return { r, lines, count };
}

describe('fixtures + plugins end to end (groups, dependencies, retry, workers)', () => {
  it('inline pool: one worker browser for the run, a page per scenario attempt, nothing for scenarios that do not ask', () => {
    const { r, count, lines } = runProject([]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('7 scenarios (7 passed)');
    expect(count(/^browser open/)).toBe(1);
    expect(count(/^browser close/)).toBe(1);
    expect(count(/^page open/)).toBe(7); // 6 scenarios use a page, the flaky one twice; "no browser needed" none
    expect(count(/^page close .* failed$/)).toBe(1); // teardown sees the failed first attempt
    expect(lines.at(-1)).toMatch(/^browser close/); // worker fixture outlives every page
  });

  it('process pool: one browser per worker process, same results', () => {
    const { r, count } = runProject(['--pool', 'process']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('7 scenarios (7 passed)');
    expect(count(/^browser open/)).toBe(2);
    expect(count(/^browser close/)).toBe(2);
    expect(count(/^page open/)).toBe(7);
  });

  it('shards together run every scenario once', () => {
    const a = runProject(['--shard', '1/2']);
    const b = runProject(['--shard', '2/2']);
    expect(a.r.status).toBe(0);
    expect(b.r.status).toBe(0);
    expect(a.count(/^page open/) + b.count(/^page open/)).toBe(7);
  });

  it('a missing plugin is a usage error (exit 2) that says how to fix it', () => {
    const { r } = runProject(['--set', 'plugins=["@bddr/does-not-exist"]']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('plugin "@bddr/does-not-exist" not found');
  });

  it('a @serial feature keeps one feature-scoped session in one worker process (process pool, 2 workers)', () => {
    for (let i = 0; i < 3; i++) {
      const { r, lines, count } = runProject(['serial-features', '--pool', 'process', '-w', '2']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(count(/^session open/)).toBe(1);
      expect(count(/^session close/)).toBe(1);
      expect(count(/^session after .* passed/)).toBe(4);
      expect(new Set(lines.map((l) => l.split(' ').at(-1))).size).toBe(1); // one pid
    }
  });
});
