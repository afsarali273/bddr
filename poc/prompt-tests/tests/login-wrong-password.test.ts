// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: login-wrong-password
// prompt: b423c1dcc478
// checks: 2eb1516a3981
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  api.createCustomer({ name: 'Ann', email: 'ann@example.com', password: 'secret1', wallet: 0 });
  ui.goto('/login');
  ui.fill({ role: 'textbox', label: 'Email' }, 'ann@example.com');
  ui.fill({ role: 'textbox', label: 'Password' }, 'nope');
  ui.click({ role: 'button', name: 'Sign in' });

  await check('C1', () => expect(ui.text({ role: 'alert' })).toBe('Invalid email or password'));
  await check('C2', () => expect(ui.has({ role: 'heading', name: 'Welcome, Ann' })).toBe(false));
};
