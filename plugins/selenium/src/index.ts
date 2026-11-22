/**
 * @bddr/selenium: Selenium WebDriver for bddr, as a plugin. bddr does not depend on Selenium; your project does.
 *
 *   // bddr.config.ts
 *   import { selenium } from '@bddr/selenium';
 *   export default defineConfig({ plugins: [selenium({ browser: 'chrome', baseURL: 'https://shop.example.com' })] });
 *
 *   // steps
 *   Given('I open {string}', ({ open }, path: string) => open(path));
 *   When('I log in', async ({ driver, selenium: { By } }) => driver.findElement(By.css('#login')).click());
 *   class LoginPage { private driver = inject('driver'); }
 *
 * Fixtures:
 *   selenium     worker    the `selenium-webdriver` module (By, Key, until, Capabilities ...)
 *   driver       scenario  a fresh WebDriver (= one browser session) per scenario attempt; screenshot at the end
 *                          With `reuseSession` a @serial feature gets ONE driver for all its scenarios instead
 *                          (sharedDriver, feature scoped): log in once, keep cookies and the open page.
 *   open         scenario  `await open('/login')`: driver.get() relative to `baseURL`
 *   wait         scenario  `await wait(until.elementLocated(By.css('h1')))`: driver.wait() with the default timeout
 *   newDriver    scenario  `await newDriver({ browser: 'firefox' })`: extra sessions (a second user, another browser),
 *                          quit after the scenario
 *
 * Run-time overrides with -D: `-D browser=firefox`, `-D headed=true`, `-D baseURL=https://staging.example.com`,
 * `-D server=http://grid:4444` (a Selenium Grid / cloud endpoint).
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Condition, ThenableWebDriver, WebDriver, WebElement, WebElementCondition } from 'selenium-webdriver';
import { defineFixture, definePlugin, type BddrPlugin, type FeatureContext, type RunContext, type StepContext } from '@bddr/runtime';

type SeleniumModule = typeof import('selenium-webdriver');

declare module '@bddr/runtime' {
  interface Fixtures {
    selenium: SeleniumModule;
    driver: WebDriver;
    /** driver.get() relative to the plugin's `baseURL`. */
    open: (path?: string) => Promise<void>;
    /** driver.wait() with `waitTimeoutMs` as the default timeout. */
    wait: {
      /** `until.elementLocated(...)` and friends resolve to the element. */
      (condition: WebElementCondition, timeoutMs?: number, message?: string): Promise<WebElement>;
      <T>(condition: Condition<T> | ((driver: WebDriver) => T | Promise<T>), timeoutMs?: number, message?: string): Promise<T>;
    };
    /** Start an extra browser session (same options as `driver`, plus your overrides); quit after the scenario. */
    newDriver: (options?: Partial<DriverOptions>) => Promise<WebDriver>;
    /** The driver shared by a feature's scenarios when it reuses one (see `reuseSession`). */
    sharedDriver: WebDriver;
  }
}

export type BrowserName = 'chrome' | 'firefox' | 'edge' | 'safari';
/** `only-on-failure`: attached only when the scenario failed. */
export type ArtifactMode = 'off' | 'on' | 'only-on-failure';

/** What identifies one browser session; the plugin options minus the plugin-wide settings. */
export interface DriverOptions {
  /** Default 'chrome'. `-D browser=firefox` overrides. */
  browser: BrowserName;
  /** Default true (not supported by safari). `-D headed=true` overrides. */
  headless: boolean;
  /** Extra command line arguments for the browser ('--lang=de', '--incognito' ...). */
  args: string[];
  /** Extra W3C capabilities (merged over the plugin's; `goog:chromeOptions` / `moz:firefoxOptions` args are combined). */
  capabilities: Record<string, unknown>;
  /** Remote WebDriver endpoint: a Selenium Grid or cloud provider, 'http://grid:4444'. `-D server=` overrides. */
  server: string;
  /** Window size. */
  windowSize: { width: number; height: number };
}

