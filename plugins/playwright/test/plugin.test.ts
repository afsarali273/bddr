import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { EventBus, buildPlan, parseSpec, type BddrEvent } from '@bddr/core';
import { Executor, Given, getGlobalRegistry, resetGlobalRegistry } from '@bddr/runtime';
import { createPlaywrightPlugin, type PlaywrightPluginOptions } from '../src/index.js';

/** A fake `playwright` module that records what the plugin does. */
function fakePlaywright() {
  const calls: string[] = [];
  let pages = 0;
  const video = (id: number) => ({
    saveAs: async (p: string) => void calls.push(`video save ${id} ${p.split('/').slice(-2).join('/')}`),
    delete: async () => void calls.push(`video delete ${id}`),
  });
  const newPage = (ctxPages: unknown[], withVideo: boolean) => async () => {
    const id = ++pages;
    calls.push(`page ${id}`);
    const page = {
      id,
      url: '',
      async goto(u: string) {
        this.url = u;
      },
      isClosed: () => false,
      screenshot: async () => (calls.push(`screenshot ${id}`), new Uint8Array([137, 80, 78, 71])),
      video: () => (withVideo ? video(id) : null),
    };
    ctxPages.push(page);
    return page;
  };
  const browserType = (name: string) => {
    const make = () => ({
        newContext: async (o: Record<string, unknown>) => {
          calls.push(`context baseURL=${String(o['baseURL'] ?? '')}${o['recordVideo'] ? ' video' : ''}${o['isMobile'] ? ' mobile' : ''}${o['locale'] ? ` locale=${String(o['locale'])}` : ''}`);
          const ctxPages: unknown[] = [];
          return {
            newPage: newPage(ctxPages, !!o['recordVideo']),
            pages: () => ctxPages,
            setDefaultTimeout: (ms: number) => void calls.push(`timeout ${ms}`),
            setDefaultNavigationTimeout: (ms: number) => void calls.push(`nav timeout ${ms}`),
            tracing: {
              start: async () => void calls.push('trace start'),
              stop: async (x?: { path?: string }) => void calls.push(`trace stop${x?.path ? ` ${x.path.split('/').slice(-2).join('/')}` : ''}`),
            },
            close: async () => void calls.push('context close'),
          };
        },
        close: async () => void calls.push(`close ${name}`),
    });
    return {
      launch: async (opts: Record<string, unknown>) => {
        calls.push(`launch ${name} headless=${String(opts['headless'])}${opts['channel'] ? ` channel=${String(opts['channel'])}` : ''}`);
        return make();
      },
      connect: async (url: string) => (calls.push(`connect ${name} ${url}`), make()),
      connectOverCDP: async (url: string) => (calls.push(`cdp ${url}`), make()),
    };
  };
  const module = {
    chromium: browserType('chromium'),
    firefox: browserType('firefox'),
    webkit: browserType('webkit'),
    devices: { 'Pixel 7': { viewport: { width: 412, height: 915 }, isMobile: true } } as Record<string, unknown>,
    selectors: { setTestIdAttribute: (a: string) => void calls.push(`testid ${a}`) },
    request: {
      newContext: async (o: Record<string, unknown>) => {
        calls.push(`request baseURL=${String(o['baseURL'] ?? '')}`);
        return { get: async () => ({ status: () => 200 }), dispose: async () => void calls.push('request dispose') };
      },
    },
  };
  return { calls, load: async () => module as never };
}

async function run(options: PlaywrightPluginOptions, src: string, params: Record<string, string> = {}, workers = 1, expectLoader?: () => Promise<never>) {
  resetGlobalRegistry();
  const fake = fakePlaywright();
  const fakeExpect = Object.assign((v: unknown) => ({ v }), { configure: (c: { timeout: number }) => (fake.calls.push(`expect timeout ${c.timeout}`), fakeExpect) });
  const loadExpect = async () => ({ expect: fakeExpect as never });
  await createPlaywrightPlugin(fake.load, expectLoader ?? loadExpect).setup({ outputDir: '/tmp/bddr-pw-test', ...options });
  Given('I open {string}', async ({ page }, url: string) => page.goto(url));
  Given('the page fails', ({ page }) => {
    throw new Error(`failed on page ${String((page as unknown as { id: number }).id)}`);
  });
  Given('I call the API', async ({ request }) => assert.equal((await request.get('/health')).status(), 200));
  Given('no browser at all', () => {});
  Given('I assert with expect', async ({ expect, page }) => {
    await expect(page);
  });
  Given('I open a second user', async ({ newContext }) => {
    const other = await newContext({ locale: 'de-DE' });
    assert.ok(other);
  });
  const scenarios = parseSpec(src, 'pw.feature').scenarios;
  const bus = new EventBus({ keepHistory: true });
  const result = await new Executor({ registry: getGlobalRegistry(), bus, plan: buildPlan(scenarios, scenarios, { workers }), params }).execute(scenarios);
  const attachments = bus.history!.filter((e): e is Extract<BddrEvent, { type: 'attachment' }> => e.type === 'attachment');
  const logs = bus.history!.flatMap((e) => (e.type === 'log' ? [e.message] : []));
  const errors = bus.history!.flatMap((e) => (e.type === 'stepFinished' && e.error ? [e.error.message] : []));
  return { ...fake, result, attachments, logs, errors };
}

