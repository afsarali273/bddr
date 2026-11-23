import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createApp } from '../app/shop.js';
import { LocatorHealer, similarity } from '../src/agents.js';
import { parseCompiled } from '../src/compiled.js';
import { staticGate } from '../src/gate.js';
import { heal } from '../src/heal.js';
import type { Approval } from '../src/project.js';
import { parsePrompt } from '../src/prompt-file.js';
import { runCompiled } from '../src/runtime.js';

const tmpDir = join(import.meta.dirname, '..', '.tmp');

const PROMPT = `id: demo
tags: smoke

Ann has 20.00 and types "hello".

\`\`\`checks
C1 the greeting is "hello"
C2 she still has 20.00
\`\`\`
`;

describe('prompt file', () => {
  it('reads the id, header, prose, checks and literals', () => {
    const p = parsePrompt(PROMPT);
    expect(p.id).toBe('demo');
    expect(p.header.tags).toBe('smoke');
    expect(p.checks.map((c) => c.id)).toEqual(['C1', 'C2']);
    expect(p.literals).toEqual([
      { kind: 'string', value: 'hello' },
      { kind: 'number', value: 20 },
    ]);
    expect(p.errors).toEqual([]);
  });

  it('keeps the prompt hash for whitespace and line-break changes, not for wording', () => {
    const a = parsePrompt(PROMPT).promptHash;
    expect(parsePrompt(PROMPT.replace('types "hello"', 'types\n   "hello"')).promptHash).toBe(a);
    expect(parsePrompt(PROMPT.replace('20.00 and', '25.00 and')).promptHash).not.toBe(a);
  });

  it('keeps prompt and checks hashes independent', () => {
    const a = parsePrompt(PROMPT);
    const b = parsePrompt(PROMPT.replace('C2 she still', 'C2 Ann still'));
    expect(b.promptHash).toBe(a.promptHash);
    expect(b.checksHash).not.toBe(a.checksHash);
  });

  it('rejects a prompt without an id or without checks', () => {
    expect(parsePrompt('Just text').errors.join()).toMatch(/missing "id:"[\s\S]*no checks/);
    expect(parsePrompt('id: x\n\n```checks\nnot a check\n```').errors.join()).toMatch(/C1 what must hold/);
    expect(parsePrompt('id: x\n\n```checks\nC1 a\nC1 b\n```').errors.join()).toMatch(/C1 appears twice/);
  });
});

const CODE = `// @bddr-compiled
// id: demo
export default async ({ ui, check, expect }: any) => {
  ui.goto('/search');
  ui.fill({ role: 'textbox', label: 'Search' }, 'apple');
  ui.click({ role: 'button', name: 'Search' });
  await check('C1', () => expect(ui.texts({ role: 'listitem' })).toContain('Apple'));
  await check('C2', () => expect(ui.texts({ role: 'listitem' })).not.toContain('Melon'));
};
`;

describe('compiled file', () => {
  it('hashes each check body, ignoring formatting', () => {
    const a = parseCompiled(CODE);
    expect(Object.keys(a.checkCode)).toEqual(['C1', 'C2']);
    const reformatted = parseCompiled(CODE.replace(".toContain('Apple'));", ".toContain(\n    'Apple',\n  ));"));
    expect(reformatted.checkCode).toEqual(a.checkCode);
    expect(parseCompiled(CODE.replace("toContain('Apple')", "toContain('Pear')")).checkCode.C1).not.toBe(a.checkCode.C1);
  });

  it('collects literals from action code only', () => {
    const keys = parseCompiled(CODE).actionLiterals.map((l) => l.value);
    expect(keys).toContain('apple');
    expect(keys).not.toContain('Apple');
  });

  it('keeps the shape when only targets change, not when steps change', () => {
    const a = parseCompiled(CODE).shape;
    expect(parseCompiled(CODE.replace("'/search'", "'/find'")).shape).toBe(a);
    expect(parseCompiled(CODE.replace("ui.click({ role: 'button', name: 'Search' });", '')).shape).not.toBe(a);
  });
});

