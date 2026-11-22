#!/usr/bin/env node
/* Renders website/social/*.html to PNG (page size from the file, 2x). Run from a project that has `playwright` installed.
 * Usage: node tools/render-social.mjs [name ...]   (default: all) */
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '../social');
const want = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 });
for (const f of readdirSync(dir).filter((f) => f.endsWith('.html') && (!want.length || want.includes(f.replace('.html', ''))))) {
  await p.goto('file://' + join(dir, f));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(dir, f.replace('.html', '.png')) });
  console.log('rendered', f);
}
await b.close();
