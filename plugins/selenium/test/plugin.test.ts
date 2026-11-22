import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { EventBus, buildPlan, parseSpec, type BddrEvent } from '@bddr/core';
import { Executor, Given, getGlobalRegistry, resetGlobalRegistry } from '@bddr/runtime';
import { createSeleniumPlugin, type SeleniumPluginOptions } from '../src/index.js';

/** A fake `selenium-webdriver` module that records what the plugin does. */
function fakeSelenium() {
  const calls: string[] = [];
  let drivers = 0;
  class Builder {
    private browser = '';
    private caps: Record<string, unknown> = {};
    private server = '';
    forBrowser(name: string) {
      this.browser = name;
      return this;
    }
    withCapabilities(caps: Record<string, unknown>) {
      this.caps = caps;
      this.browser = ''; // like the real Builder: replaces everything, browserName included
      return this;
    }
    usingServer(url: string) {
      this.server = url;
      return this;
    }
    build() {
      if (!this.browser) throw new Error('Target browser must be a string, but is <undefined>; did you forget to call forBrowser()?');
      const id = ++drivers;
      const args = Object.values(this.caps).flatMap((v) => ((v as { args?: string[] }).args ?? []));
      calls.push(`start ${id} ${this.browser}${args.length ? ` args=${args.join(',')}` : ''}${this.server ? ` server=${this.server}` : ''}`);
      const driver = {
        id,
        url: '',
        get: async (u: string) => {
          driver.url = u;
          calls.push(`get ${id} ${u}`);
        },
        manage: () => ({
          setTimeouts: async (t: Record<string, number>) => void calls.push(`timeouts ${JSON.stringify(t)}`),
          window: () => ({ setRect: async (r: { width: number; height: number }) => void calls.push(`rect ${r.width}x${r.height}`) }),
        }),
        wait: async (_c: unknown, timeout: number) => (calls.push(`wait ${timeout}`), 'ok'),
        takeScreenshot: async () => (calls.push(`screenshot ${id}`), Buffer.from([137, 80, 78, 71]).toString('base64')),
        quit: async () => void calls.push(`quit ${id}`),
      };
      return driver;
    }
  }
  return { calls, load: async () => ({ Builder }) as never };
}

async function run(options: SeleniumPluginOptions, src: string, params: Record<string, string> = {}, workers = 1) {
  resetGlobalRegistry();
  const fake = fakeSelenium();
  await createSeleniumPlugin(fake.load).setup(options);
  Given('I open {string}', async ({ open }, path: string) => open(path));
  Given('the driver fails', ({ driver }) => {
    throw new Error(`failed on driver ${String((driver as unknown as { id: number }).id)}`);
  });
  Given('I wait', async ({ wait }) => {
    assert.equal(await wait(() => true), 'ok');
  });
  Given('I start a second browser', async ({ newDriver }) => {
    assert.ok(await newDriver({ browser: 'firefox', args: ['--lang=de'] }));
  });
  Given('no browser at all', () => {});
  const scenarios = parseSpec(src, 'sel.feature').scenarios;
  const bus = new EventBus({ keepHistory: true });
  const result = await new Executor({ registry: getGlobalRegistry(), bus, plan: buildPlan(scenarios, scenarios, { workers }), params }).execute(scenarios);
  const attachments = bus.history!.filter((e): e is Extract<BddrEvent, { type: 'attachment' }> => e.type === 'attachment');
  const errors = bus.history!.flatMap((e) => (e.type === 'stepFinished' && e.error ? [e.error.message] : []));
  return { ...fake, result, attachments, errors };
}

afterEach(() => void resetGlobalRegistry());

const TWO = 'Feature: F\n  Scenario: one\n    Given I open "/a"\n  Scenario: two\n    Given I open "/b"\n';

