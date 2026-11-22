import { defineConfig } from '@bddr/cli';
import { axios } from '@bddr/axios';
import { playwright } from '@bddr/playwright';

const uiBaseUrl = 'https://the-internet.herokuapp.com';
const apiBaseUrl = 'https://jsonplaceholder.typicode.com';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: ['src/support/hooks.ts', 'src/steps/**/*.ts'],
  dataDir: 'data',
  // Browser per worker, context + page per scenario, API request context: all from the plugin.
  // Run headed with -D headed=true, another browser with -D browser=firefox.
  plugins: [
    axios({ baseURL: apiBaseUrl, attach: 'only-on-failure' }), // API client for mixed UI + API scenarios: `api`
    playwright({
      browser: 'chromium',
      screenshot: 'only-on-failure',
      trace: 'only-on-failure', // reports/playwright/traces/*.zip, open with: npx playwright show-trace <file>
      testIdAttribute: 'data-test', // SauceDemo's test ids: page.getByTestId('login-button')
      expectTimeoutMs: 7_000, // retrying `expect` assertions
      actionTimeoutMs: 10_000,
      context: { baseURL: uiBaseUrl, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } },
      request: {
        baseURL: apiBaseUrl,
        extraHTTPHeaders: { Accept: 'application/json', 'User-Agent': 'bddr-playwright-showcase' },
        timeout: 15_000,
      },
    }),
  ],
  workers: 4,
  pool: 'process',
  stepTimeoutMs: 15_000,
  scenarioTimeout: '45s',
  runTimeout: '5m',
  logLevel: 'info',
  params: {
    uiBaseUrl,
    apiBaseUrl,
    sauceBaseUrl: 'https://www.saucedemo.com',
    todoBaseUrl: 'https://demo.playwright.dev/todomvc',
    dummyApiBaseUrl: 'https://dummyjson.com',
    independentUiBaseUrl: 'https://playwright.dev',
    independentApiBaseUrl: 'https://httpbin.org',
  },
  retry: {
    scenario: 1,
    delay: '250ms',
    backoff: 2,
    workerCrash: 1,
    on: ['TimeoutError', '/ECONNRESET/', '/fetch failed/', '/socket hang up/', '/controlled transient/'],
  },
  groups: {
    health: { match: '@health', mode: 'serial', priority: -100, timeout: '1m' },
    theInternet: { match: '@the-internet', mode: 'parallel', workers: 2, dependsOn: ['health'], timeout: '3m' },
    jsonPlaceholder: { match: '@jsonplaceholder', mode: 'parallel', workers: 3, dependsOn: ['health'], timeout: '2m' },
    sauceDemo: {
      match: '@saucedemo',
      mode: 'serial',
      dependsOn: ['health'],
      locks: ['saucedemo-standard-user'],
      timeout: '3m',
    },
    todoMvc: { match: '@todomvc', mode: 'parallel', workers: 2, dependsOn: ['health'], timeout: '2m' },
    dummyJson: { match: '@dummyjson', mode: 'serial', dependsOn: ['health'], timeout: '2m' },
    mixed: { match: '@mixed', mode: 'parallel', workers: 2, dependsOn: ['health'], timeout: '3m' },
  },
  validation: {
    allowedTagKeys: [
      'api', 'capture', 'dummyjson', 'health', 'jsonplaceholder', 'owner', 'saucedemo', 'smoke',
      'the-internet', 'todomvc', 'ui',
      'independent', 'plugin', 'reuseContext', 'mixed',
    ],
  },
  reporters: [
    'console',
    ['html', { outputFile: 'reports/report.html', title: 'bddr + Playwright showcase' }],
    ['junit', { outputFile: 'reports/junit.xml', suiteName: 'bddr-playwright-showcase' }],
    ['ndjson', { outputFile: 'reports/events.ndjson' }],
  ],
  profiles: {
    ci: {
      reporters: ['progress', 'junit:reports/junit.xml', 'ndjson:reports/events.ndjson'],
      logLevel: 'warn',
      failFast: true,
    },
    ui: { tags: '@ui' },
    api: { tags: '@api' },
    smoke: { tags: '@smoke' },
  },
});
