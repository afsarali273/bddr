import { Before, Given } from '@bddr/runtime';

Given('duplicated', () => {});
Given('duplicated', () => {});
Given('never used', () => {});

Before({ tags: '@never' }, () => {});
