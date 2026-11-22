import { describe, expect, it } from 'vitest';
import { EventBus, buildPlan, parseSpec, type Log } from '@bddr/core';
import { Executor, SupportRegistry, log, type StepContext } from '@bddr/runtime';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('levelled logging', () => {
  it('ctx.log levels + data become log events attributed to scenario and step', async () => {
    const r = new SupportRegistry();
    r.defineStep('noisy', (ctx: StepContext) => {
      ctx.log('plain');
      ctx.log.debug('d', { a: 1 });
      ctx.log.warn('w');
      ctx.log.error('e', new Error('kaput'));
    });
    const bus = new EventBus({ keepHistory: true });
    const s = parseSpec('Feature: L\n  Scenario: s\n    Given noisy\n', 'l.feature').scenarios;
    await new Executor({ registry: r, bus }).execute(s);
    const logs = bus.history!.filter((e): e is Log => e.type === 'log' && e.source === 'user');
    expect(logs.map((l) => [l.level, l.message])).toEqual([
      ['info', 'plain'],
      ['debug', 'd'],
      ['warn', 'w'],
      ['error', 'e'],
    ]);
    expect(logs[1]!.data).toEqual({ a: 1 });
    expect(logs[3]!.data).toMatchObject({ name: 'Error', message: 'kaput' });
    expect(logs.every((l) => l.scenarioId === 'l.feature::s' && l.stepId)).toBe(true);
  });

  it('the global `log` follows the running scenario across awaits and concurrency; run-level outside', async () => {
    const r = new SupportRegistry();
    const helper = {
      async work(tag: string) {
        log.info(`before ${tag}`);
        await sleep(tag === 'a' ? 30 : 5);
        log.warn(`after ${tag}`);
      },
    };
    r.defineStep('work {word}', (_ctx: StepContext, tag: string) => helper.work(tag));
    r.defineHook('run', 'before', {}, () => log.info('in BeforeAll'));
    const bus = new EventBus({ keepHistory: true });
    const s = parseSpec('Feature: G\n  Scenario: a\n    Given work a\n  Scenario: b\n    Given work b\n', 'g.feature').scenarios;
    await new Executor({ registry: r, bus, plan: buildPlan(s, s, { workers: 2 }) }).execute(s);
    const user = bus.history!.filter((e): e is Log => e.type === 'log' && e.source === 'user');
    const by = (m: string) => user.find((l) => l.message === m)!;
    expect(by('in BeforeAll').scenarioId).toBeUndefined();
    expect(by('after a').scenarioId).toBe('g.feature::a');
    expect(by('after b').scenarioId).toBe('g.feature::b');
    // b finished while a was still waiting: proves per-async-context attribution
    expect(user.indexOf(by('after b'))).toBeLessThan(user.indexOf(by('after a')));
  });

  it('emits framework diagnostics as debug logs with source bddr', async () => {
    const r = new SupportRegistry();
    r.defineStep('ok', () => {});
    const bus = new EventBus({ keepHistory: true });
    const s = parseSpec('Feature: D\n  @id:a\n  Scenario: a\n    Given ok\n  @dependsOn:a\n  Scenario: b\n    Given ok\n', 'd.feature').scenarios;
    await new Executor({ registry: r, bus }).execute(s);
    const diag = bus.history!.filter((e): e is Log => e.type === 'log' && e.source === 'bddr').map((l) => l.message);
    expect(diag[0]).toMatch(/^plan: 2 scenario\(s\), workers=1/);
    expect(diag).toContain('start d.feature::b on w1 after a');
  });
});

describe('logging images', () => {
  it('ctx.log.image and bytes-as-data attach an image to the log line; media type sniffed', async () => {
    const { sniffMediaType } = await import('@bddr/runtime');
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const jpg = Buffer.from('ffd8ffe0', 'hex');
    expect(sniffMediaType(png)).toBe('image/png');
    expect(sniffMediaType(jpg)).toBe('image/jpeg');
    expect(sniffMediaType(Buffer.from('<svg xmlns="x"/>'))).toBe('image/svg+xml');
    expect(sniffMediaType(Buffer.from('hello'))).toBe('application/octet-stream');

    const r = new SupportRegistry();
    r.defineStep('snap', (ctx: StepContext) => {
      ctx.log.image('after login', png, { name: 'login.png' });
      ctx.log.warn('odd layout', jpg);
      log.image('from helper', png, { level: 'debug', mediaType: 'image/png' });
    });
    const bus = new EventBus({ keepHistory: true });
    await new Executor({ registry: r, bus }).execute(parseSpec('Feature: I\n  Scenario: s\n    Given snap\n', 'i.feature').scenarios);
    const logs = bus.history!.filter((e): e is Log => e.type === 'log' && e.source === 'user');
    expect(logs.map((l) => [l.level, l.message, l.attachment?.mediaType, l.attachment?.name, l.attachment?.bytes])).toEqual([
      ['info', 'after login', 'image/png', 'login.png', 8],
      ['warn', 'odd layout', 'image/jpeg', undefined, 4],
      ['debug', 'from helper', 'image/png', undefined, 8],
    ]);
    expect(logs[0]!.attachment!.body).toBe(png.toString('base64'));
    expect(logs.every((l) => l.data === undefined && l.stepId)).toBe(true);
  });
});
