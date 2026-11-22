import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateProject } from '../src/migrate.js';

function oldProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bddr-migrate-'));
  mkdirSync(join(dir, 'steps'));
  mkdirSync(join(dir, '.bddx'));
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'bddx.config.ts'), "import { defineConfig } from '@bddx/cli';\nexport default defineConfig({});\n");
  writeFileSync(join(dir, 'steps', 'a.steps.ts'), "import { Given } from '@bddx/runtime';\nif (process.env.BDDX_DEBUG) {}\n");
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"bddx run"},"devDependencies":{"@bddx/cli":"^0.1.0"}}\n');
  writeFileSync(join(dir, 'node_modules', 'x', 'i.ts'), "import '@bddx/core';\n");
  return dir;
}

describe('bddr migrate', () => {
  it('previews without changing anything', async () => {
    const dir = oldProject();
    const r = await migrateProject(dir, false);
    expect(r.changes.length).toBeGreaterThanOrEqual(5);
    expect(existsSync(join(dir, 'bddx.config.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'steps', 'a.steps.ts'), 'utf8')).toContain('@bddx/runtime');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sandbox cleanup */ }
  });

  it('rewrites names, renames the config and history folder, and skips node_modules', async () => {
    const dir = oldProject();
    await migrateProject(dir, true);
    expect(existsSync(join(dir, 'bddr.config.ts'))).toBe(true);
    expect(existsSync(join(dir, 'bddx.config.ts'))).toBe(false);
    expect(existsSync(join(dir, '.bddr'))).toBe(true);
    expect(readFileSync(join(dir, 'bddr.config.ts'), 'utf8')).toContain('@bddr/cli');
    expect(readFileSync(join(dir, 'steps', 'a.steps.ts'), 'utf8')).toContain('BDDR_DEBUG');
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('"bddr run"');
    expect(readFileSync(join(dir, 'node_modules', 'x', 'i.ts'), 'utf8')).toContain('@bddx/core');
    const again = await migrateProject(dir, true);
    expect(again.changes).toEqual([]);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sandbox cleanup */ }
  });
});
