#!/usr/bin/env node
/*
 * Generates one explainer image per unique bddr feature: assets/img/features/<slug>.svg
 * (PNG versions: node tools/render-images.mjs). Each image: the problem with Cucumber.js on its own (left) and how bddr
 * solves it in one run (right). Edit the FEATURES below and re-run.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../assets/img/features');
mkdirSync(out, { recursive: true });

const C = { ink: '#171a33', ink2: '#474d6b', ink3: '#737a96', accent: '#0b7a86', accentBg: '#e3f2f3', pass: '#2f9e6e', passBg: '#e1f3ea', fail: '#c9463b', failBg: '#fbe6e3',
  skip: '#8b90a0', skipBg: '#eceef3', flaky: '#b87d12', flakyBg: '#faf0d9', g3: '#6a5fc4', g3Bg: '#eceaf9', g4: '#b87d12', code: '#1a1d38', line: '#d5d9e6', bg: '#fbfcfe', card: '#ffffff' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const t = (x, y, s, o = {}) => `<text xml:space="preserve" x="${x}" y="${y}" font-family="${o.f ?? 'Plex Sans'}" font-size="${o.s ?? 24}" font-weight="${o.w ?? 400}" fill="${o.c ?? C.ink}" text-anchor="${o.a ?? 'start'}"${o.i ? ' font-style="italic"' : ''}>${esc(s)}</text>`;
const mono = (x, y, s, o = {}) => t(x, y, s, { f: 'Plex Mono', s: 21, ...o });
const r = (x, y, w, h, fill, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 10}" fill="${fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 2}"` : ''}${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}/>`;
const block = (x, y, w, h, label, fill, ink, o = {}) => r(x, y, w, h, fill, { stroke: ink, ...o }) + t(x + w / 2, y + h / 2 + 7, label, { a: 'middle', s: o.fs ?? 20, w: 600, c: ink });
const arrow = (x1, y1, x2, y2, c = C.ink2, dash) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="3"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#ah-${c.slice(1)})"/>`;
const heads = [C.ink2, C.fail, C.accent, C.pass, C.skip].map((c) => `<marker id="ah-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`).join('');
const chip = (x, y, label, fill, ink) => { const w = label.length * 12.5 + 28; return r(x, y, w, 36, fill, { rx: 18 }) + t(x + w / 2, y + 25, label, { a: 'middle', s: 19, w: 600, c: ink }); };
const x_ = (x, y) => `<g stroke="${C.fail}" stroke-width="3.5" stroke-linecap="round"><line x1="${x}" y1="${y - 8}" x2="${x + 16}" y2="${y + 8}"/><line x1="${x + 16}" y1="${y - 8}" x2="${x}" y2="${y + 8}"/></g>`;
const ok_ = (x, y) => `<path d="M${x} ${y} l7 8 l14 -17" fill="none" stroke="${C.pass}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const code = (x, y, w, lines) => r(x, y, w, lines.length * 32 + 34, C.code, { rx: 12 }) + lines.map((l, i) => mono(x + 24, y + 42 + i * 32, l.text ?? l, { c: l.c ?? '#e7e9f5' })).join('');
const kw = (s) => ({ text: s, c: '#e8a2c9' });

/** lane chart helper: lanes at y, columns by x */
const lanes = (x, y, names, w, gap = 64) => names.map((n, i) => t(x, y + i * gap + 38, n, { f: 'Plex Mono', s: 19, c: C.ink3 }) + `<line x1="${x + 46}" y1="${y + i * gap + 62}" x2="${x + w}" y2="${y + i * gap + 62}" stroke="${C.line}" stroke-width="2"/>`).join('');

