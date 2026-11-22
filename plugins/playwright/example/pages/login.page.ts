import { inject } from '@bddr/runtime';

/** Page object: takes its page and the shop from fixtures; no constructor wiring. */
export class LoginPage {
  private page = inject('page');
  private shop = inject('shop');

  open() {
    return this.page.goto(`${this.shop.url}/login`);
  }
  async logIn(user: string, password: string) {
    await this.page.getByPlaceholder('user').fill(user);
    await this.page.getByPlaceholder('password').fill(password);
    await this.page.getByRole('button', { name: 'Log in' }).click();
  }
  message() {
    return this.page.getByRole('status').textContent();
  }
}
