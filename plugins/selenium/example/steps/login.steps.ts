import { strict as assert } from 'node:assert';
import { Given, Steps, Then, When, inject } from '@bddr/runtime';
import { LoginPage } from '../pages/login.page.js';

// Class style: inject() the page object.
@Steps()
export class LoginSteps {
  private login = inject(LoginPage);

  @Given('I am on the login page')
  async open() {
    await this.login.open();
    await this.login.waitUntilReady();
  }

  @When('I log in as {string} with {string}')
  logIn(user: string, password: string) {
    return this.login.logIn(user, password);
  }

  @Then('I see {string}')
  async sees(text: string) {
    assert.equal(await this.login.message(), text);
  }

  @Then('the page title is {string}')
  async title(title: string) {
    assert.equal(await this.login.title(), title);
  }
}

// Function style: destructure the fixtures. `newDriver` starts a second browser session.
Then('a second browser session is not logged in', async ({ newDriver, shop, selenium: { By } }) => {
  const other = await newDriver();
  await other.get(`${shop.url}/login`);
  assert.equal(await other.findElement(By.css('#msg')).getText(), '');
});
