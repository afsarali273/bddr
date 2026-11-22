import { describe, expect, it } from 'vitest';
import { createDebugController, type DebugIO } from '../src/debug.js';
import type { DebugStepView } from '@bddr/runtime';

function io(lines: string[]) {
  const out: string[] = [];
  const q = [...lines];
  const d: DebugIO = { ask: async (p) => (out.push(p), q.shift()), write: (t) => void out.push(t) };
  return { d, out: () => out.join('') };
}

function view(): DebugStepView {
  const store = new Map<string, unknown>([['basket', { items: 2 }]]);
  const s = { keys: () => [...store.keys()], get: (k: string) => store.get(k) as never, set: (k: string, v: unknown) => void store.set(k, v) };
  return {
    scenario: { id: 'a.feature::x', name: 'Buy', uri: 'a.feature', line: 3, tags: [] },
    step: { index: 2, total: 4, id: 's2', keyword: 'When ', text: 'I pay', line: 5 },
    ctx: { state: s, run: { keys: () => [], get: () => undefined as never }, params: { env: 'qa' } } as never,
  };
}

describe('cli debugger', () => {
  it('failure prompt: shows error, evaluates expressions with ctx, then retries', async () => {
    const t = io(['e ctx.state.get("basket").items', 's', 'r']);
    const c = createDebugController({ stepMode: false, io: t.d, quit: () => {} });
    const act = await c.onFailure!({ ...view(), status: 'failed', error: new Error('card declined') });
    expect(act).toBe('retry');
    const out = t.out();
    expect(out).toContain('card declined');
    expect(out).toContain('step 2/4');
    expect(out).toContain("debug (failed)> 2\n"); // eval result
    expect(out).toContain('basket = {');
    expect(out).toContain('"env": "qa"');
  });

  it('eval errors are shown, not thrown; unknown commands and retry-without-failure are explained', async () => {
    const t = io(['e nope.x', 'zzz', 'r', 'c']);
    const c = createDebugController({ stepMode: true, io: t.d, quit: () => {} });
    expect(await c.beforeStep!(view())).toBe('run');
    expect(t.out()).toContain('error: nope is not defined');
    expect(t.out()).toContain('unknown command "zzz"');
    expect(t.out()).toContain('retry is only available after a failure');
  });

  it('only pauses before steps in step mode; n keeps stepping, c stops stepping', async () => {
    const t = io(['n', 'c']);
    const c = createDebugController({ stepMode: true, io: t.d, quit: () => {} });
    await c.beforeStep!(view()); // n
    await c.beforeStep!(view()); // c
    await c.beforeStep!(view()); // runs without asking
    expect(t.out().match(/debug> /g)).toHaveLength(2);
    const quiet = createDebugController({ stepMode: false, io: io([]).d, quit: () => {} });
    expect(await quiet.beforeStep!(view())).toBe('run');
  });

  it('q and end of input both quit the run', async () => {
    let quits = 0;
    const c1 = createDebugController({ stepMode: true, io: io(['q']).d, quit: () => quits++ });
    expect(await c1.beforeStep!(view())).toBe('quit');
    const c2 = createDebugController({ stepMode: false, io: io([]).d, quit: () => quits++ });
    expect(await c2.onFailure!({ ...view(), status: 'failed', error: 'x' })).toBe('quit');
    expect(quits).toBe(2);
  });
});
