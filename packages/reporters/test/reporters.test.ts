import { describe, expect, it } from 'vitest';
import { EventBus, parseSpec } from '@bddr/core';
import { Executor, SupportRegistry, type StepContext } from '@bddr/runtime';
import { consoleReporter, createReporter, junitReporter } from '@bddr/reporters';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FEATURE = `Feature: Login & <stuff>
  Scenario: good
    Given ok
  Scenario: bad
    Given ok
    When it breaks
  Scenario: missing
    Given I click "Save" 3 times
`;

async function runWith(...reporters: ReturnType<typeof consoleReporter>[]) {
  const r = new SupportRegistry();
  r.defineStep('ok', () => {});
  r.defineStep('it breaks', (_c: StepContext) => {
    throw new Error('expected <200> got "500"');
  });
  const bus = new EventBus();
  for (const rep of reporters) bus.on((e) => rep.onEvent(e));
  await new Executor({ registry: r, bus }).execute(parseSpec(FEATURE, 'login.feature').scenarios);
  await bus.flush();
  for (const rep of reporters) await rep.close?.();
}

describe('console reporter', () => {
  it('prints scenarios, failing steps, failures, snippets and a summary', async () => {
    let out = '';
    await runWith(consoleReporter({ colors: false, write: (t: string) => void (out += t) }));
    expect(out).toContain('✔ good');
    expect(out).toContain('✘ bad');
    expect(out).toContain('✘ When it breaks');
    expect(out).toContain('Failures:');
    expect(out).toContain(`Given('I click {string} {int} times', async (ctx, string: string, int: number) => {`);
    expect(out).toContain('3 scenarios (1 passed, 1 failed, 1 undefined)');
    expect(out).toContain('FAILED');
  });

  it('progress style prints one char per scenario', async () => {
    let out = '';
    await runWith(consoleReporter({ colors: false, style: 'progress', write: (t: string) => void (out += t) }));
    expect(out.startsWith('.✘?')).toBe(true);
  });
});

describe('junit reporter: run-level hook failures', () => {
  it('reports a failed BeforeWorker hook as an errored testcase so CI goes red', async () => {
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    r.defineHook('worker', 'before', {}, () => {
      throw new Error('browser missing');
    });
    const dir = mkdtempSync(join(tmpdir(), 'bddr-junit-hook-'));
    const file = join(dir, 'j.xml');
    const rep = junitReporter({ outputFile: file });
    const bus = new EventBus();
    bus.on((e) => rep.onEvent(e));
    await new Executor({ registry: r, bus }).execute(parseSpec('Feature: F\n  Scenario: s\n    Given ok\n', 'f.feature').scenarios);
    await bus.flush();
    await rep.close?.();
    const xml = readFileSync(file, 'utf8');
    expect(xml).toMatch(/<testsuites [^>]*errors="1"/);
    expect(xml).toContain('<testsuite name="Hooks"');
    expect(xml).toContain('<error type="hook" message="browser missing">');
  });
});

describe('junit reporter', () => {
  it('writes escaped XML with failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-junit-'));
    const file = join(dir, 'out', 'junit.xml');
    await runWith(junitReporter({ outputFile: file }));
    const xml = readFileSync(file, 'utf8');
    expect(xml).toContain('<testsuites name="bddr" tests="3" failures="2" skipped="0"');
    expect(xml).toContain('name="Login &amp; &lt;stuff&gt;"');
    expect(xml).toContain('<failure type="failed" message="expected &lt;200&gt; got &quot;500&quot;">');
    expect(xml).toContain('<failure type="undefined"');
  });
});

describe('createReporter', () => {
  it('parses name:file shorthand and rejects unknown names', () => {
    expect(createReporter('junit:x.xml').name).toBe('junit');
    expect(createReporter(['ndjson', { outputFile: 'a.ndjson' }]).name).toBe('ndjson');
    expect(() => createReporter('nope')).toThrow(/Unknown reporter "nope"/);
  });
});

