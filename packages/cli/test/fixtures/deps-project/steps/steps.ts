import { Given } from '@bddr/runtime';

Given('a passing step', () => {});
Given('a failing step', () => {
  throw new Error('boom');
});
Given('a slow step', () => new Promise((resolve) => setTimeout(resolve, 40)));
Given('I export {string}', (ctx, value: string) => ctx.export('value', value));
Given('I read the export of {string} and expect {string}', (ctx, id: string, expected: string) => {
  const actual = ctx.from(id).get<string>('value');
  if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
});
