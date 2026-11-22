import { strict as assert } from 'node:assert';
import { CONTEXT, Given, Steps, Then, When, inject, type DataTable } from '@bddr/runtime';
import { SauceInventoryPage, SauceLoginPage } from '../pages/saucedemo.page.js';

@Steps()
export class SauceDemoSteps {
  private login = inject(SauceLoginPage);
  private inventory = inject(SauceInventoryPage);
  private ctx = inject(CONTEXT);

  @Given('the SauceDemo login page is open')
  open() {
    return this.login.open(this.ctx.params['sauceBaseUrl']!);
  }

  @When('I sign in to SauceDemo as {string} with password {string}')
  signIn(username: string, password: string) {
    return this.login.logIn(username, password);
  }

  @Then('the SauceDemo inventory page is displayed')
  async inventoryDisplayed() {
    await this.inventory.waitUntilVisible();
  }

  @Then('the SauceDemo login error contains {string}')
  async loginError(text: string) {
    assert.ok((await this.login.error()).includes(text));
  }

  @Then('SauceDemo displays {int} inventory products')
  async count(expected: number) {
    assert.equal((await this.inventory.names()).length, expected);
  }

  @When('I sort SauceDemo inventory by {string}')
  sort(label: string) {
    return this.inventory.sortBy(label);
  }

  @Then('the first SauceDemo product is {string}')
  async first(expected: string) {
    assert.equal((await this.inventory.names())[0], expected);
  }

  @When('I add these SauceDemo products to the cart:')
  async addAll(table: DataTable) {
    for (const row of table.hashes()) await this.inventory.addProduct(row['product'] ?? '');
  }

  @Then('the SauceDemo cart badge is {int}')
  async badge(expected: number) {
    assert.equal(await this.inventory.badge(), String(expected));
  }

  @Then('the SauceDemo cart contains:')
  async cartContains(table: DataTable) {
    const names = await this.inventory.openCart();
    for (const row of table.hashes()) assert.ok(names.includes(row['product'] ?? ''), `cart is missing ${row['product']}`);
  }
}