describe('runtime', () => {
  const run = (code: string, mutations: string[] = []) =>
    runCompiled(code, { contract: ['C1', 'C2'], fixtures: createApp(mutations), tmpDir });

  it('passes when every check runs once', async () => {
    expect((await run(CODE)).outcome).toBe('passed');
  });

  it('classifies a failed assertion as check-failed', async () => {
    const r = await run(CODE, ['search-broken']);
    expect([r.outcome, r.failedCheck]).toEqual(['check-failed', 'C1']);
    expect(r.checks.map((c) => c.status)).toEqual(['failed', 'not-run']);
  });

  it('classifies a missing target in action code as action-failed', async () => {
    expect((await run(CODE, ['search-route'])).outcome).toBe('action-failed');
  });

  it('enforces the contract: missing, unknown and repeated checks', async () => {
    expect((await run(CODE.replace(/await check\('C2'.*\n/, ''))).outcome).toBe('contract-violation');
    expect((await run(CODE.replace("check('C2'", "check('C9'"))).outcome).toBe('contract-violation');
    expect((await run(CODE.replace("check('C2'", "check('C1'"))).outcome).toBe('contract-violation');
  });

  it('reports a file that does not load', async () => {
    expect((await run('export default 42;')).outcome).toBe('load-error');
  });
});

describe('gate and heal', () => {
  const prompt = parsePrompt(`id: demo\n\nSearch for "apple".\n\n\`\`\`checks\nC1 Apple is found\nC2 Melon is not\n\`\`\`\n`);
  const parsed = parseCompiled(CODE);
  const approval: Approval = {
    checksHash: prompt.checksHash,
    checkCode: parsed.checkCode,
    actionLiterals: parsed.actionLiterals.map((l) => (l.kind === 'number' ? `n:${l.value}` : `s:${l.value}`)),
    shape: parsed.shape,
    by: 'test',
    on: '2026-11-24',
  };

  it('accepts a pure re-target, flags a check edit, rejects dropped data and new numbers', () => {
    expect(staticGate(CODE.replace("'/search'", "'/find'"), prompt, approval)).toEqual({ reject: [], needsApproval: [] });
    expect(staticGate(CODE.replace("toContain('Apple')", "toContain('Pear')"), prompt, approval).needsApproval.join()).toMatch(/G3 check C1/);
    expect(staticGate(CODE.replace("'apple'", "'pear'"), prompt, approval).reject.join()).toMatch(/G4/);
    expect(staticGate(CODE.replace("ui.goto('/search');", "ui.goto('/search'); const n = 42;"), prompt, approval).reject.join()).toMatch(/new number 42/);
    expect(staticGate(CODE.replace(/await check\('C2'.*\n/, ''), prompt, approval).reject.join()).toMatch(/C2 was removed/);
  });

  it('heals a moved route and refuses to heal a failed check', async () => {
    const fixtures = (m: string[]) => (attempt: number) => createApp(m, { attempt });
    const moved = await runCompiled(CODE, { contract: ['C1', 'C2'], fixtures: createApp(['search-route']), tmpDir });
    const ok = await heal(CODE, moved, { agent: new LocatorHealer(), prompt, approval, fixtures: fixtures(['search-route']), tmpDir });
    expect(ok.status).toBe('accepted');
    expect(ok.code).toContain("'/find'");

    const bug = await runCompiled(CODE, { contract: ['C1', 'C2'], fixtures: createApp(['search-broken']), tmpDir });
    const no = await heal(CODE, bug, { agent: new LocatorHealer(), prompt, approval, fixtures: fixtures(['search-broken']), tmpDir });
    expect(no.status).toBe('not-allowed');
  });

  it('scores similar labels high and unrelated ones low', () => {
    expect(similarity('Pay 7.50', 'Pay now (7.50)')).toBeGreaterThan(0.5);
    expect(similarity('Email', 'Email address')).toBeGreaterThan(0.5);
    expect(similarity('Coupon', 'Promo code')).toBeLessThan(0.5);
  });
});
