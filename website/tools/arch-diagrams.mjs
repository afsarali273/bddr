#!/usr/bin/env node
/*
 * Generates the inline architecture diagrams used by src/architecture.page.
 * Output: website/src/diagrams/<name>.html (an <svg> element). Colours come from the site's CSS variables
 * (classes d-* in assets/css/theme.css), so the diagrams follow light and dark mode.
 * Run: node tools/arch-diagrams.mjs   then   node tools/build-pages.mjs architecture
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../src/diagrams');
mkdirSync(out, { recursive: true });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, s, cls = 'd-t', anchor = 'start') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`;
const box = (x, y, w, h, cls = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" class="d-box ${cls}"/>`;
const line = (d, cls = '', marker = 'a') => `<path d="${d}" class="d-line ${cls}"${marker ? ` marker-end="url(#${marker}-ID)"` : ''}/>`;
const defs = `<defs>
  <marker id="a-ID" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1 1l8 4-8 4" class="d-head"/></marker>
  <marker id="p-ID" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1 1l8 4-8 4" class="d-head accent"/></marker>
</defs>`;
const svg = (id, w, h, title, desc, body) =>
  `<svg class="diagram-svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${id}-t ${id}-d">
<title id="${id}-t">${esc(title)}</title>
<desc id="${id}-d">${esc(desc)}</desc>
${defs.replace(/-ID/g, '-' + id)}
${body.replace(/-ID\)/g, '-' + id + ')')}
</svg>
`;
const write = (name, s) => writeFileSync(join(out, name + '.html'), s);

/* ---------- 1. packages ---------- */
{
  let b = '';
  // your project
  b += text(30, 30, 'Your project', 'd-h');
  const proj = [['features/*.feature', 'the specs'], ['steps/*.ts', 'step code and fixtures'], ['bddr.config.ts', 'workers, groups, plugins']];
  proj.forEach(([a, c], i) => {
    const x = 30 + i * 200;
    b += box(x, 44, 184, 56, 'soft') + text(x + 14, 68, a, 'd-m') + text(x + 14, 88, c, 'd-s');
  });
  // plugins column
  b += text(662, 30, 'Plugins you install', 'd-h accent');
  const plug = [['@bddr/playwright', 'browser'], ['@bddr/selenium', 'browser'], ['@bddr/axios', 'HTTP client']];
  plug.forEach(([a, c], i) => {
    const y = 44 + i * 62;
    b += box(662, y, 268, 50, 'plug') + text(678, y + 22, a, 'd-m accent') + text(678, y + 40, c, 'd-s');
  });
  b += text(662, 322, 'Each wraps a library your project installs.', 'd-s');
  b += text(662, 340, 'bddr itself depends on none of them.', 'd-s');
  // cli
  b += box(30, 130, 580, 60, 'pkg') + text(48, 156, '@bddr/cli', 'd-h') + text(48, 177, 'bddr run, plan, report, docs, watch, debug. Reads the config and wires the rest together.', 'd-s');
  // reporters (left) + runtime (right, next to the plugins)
  b += box(30, 236, 196, 112, 'pkg') + text(48, 262, '@bddr/reporters', 'd-h');
  ['console, html, junit', 'cucumber-json, messages', 'ndjson, living docs'].forEach((l, i) => (b += text(48, 284 + i * 17, l, 'd-s')));
  b += box(238, 236, 372, 112, 'pkg') + text(256, 262, '@bddr/runtime', 'd-h');
  ['Step and hook registry, class steps', 'Scheduler, inline and process pool', 'Executor, retries, fixtures, context', 'Plugin API (definePlugin)'].forEach((l, i) => (b += text(256, 284 + i * 17, l, 'd-s')));
  // core
  b += box(30, 392, 580, 112, 'pkg core') + text(48, 418, '@bddr/core', 'd-h');
  ['Spec model and stable scenario ids', 'Tags and selection', 'The plan: groups, dependencies, locks, shards', 'Data files and run history'].forEach((l, i) => (b += text(48 + (i % 2) * 280, 442 + Math.floor(i / 2) * 20, l, 'd-s')));
  b += text(48, 488, 'Event schema v1: the only thing reporters read', 'd-s');
  // replaceable parts
  b += text(662, 392, 'Replaceable parts', 'd-h');
  b += text(662, 410, 'Cucumber libraries sit behind adapters:', 'd-s');
  [['gherkin parser', 'core'], ['tag expressions', 'core'], ['cucumber expressions', 'runtime']].forEach(([a, c], i) => {
    const y = 422 + i * 28;
    b += box(662, y, 268, 22, 'soft') + text(674, y + 15, a, 'd-s ink') + text(918, y + 15, c, 'd-s', 'end');
  });
  // arrows
  b += line('M128 190V236', '', 'a');
  b += line('M424 190V236', '', 'a');
  b += line('M128 348V392', '', 'a');
  b += line('M424 348V392', '', 'a');
  b += line('M796 224V292H610', 'accent dash', 'p');
  b += text(626, 284, 'register fixtures', 'd-s accent');
  b += text(140, 218, 'writes reports', 'd-s');
  b += text(436, 218, 'runs the plan', 'd-s');
  write('packages', svg('pk', 960, 520, 'bddr packages and their dependencies',
    'The CLI uses the runtime and the reporters. Both use core. Plugins sit outside and register fixtures with the runtime.', b));
}

