// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: signup-invalid-email
// prompt: 914c1dcc674e
// checks: 66b20b3226b6
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  ui.goto('/signup');
  ui.fill({ role: 'textbox', label: 'Name' }, 'Bo');
  ui.fill({ role: 'textbox', label: 'Email' }, 'not-an-email');
  ui.fill({ role: 'textbox', label: 'Password' }, 'hunter22');
  ui.click({ role: 'button', name: 'Create account' });

  await check('C1', () => expect(ui.text({ role: 'alert' })).toBe('Enter a valid email'));
  await check('C2', () => expect(api.customerByEmail('not-an-email')).toBe(undefined));
};
