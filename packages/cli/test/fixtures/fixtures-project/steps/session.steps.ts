import { strict as assert } from 'node:assert';
import { appendFileSync } from 'node:fs';
import { Given, Then, defineFixture } from '@bddr/runtime';

declare module '@bddr/runtime' {
  interface Fixtures {
    session: { user?: string; pid: number };
  }
}

const note = (line: string) => process.env['BDDR_FX_LOG'] && appendFileSync(process.env['BDDR_FX_LOG'], `${line}\n`);

// Stands in for a shared browser context: one per feature, survives between the feature's scenarios.
defineFixture('session', () => (note(`session open ${process.pid}`), { pid: process.pid }), {
  scope: 'feature',
  afterScenario: (s, { status, ctx }) => note(`session after ${'scenario' in ctx ? ctx.scenario.name : '?'} ${status} ${s.pid}`),
  teardown: (s) => note(`session close ${s.pid}`),
});

Given('the session logs in as {string}', ({ session }, user: string) => {
  session.user = user;
});
Then('the session is still {string}', ({ session }, user: string) => {
  assert.equal(session.user, user);
});
