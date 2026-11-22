/**
 * @bddr/axios: API testing for bddr with axios, as a plugin. bddr does not depend on axios; your project does.
 *
 *   // bddr.config.ts
 *   import { axios } from '@bddr/axios';
 *   export default defineConfig({ plugins: [axios({ baseURL: 'https://api.example.com', auth: { bearer: 'token' } })] });
 *
 *   // steps
 *   When('I create a product', async ({ api, state }) => state.set('res', await api.post('/products', { name: 'apple' })));
 *   Then('it is created', ({ state }) => assert.equal(state.get<AxiosResponse>('res').status, 201));
 *   class ProductsApi { private api = inject('api'); list() { return this.api.get('/products'); } }
 *
 * Fixtures:
 *   axios    worker    the `axios` module (AxiosError, isAxiosError, create ...)
 *   api      scenario  an axios instance with baseURL, headers, timeout and auth from the plugin options. HTTP error
 *                      statuses do NOT throw (so a step can assert on a 404); every call is recorded, and the call log
 *                      (method, url, status, duration, bodies; secrets masked) is attached to the report.
 *   newApi   scenario  `newApi({ baseURL: 'https://other', headers: {...} })`: another instance (a second service or user)
 *                      that records into the same call log
 *
 * Run-time overrides with -D: `-D baseURL=https://staging.example.com`, `-D token=<bearer token>`.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { defineFixture, definePlugin, type BddrPlugin, type RunContext } from '@bddr/runtime';

type AxiosModule = typeof import('axios').default;

declare module '@bddr/runtime' {
  interface Fixtures {
    axios: AxiosModule;
    api: AxiosInstance;
    /** Another axios instance (other base URL, headers or credentials) recording into this scenario's call log. */
    newApi: (config?: AxiosRequestConfig) => AxiosInstance;
  }
}

/** `only-on-failure`: the call log is attached only when the scenario failed. */
export type AttachMode = 'off' | 'on' | 'only-on-failure';

export interface AxiosPluginOptions {
  /** Base URL of the API under test. `-D baseURL=` overrides. */
  baseURL?: string;
  /** Default headers of every request. */
  headers?: Record<string, string>;
  /** Request timeout (ms). Default 15000. */
  timeoutMs?: number;
  /** Credentials: a bearer token (`-D token=` overrides), or basic auth. */
  auth?: { bearer?: string; username?: string; password?: string };
  /** Throw on 4xx/5xx like axios does by default. Default false: the status is just data a step can assert on. */
  throwOnHttpError?: boolean;
  /** Attach the call log (json) to the report. Default 'only-on-failure'. */
  attach?: AttachMode;
  /** Largest request/response body kept in the call log (characters). Default 5000. */
  maxBodyChars?: number;
  /** Extra axios request defaults (proxy, httpsAgent, maxRedirects ...). */
  config?: AxiosRequestConfig;
}

/** One recorded HTTP call. */
export interface ApiCall {
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
}

const keep = (mode: AttachMode | undefined, status: string | undefined) => mode === 'on' || (mode === 'only-on-failure' && status === 'failed');
const SECRET = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;

/** Load axios from the PROJECT (working directory), so `AxiosError` checks in your steps use the same copy as the plugin. */
async function loadProjectAxios(): Promise<AxiosModule> {
  try {
    const mod = createRequire(join(process.cwd(), 'package.json'))('axios') as AxiosModule & { default?: AxiosModule };
    return mod.default ?? mod;
  } catch {
    const mod = (await import('axios')) as unknown as { default: AxiosModule };
    return mod.default;
  }
}

