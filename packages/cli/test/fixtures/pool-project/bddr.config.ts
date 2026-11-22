import { defineConfig } from '@bddr/cli';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: 'steps/**/*.ts',
  workers: 2,
  pool: 'process',
  logLevel: 'warn',
  reporters: ['console'],
});
