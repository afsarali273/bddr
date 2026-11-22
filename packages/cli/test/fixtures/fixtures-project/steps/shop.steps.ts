import { strict as assert } from 'node:assert';
import { CONTEXT, Given, Steps, Then, When, defineFixture, inject } from '@bddr/runtime';
import type { FakePage } from '../plugins/fake-browser.plugin.js';

/** A page object: gets its page from the fixture, no constructor wiring. */
export class ShopPage {
  private page = inject('page');
  open(path: string) {
    this.page.url = `https://shop.test${path}`;
  }
  get url() {
    return this.page.url;
  }
}

declare module '@bddr/runtime' {
  interface Fixtures {
    shop: ShopPage;
  }
}
// a page object as a fixture too, for function steps
defineFixture('shop', ({ page }) => Object.assign(new ShopPage(), { page }) as unknown as ShopPage);

// Function style: destructure what you need.
Given('the shop is open at {string}', ({ page, browser }, path: string) => {
  assert.equal(browser.product, 'fakium');
  page.url = `https://shop.test${path}`;
});

Then('the url ends with {string}', ({ page }, end: string) => {
  assert.ok(page.url.endsWith(end), `${page.url} should end with ${end}`);
});

let flakyFailures = 0;
When('a flaky click happens', ({ page }) => {
  if (flakyFailures++ === 0) throw new Error(`first click on ${page.id} fails`);
});

// Class style: inject(), no static inject list, no getters.
@Steps()
export class CheckoutSteps {
  private shop = inject(ShopPage);
  private ctx = inject(CONTEXT);

  @Given('I am on the checkout page')
  openCheckout() {
    this.shop.open('/checkout');
    this.ctx.state.set('visited', this.shop.url);
  }

  @Then('the checkout url is shown')
  checkUrl() {
    assert.equal(this.shop.url, 'https://shop.test/checkout');
    assert.equal(this.ctx.state.get('visited'), this.shop.url);
  }
}

export type { FakePage };

Given('nothing browser related', () => {});
