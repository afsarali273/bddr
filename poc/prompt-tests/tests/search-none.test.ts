// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: search-none
// prompt: 0b2e495da703
// checks: 872787667aa0
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, check, expect }: any) => {
  ui.goto('/search');
  ui.fill({ role: 'textbox', label: 'Search' }, 'zzz');
  ui.click({ role: 'button', name: 'Search' });

  await check('C1', () => expect(ui.text({ role: 'alert' })).toBe('No products found'));
  await check('C2', () => expect(ui.texts({ role: 'listitem' })).toHaveLength(0));
};
