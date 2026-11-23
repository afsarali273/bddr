// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: coupon-invalid
// prompt: a2be58cd5c25
// checks: 475a8fe0b023
// built: 2026-11-24, compiled by hand by Claude (no model is reachable in the POC environment)
export default async ({ ui, api, check, expect }: any) => {
  const customer = api.createCustomer({ name: 'Ed', email: 'ed@example.com', password: 'pw', wallet: 50.0 });
  api.loginAs(customer.id);
  ui.goto('/shop');
  ui.click({ role: 'button', name: 'Add Melon to basket' });
  ui.goto('/basket');
  ui.fill({ role: 'textbox', label: 'Coupon' }, 'BOGUS');
  ui.click({ role: 'button', name: 'Apply' });

  await check('C1', () => expect(ui.text({ role: 'alert' })).toBe('Coupon not valid'));
  await check('C2', () => expect(ui.text({ role: 'status', name: 'Total' })).toBe('20.00'));
};