describe('cucumber-json reporter', () => {
  it('writes features > elements > steps with statuses and nanosecond durations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-cj-'));
    const file = join(dir, 'cucumber.json');
    const { cucumberJsonReporter } = await import('@bddr/reporters');
    await runWith(cucumberJsonReporter({ outputFile: file }));
    const json = JSON.parse(readFileSync(file, 'utf8')) as Array<{
      name: string;
      uri: string;
      elements: Array<{ name: string; keyword: string; steps: Array<{ keyword: string; name: string; result: { status: string; duration: number; error_message?: string } }> }>;
    }>;
    expect(json).toHaveLength(1);
    expect(json[0]!.name).toBe('Login & <stuff>');
    expect(json[0]!.elements.map((e) => e.name)).toEqual(['good', 'bad', 'missing']);
    expect(json[0]!.elements[0]!.keyword).toBe('Scenario');
    const bad = json[0]!.elements[1]!.steps;
    expect(bad.map((s) => s.result.status)).toEqual(['passed', 'failed']);
    expect(bad[1]!.result.error_message).toContain('expected <200>');
    expect(json[0]!.elements[2]!.steps[0]!.result.status).toBe('undefined');
    expect(typeof bad[0]!.result.duration).toBe('number');
  });
});

describe('console reporter log levels', () => {
  const logEvents = (consoleOpts: Record<string, unknown>) => {
    let out = '';
    const rep = consoleReporter({ colors: false, write: (t: string) => void (out += t), ...consoleOpts });
    rep.onEvent({ ts: 0, type: 'planReady', scenarios: [{ id: 's', name: 'S', uri: 'x.feature', line: 1, featureName: 'F', tags: [], steps: [] }] });
    rep.onEvent({ ts: 0, type: 'log', level: 'info', source: 'user', message: 'run-level info' });
    rep.onEvent({ ts: 0, type: 'log', level: 'debug', source: 'user', message: 'dbg', scenarioId: 's', data: { k: 1 } });
    rep.onEvent({ ts: 0, type: 'log', level: 'warn', source: 'user', message: 'careful', scenarioId: 's' });
    rep.onEvent({ ts: 0, type: 'log', level: 'debug', source: 'bddr', message: 'start s on w1', scenarioId: 's' });
    rep.onEvent({ ts: 0, type: 'scenarioFinished', scenarioId: 's', attempt: 1, status: 'passed', durationMs: 1 });
    return out;
  };
  it('defaults to info and prints scenario logs under the scenario', () => {
    const out = logEvents({});
    expect(out).toContain('✔ S');
    expect(out).toContain('      [warn] careful');
    expect(out).toContain('[info] run-level info');
    expect(out).not.toContain('dbg');
    expect(out).not.toContain('start s on w1');
  });
  it('warn hides info', () => {
    expect(logEvents({ logLevel: 'warn' })).not.toContain('run-level info');
  });
  it('debug shows everything, framework logs tagged bddr:debug, data inline', () => {
    const out = logEvents({ logLevel: 'debug' });
    expect(out).toContain('[info] run-level info');
    expect(out).toContain('[debug] dbg {"k":1}');
    expect(out).toContain('[bddr:debug] start s on w1');
  });
  it('silent hides logs', () => {
    expect(logEvents({ logLevel: 'silent' })).not.toContain('careful');
  });
});

