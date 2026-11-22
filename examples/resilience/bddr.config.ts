import { defineConfig } from '@bddr/cli';

/**
 * Resilience demo (Phase 4): scenario retry, group retry, flaky detection, quarantine,
 * soft assertions, scenario time budgets. Everything here passes (some only after retries).
 */
export default defineConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
  workers: 2,
  retry: { scenario: 0, delay: '20ms', on: ['ServiceUnavailable', '/timed out/'] },
  groups: {
    warmup: { mode: 'serial', retry: 1 }, // whole group re-runs once if any member fails
  },
  reporters: [
    'console',
    ['html', { outputFile: 'reports/report.html', title: 'Resilience demo' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
    ['ndjson', { outputFile: 'reports/events.ndjson' }],
  ],
});
