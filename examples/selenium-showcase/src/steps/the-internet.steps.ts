import { strict as assert } from 'node:assert';
import { Given, Steps, Then, When, inject } from '@bddr/runtime';
import type { WebDriver } from 'selenium-webdriver';
import { LoginPage } from '../pages/login.page.js';

// Function style: destructure what the step needs. `open`, `wait`, `driver` and `selenium` come from the plugin.

Given('I open {string}', async ({ open }, path: string) => open(path));

Then('the current path is {string}', async ({ driver, wait }, expected: string) => {
  await wait(async () => new URL(await driver.getCurrentUrl()).pathname === expected, 8000, `path never became ${expected}`);
});

// ---- Authentication: class style, the page object is injected
@Steps()
export class AuthSteps {
  private login = inject(LoginPage);

  @When('I log in with username {string} and password {string}')
  logIn(username: string, password: string) {
    return this.login.logIn(username, password);
  }

  @When('I log out')
  logOut() {
    return this.login.logOut();
  }

  @Then('the flash message contains {string}')
  flash(text: string) {
    return this.login.flashContains(text);
  }
}

// ---- Forms
const checkboxes = (driver: WebDriver, By: typeof import('selenium-webdriver').By) => driver.findElements(By.css('input[type="checkbox"]'));

Then('checkbox {int} is {word}', async ({ driver, selenium: { By } }, number: number, state: string) => {
  const box = (await checkboxes(driver, By))[number - 1]!;
  assert.equal(await box.isSelected(), state === 'checked');
});

When('I set checkbox {int} to {word}', async ({ driver, selenium: { By } }, number: number, state: string) => {
  const box = (await checkboxes(driver, By))[number - 1]!;
  if ((await box.isSelected()) !== (state === 'checked')) await box.click();
});

When('I select dropdown option {string}', async ({ driver, selenium: { By } }, option: string) => {
  await driver.findElement(By.id('dropdown')).click();
  await driver.findElement(By.xpath(`//select[@id='dropdown']/option[normalize-space()='${option}']`)).click();
});

Then('dropdown option {string} is selected', async ({ driver, wait, selenium: { By } }, option: string) => {
  await wait(async () => (await driver.findElement(By.css('#dropdown option:checked')).getText()) === option);
});

When('I enter number {string}', async ({ driver, selenium: { By } }, value: string) => {
  await driver.findElement(By.css('input[type="number"]')).sendKeys(value);
});

Then('the number input value is {string}', async ({ driver, selenium: { By } }, expected: string) => {
  assert.equal(await driver.findElement(By.css('input[type="number"]')).getAttribute('value'), expected);
});

When('I press keyboard key {string}', async ({ driver, selenium: { By, Key } }, name: string) => {
  const key = (Key as unknown as Record<string, string>)[name.toUpperCase()];
  assert.ok(key, `unknown key ${name}`);
  await driver.findElement(By.id('target')).sendKeys(key);
});

Then('the key result contains {string}', async ({ driver, wait, selenium: { By } }, expected: string) => {
  await wait(async () => (await driver.findElement(By.id('result')).getText()).includes(expected), 5000, `result never contained ${expected}`);
});

// ---- Dynamic content
When('I add {int} elements', async ({ driver, selenium: { By } }, count: number) => {
  for (let i = 0; i < count; i++) await driver.findElement(By.css('button[onclick="addElement()"]')).click();
});

When('I remove one element', async ({ driver, selenium: { By } }) => {
  await driver.findElement(By.css('.added-manually')).click();
});

Then('{int} delete buttons are displayed', async ({ driver, wait, selenium: { By } }, expected: number) => {
  await wait(async () => (await driver.findElements(By.css('.added-manually'))).length === expected);
});

When('I start the dynamic loading', async ({ driver, selenium: { By } }) => {
  await driver.findElement(By.css('#start button')).click();
});

Then('the loaded text is {string}', async ({ wait, selenium: { By, until } }, expected: string) => {
  const done = await wait(until.elementLocated(By.css('#finish h4')), 15_000);
  await wait(until.elementIsVisible(done), 15_000);
  assert.equal(await done.getText(), expected);
});

Then('the text input is disabled', async ({ driver, selenium: { By } }) => {
  assert.equal(await driver.findElement(By.css('#input-example input')).isEnabled(), false);
});

When('I enable the text input', async ({ driver, selenium: { By } }) => {
  await driver.findElement(By.css('#input-example button')).click();
});

Then('the text input becomes enabled', async ({ wait, selenium: { By, until } }) => {
  const input = await wait(until.elementLocated(By.css('#input-example input')));
  await wait(until.elementIsEnabled(input), 15_000);
});

// ---- Alerts and windows
When('I trigger the JS {word}', async ({ driver, selenium: { By } }, kind: string) => {
  const handler = { alert: 'jsAlert()', confirm: 'jsConfirm()', prompt: 'jsPrompt()' }[kind];
  assert.ok(handler, `unknown dialog ${kind}`);
  await driver.findElement(By.css(`button[onclick="${handler}"]`)).click();
});

When('I accept the dialog', async ({ driver, wait, selenium: { until } }) => {
  await wait(until.alertIsPresent());
  await driver.switchTo().alert().accept();
});

When('I dismiss the dialog', async ({ driver, wait, selenium: { until } }) => {
  await wait(until.alertIsPresent());
  await driver.switchTo().alert().dismiss();
});

When('I type {string} into the prompt and accept', async ({ driver, wait, selenium: { until } }, text: string) => {
  await wait(until.alertIsPresent());
  const alert = driver.switchTo().alert();
  await alert.sendKeys(text);
  await alert.accept();
});

Then('the dialog result says {string}', async ({ driver, wait, selenium: { By } }, expected: string) => {
  await wait(async () => (await driver.findElement(By.id('result')).getText()) === expected);
});

When('I open the link that opens a new window', async ({ driver, selenium: { By } }) => {
  await driver.findElement(By.css('a[href="/windows/new"]')).click();
});

Then('a second window opens with heading {string}', async ({ driver, wait, selenium: { By, until } }, heading: string) => {
  await wait(async () => (await driver.getAllWindowHandles()).length === 2, 8000, 'the second window never opened');
  const [first, second] = await driver.getAllWindowHandles();
  await driver.switchTo().window(second!);
  assert.equal(await (await wait(until.elementLocated(By.css('h3')))).getText(), heading); // the new window may still be loading
  await driver.close();
  await driver.switchTo().window(first!);
});

// ---- Several sessions in one scenario: newDriver
Given('user {string} is logged in', async ({ open, driver, wait, selenium: { By, until } }) => {
  await open('/login');
  await driver.findElement(By.id('username')).sendKeys('tomsmith');
  await driver.findElement(By.id('password')).sendKeys('SuperSecretPassword!');
  await driver.findElement(By.css('button[type="submit"]')).click();
  await wait(until.urlContains('/secure'));
});

When('a second browser session opens the secure area', async ({ newDriver, state, selenium: { until } }) => {
  const other = await newDriver();
  await other.get(new URL('/secure', 'https://the-internet.herokuapp.com').href);
  await other.wait(until.urlContains('/login'), 8000);
  state.set('session.other', other);
});

Then('the second session was sent to the login page', async ({ state }) => {
  const other = state.get<WebDriver>('session.other');
  assert.match(await other.getCurrentUrl(), /\/login$/);
});

Then('the first session is still on the secure area', async ({ driver }) => {
  assert.match(await driver.getCurrentUrl(), /\/secure$/);
});
