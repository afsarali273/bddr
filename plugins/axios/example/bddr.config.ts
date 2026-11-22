import { defineConfig } from '@bddr/cli';
import { axios } from '../src/index.js'; // in your project: import { axios } from '@bddr/axios';

export default defineConfig({
  features: 'features/**/*.feature',
  steps: ['steps/**/*.ts', 'support/**/*.ts'],
  plugins: [
    axios({
      // no baseURL here: the local test server picks a free port, steps use `api` via the shop fixture's url
      headers: { 'x-client': 'bddr-example' },
      auth: { bearer: 'secret' }, // -D token=other overrides it
      attach: 'only-on-failure', // the call log of a failed scenario is attached to the report
    }),
  ],
  workers: 3,
  reporters: ['progress', 'html:reports/report.html'],
});
