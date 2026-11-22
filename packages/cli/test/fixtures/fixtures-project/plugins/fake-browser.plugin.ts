import { appendFileSync } from 'node:fs';
import { defineFixture, definePlugin } from '@bddr/runtime';

/** Stands in for a Playwright/Selenium plugin: a browser per worker process, a page per scenario. */
export interface FakeBrowser { product: string; pid: number; pages: number }
export interface FakePage { id: string; url: string; browser: FakeBrowser }

declare module '@bddr/runtime' {
  interface Fixtures {
    browser: FakeBrowser;
    page: FakePage;
  }
}

const note = (line: string) => {
  const file = process.env['BDDR_FX_LOG'];
  if (file) appendFileSync(file, `${line}\n`);
};

export default definePlugin<{ product: string }>({
  name: 'fake-browser',
  setup({ product }) {
    defineFixture(
      'browser',
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        note(`browser open ${process.pid}`);
        return { product, pid: process.pid, pages: 0 };
      },
      { scope: 'worker', teardown: (b) => note(`browser close ${b.pid}`) },
    );
    defineFixture('page', async ({ browser, scenario }) => {
      browser.pages++;
      note(`page open ${scenario.name}`);
      return { id: `${browser.pid}:${browser.pages}`, url: 'about:blank', browser };
    }, { teardown: (p, info) => note(`page close ${p.id} ${info.status}`) });
  },
});
