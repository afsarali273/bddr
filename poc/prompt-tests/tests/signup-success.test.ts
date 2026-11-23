// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: signup-success
// prompt: 1edff875c8d0
// checks: f1763179b119
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  ui.goto('/signup');
  ui.fill({ role: 'textbox', label: 'Name' }, 'Bo');
  ui.fill({ role: 'textbox', label: 'Email' }, 'bo@example.com');
  ui.fill({ role: 'textbox', label: 'Password' }, 'hunter22');
  ui.click({ role: 'button', name: 'Create account' });

  await check('C1', () => expect(ui.has({ role: 'heading', name: 'Welcome, Bo' })).toBe(true));
  await check('C2', () => expect(api.customerByEmail('bo@example.com')?.name).toBe('Bo'));
};
