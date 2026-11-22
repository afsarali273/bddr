import { strict as assert } from 'node:assert';
import { Given, Then, When, type DataTable } from '@bddr/runtime';
import { SauceDemoCartPage, SauceDemoInventoryPage, SauceDemoLoginPage, SauceDemoProductPage } from '../pages/saucedemo.page.js';
import { requiredParam } from '../support/world.js';

Given('the SauceDemo login page is open', async (ctx) => {
  await new SauceDemoLoginPage(ctx.page).open(requiredParam(ctx, 'sauceBaseUrl'));
});

Given('I am signed in to SauceDemo as {string}', async (ctx, username: string) => {
  const loginPage = new SauceDemoLoginPage(ctx.page);
  await loginPage.open(requiredParam(ctx, 'sauceBaseUrl'));
  await loginPage.login(username, 'secret_sauce');
  await new SauceDemoInventoryPage(ctx.page).waitUntilVisible();
});

When('I sign in to SauceDemo as {string} with password {string}', async (ctx, username: string, password: string) => {
  await new SauceDemoLoginPage(ctx.page).login(username, password);
});

Then('the SauceDemo inventory page is displayed', async (ctx) => {
  await ctx.expect(ctx.page).toHaveURL(/\/inventory\.html$/);
  await new SauceDemoInventoryPage(ctx.page).waitUntilVisible();
});

Then('the SauceDemo login error contains {string}', async (ctx, expected: string) => {
  await ctx.expect(new SauceDemoLoginPage(ctx.page).error).toContainText(expected);
});

When('I log out of SauceDemo', async (ctx) => {
  await new SauceDemoLoginPage(ctx.page).logout();
});

Then('the SauceDemo login page is displayed', async (ctx) => {
  await ctx.expect(ctx.page).toHaveURL(/\/$/);
  await new SauceDemoLoginPage(ctx.page).waitUntilVisible();
});

Then('SauceDemo displays {int} inventory products', async (ctx, expected: number) => {
  await ctx.expect(new SauceDemoInventoryPage(ctx.page).items).toHaveCount(expected);
});

When('I sort SauceDemo inventory by {string}', async (ctx, label: string) => {
  await new SauceDemoInventoryPage(ctx.page).sortBy(label);
});

Then('the first SauceDemo product is {string}', async (ctx, expected: string) => {
  await ctx.expect(new SauceDemoInventoryPage(ctx.page).firstName).toHaveText(expected);
});

When('I open SauceDemo product {string}', async (ctx, product: string) => {
  await new SauceDemoInventoryPage(ctx.page).openProduct(product);
});

Then('the SauceDemo product detail name is {string}', async (ctx, expected: string) => {
  const ids: Record<string, string> = {
    'Sauce Labs Backpack': '4',
    'Sauce Labs Bike Light': '0',
    'Sauce Labs Bolt T-Shirt': '1',
  };
  const productPage = new SauceDemoProductPage(ctx.page);
  assert.equal(productPage.pathname(), '/inventory-item.html');
  assert.equal(productPage.productId(), ids[expected]);
});

When('I add SauceDemo product {string} to the cart', async (ctx, product: string) => {
  await new SauceDemoInventoryPage(ctx.page).addProduct(product);
});

When('I add these SauceDemo products to the cart:', async (ctx, table: DataTable) => {
  await new SauceDemoInventoryPage(ctx.page).addProducts(table.hashes().map((row) => row['product'] ?? ''));
});

Then('the SauceDemo cart badge is {int}', async (ctx, expected: number) => {
  await ctx.expect(new SauceDemoInventoryPage(ctx.page).badge).toHaveText(String(expected));
});

Then('the SauceDemo cart contains {string}', async (ctx, product: string) => {
  const cartPage: SauceDemoCartPage = await new SauceDemoInventoryPage(ctx.page).openCart();
  const names = await cartPage.productNames();
  assert.ok(names.includes(product));
});