const FEATURES = [
  {
    slug: '01-groups-in-one-run', title: 'Groups: parallel and serial work in one run',
    problem: 'Setup first, checkout in parallel, payments one at a time, reports last, without splitting your CI into jobs.',
    left: ['--parallel runs every scenario the same way: all at once.', 'No "run setup first" or "reports last".', 'Teams split the suite into separate jobs and glue them with shell scripts.'],
    right: () => lanes(800, 280, ['w1', 'w2', 'w3'], 690) +
      block(850, 292, 110, 44, 'setup', C.skipBg, C.skip, { fs: 18 }) +
      block(980, 292, 120, 44, 'checkout', C.accentBg, C.accent, { fs: 18 }) + block(980, 356, 120, 44, 'checkout', C.accentBg, C.accent, { fs: 18 }) + block(980, 420, 120, 44, 'checkout', C.accentBg, C.accent, { fs: 18 }) +
      block(1120, 292, 110, 44, 'payments 1', C.g3Bg, C.g3, { fs: 17 }) + block(1240, 292, 110, 44, 'payments 2', C.g3Bg, C.g3, { fs: 17 }) +
      block(1370, 292, 100, 44, 'reports', C.flakyBg, C.flaky, { fs: 18 }) +
      t(860, 506, 'serial, first  ·  parallel x3  ·  serial + lock  ·  runs last', { s: 19, c: C.ink2 }),
    snippet: ['groups: {', '  setup:    { mode: \'serial\' },', '  checkout: { workers: 3, dependsOn: [\'setup\'] },', '  payments: { mode: \'serial\', locks: [\'db\'] },', '  reports:  { dependsOn: [\'checkout\', \'payments\'] },', '}'],
    result: 'One command, one schedule. bddr plan shows it before you run.',
  },
  {
    slug: '02-dependencies-and-data', title: 'Dependencies and data between scenarios',
    problem: 'A scenario that needs an order created by another one: ordered, skipped when it cannot run, and data passed along.',
    left: ['Scenarios are meant to be independent.', 'Sharing an order id means a global variable or a temp file.', 'Both break as soon as you run in parallel.'],
    right: () => block(810, 300, 210, 70, 'Create order', C.passBg, C.pass) + block(1230, 300, 230, 70, 'Cancel order', C.accentBg, C.accent) + arrow(1022, 335, 1226, 335, C.accent) +
      t(1124, 318, "ctx.export('orderId')", { a: 'middle', s: 17, f: 'Plex Mono', c: C.accent }) + t(1124, 368, "ctx.from('create-order')", { a: 'middle', s: 17, f: 'Plex Mono', c: C.accent }) +
      block(810, 440, 210, 70, 'Create order', C.failBg, C.fail) + block(1230, 440, 230, 70, 'Cancel order', C.skipBg, C.skip, { dash: '8 6' }) + arrow(1022, 475, 1226, 475, C.skip, '8 6') +
      t(1124, 466, 'failed, so', { a: 'middle', s: 18, c: C.fail }) + t(1124, 506, 'dependent is skipped', { a: 'middle', s: 18, c: C.skip }),
    snippet: ['@id:create-order', 'Scenario: Create an order', '', '@dependsOn:create-order', 'Scenario: Cancel the order'],
    result: 'Order, skip and data hand-over are declared in the feature file, and work across worker processes.',
  },
  {
    slug: '03-serial-journey', title: 'Serial journeys inside a parallel run',
    problem: 'A checkout journey (log in, add to basket, pay) must run in order and keep one browser, while the rest of the suite runs in parallel.',
    left: ['Scenarios run in any order, on any worker.', 'To keep a journey in order you merge it into one huge scenario...', '...or run the whole suite serially.'],
    right: () => lanes(800, 280, ['w1', 'w2', 'w3'], 690) +
      r(852, 288, 450, 56, 'none', { stroke: C.accent, dash: '8 6', rx: 14 }) + t(1082, 282, 'one browser session', { a: 'middle', s: 17, c: C.accent, w: 600 }) +
      block(862, 296, 130, 40, '1 log in', C.accentBg, C.accent, { fs: 17 }) + block(1002, 296, 140, 40, '2 add item', C.accentBg, C.accent, { fs: 17 }) + block(1152, 296, 140, 40, '3 pay', C.accentBg, C.accent, { fs: 17 }) +
      block(862, 360, 200, 40, 'search feature', C.skipBg, C.skip, { fs: 17 }) + block(1072, 360, 200, 40, 'profile feature', C.skipBg, C.skip, { fs: 17 }) + block(862, 424, 260, 40, 'catalogue feature', C.skipBg, C.skip, { fs: 17 }) + block(1132, 424, 180, 40, 'admin feature', C.skipBg, C.skip, { fs: 17 }),
    snippet: ['@serial @reuseContext', 'Feature: Checkout journey', '  Scenario: Log in', '  Scenario: Add to basket', '  Scenario: Pay'],
    result: 'Ordered scenarios, one shared session, and everything else still in parallel.',
  },
  {
    slug: '04-locks-and-priority', title: 'Locks, exclusive and priority',
    problem: 'Two scenarios must never touch the same database, account or service at the same time.',
    left: ['No way to say "these two must not overlap".', 'Parallel runs corrupt shared test data and fail at random.', 'Workaround: tag-split runs, or give up on parallelism.'],
    right: () => lanes(800, 280, ['w1', 'w2', 'w3'], 690) +
      block(860, 292, 200, 44, 'Refund order', C.g3Bg, C.g3, { fs: 18 }) +
      r(860, 356, 200, 44, 'none', { stroke: C.skip, dash: '6 5' }) + t(960, 384, 'waits for the lock', { a: 'middle', s: 17, c: C.skip }) + block(1070, 356, 200, 44, 'Close day', C.g3Bg, C.g3, { fs: 18 }) +
      block(860, 420, 410, 44, 'Browse catalogue: no lock, runs now', C.accentBg, C.accent, { fs: 18 }) +
      chip(810, 486, '@lock: never overlap', C.g3Bg, C.g3) + chip(1100, 486, '@exclusive: runs alone', C.flakyBg, C.flaky),
    snippet: ['@lock:payments-db', 'Scenario: Refund an order', '@exclusive', 'Scenario: Restart the gateway'],
    result: 'Shared resources are protected by name. Everything else keeps its parallel speed.',
  },
  {
    slug: '05-retries-flaky-quarantine', title: 'Retries that tell the truth: flaky and quarantine',
    problem: 'Retry flaky tests without hiding them, and keep a known-bad test visible without breaking the build.',
    left: ['--retry makes a flaky run turn green, and then nobody sees it.', 'No flakiness score, no quarantine.', 'No "retry the whole group" for linked scenarios.'],
    right: () => block(810, 290, 150, 56, 'attempt 1', C.failBg, C.fail) + arrow(962, 318, 1018, 318, C.ink2) + block(1022, 290, 150, 56, 'attempt 2', C.passBg, C.pass) + chip(1200, 299, 'FLAKY', C.flakyBg, C.flaky) + t(1306, 324, 'run passes, report flags it', { s: 17, c: C.ink2 }) +
      block(810, 380, 330, 56, 'Export to PDF  @quarantine', C.failBg, C.fail) + chip(1170, 390, 'build stays green', C.passBg, C.pass) +
      r(810, 460, 650, 70, 'none', { stroke: C.g3, dash: '8 6', rx: 14 }) + t(830, 490, 'group retry: login > create > pay re-run together', { s: 19, c: C.g3, w: 600 }) + t(830, 518, "retryMembers: 'failed'", { s: 17, f: 'Plex Mono', c: C.ink2 }),
    snippet: ['retry: { scenario: 2, on: [\'/timed out/\'] },', 'history: true,   // flakiness score per scenario', '', '@quarantine @owner:ann', 'Scenario: Export to PDF'],
    result: 'Retries stay honest: flaky is reported, quarantined never fails the build, and bddr history ranks the worst.',
  },
  {
    slug: '06-sharding-in-ci', title: 'Sharding that keeps related tests together',
    problem: 'Split the suite across 4 CI machines without cutting a dependency chain, a group or a lock in half.',
    left: ['Teams split by file with a custom script.', 'A scenario that depends on another may land on a different machine and fail.', 'Shards are unbalanced, so one machine runs 3x longer.'],
    right: () => [0, 1, 2, 3].map((i) => r(800 + i * 178, 290, 160, 230, C.card, { stroke: C.line }) + t(880 + i * 178, 318, `shard ${i + 1}/4`, { a: 'middle', s: 19, w: 600, c: C.ink })).join('') +
      block(812, 336, 136, 40, 'create', C.passBg, C.pass, { fs: 17 }) + block(812, 384, 136, 40, 'cancel', C.passBg, C.pass, { fs: 17 }) + `<line x1="880" y1="376" x2="880" y2="384" stroke="${C.pass}" stroke-width="3"/>` + block(812, 432, 136, 70, '@lock: db', C.g3Bg, C.g3, { fs: 17 }) +
      block(990, 336, 136, 110, 'checkout group', C.accentBg, C.accent, { fs: 17 }) + block(990, 454, 136, 48, 'a', C.skipBg, C.skip, { fs: 17 }) +
      block(1168, 336, 136, 70, 'serial feature', C.flakyBg, C.flaky, { fs: 17 }) + block(1168, 414, 136, 88, 'b, c', C.skipBg, C.skip, { fs: 17 }) +
      block(1346, 336, 136, 80, 'orders', C.accentBg, C.accent, { fs: 17 }) + block(1346, 424, 136, 78, 'd, e', C.skipBg, C.skip, { fs: 17 }) +
      t(800, 552, 'packed by recorded duration, so shards finish together', { s: 19, c: C.ink2 }),
    snippet: ['npx bddr run --shard 1/4', 'npx bddr run --shard 2/4', '# ...every machine agrees, no coordination', 'npx bddr report events-*.ndjson -f html'],
    result: 'Deterministic, balanced by history, and dependent scenarios never get separated. Results merge into one report.',
  },
  {
    slug: '07-data-files', title: 'Data files: one scenario, one row, stable ids',
    problem: 'Drive scenarios from a CSV or Excel file that the QA team edits, without pasting the data into feature files.',
    left: ['Examples tables live inside the feature file.', 'Reading CSV or Excel means writing a pre-processing script.', 'Row ids change when data changes, so reruns and reports break.'],
    right: () => r(810, 290, 190, 150, C.card, { stroke: C.line }) + t(905, 320, 'prices.csv', { a: 'middle', s: 19, w: 600 }) + mono(826, 352, 'apple,2,1.00', { s: 18, c: C.ink2 }) + mono(826, 380, 'pear,4,3.00', { s: 18, c: C.ink2 }) + mono(826, 408, 'melon,1,3.00', { s: 18, c: C.ink2 }) +
      arrow(1004, 365, 1090, 365, C.accent) +
      ['2 x apple costs 1.00', '4 x pear costs 3.00', '1 x melon costs 3.00'].map((s, i) => block(1096, 290 + i * 58, 380, 46, s, C.passBg, C.pass, { fs: 18 }) + mono(1100, 1, '', {})).join('') +
      t(810, 478, 'also: .xlsx#Sheet?active=yes, JSON, YAML, TSV', { s: 18, c: C.ink2 }) + chip(810, 494, 'ids: [prices.csv#1] [#2] [#3]', C.accentBg, C.accent),
    snippet: ['@data:prices.csv', 'Scenario: <qty> x <product> costs <total>', '  When I add <qty> "<product>"', '  Then the basket total is <total>'],
    result: 'CSV, TSV, JSON, YAML and Excel with filters, a data folder per profile, and ids that survive edits.',
  },
  {
    slug: '08-ui-and-api-in-one-scenario', title: 'UI and API in one scenario, started only when needed',
    problem: 'Create data through the API, check it in the browser, with Playwright or Selenium and axios, using one runner.',
    left: ['The World class is hand-wired for each tool.', 'The browser starts for every scenario, even API-only ones.', 'Switching Playwright for Selenium means rewriting the glue.'],
    right: () => r(810, 290, 650, 54, C.card, { stroke: C.ink3, rx: 12 }) + t(1135, 324, 'Scenario: a post title from the API shows up in the browser', { a: 'middle', s: 19, w: 600, c: C.ink }) +
      block(810, 364, 300, 54, 'When I fetch post 1', C.accentBg, C.accent, { fs: 19 }) + chip(1124, 373, '{ api }  axios', C.accentBg, C.accent) +
      block(810, 436, 300, 54, 'And I add it as a todo', C.g3Bg, C.g3, { fs: 19 }) + chip(1124, 445, '{ page }  playwright', C.g3Bg, C.g3) +
      t(810, 524, 'values travel in ctx.state. A scenario that only asks for { api } never opens a browser.', { s: 18, c: C.ink2 }),
    snippet: ['plugins: [', '  axios({ baseURL }),', '  playwright(),   // or selenium()', '],'],
    result: 'Plugins add fixtures. Groups, retries, sharding and reports work the same with any of them.',
  },
  {
    slug: '09-step-repeat-and-retry', title: 'Repeat and retry a single step from the feature file',
    problem: 'Wait for a slow report to be ready, or create 100 users, without writing loops in step code.',
    left: ['Polling loops and sleeps live inside step code.', 'Bulk data needs a for loop in each step.', 'Nothing shows attempts in the report.'],
    right: () => t(810, 308, 'Then the report is ready  @retry:5 @delay:2s', { s: 21, f: 'Plex Mono', c: C.ink }) +
      [C.fail, C.fail, C.fail, C.pass].map((c, i) => `<circle cx="${830 + i * 70}" cy="352" r="22" fill="${c === C.pass ? C.passBg : C.failBg}" stroke="${c}" stroke-width="3"/>` + (c === C.pass ? ok_(820 + i * 70, 352) : x_(822 + i * 70, 352))).join('') + t(1110, 360, 'passed on attempt 4, recorded', { s: 19, c: C.ink2 }) +
      t(810, 440, 'When I create user "u{{i}}"  @repeat:100 @concurrency:10', { s: 21, f: 'Plex Mono', c: C.ink }) +
      Array.from({ length: 20 }, (_, i) => r(810 + (i % 10) * 64, 462 + Math.floor(i / 10) * 30, 54, 22, C.passBg, { stroke: C.pass, sw: 1.5, rx: 5 })).join('') + t(1450, 540, 'x 100, ten at a time', { a: 'end', s: 18, c: C.ink2 }),
    snippet: ['Then the report is ready @retry:5 @delay:2s @timeout:30s', 'When I create user "u{{i}}" @repeat:100 @concurrency:10', '', '@stepRetry:2   # default for the whole scenario'],
    result: 'Each attempt is an event in the report. {{i}} and {{n}} fill in the iteration.',
  },
  {
    slug: '10-plan-and-execution-timeline', title: 'See the schedule before and after the run',
    problem: 'Understand why a scenario waited, ran late or was skipped, and where the time went.',
    left: ['No plan: the order is only visible while it runs.', 'Reports show a list, not what ran on which worker.', 'Finding the bottleneck means reading logs.'],
    right: () => r(810, 290, 330, 230, C.code, { rx: 12 }) + ['bddr plan --explain pay', '', 'pay', '  groups: payments (serial)', '  locks: payments-db', '  waits for: login, setup', '  needed by: reports'].map((s, i) => mono(830, 326 + i * 28, s, { s: 17, c: i === 0 ? '#e8a2c9' : '#e7e9f5' })).join('') +
      lanes(1160, 280, ['w1', 'w2', 'w3', 'w4'], 320, 52) +
      block(1220, 286, 70, 34, '', C.skipBg, C.skip, { fs: 13 }) + block(1300, 286, 100, 34, '', C.flakyBg, C.flaky, { fs: 13 }) +
      block(1220, 338, 120, 34, '', C.accentBg, C.accent, { fs: 13 }) + block(1350, 338, 80, 34, '', C.accentBg, C.accent, { fs: 13 }) +
      block(1300, 390, 130, 34, '', C.g3Bg, C.g3, { fs: 13 }) + block(1220, 442, 150, 34, '', C.accentBg, C.accent, { fs: 13 }) +
      t(1320, 512, 'worker timeline + dependency graph', { a: 'middle', s: 17, c: C.ink2 }),
    snippet: ['npx bddr plan                      # text', 'npx bddr plan --plan-format mermaid # diagram', 'npx bddr -f html:reports/report.html'],
    result: 'Plan, explain and an HTML report with a worker timeline and dependency graph.',
  },
];

