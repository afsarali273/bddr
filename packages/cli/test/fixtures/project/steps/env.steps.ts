import { Given } from '@bddr/runtime';

Given('the env is {string}', (ctx, expected: string) => {
  const actual = ctx.params['env'];
  if (actual !== expected) throw new Error(`env is "${actual}", expected "${expected}"`);
});
