import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineFixture } from '@bddr/runtime';

/** A tiny local shop, so the example needs no internet. One server per worker process. */
export interface Shop { url: string }
declare module '@bddr/runtime' {
  interface Fixtures { shop: Shop }
}

const LOGIN = `<!doctype html><title>Shop login</title>
<form id="f"><input id="user" placeholder="user"><input id="pass" type="password" placeholder="password"><button>Log in</button></form>
<p id="msg" role="status"></p>
<script>f.onsubmit=e=>{e.preventDefault();msg.textContent=pass.value==='secret'?'Welcome '+user.value:'Wrong password'}</script>`;

defineFixture(
  'shop',
  () =>
    new Promise<Shop & { server: Server }>((resolve) => {
      const server = createServer((req, res) => {
        if (req.url === '/api/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        if (req.url?.startsWith('/api/products')) {
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ id: 1, name: 'apple', price: 0.5 }, { id: 2, name: 'pear', price: 0.75 }]));
        }
        res.writeHead(200, { 'content-type': 'text/html' }).end(LOGIN);
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    }),
  { scope: 'worker', teardown: (s) => new Promise<void>((r) => (s as Shop & { server: Server }).server.close(() => r())) },
);
