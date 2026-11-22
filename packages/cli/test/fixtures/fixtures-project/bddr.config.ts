import { defineConfig } from '@bddr/cli';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
  plugins: [['./plugins/fake-browser.plugin.ts', { product: 'fakium' }]],
  workers: 2,
  logLevel: 'warn',
  reporters: ['progress'],
  groups: {
    checkout: { mode: 'serial' },
    search: { mode: 'parallel' },
  },
});