export interface SeleniumPluginOptions extends Partial<DriverOptions> {
  /** Base of relative `open('/path')` calls. `-D baseURL=` overrides. */
  baseURL?: string;
  /** Implicit wait (ms) of every findElement. Default: Selenium's 0; prefer explicit `wait(until...)`. */
  implicitWaitMs?: number;
  /** Page load timeout (ms). Selenium's default is 300000. */
  pageLoadTimeoutMs?: number;
  /** Script timeout (ms). */
  scriptTimeoutMs?: number;
  /** Default timeout of the `wait` fixture (ms). Default 10000. */
  waitTimeoutMs?: number;
  /** Screenshot at the end of the scenario, attached to the report. Default 'only-on-failure'. */
  screenshot?: ArtifactMode;
  /**
   * Reuse one browser session for every scenario of a @serial feature (cookies, storage and the open page carry over;
   * the browser is quit when the feature ends). 'off' (default): a fresh session per scenario.
   * 'serial': every @serial feature reuses. Per feature: `@reuseSession` (needs @serial) / `@freshSession`.
   */
  reuseSession?: 'off' | 'serial';
}

const keep = (mode: ArtifactMode | undefined, status: string | undefined) => mode === 'on' || (mode === 'only-on-failure' && status === 'failed');
const bool = (v: string | undefined) => (v === undefined ? undefined : /^(1|true|yes|on)$/i.test(v));
const BROWSERS: readonly BrowserName[] = ['chrome', 'firefox', 'edge', 'safari'];

/** Vendor capability that carries the command line arguments, and the flag that makes the browser headless. */
const VENDOR: Record<Exclude<BrowserName, 'safari'>, { key: string; headless: string }> = {
  chrome: { key: 'goog:chromeOptions', headless: '--headless=new' },
  firefox: { key: 'moz:firefoxOptions', headless: '-headless' },
  edge: { key: 'ms:edgeOptions', headless: '--headless=new' },
};

/**
 * Load `selenium-webdriver` from the PROJECT (the working directory), not from wherever this plugin is installed.
 * Selenium checks `until.*` conditions with `instanceof`, so the driver and your own `import { until } from
 * 'selenium-webdriver'` must come from the same copy; with a linked or duplicated install they would not.
 */
async function loadProjectSelenium(): Promise<SeleniumModule> {
  try {
    return createRequire(join(process.cwd(), 'package.json'))('selenium-webdriver') as SeleniumModule;
  } catch {
    const mod = (await import('selenium-webdriver')) as SeleniumModule & { default?: SeleniumModule }; // CommonJS package
    return mod.Builder ? mod : (mod.default as SeleniumModule);
  }
}

