# @bddr/axios

API testing for [bddr](../../README.md) with [axios](https://axios-http.com), as a plugin. bddr has no dependency on
axios: your project installs both, and this plugin connects them through bddr fixtures. It works the same way as
[`@bddr/playwright`](../playwright/README.md) and [`@bddr/selenium`](../selenium/README.md), and can be used together
with them in one project (a scenario can call the API and drive the browser).

```bash
npm i -D @bddr/axios axios
```

```ts
// bddr.config.ts
import { defineConfig } from '@bddr/cli';
import { axios } from '@bddr/axios';

export default defineConfig({
  plugins: [axios({ baseURL: 'https://api.example.com', auth: { bearer: process.env.API_TOKEN }, headers: { 'x-team': 'qa' } })],
  // or untyped: plugins: [['@bddr/axios', { baseURL: 'https://api.example.com' }]]
});
```

```ts
// steps: ask for what you need
When('I create product {string}', async ({ api, state }, name: string) => {
  state.set('res', await api.post('/products', { name }));
});
Then('it is created', ({ state }) => assert.equal(state.get<AxiosResponse>('res').status, 201));

// page objects and step classes: inject()
class ProductsApi { private api = inject('api'); list() { return this.api.get('/products'); } }
```

Add `import '@bddr/axios';` (or `"types": ["@bddr/axios"]` in tsconfig) in one support file so `ctx.api`, `({ api })`
and `inject('api')` are typed. bddr starts a fixture only when a step names it (`({ api })`, `ctx.api`,
`const { api } = ctx`, `inject('api')`); a helper that reads `ctx.api` inside, without the step naming it, is not seen.

## Fixtures

| name | scope | what |
|---|---|---|
| `axios` | worker | the `axios` module (`isAxiosError`, `create` ...) |
| `api` | scenario | an axios instance: baseURL, headers, timeout and auth from the options; HTTP errors do not throw; calls recorded |
| `newApi` | scenario | `newApi({ baseURL, headers })`: another instance (second service or user) that records into the same call log |

## What you get that plain axios does not give

- **Status codes are data.** By default 4xx/5xx do not throw, so `Then the status is 404` is an ordinary assertion.
  `throwOnHttpError: true` brings axios's default back.
- **A call log in the report.** Every call (method, final URL, status, duration, request and response bodies) is attached
  as `api-calls.json` when a scenario fails (`attach: 'on'` for every scenario). Authorization, cookie and API-key
  headers are masked as `***`; bodies are cut at `maxBodyChars`. Network errors and timeouts are recorded too.
- **Credentials from the command line.** `-D token=...` replaces the bearer token, `-D baseURL=...` the base URL.
- **No browser, no extra process.** A scenario that only uses `api` starts nothing else. Groups, dependencies,
  `--pool process`, `--shard` and retries work as usual.

## Options

| option | default | |
|---|---|---|
| `baseURL` | | API base URL; `-D baseURL=` overrides |
| `headers` | | default headers of every request (`Accept: application/json` is added) |
| `timeoutMs` | `15000` | request timeout |
| `auth` | | `{ bearer }` (`-D token=` overrides) or `{ username, password }` (basic) |
| `throwOnHttpError` | `false` | throw on 4xx/5xx like axios |
| `attach` | `'only-on-failure'` | `'off' \| 'on' \| 'only-on-failure'`: attach the call log |
| `maxBodyChars` | `5000` | longest body kept in the call log |
| `config` | | any other axios request defaults (`proxy`, `httpsAgent`, `maxRedirects` ...) |

The plugin uses the `axios` of your project, so `axios.isAxiosError(e)` in your steps and the plugin share one copy.

## Mixing UI and API in one scenario

Install the plugins side by side; their fixtures do not clash (`page`/`request` or `driver`, plus `api`):

```ts
plugins: [playwright({ ... }), axios({ baseURL: 'https://api.example.com' })]
// When('the product exists', async ({ api }) => ...create through the API...)
// Then('I see it', async ({ page, expect }) => ...check the UI...)
```

## Example

`example/` runs offline (a local products API is a worker fixture): list, create/read/delete, validation errors, 404s,
token handling.

```bash
cd plugins/axios && npm install
cd example && npx bddr            # or: npx bddr --pool process -w 3, -D token=wrong
```

## Developing

`npm run verify` (typecheck, build, tests). The tests use real axios against a local HTTP server.