describe('logs and images in file reports', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

  async function richRun(...reporters: ReturnType<typeof consoleReporter>[]) {
    const r = new SupportRegistry();
    r.defineStep('ok <x>', () => {});
    r.defineStep('shop', (c: StepContext) => {
      c.log.info('cart <ready>', { items: 2 });
      c.log.debug('internal');
      c.log.image('cart page', PNG, { name: 'cart.png' });
      c.log.warn('slow ]]> response', PNG);
      c.attach('{"a":1}', 'application/json', 'payload');
    });
    r.defineStep('boom', () => {
      throw new Error('kaput & <gone>');
    });
    r.defineHook('scenario', 'before', {}, (c) => c.log.info(`hook for ${c.scenario.name}`));
    const bus = new EventBus();
    for (const rep of reporters) bus.on((e) => rep.onEvent(e));
    const src = 'Feature: Rich\n  Scenario: buy\n    Given shop\n  Scenario: broken\n    Given boom\n';
    await new Executor({ registry: r, bus }).execute(parseSpec(src, 'rich.feature').scenarios);
    await bus.flush();
    for (const rep of reporters) await rep.close?.();
  }

  it('HTML: self-contained page with logs (levels), log images, attachments, errors, escaping', async () => {
    const { htmlReporter } = await import('@bddr/reporters');
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html-'));
    const file = join(dir, 'r.html');
    await richRun(htmlReporter({ outputFile: file, title: 'My <Run>' }));
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('<title>My &lt;Run&gt;</title>');
    expect(html).toContain('FAILED');
    expect(html).toContain('<span class="msg">cart &lt;ready&gt;</span>');
    expect(html).toContain('class="log lv-debug"');
    expect(html).toContain('class="log lv-warn"');
    expect(html).toMatch(/class="logimg"[^>]*><img[^>]*alt="cart.png" src="data:image\/png;base64,/);
    expect(html).toContain('📎 payload');
    expect(html).toContain('kaput &amp; &lt;gone&gt;');
    expect(html).toContain('hook for buy'); // scenario-level (hook) log
    expect(html).not.toMatch(/<script[^>]+src=/); // no external assets
  });

  it('JUnit: logs in system-out / system-err, CDATA-safe, step names prefixed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-junit2-'));
    const file = join(dir, 'j.xml');
    await richRun(junitReporter({ outputFile: file }));
    const xml = readFileSync(file, 'utf8');
    expect(xml).toContain('<system-out><![CDATA[[info] hook for buy\nGiven shop: [info] cart <ready> {"items":2}\nGiven shop: [info] cart page [image: cart.png, 29 B]]]></system-out>');
    expect(xml).toContain('<system-err><![CDATA[Given shop: [warn] slow ]]]]><![CDATA[> response [image: image/png, 29 B]]]></system-err>');
    expect(xml).not.toContain('[debug] internal'); // debug below default 'info'
  });

  it('Cucumber JSON: step output lines, log images as embeddings, hook logs in before', async () => {
    const { cucumberJsonReporter } = await import('@bddr/reporters');
    const dir = mkdtempSync(join(tmpdir(), 'bddr-cj2-'));
    const file = join(dir, 'c.json');
    await richRun(cucumberJsonReporter({ outputFile: file, logLevel: 'debug' }));
    const [feature] = JSON.parse(readFileSync(file, 'utf8')) as Array<{
      elements: Array<{ before?: Array<{ output: string[] }>; steps: Array<{ output?: string[]; embeddings?: Array<{ mime_type: string; name?: string }> }> }>;
    }>;
    const buy = feature!.elements[0]!;
    expect(buy.before![0]!.output).toEqual(['[info] hook for buy']);
    expect(buy.steps[0]!.output).toEqual([
      '[info] cart <ready> {"items":2}',
      '[debug] internal',
      '[info] cart page [image: cart.png, 29 B]',
      '[warn] slow ]]> response [image: image/png, 29 B]',
    ]);
    expect(buy.steps[0]!.embeddings!.map((e) => `${e.mime_type}:${e.name}`)).toEqual([
      'application/json:payload',
      'image/png:cart.png',
      'image/png:slow ]]> response',
    ]);
  });
});

