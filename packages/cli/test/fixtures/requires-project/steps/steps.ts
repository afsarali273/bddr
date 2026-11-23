import { Given } from '@bddr/runtime';

Given('a passing step', () => {});
Given('a failing step', () => {
  throw new Error('boom');
});