const FONT = ['400', '600'].map((w) => `@font-face{font-family:'Plex Sans';src:url('../../fonts/ibm-plex-sans-latin-${w}-normal.woff2') format('woff2');font-weight:${w}}`).join('') +
  `@font-face{font-family:'Plex Condensed';src:url('../../fonts/ibm-plex-sans-condensed-latin-700-normal.woff2') format('woff2');font-weight:700}` +
  `@font-face{font-family:'Plex Mono';src:url('../../fonts/ibm-plex-mono-latin-400-normal.woff2') format('woff2');font-weight:400}`;

for (const f of FEATURES) {
  const left = f.left.map((s, i) => x_(106, 380 + i * 112) + t(142, 387 + i * 112, s.length > 44 ? s.slice(0, s.lastIndexOf(' ', 44)) : s, { s: 23, c: C.ink }) + (s.length > 44 ? t(142, 417 + i * 112, s.slice(s.lastIndexOf(' ', 44) + 1), { s: 23, c: C.ink }) : '')).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="1600" height="900" role="img" aria-label="${esc(f.title)}">
<defs><style>${FONT}</style>${heads}</defs>
${r(0, 0, 1600, 900, C.bg, { rx: 0 })}
${t(80, 100, f.title, { f: 'Plex Condensed', s: 52, w: 700 })}
${t(80, 150, f.problem.length > 112 ? f.problem.slice(0, f.problem.lastIndexOf(' ', 112)) : f.problem, { s: 25, c: C.ink2 })}${f.problem.length > 112 ? t(80, 182, f.problem.slice(f.problem.lastIndexOf(' ', 112) + 1), { s: 25, c: C.ink2 }) : ''}
${r(80, 215, 660, 560, C.card, { stroke: C.line, rx: 16 })}
${chip(106, 238, 'Cucumber.js on its own', C.failBg, C.fail)}
${t(106, 322, 'The problem', { s: 21, w: 600, c: C.ink3 })}
${left}
${r(780, 215, 740, 560, C.card, { stroke: C.accent, sw: 3, rx: 16 })}
${chip(806, 238, 'bddr', C.accentBg, C.accent)}
${f.right()}
${code(806, 760 - (f.snippet.length * 32 + 34), 690, f.snippet)}
${r(80, 810, 1440, 56, C.accent, { rx: 14 })}${t(800, 846, f.result, { a: 'middle', s: 23, w: 600, c: '#ffffff' })}
</svg>`;
  writeFileSync(join(out, `${f.slug}.svg`), svg);
}
console.log('wrote', FEATURES.length, 'images to', out);
