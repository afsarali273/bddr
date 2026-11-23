import { defineConfig } from '@bddr/cli';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
  reporters: [['console', { colors: false }]],
  groups: {
    setup: {},
    reports: { dependsOn: ['setup'] },
  },
});
