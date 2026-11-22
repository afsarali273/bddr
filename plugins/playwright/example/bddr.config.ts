import { defineConfig } from '@bddr/cli';
import { playwright } from '../src/index.js'; // in your project: import { playwright } from '@bddr/playwright';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: ['steps/**/*.ts', 'support/**/*.ts'],
  plugins: [
    playwright({
      browser: 'chromium',
      screenshot: 'only-on-failure',
      trace: 'only-on-failure',
      actionTimeoutMs: 5000,
      outputDir: 'reports/playwright',
    }),
  ],
  workers: 2,
  reporters: ['progress', 'html:reports/report.html'],
  groups: { checkout: { mode: 'serial' } },
});
