import { Before, Given, When, defineFixture } from '@bddr/runtime';

Given('a plain step', () => {});
Given('I have {int} apples', (_ctx, _n: number) => {});
When(/^I eat (\d+) of them$/i, (_ctx, _n: string) => {});
Given('a slow step', { tags: '@slow', timeoutMs: 5000 }, () => {});
Before({ tags: '@db' }, () => {});
defineFixture('db', () => ({}), { scope: 'worker' });
defineFixture('repo', ({ db }: any) => db, { scope: 'scenario' });
