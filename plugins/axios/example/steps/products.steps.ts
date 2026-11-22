import { strict as assert } from 'node:assert';
import { Given, Steps, Then, When, inject, type DataTable } from '@bddr/runtime';
import type { AxiosResponse } from 'axios';

// Class style: `api` and the server are injected; the base URL is the local server's.
@Steps()
export class ProductSteps {
  private api = inject('api');
  private server = inject('products');

  private async call(method: 'get' | 'post' | 'delete', path: string, data?: unknown): Promise<AxiosResponse> {
    return this.api.request({ method, url: `${this.server.url}${path}`, data });
  }

  private last?: AxiosResponse;

  @When('I GET {string}')
  async get(path: string) {
    this.last = await this.call('get', path);
  }

  @When('I create product {string} with price {float}')
  async create(name: string, price: number) {
    this.last = await this.call('post', '/products', { name, price });
  }

  @When('I create a product without a name')
  async createInvalid() {
    this.last = await this.call('post', '/products', {});
  }

  @When('I delete the created product')
  async deleteCreated() {
    this.last = await this.call('delete', `/products/${(this.last!.data as { id: number }).id}`);
  }

  @Then('the status is {int}')
  status(expected: number) {
    assert.equal(this.last!.status, expected);
  }

  @Then('the response has:')
  has(table: DataTable) {
    for (const row of table.hashes()) assert.equal(String((this.last!.data as Record<string, unknown>)[row['field']!]), row['value']);
  }

  @Then('the list contains {int} products')
  count(expected: number) {
    assert.equal((this.last!.data as unknown[]).length, expected);
  }
}

// Function style: destructure what the step needs.
When('I GET {string} without a token', async ({ axios, products }, path: string) => {
  // `axios` is the module: a plain client with no auth
  const res = await axios.get(`${products.url}${path}`, { validateStatus: () => true });
  assert.equal(res.status, 401);
});

Given('another client with token {string}', async ({ newApi, products, state }, token: string) => {
  const other = newApi({ headers: { Authorization: `Bearer ${token}` } });
  state.set('other.status', (await other.get(`${products.url}/products`)).status);
});

Then('that client is rejected with {int}', ({ state }, expected: number) => {
  assert.equal(state.get<number>('other.status'), expected);
});
