import { inject } from '@bddr/runtime';
import { By, until } from 'selenium-webdriver';

/** Page object: takes its driver and the shop from fixtures; no constructor wiring. */
export class LoginPage {
  private driver = inject('driver');
  private shop = inject('shop');

  open() {
    return this.driver.get(`${this.shop.url}/login`);
  }
  async logIn(user: string, password: string) {
    await this.driver.findElement(By.css('#user')).sendKeys(user);
    await this.driver.findElement(By.css('#pass')).sendKeys(password);
    await this.driver.findElement(By.css('button')).click();
  }
  async message(): Promise<string> {
    const status = this.driver.findElement(By.css('#msg'));
    await this.driver.wait(async () => (await status.getText()) !== '', 5000); // wait until the page has answered
    return status.getText();
  }
  title() {
    return this.driver.getTitle();
  }
  waitUntilReady() {
    return this.driver.wait(until.elementLocated(By.css('form')), 5000);
  }
}
