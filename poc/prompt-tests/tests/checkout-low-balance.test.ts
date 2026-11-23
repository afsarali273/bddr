// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: checkout-low-balance
// prompt: b513a14d03ee
// checks: c60efcab8263
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  const customer = api.createCustomer({ name: 'Cy', email: 'cy@example.com', password: 'pw', wallet: 5.0 });
  api.loginAs(customer.id);
  ui.goto('/shop');
  ui.click({ role: 'button', name: 'Add Apple to basket' });
  ui.goto('/basket');
  ui.click({ role: 'button', name: 'Pay 7.50' });

  await check('C1', () => expect(ui.text({ role: 'alert' })).toBe('Insufficient funds'));
  await check('C2', () => expect(api.walletBalance(customer.id)).toBeCloseTo(5.0));
  await check('C3', () => expect(api.orders(customer.id)).toHaveLength(0));
};
