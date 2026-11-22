import { inject } from '@bddr/runtime';
import { By, until } from 'selenium-webdriver';

const tid = (id: string) => By.css(`[data-test="${id}"]`);

export class SauceLoginPage {
  private driver = inject('driver');

  open(baseUrl: string) {
    return this.driver.get(baseUrl);
  }
  async logIn(username: string, password: string): Promise<void> {
    await this.driver.findElement(tid('username')).sendKeys(username);
    await this.driver.findElement(tid('password')).sendKeys(password);
    await this.driver.findElement(tid('login-button')).click();
  }
  async error(): Promise<string> {
    return (await this.driver.wait(until.elementLocated(tid('error')), 8000)).getText();
  }
}

export class SauceInventoryPage {
  private driver = inject('driver');

  async waitUntilVisible(): Promise<void> {
    await this.driver.wait(until.elementLocated(tid('inventory-list')), 10_000);
  }
  async names(): Promise<string[]> {
    return Promise.all((await this.driver.findElements(tid('inventory-item-name'))).map((e) => e.getText()));
  }
  async sortBy(label: string): Promise<void> {
    await this.driver.findElement(tid('product-sort-container')).click();
    await this.driver.findElement(By.xpath(`//select[@data-test='product-sort-container']/option[normalize-space()='${label}']`)).click();
  }
  async addProduct(name: string): Promise<void> {
    await this.driver.findElement(By.xpath(`//div[@data-test='inventory-item'][.//div[@data-test='inventory-item-name' and normalize-space()='${name}']]//button`)).click();
  }
  async badge(): Promise<string> {
    return (await this.driver.wait(until.elementLocated(tid('shopping-cart-badge')), 8000)).getText();
  }
  async openCart(): Promise<string[]> {
    await this.driver.findElement(tid('shopping-cart-link')).click();
    await this.driver.wait(until.urlContains('cart.html'), 8000);
    return this.names();
  }
}