afterEach(() => void resetGlobalRegistry());

const TWO = 'Feature: F\n  Scenario: one\n    Given I open "/a"\n  Scenario: two\n    Given I open "/b"\n';

describe('@bddr/playwright', () => {
  it('one browser per worker, a context and page per scenario, closed in the right order', async () => {
    const { calls, result } = await run({}, TWO);
    assert.equal(result.success, true);
    assert.deepEqual(calls, [
      'launch chromium headless=true',
      'context baseURL=',
      'page 1',
      'context close',
      'context baseURL=',
      'page 2',
      'context close',
      'close chromium',
    ]);
  });

  it('API-only and plain scenarios never launch a browser', async () => {
    const { calls } = await run({ context: { baseURL: 'https://api.test' } }, 'Feature: F\n  Scenario: api\n    Given I call the API\n  Scenario: none\n    Given no browser at all\n');
    assert.deepEqual(calls, ['request baseURL=https://api.test', 'request dispose']);
  });

  it('screenshot only-on-failure (default) is attached to the failed scenario only', async () => {
    const { calls, attachments, result } = await run({}, 'Feature: F\n  Scenario: bad\n    Given the page fails\n  Scenario: good\n    Given I open "/x"\n');
    assert.equal(result.success, false);
    assert.deepEqual(calls.filter((c) => c.startsWith('screenshot')), ['screenshot 1']);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.mediaType, 'image/png');
    assert.equal(attachments[0]!.scenarioId, 'pw.feature::bad');
  });

  it('trace and video retained only on failure; a passing scenario discards them', async () => {
    const { calls, logs } = await run(
      { trace: 'only-on-failure', video: 'only-on-failure', screenshot: 'off' },
      'Feature: F\n  Scenario: bad\n    Given the page fails\n  Scenario: good\n    Given I open "/x"\n',
    );
    assert.ok(calls.includes('trace stop traces/pw.feature_bad.zip'));
    assert.ok(calls.includes('video save 1 videos/pw.feature_bad.webm'));
    assert.ok(calls.includes('video delete 2'));
    assert.equal(calls.filter((c) => c === 'trace stop').length, 1); // good: stopped without saving
    assert.ok(logs.some((l) => l.includes('npx playwright show-trace')));
    assert.ok(!calls.some((c) => c.startsWith('screenshot')));
  });

  it('-D browser / headed / baseURL override the config; options pass through', async () => {
    const { calls } = await run(
      { browser: 'chromium', channel: 'chrome', actionTimeoutMs: 5000, navigationTimeoutMs: 9000, context: { baseURL: 'https://prod' } },
      TWO,
      { browser: 'firefox', headed: 'true', baseURL: 'https://staging' },
    );
    assert.equal(calls[0], 'launch firefox headless=false'); // channel only applies to chromium
    assert.ok(calls.includes('context baseURL=https://staging'));
    assert.ok(calls.includes('timeout 5000') && calls.includes('nav timeout 9000'));
  });

  it('concurrent scenarios share the browser and get their own contexts', async () => {
    const src = `Feature: F\n${[1, 2, 3, 4].map((i) => `  Scenario: s${i}\n    Given I open "/${i}"\n`).join('')}`;
    const { calls, result } = await run({}, src, {}, 4);
    assert.equal(result.success, true);
    assert.equal(calls.filter((c) => c.startsWith('launch')).length, 1);
    assert.equal(calls.filter((c) => c.startsWith('context baseURL')).length, 4);
    assert.equal(calls.at(-1), 'close chromium');
  });

  it('rejects an unknown browser name with a clear message', async () => {
    const { result, errors } = await run({}, TWO, { browser: 'netscape' });
    assert.equal(result.success, false);
    assert.match(errors[0]!, /browser must be chromium, firefox, webkit \(got "netscape"\)/);
  });

  it('expect fixture: Playwright\'s expect, with expectTimeoutMs applied', async () => {
    const { calls, result } = await run({ expectTimeoutMs: 1234 }, 'Feature: F\n  Scenario: a\n    Given I assert with expect\n');
    assert.equal(result.success, true);
    assert.ok(calls.includes('expect timeout 1234'));
  });

  it('expect fixture explains how to install @playwright/test when it is missing', async () => {
    const { result, errors } = await run({}, 'Feature: F\n  Scenario: a\n    Given I assert with expect\n', {}, 1, async () => {
      throw new Error("Cannot find package '@playwright/test'");
    });
    assert.equal(result.success, false);
    assert.match(errors[0]!, /optional package @playwright\/test \(npm i -D @playwright\/test/);
  });

  it('device emulation: config or -D device; context options win; unknown device is an error', async () => {
    const a = await run({ device: 'Pixel 7', context: { locale: 'fr-FR' } }, TWO);
    assert.ok(a.calls.includes('context baseURL= mobile locale=fr-FR'));
    const b = await run({}, TWO, { device: 'Pixel 7' });
    assert.ok(b.calls.includes('context baseURL= mobile'));
    const c = await run({ device: 'Nokia 3310' }, TWO);
    assert.match(c.errors[0]!, /unknown device "Nokia 3310"/);
  });

  it('testIdAttribute, connect and cdpUrl are passed to Playwright', async () => {
    const a = await run({ testIdAttribute: 'data-test', connect: { wsEndpoint: 'ws://grid:3000' } }, TWO);
    assert.ok(a.calls.includes('testid data-test'));
    assert.ok(a.calls.includes('connect chromium ws://grid:3000'));
    assert.ok(!a.calls.some((c) => c.startsWith('launch')));
    const b = await run({ cdpUrl: 'http://localhost:9222' }, TWO);
    assert.ok(b.calls.includes('cdp http://localhost:9222'));
    const c = await run({ cdpUrl: 'http://x', browser: 'firefox' }, TWO);
    assert.match(c.errors[0]!, /cdpUrl needs browser "chromium"/);
  });

  it('newContext opens extra isolated contexts and closes them after the scenario', async () => {
    const { calls, result } = await run({}, 'Feature: F\n  Scenario: two users\n    Given I open a second user\n');
    assert.equal(result.success, true);
    assert.deepEqual(calls, ['launch chromium headless=true', 'context baseURL= locale=de-DE', 'context close', 'close chromium']);
  });

  const JOURNEY = (tags: string) => `${tags}
Feature: Journey
  Scenario: log in
    Given I open "/login"
  Scenario: browse
    Given the page fails
  Scenario: buy
    Given I open "/buy"
`;

  it("reuseContext 'serial': one context and page for a @serial feature; per-scenario screenshot on failure", async () => {
    const { calls, attachments, result } = await run({ reuseContext: 'serial' }, JOURNEY('@serial'));
    assert.equal(result.success, false);
    assert.deepEqual(calls, [
      'launch chromium headless=true',
      'context baseURL=',
      'page 1',
      'screenshot 1', // the failed scenario, from the shared page
      'context close', // only when the feature ends
      'close chromium',
    ]);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.scenarioId, 'pw.feature::browse');
  });

  it('a reused context keeps the trace for the whole feature when any scenario failed', async () => {
    const { calls } = await run({ reuseContext: 'serial', trace: 'only-on-failure', screenshot: 'off' }, JOURNEY('@serial'));
    assert.deepEqual(calls.filter((c) => c.startsWith('trace')), ['trace start', 'trace stop traces/pw.feature.zip']);
  });

  it('@reuseContext on a @serial feature works without the option; @freshContext opts out of it', async () => {
    const on = await run({}, JOURNEY('@serial @reuseContext'));
    assert.equal(on.calls.filter((c) => c.startsWith('context baseURL')).length, 1);
    const off = await run({ reuseContext: 'serial' }, JOURNEY('@serial @freshContext'));
    assert.equal(off.calls.filter((c) => c.startsWith('context baseURL')).length, 3);
  });

  it('default (off): a @serial feature still gets a fresh context per scenario', async () => {
    const { calls } = await run({}, JOURNEY('@serial'));
    assert.equal(calls.filter((c) => c.startsWith('context baseURL')).length, 3);
    assert.equal(calls.filter((c) => c === 'context close').length, 3);
  });

  it('@reuseContext without @serial is an error that says why', async () => {
    const { errors } = await run({}, JOURNEY('@reuseContext'));
    assert.match(errors[0]!, /@reuseContext on feature "Journey" needs @serial on the Feature/);
  });
});
