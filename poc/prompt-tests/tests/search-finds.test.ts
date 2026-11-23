// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: search-finds
// prompt: 197dbd15154c
// checks: 87cfad2d6587
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, check, expect }: any) => {
  ui.goto('/search');
  ui.fill({ role: 'textbox', label: 'Search' }, 'apple');
  ui.click({ role: 'button', name: 'Search' });
  const results = ui.texts({ role: 'listitem' });

  await check('C1', () => {
    expect(results).toContain('Apple');
    expect(results).toContain('Pineapple');
  });
  await check('C2', () => expect(results).not.toContain('Melon'));
};
