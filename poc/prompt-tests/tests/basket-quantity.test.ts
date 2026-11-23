// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: basket-quantity
// prompt: 65a13471d95b
// checks: 2a91b409ef71
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  const customer = api.createCustomer({ name: 'Fay', email: 'fay@example.com', password: 'pw', wallet: 0 });
  api.loginAs(customer.id);
  ui.goto('/shop');
  for (let i = 0; i < 3; i++) ui.click({ role: 'button', name: 'Add Apple to basket' });
  ui.goto('/basket');

  await check('C1', () => expect(ui.text({ role: 'status', name: 'Total' })).toBe('22.50'));
  await check('C2', () => expect(ui.texts({ role: 'listitem' })).toEqual(['Apple x3']));
};
