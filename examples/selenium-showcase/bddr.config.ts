import { defineConfig } from '@bddr/cli';
import { selenium } from '@bddr/selenium';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: ['src/support/hooks.ts', 'src/steps/**/*.ts'],
  // Browser, driver per scenario, screenshots on failure: all from the plugin.
  // Other browser: -D browser=firefox. Watch it: -D headed=true. Remote grid: -D server=http://grid:4444
  plugins: [
    selenium({
      browser: 'chrome',
      baseURL: 'https://the-internet.herokuapp.com',
      screenshot: 'only-on-failure',
      windowSize: { width: 1440, height: 900 },
      pageLoadTimeoutMs: 30_000,
      waitTimeoutMs: 10_000,
    }),
  ],
  workers: 3,
  pool: 'process',
  scenarioTimeout: '1m',
  runTimeout: '10m',
  params: {
    sauceBaseUrl: 'https://www.saucedemo.com',
  },
  retry: { scenario: 1, delay: '500ms', on: ['TimeoutError', 'WebDriverError', '/ECONNRESET/', '/fetch failed/'] },
  groups: {
    theInternet: { match: '@the-internet', mode: 'parallel', workers: 2, timeout: '5m' },
    sauceDemo: { match: '@saucedemo', mode: 'parallel', workers: 2, timeout: '5m' },
  },
  validation: {
    allowedTagKeys: ['alerts', 'auth', 'browser', 'dynamic', 'forms', 'journey', 'owner', 'reuseSession', 'saucedemo', 'serial', 'smoke', 'the-internet', 'ui'],
  },
  reporters: ['console', ['html', { outputFile: 'reports/report.html', title: 'bddr + Selenium showcase' }], ['junit', { outputFile: 'reports/junit.xml', suiteName: 'bddr-selenium-showcase' }]],
  profiles: {
    ci: { reporters: ['progress', 'junit:reports/junit.xml'], logLevel: 'warn' },
    smoke: { tags: '@smoke' },
  },
});
