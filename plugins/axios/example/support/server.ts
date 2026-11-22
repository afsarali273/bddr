import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defineFixture } from '@bddr/runtime';

/** A tiny products API on a free port, so the example needs no internet. One server per worker process. */
export interface ProductsApi { url: string }
declare module '@bddr/runtime' {
  interface Fixtures { products: ProductsApi }
}

defineFixture(
  'products',
  () =>
    new Promise<ProductsApi & { server: Server }>((resolve) => {
      const store = new Map<number, { id: number; name: string; price: number }>([[1, { id: 1, name: 'apple', price: 0.5 }]]);
      let next = 2;
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('end', () => {
          const send = (status: number, data?: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(data === undefined ? '' : JSON.stringify(data));
          };
          const url = new URL(req.url ?? '/', 'http://x');
          if (url.pathname === '/health') return send(200, { status: 'ok' });
          if (req.headers['authorization'] !== 'Bearer secret') return send(401, { error: 'unauthorized' });
          const id = Number(url.pathname.split('/')[2]);
          if (url.pathname === '/products' && req.method === 'GET') return send(200, [...store.values()]);
          if (url.pathname === '/products' && req.method === 'POST') {
            const body = JSON.parse(raw || '{}') as { name?: string; price?: number };
            if (!body.name) return send(400, { error: 'name is required' });
            const product = { id: next++, name: body.name, price: body.price ?? 0 };
            store.set(product.id, product);
            return send(201, product);
          }
          if (url.pathname.startsWith('/products/') && store.has(id)) {
            if (req.method === 'GET') return send(200, store.get(id));
            if (req.method === 'DELETE') return store.delete(id), send(204);
          }
          return send(404, { error: 'not found' });
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    }),
  { scope: 'worker', teardown: (s) => new Promise<void>((r) => (s as ProductsApi & { server: Server }).server.close(() => r())) },
);
