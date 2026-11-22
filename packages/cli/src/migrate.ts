import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

/**
 * `bddr migrate`: updates a project that used the old name "bddx" (the name before bddr).
 * Rewrites `@bddx/*` imports, `BDDX_*` environment variables, `bddx.config.*` and `.bddx/` references, and renames the
 * config file and the history folder. Without `write` it only reports what would change.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'reports', '.bddr', '.bddx']);
const CODE = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.feature']);
const TEXT = new Set(['.md', '.yml', '.yaml', '.sh', '.ps1', '.txt']);
const CONFIG_EXT = ['ts', 'mts', 'js', 'mjs', 'json'];

export interface MigrateChange {
  file: string;
  kind: 'edit' | 'rename';
  detail: string;
}

export interface MigrateResult {
  changes: MigrateChange[];
  written: boolean;
}

/** Exact patterns, applied to every scanned file. */
function rewrite(text: string, loose: boolean): string {
  let out = text
    .replace(/@bddx\//g, '@bddr/')
    .replace(/\bBDDX_/g, 'BDDR_')
    .replace(/\bbddx\.config\b/g, 'bddr.config')
    .replace(/\.bddx\b/g, '.bddr');
  // Commands in package.json scripts, docs and CI files ("npx bddx run").
  if (loose) out = out.replace(/\bbddx\b/g, 'bddr');
  return out;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name));
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

export async function migrateProject(root: string, write: boolean): Promise<MigrateResult> {
  const changes: MigrateChange[] = [];
  for await (const file of walk(root)) {
    const ext = extname(file);
    const base = file.slice(file.lastIndexOf('/') + 1);
    const isCode = CODE.has(ext);
    const isText = TEXT.has(ext) || base === '.gitignore' || base === 'package.json';
    if (!isCode && !isText) continue;
    const before = await readFile(file, 'utf8');
    const after = rewrite(before, isText);
    if (after !== before) {
      changes.push({ file: relative(root, file), kind: 'edit', detail: 'bddx -> bddr' });
      if (write) await writeFile(file, after);
    }
  }
  for (const ext of CONFIG_EXT) {
    const from = join(root, `bddx.config.${ext}`);
    const to = join(root, `bddr.config.${ext}`);
    if (existsSync(from) && !existsSync(to)) {
      changes.push({ file: `bddx.config.${ext}`, kind: 'rename', detail: `-> bddr.config.${ext}` });
      if (write) await rename(from, to);
    }
  }
  if (existsSync(join(root, '.bddx')) && !existsSync(join(root, '.bddr'))) {
    changes.push({ file: '.bddx', kind: 'rename', detail: '-> .bddr (run history)' });
    if (write) await rename(join(root, '.bddx'), join(root, '.bddr'));
  }
  return { changes, written: write };
}

export function formatMigration(result: MigrateResult): string {
  if (result.changes.length === 0) return 'Nothing to migrate: no bddx names found.\n';
  const lines = result.changes.map((c) => `  ${c.kind === 'rename' ? 'rename' : 'edit  '} ${c.file}  ${c.detail}`);
  const head = result.written ? `Migrated ${result.changes.length} item(s):` : `Would change ${result.changes.length} item(s) (run again with --write to apply):`;
  const tail = result.written ? '\nNext: run npm install so the @bddr/* packages replace @bddx/*, then run your tests.\n' : '';
  return `${head}\n${lines.join('\n')}\n${tail}`;
}
