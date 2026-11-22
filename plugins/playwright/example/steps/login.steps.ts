import { strict as assert } from 'node:assert';
import { Given, Steps, Then, When, inject } from '@bddr/runtime';
import { LoginPage } from '../pages/login.page.js';

// Class style: inject() the page object.
@Steps()
export class LoginSteps {
  private login = inject(LoginPage);

  @Given('I am on the login page')
  open() {
    return this.login.open();
  }

  @When('I log in as {string} with {string}')
  logIn(user: string, password: string) {
    return this.login.logIn(user, password);
  }

  @Then('I see {string}')
  async sees(text: string) {
    assert.equal(await this.login.message(), text);
  }
}

// Function style: destructure the fixtures.
Then('the page title is {string}', async ({ page }, title: string) => {
  assert.equal(await page.title(), title);
});