/** Build the plugin. `load` is how axios is imported (tests pass a fake). */
export function createAxiosPlugin(load: () => Promise<AxiosModule> = loadProjectAxios): BddrPlugin<AxiosPluginOptions> {
  return definePlugin<AxiosPluginOptions>({
    name: 'axios',
    setup(o = {}) {
      const maxBody = o.maxBodyChars ?? 5000;
      const trim = (value: unknown): unknown => {
        if (value === undefined) return undefined;
        const text = typeof value === 'string' ? value : safeJson(value);
        return text.length > maxBody ? `${text.slice(0, maxBody)}… (${text.length} characters)` : typeof value === 'string' ? value : JSON.parse(text);
      };
      const mask = (headers: unknown): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries((headers as { toJSON?: () => object })?.toJSON?.() ?? headers ?? {})) {
          if (v !== undefined && v !== null && typeof v !== 'object') out[k] = SECRET.test(k) ? '***' : String(v);
        }
        return out;
      };

      const calls = new WeakMap<object, ApiCall[]>();

      /** An axios instance that records its calls into `log`. */
      const make = (axios: AxiosModule, ctx: RunContext, log: ApiCall[], extra: AxiosRequestConfig = {}): AxiosInstance => {
        const token = ctx.params['token'] ?? o.auth?.bearer;
        const baseURL = ctx.params['baseURL'] ?? o.baseURL;
        const instance = axios.create({
          ...(baseURL ? { baseURL } : {}),
          timeout: o.timeoutMs ?? 15_000,
          ...(o.throwOnHttpError ? {} : { validateStatus: () => true }),
          ...(o.auth?.username !== undefined ? { auth: { username: o.auth.username, password: o.auth.password ?? '' } } : {}),
          ...o.config,
          ...extra,
          headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...o.headers, ...(extra.headers as Record<string, string>) },
        });
        const startedAt = new WeakMap<object, number>();
        instance.interceptors.request.use((config) => {
          startedAt.set(config, Date.now());
          return config;
        });
        const record = (config: AxiosRequestConfig, response?: AxiosResponse, error?: unknown) => {
          const call: ApiCall = {
            method: (config.method ?? 'get').toUpperCase(),
            url: instance.getUri(config),
            ...(response ? { status: response.status } : {}),
            durationMs: Date.now() - (startedAt.get(config) ?? Date.now()),
            requestHeaders: mask(config.headers),
            ...(config.data !== undefined ? { requestBody: trim(parseIfJson(config.data)) } : {}),
            ...(response?.data !== undefined && response.data !== '' ? { responseBody: trim(response.data) } : {}),
            ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          };
          log.push(call);
          ctx.log.debug(`${call.method} ${call.url} -> ${call.status ?? call.error ?? '?'} (${call.durationMs} ms)`);
        };
        instance.interceptors.response.use(
          (response) => (record(response.config, response), response),
          (error: { config?: AxiosRequestConfig; response?: AxiosResponse }) => {
            if (error.config) record(error.config, error.response, error);
            return Promise.reject(error);
          },
        );
        calls.set(instance, log);
        return instance;
      };

      defineFixture('axios', () => load(), { scope: 'worker' });

      defineFixture(
        'api',
        async (ctx) => make(await ctx.fixture('axios'), ctx, []),
        {
          teardown: (instance, { status, ctx }) => {
            const log = calls.get(instance) ?? [];
            if (log.length > 0 && keep(o.attach ?? 'only-on-failure', status)) ctx.attach(JSON.stringify(log, null, 2), 'application/json', 'api-calls.json');
          },
        },
      );

      defineFixture('newApi', async (ctx) => {
        const axios = await ctx.fixture('axios');
        const api = await ctx.fixture('api'); // the call log of this scenario
        return (config?: AxiosRequestConfig) => make(axios, ctx, calls.get(api) ?? [], config);
      });
    },
  });
}

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};
const parseIfJson = (data: unknown): unknown => {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
};

/** The plugin with axios from your project. Use as `plugins: ['@bddr/axios']` or `plugins: [axios({ ... })]`. */
const plugin = createAxiosPlugin();
export default plugin;

/** Typed form for bddr.config.ts: `plugins: [axios({ baseURL: 'https://api.example.com' })]`. */
export function axios(options: AxiosPluginOptions = {}): { name: string; setup(): void | Promise<void> } {
  return { name: plugin.name, setup: () => plugin.setup(options) };
}