/** Build the plugin. `load` is how the `selenium-webdriver` module is imported (tests pass a fake). */
export function createSeleniumPlugin(load: () => Promise<SeleniumModule> = loadProjectSelenium): BddrPlugin<SeleniumPluginOptions> {
  return definePlugin<SeleniumPluginOptions>({
    name: 'selenium',
    setup(o = {}) {
      const screenshot = o.screenshot ?? 'only-on-failure';
      const waitTimeout = o.waitTimeoutMs ?? 10_000;
      const baseURLOf = (ctx: { params: Readonly<Record<string, string>> }) => ctx.params['baseURL'] ?? o.baseURL;

      defineFixture('selenium', () => load(), { scope: 'worker' });

      /** Start one browser session. `extra` overrides the plugin options (newDriver). */
      const start = async (ctx: RunContext, extra: Partial<DriverOptions> = {}): Promise<WebDriver> => {
        const selenium = await ctx.fixture('selenium');
        const name = (extra.browser ?? ctx.params['browser'] ?? o.browser ?? 'chrome') as BrowserName;
        if (!BROWSERS.includes(name)) throw new Error(`@bddr/selenium: browser must be ${BROWSERS.join(', ')} (got "${name}")`);
        const headed = bool(ctx.params['headed']);
        const headless = extra.headless ?? (headed !== undefined ? !headed : (o.headless ?? true));
        const server = extra.server ?? ctx.params['server'] ?? o.server;

        const capabilities: Record<string, unknown> = { ...o.capabilities, ...extra.capabilities };
        if (name !== 'safari') {
          const vendor = VENDOR[name];
          const own = (capabilities[vendor.key] ?? {}) as { args?: string[] };
          capabilities[vendor.key] = {
            ...own,
            args: [...(own.args ?? []), ...(o.args ?? []), ...(extra.args ?? []), ...(headless ? [vendor.headless] : [])],
          };
        }

        // withCapabilities() replaces the builder's capabilities (browserName included), so it goes first.
        let builder = new selenium.Builder();
        if (Object.keys(capabilities).length > 0) builder = builder.withCapabilities(capabilities);
        builder = builder.forBrowser(name);
        if (server) builder = builder.usingServer(server);
        const driver = await (builder.build() as ThenableWebDriver);
        try {
          const timeouts = {
            ...(o.implicitWaitMs !== undefined ? { implicit: o.implicitWaitMs } : {}),
            ...(o.pageLoadTimeoutMs !== undefined ? { pageLoad: o.pageLoadTimeoutMs } : {}),
            ...(o.scriptTimeoutMs !== undefined ? { script: o.scriptTimeoutMs } : {}),
          };
          if (Object.keys(timeouts).length > 0) await driver.manage().setTimeouts(timeouts);
          const size = extra.windowSize ?? o.windowSize;
          if (size) await driver.manage().window().setRect({ width: size.width, height: size.height });
        } catch (e) {
          await driver.quit().catch(() => undefined);
          throw e;
        }
        return driver;
      };
      const quit = (driver: WebDriver) => driver.quit().catch(() => undefined);
      const screenshotTo = async (driver: WebDriver, status: string | undefined, ctx: RunContext) => {
        if (!keep(screenshot, status)) return;
        try {
          ctx.attach(Buffer.from(await driver.takeScreenshot(), 'base64'), 'image/png', `screenshot ${status ?? ''}`.trim());
        } catch (e) {
          ctx.log.warn(`@bddr/selenium: could not take a screenshot: ${e instanceof Error ? e.message : String(e)}`);
        }
      };

      const shared = new WeakSet<object>();
      const featureFailed = new WeakMap<object, boolean>();
      const opened = new WeakMap<object, WebDriver[]>();
      /** Does this scenario use the feature's shared driver? */
      const reuses = (ctx: StepContext): boolean => {
        const tags = ctx.featureInfo.tags.map((t) => t.name);
        if (tags.includes('@freshSession')) return false;
        const asked = tags.includes('@reuseSession');
        if (asked && ctx.scenario.serial !== 'feature') {
          throw new Error(
            `@reuseSession on feature "${ctx.featureInfo.name}" needs @serial on the Feature: scenarios sharing one browser session must run one at a time, in order`,
          );
        }
        return asked || (o.reuseSession === 'serial' && ctx.scenario.serial === 'feature');
      };

      defineFixture(
        'sharedDriver',
        async (ctx: FeatureContext) => {
          const driver = await start(ctx);
          shared.add(driver);
          return driver;
        },
        {
          scope: 'feature',
          afterScenario: async (driver, { status, ctx }) => {
            if (status === 'failed') featureFailed.set(driver, true);
            await screenshotTo(driver, status, ctx);
          },
          teardown: (driver) => quit(driver),
        },
      );

      defineFixture('driver', async (ctx: StepContext) => (reuses(ctx) ? ctx.fixture('sharedDriver') : start(ctx)), {
        teardown: async (driver, { status, ctx }) => {
          if (shared.has(driver)) return;
          await screenshotTo(driver, status, ctx);
          await quit(driver);
        },
      });

      defineFixture(
        'open',
        async (ctx: StepContext) => {
          const driver = await ctx.fixture('driver');
          const base = baseURLOf(ctx);
          return (path = '/') => driver.get(base ? new URL(path, base).href : path); // same rule as Playwright's baseURL
        },
      );

      defineFixture(
        'wait',
        async (ctx: StepContext) => {
          const driver = await ctx.fixture('driver');
          return ((condition: Parameters<WebDriver['wait']>[0], timeoutMs?: number, message?: string) =>
            driver.wait(condition, timeoutMs ?? waitTimeout, message)) as never;
        },
      );

      defineFixture(
        'newDriver',
        async (ctx: StepContext) => {
          const list: WebDriver[] = [];
          const make = async (options: Partial<DriverOptions> = {}) => {
            const driver = await start(ctx, options);
            list.push(driver);
            return driver;
          };
          opened.set(make, list);
          return make;
        },
        { teardown: async (make) => void (await Promise.all((opened.get(make) ?? []).map(quit))) },
      );
    },
  });
}

/** The plugin with Selenium from your project. Use as `plugins: ['@bddr/selenium']` or `plugins: [selenium({ ... })]`. */
const plugin = createSeleniumPlugin();
export default plugin;

/** Typed form for bddr.config.ts: `plugins: [selenium({ browser: 'firefox', screenshot: 'on' })]`. */
export function selenium(options: SeleniumPluginOptions = {}): { name: string; setup(): void | Promise<void> } {
  return { name: plugin.name, setup: () => plugin.setup(options) };
}
