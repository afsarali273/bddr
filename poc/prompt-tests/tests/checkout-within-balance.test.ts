// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: checkout-within-balance
// prompt: 5bfc48de12b7
// checks: ce5fd9782cdb
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  const ann = api.createCustomer({ name: 'Ann', email: 'ann@example.com', password: 'secret1', wallet: 20.0 });
  api.loginAs(ann.id);
  ui.goto('/shop');
  ui.click({ role: 'button', name: 'Add Apple to basket' });
  ui.goto('/basket');
  ui.click({ role: 'button', name: 'Pay 7.50' });

  await check('C1', () => expect(ui.has({ role: 'heading', name: 'Payment received' })).toBe(true));
  await check('C2', () => expect(api.walletBalance(ann.id)).toBeCloseTo(12.5));
  await check('C3', () => expect(api.orders(ann.id)).toHaveLength(1));
};
