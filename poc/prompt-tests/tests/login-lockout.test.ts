// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: login-lockout
// prompt: 924d804a8e31
// checks: aa7fee51166b
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  api.createCustomer({ name: 'Ann', email: 'ann@example.com', password: 'secret1', wallet: 0 });
  ui.goto('/login');
  for (let attempt = 1; attempt <= 3; attempt++) {
    ui.fill({ role: 'textbox', label: 'Email' }, 'ann@example.com');
    ui.fill({ role: 'textbox', label: 'Password' }, 'nope');
    ui.click({ role: 'button', name: 'Sign in' });
  }
  await check('C1', () => expect(ui.text({ role: 'alert' })).toBe('Account locked'));

  ui.fill({ role: 'textbox', label: 'Email' }, 'ann@example.com');
  ui.fill({ role: 'textbox', label: 'Password' }, 'secret1');
  ui.click({ role: 'button', name: 'Sign in' });
  await check('C2', () => expect(ui.text({ role: 'alert' })).toBe('Account locked'));
};