describe('@bddr/selenium', () => {
  it('a headless driver per scenario, quit after each', async () => {
    const { calls, result } = await run({ baseURL: 'https://shop.test' }, TWO);
    assert.equal(result.success, true);
    assert.deepEqual(calls, [
      'start 1 chrome args=--headless=new',
      'get 1 https://shop.test/a',
      'quit 1',
      'start 2 chrome args=--headless=new',
      'get 2 https://shop.test/b',
      'quit 2',
    ]);
  });

  it('scenarios that use no browser start none', async () => {
    const { calls } = await run({}, 'Feature: F\n  Scenario: none\n    Given no browser at all\n');
    assert.deepEqual(calls, []);
  });

  it('screenshot only-on-failure (default) is attached to the failed scenario only', async () => {
    const { calls, attachments, result } = await run({}, 'Feature: F\n  Scenario: bad\n    Given the driver fails\n  Scenario: good\n    Given I open "/x"\n');
    assert.equal(result.success, false);
    assert.deepEqual(calls.filter((c) => c.startsWith('screenshot')), ['screenshot 1']);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.mediaType, 'image/png');
    assert.equal(attachments[0]!.scenarioId, 'sel.feature::bad');
    assert.ok(calls.indexOf('screenshot 1') < calls.indexOf('quit 1')); // taken before the browser closes
  });

  it('-D browser / headed / server / baseURL override the config; extra args and capabilities are combined', async () => {
    const { calls } = await run(
      { browser: 'chrome', baseURL: 'https://prod', args: ['--lang=fr'], capabilities: { 'moz:firefoxOptions': { args: ['-private'] } } },
      TWO,
      { browser: 'firefox', headed: 'true', server: 'http://grid:4444', baseURL: 'https://staging' },
    );
    assert.equal(calls[0], 'start 1 firefox args=-private,--lang=fr server=http://grid:4444'); // headed: no -headless
    assert.ok(calls.includes('get 1 https://staging/a'));
  });

  it('timeouts, window size and the wait default are applied', async () => {
    const { calls, result } = await run(
      { implicitWaitMs: 100, pageLoadTimeoutMs: 20000, windowSize: { width: 1280, height: 800 }, waitTimeoutMs: 3000 },
      'Feature: F\n  Scenario: a\n    Given I wait\n',
    );
    assert.equal(result.success, true);
    assert.ok(calls.includes('timeouts {"implicit":100,"pageLoad":20000}'));
    assert.ok(calls.includes('rect 1280x800'));
    assert.ok(calls.includes('wait 3000'));
  });

  it('rejects an unknown browser name with a clear message', async () => {
    const { result, errors } = await run({}, TWO, { browser: 'netscape' });
    assert.equal(result.success, false);
    assert.match(errors[0]!, /browser must be chrome, firefox, edge, safari \(got "netscape"\)/);
  });

  it('newDriver starts extra sessions and quits them after the scenario', async () => {
    const { calls, result } = await run({}, 'Feature: F\n  Scenario: two browsers\n    Given I open "/a"\n    And I start a second browser\n');
    assert.equal(result.success, true);
    assert.deepEqual(calls.filter((c) => c.startsWith('start')), ['start 1 chrome args=--headless=new', 'start 2 firefox args=--lang=de,-headless']);
    assert.equal(calls.filter((c) => c.startsWith('quit')).length, 2);
  });

  it('concurrent scenarios each get their own driver', async () => {
    const src = `Feature: F\n${[1, 2, 3, 4].map((i) => `  Scenario: s${i}\n    Given I open "/${i}"\n`).join('')}`;
    const { calls, result } = await run({}, src, {}, 4);
    assert.equal(result.success, true);
    assert.equal(calls.filter((c) => c.startsWith('start')).length, 4);
    assert.equal(calls.filter((c) => c.startsWith('quit')).length, 4);
  });

  const JOURNEY = (tags: string) => `${tags}
Feature: Journey
  Scenario: log in
    Given I open "/login"
  Scenario: browse
    Given the driver fails
  Scenario: buy
    Given I open "/buy"
`;

  it("reuseSession 'serial': one driver for a @serial feature; per-scenario screenshot; quit when the feature ends", async () => {
    const { calls, attachments, result } = await run({ reuseSession: 'serial' }, JOURNEY('@serial'));
    assert.equal(result.success, false);
    assert.equal(calls.filter((c) => c.startsWith('start')).length, 1);
    assert.deepEqual(calls.filter((c) => c.startsWith('quit')), ['quit 1']);
    assert.equal(calls.at(-1), 'quit 1');
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.scenarioId, 'sel.feature::browse');
  });

  it('@reuseSession on a @serial feature works without the option; @freshSession opts out of it', async () => {
    const on = await run({}, JOURNEY('@serial @reuseSession'));
    assert.equal(on.calls.filter((c) => c.startsWith('start')).length, 1);
    const off = await run({ reuseSession: 'serial' }, JOURNEY('@serial @freshSession'));
    assert.equal(off.calls.filter((c) => c.startsWith('start')).length, 3);
  });

  it('default (off): a @serial feature still gets a fresh driver per scenario', async () => {
    const { calls } = await run({}, JOURNEY('@serial'));
    assert.equal(calls.filter((c) => c.startsWith('start')).length, 3);
  });

  it('@reuseSession without @serial is an error that says what to do', async () => {
    const { result, errors } = await run({}, JOURNEY('@reuseSession'));
    assert.equal(result.success, false);
    assert.match(errors[0]!, /@reuseSession on feature "Journey" needs @serial/);
  });
});
