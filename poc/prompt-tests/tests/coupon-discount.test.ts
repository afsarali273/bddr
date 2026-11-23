// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: coupon-discount
// prompt: 7552c96c6f23
// checks: 8a75f1cae3ff
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  const customer = api.createCustomer({ name: 'Di', email: 'di@example.com', password: 'pw', wallet: 50.0 });
  api.loginAs(customer.id);
  ui.goto('/shop');
  ui.click({ role: 'button', name: 'Add Melon to basket' });
  ui.goto('/basket');
  ui.fill({ role: 'textbox', label: 'Coupon' }, 'SAVE10');
  ui.click({ role: 'button', name: 'Apply' });

  await check('C1', () => expect(ui.text({ role: 'status', name: 'Total' })).toBe('18.00'));

  ui.click({ role: 'button', name: 'Pay 18.00' });
  await check('C2', () => expect(api.walletBalance(customer.id)).toBeCloseTo(32.0));
};
