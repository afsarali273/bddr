import { strict as assert } from 'node:assert';
import { CONTEXT, Given, Steps, Then, When, inject } from '@bddr/runtime';
import { requiredParam } from '../support/world.js';

type CheckState = 'checked' | 'unchecked';

@Steps()
export class InternetUiSteps {
  private readonly ctx = inject(CONTEXT);
  private readonly page = inject('page');
  private readonly expect = inject('expect'); // Playwright's retrying assertions

  @Given('the UI base URL is configured', { concurrent: false })
  configured() {
    assert.match(requiredParam(this.ctx, 'uiBaseUrl'), /^https?:\/\//);
  }

  @When('I open UI path {string}', { concurrent: false })
  async open(path: string) {
    const result = await this.page.goto(path, { waitUntil: 'domcontentloaded' });
    this.ctx.state.set('ui.responseStatus', result?.status());
  }

  @Then('the page heading is {string}', { concurrent: false })
  async heading(expected: string) {
    await this.expect(this.page.locator('h1, h2').first()).toHaveText(expected);
  }

  @Then('the page has at least {int} example links', { concurrent: false })
  async linkCount(minimum: number) {
    await this.expect.poll(() => this.page.locator('#content a').count()).toBeGreaterThanOrEqual(minimum);
  }

  @When('I follow the example link {string}', { concurrent: false })
  async followExample(label: string) {
    await this.page.getByRole('link', { name: label, exact: true }).click();
  }

  @Then('the current UI path is {string}', { concurrent: false })
  currentPath(expected: string) {
    const normalize = (value: string) => value.length > 1 ? value.replace(/\/$/, '') : value;
    assert.equal(normalize(new URL(this.page.url()).pathname), normalize(expected));
  }

  @Then('the response status is {int}', { concurrent: false })
  status(expected: number) {
    assert.equal(this.ctx.state.get<number>('ui.responseStatus'), expected);
  }

  @Then('the page content mentions status code {int}', { concurrent: false })
  async statusContent(expected: number) {
    assert.match(await this.page.locator('#content').innerText(), new RegExp(`returned a ${expected} status code`, 'i'));
  }

  @When('I follow the redirect link', { concurrent: false })
  async followRedirect() {
    await this.page.getByRole('link', { name: 'here' }).click();
  }

  @Then('checkbox {int} is {word}', { concurrent: false })
  async checkboxState(number: number, state: CheckState) {
    const box = this.page.locator('input[type="checkbox"]').nth(number - 1);
    await (state === 'checked' ? this.expect(box).toBeChecked() : this.expect(box).not.toBeChecked());
  }

  @When('I set checkbox {int} to {word}', { concurrent: false })
  async setCheckbox(number: number, state: CheckState) {
    await this.page.locator('input[type="checkbox"]').nth(number - 1).setChecked(state === 'checked');
  }

  @When('I select dropdown option {string}', { concurrent: false })
  async selectOption(option: string) {
    await this.page.locator('#dropdown').selectOption({ label: option });
  }

  @Then('dropdown option {string} is selected', { concurrent: false })
  async selectedOption(option: string) {
    await this.expect(this.page.locator('#dropdown option:checked')).toHaveText(option);
  }

  @When('I enter number {string}', { concurrent: false })
  async enterNumber(value: string) {
    await this.page.locator('input[type="number"]').fill(value);
  }

  @Then('the number input value is {string}', { concurrent: false })
  async numberValue(expected: string) {
    await this.expect(this.page.locator('input[type="number"]')).toHaveValue(expected);
  }

  @When('I press keyboard key {string}', { concurrent: false })
  async pressKey(key: string) {
    await this.page.locator('body').press(key);
  }

  @Then('the key result contains {string}', { concurrent: false })
  async keyResult(expected: string) {
    await this.expect(this.page.locator('#result')).toContainText(new RegExp(expected));
  }

  @When('I log in with username {string} and password {string}', { concurrent: false })
  async login(username: string, password: string) {
    await this.page.locator('#username').fill(username);
    await this.page.locator('#password').fill(password);
    await this.page.getByRole('button', { name: 'Login' }).click();
  }

  @Then('the login message contains {string}', { concurrent: false })
  async loginMessage(expected: string) {
    await this.expect(this.page.locator('#flash')).toContainText(expected);
  }

  @When('I add {int} elements', { concurrent: false })
  async addElements(count: number) {
    for (let index = 0; index < count; index++) {
      await this.page.getByRole('button', { name: 'Add Element' }).click();
    }
  }

  @Then('{int} delete buttons are displayed', { concurrent: false })
  async deleteButtons(expected: number) {
    await this.expect(this.page.getByRole('button', { name: 'Delete' })).toHaveCount(expected);
  }

  @When('I set the horizontal slider to {string}', { concurrent: false })
  async setSlider(value: string) {
    const slider = this.page.locator('input[type="range"]');
    const increments = Math.round(Number(value) / 0.5);
    await slider.press('Home');
    for (let index = 0; index < increments; index++) await slider.press('ArrowRight');
  }

  @Then('the horizontal slider value is {string}', { concurrent: false })
  async sliderValue(expected: string) {
    await this.expect(this.page.locator('#range')).toHaveText(expected);
  }
}
