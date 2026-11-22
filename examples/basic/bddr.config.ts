import { defineConfig } from '@bddr/cli';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
  dataDir: 'data',
  tags: 'not @wip',
  params: { currency: 'SGD' },
  reporters: [
    'console',
    ['html', { outputFile: 'reports/report.html', title: 'Shop examples' }],
    ['ndjson', { outputFile: 'reports/events.ndjson' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
  ],
  profiles: {
    ci: { reporters: ['progress', 'junit:reports/junit.xml'], failFast: true },
    smoke: { tags: '@smoke' },
    qa: { tags: '@data-driven' },
  },
});
