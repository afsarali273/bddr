import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isIgnored, planWatchRun } from '../src/watch.js';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (statSync(src).isDirectory()) copyTree(src, join(to, name));
    else writeFileSync(join(to, name), readFileSync(src));
  }
}

describe('watch planning', () => {
  it('feature-only changes re-run just those files; anything else re-runs the selection', () => {
    expect(planWatchRun(['features/b.feature', 'features/a.feature', 'features/a.feature'])).toEqual({ paths: ['features/a.feature', 'features/b.feature'] });
    expect(planWatchRun(['features/a.feature', 'steps/x.ts'])).toEqual({});
    expect(planWatchRun(['data/users.csv'])).toEqual({});
    expect(planWatchRun(['bddr.config.ts'])).toEqual({});
  });

  it('ignores build output, reports, history and editor temp files', () => {
    for (const f of ['node_modules/x/index.js', '.bddr/history/1.json', 'reports/report.html', 'dist/a.js', '.git/HEAD', 'features/a.feature~', 'features/.a.feature.swp']) {
      expect(isIgnored(f)).toBe(true);
    }
    expect(isIgnored('features/a.feature')).toBe(false);
    expect(planWatchRun(['reports/report.html'])).toEqual({ paths: [] });
  });
});

describe('bddr --watch', () => {
  it('runs once, re-runs when a feature changes, and quits on q', async () => {
    const dir = mkdtempSync(join(fixtures, 'tmp-watch-'));
    try {
      copyTree(join(fixtures, 'project'), dir);
      const child = spawn(process.execPath, [bin, '--watch', '-t', '@green', '-D', 'env=local', '-f', 'progress'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      const until = async (re: RegExp, count: number, ms = 20000) => {
        const t0 = Date.now();
        while ((out.match(re) ?? []).length < count) {
          if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${re} x${count}. Output:\n${out}`);
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      await until(/Waiting for changes/g, 1);
      expect(out).toContain('bddr watch: watching');
      appendFileSync(join(dir, 'features', 'mixed.feature'), '\n  @green\n  Scenario: added later\n    Given the env is "local"\n');
      await until(/Waiting for changes/g, 2);
      expect(out).toContain('running features/mixed.feature');
      expect(out).toContain('2 scenarios (2 passed)');
      const exited = new Promise<number | null>((res) => child.on('exit', res));
      child.stdin.write('q\n');
      expect(await exited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
