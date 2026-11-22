import { inject } from '@bddr/runtime';
import { By, until } from 'selenium-webdriver';

/** the-internet.herokuapp.com/login. A page object gets its driver from the plugin: no constructor wiring. */
export class LoginPage {
  private driver = inject('driver');

  async logIn(username: string, password: string): Promise<void> {
    await this.driver.findElement(By.id('username')).sendKeys(username);
    await this.driver.findElement(By.id('password')).sendKeys(password);
    await this.driver.findElement(By.css('button[type="submit"]')).click();
  }

  async logOut(): Promise<void> {
    await this.driver.findElement(By.css('a[href="/logout"]')).click();
  }

  async flashContains(text: string, timeoutMs = 8000): Promise<void> {
    const flash = await this.driver.wait(until.elementLocated(By.id('flash')), timeoutMs);
    await this.driver.wait(until.elementTextContains(flash, text), timeoutMs, `flash message never contained "${text}"`);
  }
}
