#!/usr/bin/env node
/* Renders assets/img/features/*.svg to PNG (1600x900, and 2x) with Playwright. Run from a project that has `playwright` installed. */
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '../assets/img/features');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
for (const f of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
  await p.goto('file://' + join(dir, f)); await p.waitForTimeout(250);
  await p.screenshot({ path: join(dir, f.replace('.svg', '.png')) });
}
await b.close(); console.log('rendered');
