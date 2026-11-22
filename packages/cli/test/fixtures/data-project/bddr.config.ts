import { defineConfig } from '@bddr/cli';

export default defineConfig({
  dataDir: 'data',
  reporters: [['console', { colors: false }]],
  profiles: { ci: {} },
});
