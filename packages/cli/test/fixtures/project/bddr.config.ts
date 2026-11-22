import { defineConfig } from '@bddr/cli';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
  tags: 'not @wip',
  reporters: [['console', { colors: false }]],
  params: { env: 'local' },
  profiles: {
    green: { tags: '@green' },
  },
});