/* ---------- 2. run pipeline ---------- */
{
  let b = '';
  const W = 148, G = 40, X0 = 30, Y = 40, H = 130;
  const st = [
    ['Parse', 'core', ['Feature files in,', 'scenarios out, each', 'with a stable id']],
    ['Select', 'core', ['Paths, tags, names,', 'ids. Hard dependencies', 'are pulled in']],
    ['Plan', 'core', ['Groups, dependencies,', 'locks, priority.', 'Plain data']],
    ['Schedule', 'runtime', ['Hands ready work to', 'free workers, holds', 'locks, applies retries']],
    ['Run', 'runtime', ['A worker runs hooks,', 'steps and fixtures', 'for one scenario']],
  ];
  st.forEach(([n, pk, ls], i) => {
    const x = X0 + i * (W + G);
    b += box(x, Y, W, H, i >= 3 ? 'pkg run' : 'pkg') + text(x + 16, Y + 30, n, 'd-h') + text(x + 16, Y + 50, '@bddr/' + pk, 'd-s mono');
    ls.forEach((l, k) => (b += text(x + 16, Y + 78 + k * 17, l, 'd-s')));
    if (i < st.length - 1) b += line(`M${x + W} ${Y + H / 2}H${x + W + G}`, '', 'a');
  });
  b += text(30, 24, 'Inputs: your feature files and bddr.config.ts', 'd-s');
  b += text(X0 + 2 * (W + G) + W / 2, Y + H + 42, 'bddr plan prints this', 'd-s accent', 'middle');
  b += line(`M${X0 + 2 * (W + G) + W / 2} ${Y + H + 28}V${Y + H + 3}`, 'accent dash', 'p');
  // events bar
  const ey = 250;
  b += box(20, ey, 920, 44, 'bar') + text(480, ey + 27, 'One event stream (schema v1): runs, groups, scenarios, steps and retries are all events', 'd-h center-h', 'middle');
  b += line(`M${X0 + 4 * (W + G) + W / 2} ${Y + H}V${ey}`, '', 'a');
  b += text(X0 + 4 * (W + G) + W / 2 + 12, Y + H + 40, 'emits', 'd-s');
  // reporters
  const rs = ['console', 'html', 'junit', 'cucumber-json', 'messages', 'ndjson'];
  const rw = 138, rg = 18;
  rs.forEach((r, i) => {
    const x = 20 + i * (rw + rg);
    b += line(`M${x + rw / 2} ${ey + 44}V${ey + 76}`, '', 'a');
    b += box(x, ey + 78, rw, 40, 'plug') + text(x + rw / 2, ey + 103, r, 'd-m', 'middle');
  });
  b += text(20, ey + 142, 'Reporters never touch the runner. They only read events, and any tool can read the ndjson file the same way.', 'd-s');
  write('run-pipeline', svg('rp', 960, 420, 'Life of a bddr run',
    'Feature files are parsed, selected, planned, scheduled and run. The run emits one event stream that every reporter reads.', b));
}

/* ---------- 3. fixture scopes ---------- */
{
  let b = '';
  // plugin
  b += box(20, 40, 210, 150, 'plug') + text(36, 68, 'Plugin', 'd-h accent') + text(36, 88, '@bddr/playwright', 'd-m');
  ['definePlugin({ setup })', 'registers fixtures:', '  browser   (worker)', '  page        (scenario)'].forEach((l, i) => (b += text(36, 116 + i * 17, l, 'd-s')));
  b += text(20, 24, '1  Registered at start-up', 'd-h');
  // arrow
  b += line('M230 115H270', 'accent', 'p');
  // lifetimes
  b += text(270, 24, '2  Created on first use, closed in reverse order', 'd-h');
  b += box(270, 40, 670, 330, 'scope w') + text(288, 66, 'Worker process', 'd-h') + text(930, 66, 'scope: worker', 'd-s mono', 'end');
  b += box(298, 82, 614, 208, 'scope f') + text(316, 108, 'Feature', 'd-h') + text(896, 108, 'scope: feature', 'd-s mono', 'end');
  b += box(326, 124, 558, 130, 'scope s') + text(344, 150, 'Scenario attempt', 'd-h') + text(868, 150, 'scope: scenario', 'd-s mono', 'end');
  b += text(344, 176, 'Given I log in as "ann"', 'd-m ink');
  b += text(344, 196, '    ({ page }) => ...      asks for page, so page is created now', 'd-s');
  b += text(344, 222, 'After hooks, then page closed', 'd-s');
  b += text(344, 242, 'A retry gets a fresh page', 'd-s');
  // browser pill
  b += box(288, 308, 640, 50, 'soft') + text(304, 330, 'browser', 'd-m ink') + text(304, 348, 'shared by every scenario in this worker. Closed after AfterWorker hooks.', 'd-s');
  b += text(20, 214, 'A fixture can use fixtures of its own scope', 'd-s');
  b += text(20, 232, 'or a longer one: a page can use the browser,', 'd-s');
  b += text(20, 250, 'never the other way round.', 'd-s');
  write('fixture-scopes', svg('fs', 960, 390, 'How plugin fixtures live inside a worker',
    'A plugin registers fixtures. A worker process holds the worker-scope browser, features hold feature-scope values, and each scenario attempt gets its own page.', b));
}
console.log('diagrams written to', out);