describe('stack trimming', () => {
  it('drops bddr-internal and node-internal frames, keeps user frames', async () => {
    const { trimStack } = await import('../src/html.js');
    const stack = [
      'Error: boom',
      '    at Object.fn (/proj/steps/a.steps.ts:3:9)',
      '    at file:///x/node_modules/@bddr/runtime/dist/executor.js:5:1',
      '    at /repo/packages/runtime/src/executor.ts:10:2',
      '    at AsyncLocalStorage.run (node:internal/async_local_storage/async_hooks:91:14)',
    ].join('\n');
    expect(trimStack(stack)).toBe('Error: boom\n    at Object.fn (/proj/steps/a.steps.ts:3:9)');
  });
});

describe('HTML report v2 views', () => {
  it('timeline lanes, dependency graph, history with trend and flaky score', async () => {
    const { buildPlan } = await import('@bddr/core');
    const { htmlReporter } = await import('@bddr/reporters');
    const r = new SupportRegistry();
    let calls = 0;
    r.defineStep('ok', () => new Promise((res) => setTimeout(res, 5)));
    r.defineStep('flaky', () => {
      if (++calls === 1) throw new Error('first time');
    });
    const spec = parseSpec(
      `Feature: V2
  @id:setup
  Scenario: Setup
    Given ok
  @dependsOn:setup @retry:1
  Scenario: Uses setup
    Given flaky
  @dependsOn:setup:soft
  Scenario: Soft user
    Given ok
`,
      'v2.feature',
    );
    const plan = buildPlan(spec.scenarios, spec.scenarios, { workers: 2 });
    const previous = [false, true].map((pass, n) => ({
      v: 1 as const,
      runId: `old-${n}`,
      startedAt: n + 1,
      durationMs: 5,
      success: pass,
      workers: 1,
      scenarios: { [spec.scenarios[1]!.id]: { s: pass ? ('passed' as const) : ('failed' as const), d: 3, n: 'Uses setup' } },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html2-'));
    const file = join(dir, 'r.html');
    const rep = htmlReporter({ outputFile: file, history: previous });
    const bus = new EventBus();
    bus.on((e) => rep.onEvent(e));
    await new Executor({ registry: r, bus, plan }).execute(spec.scenarios);
    await rep.close?.();
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('<summary>Timeline</summary>');
    expect(html).toMatch(/class="tl-lane">w1</);
    expect(html).toContain('tb-retried'); // failed attempt that was retried
    expect(html).toContain('<summary>Dependencies</summary>');
    expect(html).toContain('class="g-edge soft"');
    expect(html).toContain('<summary>History</summary>');
    expect(html).toContain('flaky score'); // failed → passed → flaky this run
    expect(html).toMatch(/<i class="h-fail"[^>]*><\/i><i class="h-pass"[^>]*><\/i><i class="h-flaky"/);
    expect(html).toMatch(/href="#sc-1"/); // timeline/graph link to the scenario card
    expect(html).toContain('id="sc-1"');
  });

  it('no history section without previous runs; no graph without dependencies', async () => {
    const { htmlReporter } = await import('@bddr/reporters');
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html3-'));
    const file = join(dir, 'r.html');
    await runWith(htmlReporter({ outputFile: file }));
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('<summary>Timeline</summary>');
    expect(html).not.toContain('<summary>Dependencies</summary>');
    expect(html).not.toContain('<summary>History</summary>');
  });
});

describe('html reporter v3: statistics, tabs and sharing', () => {
  async function mixedHtml() {
    const { htmlReporter } = await import('@bddr/reporters');
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html4-'));
    const file = join(dir, 'r.html');
    await runWith(htmlReporter({ outputFile: file, title: 'Stats </script> run' }));
    return readFileSync(file, 'utf8');
  }

  it('has Overview/Results/Execution tabs and a stats overview with KPIs, causes and breakdowns', async () => {
    const html = await mixedHtml();
    expect(html).toContain('data-tab="overview"');
    expect(html).toContain('data-tab="results"');
    expect(html).toContain('data-tab="execution"');
    expect(html).not.toContain('data-tab="history"'); // no history recorded
    expect(html).toContain('33.3%'); // 1 of 3 passed
    expect(html).toContain('Failures grouped by cause');
    expect(html).toContain('expected &lt;200&gt; got &quot;500&quot;');
    expect(html).toContain('Scenario results');
    expect(html).toContain('By feature');
    expect(html).toContain('class="donut"');
  });

  it('embeds the results as JSON that cannot break out of the script tag', async () => {
    const html = await mixedHtml();
    const m = /<script type="application\/json" id="bddr-data">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    const payload = JSON.parse(m![1]!) as { title: string; success: boolean; summary: string; scenarios: Array<{ name: string; status: string }>; stats: { total: number } };
    expect(payload.title).toBe('Stats </script> run');
    expect(payload.success).toBe(false);
    expect(payload.stats.total).toBe(3);
    expect(payload.scenarios.map((x) => `${x.name}:${x.status}`)).toEqual(['good:passed', 'bad:failed', 'missing:undefined']);
    expect(payload.summary).toContain('FAILED');
    expect(html.match(/<\/script>/g)!.length).toBe(2); // data + behaviour only
  });

  it('computeStats: pass rate, percentiles, histogram, failure clusters (numbers normalised) and breakdowns', async () => {
    const { computeStats, summaryText } = await import('@bddr/reporters');
    const plan = [1, 2, 3, 4].map((n) => ({
      id: `s${n}`, name: `sc${n}`, uri: n < 3 ? 'a.feature' : 'b.feature', line: n, featureName: n < 3 ? 'A' : 'B',
      tags: n === 1 ? ['@x'] : [], steps: [{ id: `st${n}`, keyword: 'Given ', text: 'x', line: n }],
    }));
    const fin = (id: string, status: string, durationMs: number, message?: string) =>
      [id, { type: 'scenarioFinished', scenarioId: id, status, durationMs, attempt: 1, ...(message ? { error: { name: 'Error', message } } : {}) }] as const;
    const results = new Map([fin('s1', 'passed', 50), fin('s2', 'failed', 300, 'HTTP 500 after 3 tries'), fin('s3', 'failed', 700, 'HTTP 502 after 9 tries'), fin('s4', 'skipped', 0)]);
    const stats = computeStats({ plan, results: results as never, steps: new Map(), retries: new Map(), intervals: [], workers: 2, history: [] });
    expect(stats.total).toBe(4);
    expect(stats.executed).toBe(3);
    expect(stats.passRate).toBeCloseTo(1 / 3);
    expect(stats.duration).toMatchObject({ p50: 300, max: 700 });
    expect(stats.histogram.find((h) => h.label === '<100ms')!.count).toBe(1);
    expect(stats.clusters).toHaveLength(1); // 500 and 502 differ only by digits -> one cause
    expect(stats.clusters[0]!.scenarios.map((x) => x.id)).toEqual(['s2', 's3']);
    expect(stats.slowest[0]!.id).toBe('s3');
    expect(stats.byFeature.map((r) => `${r.label}:${r.counts.failed}`)).toEqual(['A:1', 'B:1']);
    expect(stats.byTag).toHaveLength(1);
    expect(summaryText('T', false, '', stats)).toMatch(/pass rate 33\.3%[\s\S]*Failures \(2\):[\s\S]*2× HTTP 500/);
  });

  it('shows a History tab and a delta vs the previous run when history exists', async () => {
    const { htmlReporter } = await import('@bddr/reporters');
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html5-'));
    const file = join(dir, 'r.html');
    const previous = [{ v: 1 as const, runId: 'old', startedAt: 1, durationMs: 100, success: true, workers: 1, scenarios: { a: { s: 'passed' as const, d: 1, n: 'a' }, b: { s: 'passed' as const, d: 1, n: 'b' }, c: { s: 'passed' as const, d: 1, n: 'c' } } }];
    await runWith(htmlReporter({ outputFile: file, history: previous }));
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('data-tab="history"');
    expect(html).toContain('id="tab-history"');
    expect(html).toContain('vs previous run');
  });
});

describe('dependency graph: standalone scenarios', () => {
  it('counts scenarios without dependencies instead of drawing them', async () => {
    const { renderGraph } = await import('../src/html-views.js');
    const sc = (id: string, dependsOn?: Array<{ id: string; soft: boolean }>) => ({
      id, name: id, uri: 'f.feature', line: 1, featureName: 'F', tags: [], steps: [], ...(dependsOn ? { dependsOn } : {}),
    });
    const plan = [sc('a'), sc('b', [{ id: 'a', soft: false }]), sc('c'), sc('d')];
    const html = renderGraph(plan, [], () => 'passed', (id) => `sc-${id}`);
    expect(html).toContain('2 of 4 scenarios have no dependencies and are not drawn here.');
    expect(html).not.toContain('>c<');
    const all = renderGraph([sc('a'), sc('b', [{ id: 'a', soft: false }])], [], () => 'passed', (id) => id);
    expect(all).not.toContain('no dependencies');
  });
});

describe('html report: data-driven scenarios and step arguments', () => {
  const FEATURE_DATA = `Feature: Pricing
  Scenario Outline: Total for <qty> <item>
    Given the catalogue:
      | item  | price |
      | apple | 0.50  |
    When I add <qty> "<item>"
    Then ok

    Examples: cheap
      | item  | qty |
      | apple | 2   |
      | pear  | 4   |

    Examples: expensive
      | item  | qty |
      | melon | 1   |

  Scenario: With a doc string
    Given a doc:
      \"\"\"json
      {"a": 1}
      \"\"\"
`;

  async function dataHtml() {
    const { htmlReporter } = await import('@bddr/reporters');
    const r = new SupportRegistry();
    r.defineStep('the catalogue:', () => {});
    r.defineStep('I add {int} {string}', (_c: StepContext, qty: number, item: string) => {
      if (item === 'pear') throw new Error(`no ${item} x${qty}`);
    });
    r.defineStep('ok', () => {});
    r.defineStep('a doc:', () => {});
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html6-'));
    const file = join(dir, 'r.html');
    const rep = htmlReporter({ outputFile: file });
    const bus = new EventBus();
    bus.on((e) => rep.onEvent(e));
    await new Executor({ registry: r, bus }).execute(parseSpec(FEATURE_DATA, 'p.feature').scenarios);
    await bus.flush();
    await rep.close?.();
    return readFileSync(file, 'utf8');
  }

  it('renders one colour-coded table per Examples block with the outline template', async () => {
    const html = await dataHtml();
    expect(html.match(/class="dataset"/g)).toHaveLength(2); // cheap + expensive
    expect(html).toContain('Examples: cheap');
    expect(html).toContain('Examples: expensive');
    expect(html).toContain('<code class="ph">&lt;qty&gt;</code>'); // title / template placeholders
    expect(html).toContain('Scenario template');
    expect(html).toContain('<span class="dc" data-label="item" title="item: pear">pear</span>');
    expect(html).toContain('class="dc-err">no pear x4</span>'); // failing row shows its error inline
    expect(html).toMatch(/<span class="pill st-failed">1 failed<\/span>/);
  });

  it('renders step data tables and doc strings with the step status', async () => {
    const html = await dataHtml();
    expect(html).toContain('<table class="argtable" style="--st:var(--passed)"><thead><tr><th>item</th><th>price</th></tr></thead><tbody><tr><td>apple</td><td>0.50</td></tr>');
    expect(html).toContain('class="docstring"');
    expect(html).toContain('<span class="dmt">json</span>');
  });

  it('rows stay searchable by their data values', async () => {
    const html = await dataHtml();
    expect(html).toMatch(/data-text="[^"]*melon[^"]*"/);
  });

  it('plan events carry step arguments (additive schema change)', async () => {
    const events: Array<{ type: string; scenarios?: Array<{ steps: Array<{ arg?: { kind: string } }> }> }> = [];
    const bus = new EventBus();
    bus.on((e) => void events.push(e as never));
    const r = new SupportRegistry();
    r.defineStep('the catalogue:', () => {});
    r.defineStep('I add {int} {string}', () => {});
    r.defineStep('ok', () => {});
    r.defineStep('a doc:', () => {});
    await new Executor({ registry: r, bus }).execute(parseSpec(FEATURE_DATA, 'p.feature').scenarios);
    await bus.flush();
    const plan = events.find((e) => e.type === 'planReady')!;
    expect(plan.scenarios![0]!.steps[0]!.arg!.kind).toBe('dataTable');
  });
});

describe('html report: responsive layout and UX hooks', () => {
  it('ships viewport meta, a sticky tab bar, phone breakpoints, labelled data cells, empty state and back-to-top', async () => {
    const { htmlReporter } = await import('@bddr/reporters');
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html7-'));
    const file = join(dir, 'r.html');
    await runWith(htmlReporter({ outputFile: file }));
    const html = readFileSync(file, 'utf8');
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain('<nav class="tabbar">');
    expect(html).toContain('@media (max-width:720px)');
    expect(html).toContain('@media (max-width:520px)');
    expect(html).toContain('id="nomatch"');
    expect(html).toContain('id="totop"');
    expect(html).toContain('id="shown"');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('data cells carry data-label for the stacked phone layout', async () => {
    const { htmlReporter } = await import('@bddr/reporters');
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html8-'));
    const file = join(dir, 'r.html');
    const r = new SupportRegistry();
    r.defineStep('I add {int}', () => {});
    const rep = htmlReporter({ outputFile: file });
    const bus = new EventBus();
    bus.on((e) => rep.onEvent(e));
    await new Executor({ registry: r, bus }).execute(
      parseSpec('Feature: F\n  Scenario Outline: add <qty>\n    Given I add <qty>\n    Examples:\n      | qty |\n      | 3   |\n', 'f.feature').scenarios,
    );
    await bus.flush();
    await rep.close?.();
    expect(readFileSync(file, 'utf8')).toContain('<span class="dc" data-label="qty" title="qty: 3">3</span>');
  });
});

describe('html report: wide data sets scroll sideways', () => {
  async function htmlFor(columns: number) {
    const { htmlReporter } = await import('@bddr/reporters');
    const names = Array.from({ length: columns }, (_, i) => `c${i + 1}`);
    const feature = `Feature: Wide\n  Scenario Outline: row <c1>\n    Given ok\n    Examples:\n      | ${names.join(' | ')} |\n      | ${names.map((_, i) => i + 1).join(' | ')} |\n`;
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    const dir = mkdtempSync(join(tmpdir(), 'bddr-html9-'));
    const file = join(dir, 'r.html');
    const rep = htmlReporter({ outputFile: file });
    const bus = new EventBus();
    bus.on((e) => rep.onEvent(e));
    await new Executor({ registry: r, bus }).execute(parseSpec(feature, 'w.feature').scenarios);
    await bus.flush();
    await rep.close?.();
    return readFileSync(file, 'utf8');
  }

  it('more than 5 parameters: scrolling grid with pinned status + row number and a hint', async () => {
    const html = await htmlFor(14);
    expect(html).toContain('<div class="dgrid wide"');
    expect(html).toContain('14 columns');
    expect(html).toContain('↔ scroll sideways');
    expect(html).toContain('<span class="pin">');
    expect(html).toMatch(/--minw:\d{4}px/); // grid is wider than a phone
  });

  it('5 or fewer parameters keep the compact layout (stacked cards on phones)', async () => {
    const html = await htmlFor(4);
    expect(html).toContain('<div class="dgrid"');
    expect(html).not.toContain('<div class="dgrid wide"');
    expect(html).not.toContain('scroll sideways</span>');
  });
});
