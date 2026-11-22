import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import { EventBus, buildPlan, parseSpec, type BddrEvent } from '@bddr/core';
import { Executor, Given, getGlobalRegistry, resetGlobalRegistry } from '@bddr/runtime';
import { createAxiosPlugin, type AxiosPluginOptions } from '../src/index.js';

/** A real local HTTP server (real axios is used: no fake needed). */
let server: Server;
let base = '';
const seen: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.url === '/ok') return json(200, { ok: true });
      if (req.url === '/missing') return json(404, { error: 'not found' });
      if (req.url === '/big') return json(200, { text: 'x'.repeat(200) });
      if (req.url === '/echo') return json(201, { got: body ? (JSON.parse(body) as unknown) : null });
      if (req.url === '/slow') return void setTimeout(() => json(200, { slow: true }), 400);
      return json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

async function run(options: AxiosPluginOptions, src: string, params: Record<string, string> = {}) {
  resetGlobalRegistry();
  seen.length = 0;
  await createAxiosPlugin().setup(options);
  Given('I get {string}', async ({ api, state }, path: string) => void state.set('res', await api.get(path)));
  Given('I post {string}', async ({ api, state }, path: string) => void state.set('res', await api.post(path, { name: 'apple' })));
  Given('the status is {int}', ({ state }, status: number) => assert.equal(state.get<{ status: number }>('res').status, status));
  Given('the check fails', () => assert.fail('boom'));
  Given('I catch an error for {string}', async ({ api, axios }, path: string) => {
    await assert.rejects(api.get(path), (e) => axios.isAxiosError(e) && e.response?.status === 404);
  });
  Given('I use another service at {string}', async ({ newApi }, url: string) => {
    assert.equal((await newApi({ baseURL: url }).get('/ok')).status, 200);
  });
  Given('no api at all', () => {});
  const scenarios = parseSpec(src, 'api.feature').scenarios;
  const bus = new EventBus({ keepHistory: true });
  const result = await new Executor({ registry: getGlobalRegistry(), bus, plan: buildPlan(scenarios, scenarios, { workers: 1 }), params }).execute(scenarios);
  const attachments = bus.history!.filter((e): e is Extract<BddrEvent, { type: 'attachment' }> => e.type === 'attachment');
  const errors = bus.history!.flatMap((e) => (e.type === 'stepFinished' && e.error ? [e.error.message] : []));
  const callsOf = (i = 0) => JSON.parse(attachments[i]!.encoding === 'base64' ? Buffer.from(attachments[i]!.body, 'base64').toString() : attachments[i]!.body) as Array<Record<string, unknown>>;
  return { result, attachments, errors, callsOf };
}

afterEach(() => void resetGlobalRegistry());

const ONE = (steps: string) => `Feature: F\n  Scenario: s\n${steps.split('\n').map((s) => `    ${s}\n`).join('')}`;

describe('@bddr/axios', () => {
  it('api uses baseURL; an HTTP error status does not throw', async () => {
    const { result } = await run({ baseURL: base }, ONE('Given I get "/missing"\nThen the status is 404'));
    assert.equal(result.success, true);
  });

  it('throwOnHttpError: true makes axios throw like by default', async () => {
    const { result } = await run({ baseURL: base, throwOnHttpError: true }, ONE('Given I catch an error for "/missing"'));
    assert.equal(result.success, true);
  });

  it('bearer token and headers are sent; -D token / -D baseURL override the config', async () => {
    const { result } = await run({ baseURL: 'http://wrong.invalid', auth: { bearer: 'from-config' }, headers: { 'x-team': 'qa' } }, ONE('Given I get "/ok"'), {
      baseURL: base,
      token: 'from-cli',
    });
    assert.equal(result.success, true);
    assert.equal(seen[0]!.headers['authorization'], 'Bearer from-cli');
    assert.equal(seen[0]!.headers['x-team'], 'qa');
    assert.match(String(seen[0]!.headers['accept']), /json/);
  });

  it('basic auth is sent', async () => {
    await run({ baseURL: base, auth: { username: 'ana', password: 'pw' } }, ONE('Given I get "/ok"'));
    assert.equal(seen[0]!.headers['authorization'], `Basic ${Buffer.from('ana:pw').toString('base64')}`);
  });

  it('call log is attached only on failure by default, with secrets masked', async () => {
    const failing = await run({ baseURL: base, auth: { bearer: 'secret-token' } }, ONE('Given I post "/echo"\nThen the check fails'));
    assert.equal(failing.result.success, false);
    assert.equal(failing.attachments.length, 1);
    assert.equal(failing.attachments[0]!.mediaType, 'application/json');
    const [call] = failing.callsOf();
    assert.equal(call!['method'], 'POST');
    assert.equal(call!['status'], 201);
    assert.deepEqual(call!['requestBody'], { name: 'apple' });
    assert.deepEqual(call!['responseBody'], { got: { name: 'apple' } });
    assert.equal((call!['requestHeaders'] as Record<string, string>)['Authorization'], '***');
    assert.ok(!JSON.stringify(failing.callsOf()).includes('secret-token'));

    const passing = await run({ baseURL: base }, ONE('Given I get "/ok"'));
    assert.equal(passing.attachments.length, 0);
  });

  it("attach 'on' attaches for passing scenarios; 'off' never; unused api attaches nothing", async () => {
    assert.equal((await run({ baseURL: base, attach: 'on' }, ONE('Given I get "/ok"'))).attachments.length, 1);
    assert.equal((await run({ baseURL: base, attach: 'off' }, ONE('Given I get "/ok"\nThen the check fails'))).attachments.length, 0);
    assert.equal((await run({ baseURL: base, attach: 'on' }, ONE('Given no api at all'))).attachments.length, 0);
  });

  it('newApi is another instance that records into the same call log', async () => {
    const { attachments, callsOf } = await run(
      { baseURL: base, attach: 'on' },
      ONE(`Given I get "/ok"\nAnd I use another service at "${base}"`),
    );
    assert.equal(attachments.length, 1);
    assert.equal(callsOf().length, 2);
  });

  it('a timeout is recorded with its error', async () => {
    const { result, callsOf } = await run({ baseURL: base, timeoutMs: 100, attach: 'on' }, ONE('Given I get "/slow"'));
    assert.equal(result.success, false);
    assert.match(String(callsOf()[0]!['error']), /timeout/i);
  });

  it('large bodies are cut in the call log', async () => {
    const { callsOf } = await run({ baseURL: base, attach: 'on', maxBodyChars: 50 }, ONE('Given I get "/big"'));
    assert.match(String(callsOf()[0]!['responseBody']), /… \(\d+ characters\)$/);
  });
});
