import { Given } from '@bddr/runtime';
Given('ok', () => {});
Given('the backend is up', (ctx) => {
  if (ctx.params['backend'] !== 'up') throw new Error('ServiceUnavailable: backend down');
});
