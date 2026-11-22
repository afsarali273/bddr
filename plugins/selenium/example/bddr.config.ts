import { defineConfig } from '@bddr/cli';
import { selenium } from '../src/index.js'; // in your project: import { selenium } from '@bddr/selenium';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: ['steps/**/*.ts', 'support/**/*.ts'],
  plugins: [
    selenium({
      browser: 'chrome', // -D browser=firefox, -D headed=true, -D server=http://grid:4444
      screenshot: 'only-on-failure',
      windowSize: { width: 1280, height: 800 },
      pageLoadTimeoutMs: 20_000,
      waitTimeoutMs: 8_000,
    }),
  ],
  workers: 2,
  reporters: ['progress', 'html:reports/report.html'],
});
