/**
 * End-to-end tests of the built CLI (packages/cli/dist). Run `npm run build` first;
 * these tests are skipped when the build output is missing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const project = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
const built = existsSync(bin);

const dataProject = fileURLToPath(new URL('./fixtures/data-project/', import.meta.url));
const orchestration = fileURLToPath(new URL('../../../examples/orchestration/', import.meta.url));
const resilience = fileURLToPath(new URL('../../../examples/resilience/', import.meta.url));
const rerunProject = fileURLToPath(new URL('./fixtures/rerun-project/', import.meta.url));
const poolProject = fileURLToPath(new URL('./fixtures/pool-project/', import.meta.url));
const validateProject = fileURLToPath(new URL('./fixtures/validate-project/', import.meta.url));

function bddr(...args: string[]) {
  return bddrIn(project, ...args);
}

function bddrIn(cwd: string, ...args: string[]) {
  return bddrEnv(cwd, {}, ...args);
}

function bddrEnv(cwd: string, env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!built)('bddr CLI (built)', () => {
  it('runs the project: exit 1 with failures, @wip excluded by config', () => {
    const r = bddr('run');
    expect(r.code).toBe(1);
    expect(r.out).toContain('✔ passes');
    expect(r.out).toContain('✘ fails');
    expect(r.out).toContain('? undefined');
    expect(r.out).not.toContain('work in progress');
    expect(r.out).toContain('3 scenarios (1 passed, 1 failed, 1 undefined)');
  });

  it('profile + -D params can make it green', () => {
    expect(bddr('--profile', 'green').code).toBe(0);
    const r = bddr('-t', 'not @green', '-D', 'env=prod', '--name', '^fails$');
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 scenario (1 passed)');
  });

  it('selects by file:line', () => {
    const r = bddr('features/mixed.feature:7');
    expect(r.out).toContain('1 scenario (1 failed)');
  });

  it('--dry-run reports undefined steps without executing', () => {
    const r = bddr('--dry-run', '--no-strict');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Given('something nobody wrote', async (ctx) => {`);
  });

  it('snippets prints code for undefined steps with their locations', () => {
    const r = bddr('snippets');
    expect(r.code).toBe(0);
    expect(r.out).toContain('// 1 undefined step pattern(s)');
    expect(r.out).toContain('// used at: features/mixed.feature:11');
    expect(r.out).toContain(`Given('something nobody wrote', async (ctx) => {`);
  });

  it('validate checks step coverage without executing scenarios', () => {
    const bad = bddr('validate');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('ERROR [undefined-step] features/mixed.feature:11 Undefined step: Given something nobody wrote');
    expect(bad.out).toMatch(/Validated 4 scenario\(s\), 4 step\(s\), \d+ definition\(s\): 2 error\(s\)/);

    const clean = bddrIn(orchestration, 'validate', '--fail-on-warnings');
    expect(clean.code, clean.out + clean.err).toBe(0);
    expect(clean.out).toContain('Validated 9 scenario(s), 17 step(s)');
    expect(clean.out).toContain('0 error(s), 0 warning(s)');

    const detailed = bddrIn(validateProject, 'validate', '--fail-on-warnings');
    expect(detailed.code).toBe(1);
    expect(detailed.out).toContain('ERROR [ambiguous-step]');
    expect(detailed.out).toContain('ERROR [undefined-step]');
    expect(detailed.out).toContain('WARN  [unused-step]');
    expect(detailed.out).toContain('WARN  [unmatched-hook]');
    expect(detailed.out).toContain('WARN  [unknown-tag]');
  });

  it('list prints ids and tags', () => {
    const r = bddr('list');
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toEqual([
      'features/mixed.feature::passes\tfeatures/mixed.feature:4\t@green',
      'features/mixed.feature::fails\tfeatures/mixed.feature:7',
      'features/mixed.feature::undefined\tfeatures/mixed.feature:10',
    ]);
  });

  it('writes NDJSON and JUnit via --format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-cli-'));
    bddr('-f', `ndjson:${join(dir, 'e.ndjson')}`, '-f', `junit:${join(dir, 'j.xml')}`);
    const lines = readFileSync(join(dir, 'e.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string });
    expect(lines[0]!.type).toBe('runStarted');
    expect(lines.at(-1)!.type).toBe('runFinished');
    expect(readFileSync(join(dir, 'j.xml'), 'utf8')).toContain('tests="3" failures="2"');
  });

  it('expands @data rows, switches data by profile, and exits 2 on data errors', () => {
    const r = bddrIn(dataProject);
    expect(r.code).toBe(2);
    expect(r.out).toContain('✔ ann has a balance (accounts.csv row 1)');
    expect(r.out).toContain('✔ bob has a balance (accounts.csv row 2)');
    expect(r.out).toContain('Parse errors:');
    expect(r.out).toContain('features/accounts.feature:6 Data file "nope.csv" not found');
    const ci = bddrIn(dataProject, '-p', 'ci', '--name', 'balance');
    expect(ci.out).toContain('✔ ci-bot has a balance (accounts.csv row 1)');
    const list = bddrIn(dataProject, 'list', '--name', 'balance');
    expect(list.out).toContain('features/accounts.feature::user-has-a-balance[accounts.csv#2]');
  });

  it('plan prints groups and dependencies; --explain and mermaid/json formats work', () => {
    const text = bddrIn(orchestration, 'plan');
    expect(text.code).toBe(0);
    expect(text.out).toContain('group checkout: parallel x3, 4 member(s), after setup');
    expect(bddrIn(orchestration, 'plan', '--explain', 'login').out).toContain('needed by:');
    expect(bddrIn(orchestration, 'plan', '--plan-format', 'mermaid').out).toMatch(/^flowchart LR/);
    const json = JSON.parse(bddrIn(orchestration, 'plan', '--plan-format', 'json').out) as { nodes: unknown[]; workers: number };
    expect(json.workers).toBe(4);
    expect(json.nodes).toHaveLength(9);
  });

  it('selecting one scenario pulls in its dependencies unless --no-deps', () => {
    const r = bddrIn(orchestration, 'run', '--name', 'Buy fig', '-w', '2');
    expect(r.code).toBe(0);
    expect(r.out).toContain('✔ Create a test user');
    expect(r.out).toContain('✔ Log in');
    expect(r.out).toContain('3 scenarios (3 passed)');
    const alone = bddrIn(orchestration, 'run', '--name', 'Buy fig', '--no-deps');
    expect(alone.code).toBe(1); // ctx.from('login') fails: login is not in the plan
    expect(alone.out).toContain('no scenario with this id in the plan');
  });

  it('--set overrides any config value (typed), rejects unknown keys', () => {
    const r = bddrIn(orchestration, 'plan', '-s', 'groups.checkout.mode=serial', '--set', 'workers=7', '-s', 'defaultMode="serial"');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Plan: 9 scenario(s), 4 group(s), workers=7');
    expect(r.out).toContain('group checkout: serial x3');
    const bad = bddrIn(orchestration, 'plan', '--set', 'wokers=2');
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--set: unknown option "wokers"');
  });

  it('--log-level controls console logs; debug adds CLI and scheduler diagnostics', () => {
    const normal = bddrIn(orchestration, 'run', '--name', 'Wallet');
    expect(normal.out).toContain('[info] paying 5 by wallet'); // default console level: info
    expect(normal.out).not.toContain('[debug]');
    const quiet = bddrIn(orchestration, 'run', '--name', 'Wallet', '--log-level', 'warn');
    expect(quiet.out).toContain('[warn] wallet payments are slow');
    expect(quiet.out).not.toContain('[info] paying');
    const loud = bddrIn(orchestration, 'run', '--name', 'Wallet', '--log-level', 'debug');
    expect(loud.out).toContain('[info] paying 5 by wallet');
    expect(loud.out).toContain('[bddr:debug] start features/payments.feature::wallet-payment on w1');
    expect(loud.err).toContain('[bddr:debug] config:');
    expect(bddrIn(orchestration, 'run', '--log-level', 'chatty').code).toBe(2);
  });

  it('runs the orchestration example green with 4 workers', () => {
    const r = bddrIn(orchestration);
    expect(r.code).toBe(0);
    expect(r.out).toContain('9 scenarios (9 passed)');
  });

  it('resilience example: retries, group retry, quarantine, soft asserts all green; flaky reported', () => {
    const r = bddrIn(resilience);
    expect(r.code).toBe(0);
    expect(r.out).toContain('↻ Pay through a flaky API attempt 1 failed: payment API returned 503 — retrying');
    expect(r.out).toContain('flaky (passed on attempt 2)');
    expect(r.out).toContain('↻ group warmup: attempt 2, re-running 1 scenario(s)');
    expect(r.out).toContain('[quarantined]');
    expect(r.out).toContain('Quarantined failures (do not fail the run):');
    expect(r.out).toMatch(/6 scenarios \(5 passed, 1 failed\) · 2 flaky, 2 retried, 1 quarantined/);
    expect(bddrIn(resilience, '--fail-on-flaky').code).toBe(1);
    const junit = readFileSync(join(resilience, 'reports/junit.xml'), 'utf8');
    expect(junit).toContain('<flakyFailure type="failed" message="payment API returned 503">');
    expect(junit).toContain('<skipped message="quarantined: BUG-123: float rounding in totals"/>');
  });

  it('--retry, --rerun-failed and bddr report merge runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-rerun-'));
    const first = bddrIn(rerunProject, '-f', `ndjson:${join(dir, 'run1.ndjson')}`);
    expect(first.code).toBe(1);
    expect(first.out).toContain('3 scenarios (1 passed, 1 failed, 1 skipped)');
    expect(bddrIn(rerunProject, '--retry', '2').out).toContain('↻ depends on the environment attempt 2 failed');
    const second = bddrIn(rerunProject, '--rerun-failed', join(dir, 'run1.ndjson'), '-D', 'backend=up', '-f', `ndjson:${join(dir, 'run2.ndjson')}`);
    expect(second.code).toBe(0);
    expect(second.out).toContain('2 scenarios (2 passed)'); // only what did not pass
    const nothing = bddrIn(rerunProject, '--rerun-failed', join(dir, 'run2.ndjson'));
    expect(nothing.out).toContain('Nothing to rerun');
    const merged = bddrIn(rerunProject, 'report', join(dir, 'run1.ndjson'), join(dir, 'run2.ndjson'), '-f', `html:${join(dir, 'merged.html')}`, '-f', 'console');
    expect(merged.code).toBe(0);
    expect(merged.out).toContain('3 scenarios (3 passed) · 2 flaky');
    expect(readFileSync(join(dir, 'merged.html'), 'utf8')).toContain('PASSED');
  });

  it('usage errors exit 2', () => {
    expect(bddr('--profile', 'nope').code).toBe(2);
    expect(bddr('--bogus').code).toBe(2);
    expect(bddr('-t', '@a and').code).toBe(2);
    expect(bddr('-w', '0').code).toBe(2);
    expect(bddr('--retry', 'x').code).toBe(2);
    expect(bddr('report').code).toBe(2);
  });
});

describe.skipIf(!built)('applySetOverrides', () => {
  it('parses JSON values, creates nested objects, keeps strings', async () => {
    const { applySetOverrides } = (await import(new URL('../dist/index.js', import.meta.url).href)) as typeof import('../src/index.js');
    const base = { params: { a: '1' }, groups: { x: { mode: 'parallel' as const } } };
    const out = applySetOverrides(base, ['groups.x.workers=3', 'groups.y.dependsOn=["x"]', 'params.url=https://h:8080/p?a=b', 'failFast=true']);
    expect(out).toEqual({
      params: { a: '1', url: 'https://h:8080/p?a=b' },
      groups: { x: { mode: 'parallel', workers: 3 }, y: { dependsOn: ['x'] } },
      failFast: true,
    });
    expect(base.groups.x).toEqual({ mode: 'parallel' }); // input not mutated
    expect(() => applySetOverrides(base, ['params.a.b=1'])).toThrow(/"a" is not an object/);
  });

  it('works when the config holds functions (plugin objects), which cannot be cloned', async () => {
    const { applySetOverrides } = (await import(new URL('../dist/index.js', import.meta.url).href)) as typeof import('../src/index.js');
    const plugin = { name: 'p', setup: () => undefined };
    const base = { plugins: [plugin], groups: { x: { mode: 'parallel' as const } } };
    const out = applySetOverrides(base, ['groups.x.workers=2', 'workers=4']);
    expect(out.plugins?.[0]).toBe(plugin);
    expect(out).toMatchObject({ workers: 4, groups: { x: { mode: 'parallel', workers: 2 } } });
    expect(base.groups.x).toEqual({ mode: 'parallel' });
  });

  describe('worker processes (--pool process)', () => {
    const traceFile = () => join(mkdtempSync(join(tmpdir(), 'bddr-pool-')), 'trace.txt');
    const count = (text: string, line: string) => text.split('\n').filter((l) => l.startsWith(line)).length;

    it('runs on separate processes: run hooks once in the parent, worker/feature hooks per process, exports + seed cross over', () => {
      const t = traceFile();
      const r = bddrIn(poolProject, 'run', '-D', `trace=${t}`);
      expect(r.code, r.out + r.err).toBe(0);
      expect(r.out).toContain('8 scenarios (8 passed)');
      expect(r.out).toContain('run store key(s) [notCloneable]');
      const trace = readFileSync(t, 'utf8');
      expect(count(trace, 'beforeAll parent')).toBe(1);
      expect(count(trace, 'afterAll parent')).toBe(1);
      expect(count(trace, 'beforeWorker w')).toBe(2);
      expect(count(trace, 'afterWorker w')).toBe(2);
      expect(count(trace, 'beforeFeature w')).toBe(count(trace, 'afterFeature w'));
      const pids = new Set(trace.split('\n').filter((l) => l.startsWith('scenario ')).map((l) => l.split(' ')[1]));
      expect(pids.size).toBe(2);
    });

    it('same results as the inline pool', () => {
      const inline = bddrIn(poolProject, 'run', '--pool', 'inline');
      expect(inline.code).toBe(0);
      expect(inline.out).toContain('8 scenarios (8 passed)');
      const t = traceFile();
      bddrIn(poolProject, 'run', '--pool', 'inline', '-D', `trace=${t}`);
      expect(count(readFileSync(t, 'utf8'), 'beforeWorker inline')).toBe(1);
      const res = bddrIn(resilience, 'run', '--pool', 'process');
      expect(res.out).toMatch(/6 scenarios \(5 passed, 1 failed\) · 2 flaky, 2 retried, 1 quarantined/);
      expect(res.code).toBe(0);
    });

    it('a crashing worker fails only its scenario; the run continues', () => {
      const r = bddrIn(poolProject, 'run', '-D', 'crash=yes');
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/worker w\d \(pid \d+\) exited unexpectedly \(code 3\)/);
      expect(r.out).toContain('8 scenarios (7 passed, 1 failed)');
    });

    it('enforces a group budget in the process pool by cancelling the lane', () => {
      const r = bddrIn(
        poolProject,
        'run',
        '--name',
        'Crashes when asked',
        '-D',
        'hang=yes',
        '--set',
        'groups.slow.match=@crash',
        '--set',
        'groups.slow.timeout=30ms',
      );
      expect(r.code).toBe(1);
      expect(r.out).toContain('Group "slow" timed out after 30 ms');
    });

    it('enforces a run-wide timeout across process workers', () => {
      const r = bddrIn(poolProject, 'run', '--name', 'Busy', '--run-timeout', '15ms');
      expect(r.code).toBe(1);
      expect(r.out).toContain('Run timed out after 15 ms');
    });

    it('handles Ctrl+C gracefully and returns exit code 130', async () => {
      const child = spawn(process.execPath, [bin, 'run', '--name', 'Crashes when asked', '-D', 'hang=yes'], {
        cwd: poolProject,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (s) => (output += s));
      child.stderr.setEncoding('utf8').on('data', (s) => (output += s));
      await new Promise((resolve) => setTimeout(resolve, 500));
      child.kill('SIGINT');
      const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
      expect(code, output).toBe(130);
      expect(output).toContain('Interrupted by SIGINT');
    });

    it('a worker that cannot start stops the run with the cause', () => {
      const r = bddrEnv(poolProject, { BDDR_TEST_BREAK_WORKER: '1' }, 'run');
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain('failed to start: support code broken in workers');
    });

    it('rejects a bad --pool value', () => {
      const r = bddrIn(poolProject, 'run', '--pool', 'threads');
      expect(r.code).toBe(2);
      expect(r.err).toContain('--pool must be inline or process');
    });
  });

  it('history: records runs, feeds the HTML report and bddr history ranks flaky scenarios', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-hist-e2e-'));
    const html = join(dir, 'r.html');
    const set = ['--set', `history={"dir":"${dir.split('\\').join('/')}/h","keep":5}`];
    for (let i = 0; i < 3; i++) expect(bddrIn(resilience, 'run', ...set, '-f', `html:${html}`).code).toBe(0);
    expect(readdirSync(join(dir, 'h'))).toHaveLength(3);
    const page = readFileSync(html, 'utf8');
    expect(page).toContain('<summary>History</summary>');
    expect(page).toContain('flaky score 1.00');
    const h = bddrIn(resilience, 'history', ...set, '--top', '2');
    expect(h.code).toBe(0);
    expect(h.out).toContain('Run history: 3 run(s)');
    expect(h.out).toMatch(/1\.00  ◐◐◐ +3\/3 passed +(Pay through a flaky API|Warm the cache)/);
    const none = bddrIn(resilience, 'history', '--set', `history={"dir":"${dir.split('\\').join('/')}/none"}`);
    expect(none.out).toContain('No run history');
    const dry = bddrIn(resilience, 'run', '--dry-run', ...set);
    expect(dry.code).toBe(0);
    expect(readdirSync(join(dir, 'h'))).toHaveLength(3); // dry runs are not recorded
  });

  it('process pool emits workerStarted and the HTML timeline shows start-up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-ws-'));
    const events = join(dir, 'e.ndjson');
    const html = join(dir, 'r.html');
    const r = bddrIn(poolProject, 'run', '-f', `ndjson:${events}`, '-f', `html:${html}`);
    expect(r.code).toBe(0);
    const started = readFileSync(events, 'utf8').split('\n').filter((l) => l.includes('"workerStarted"')).map((l) => JSON.parse(l));
    expect(started.map((e) => e.workerId).sort()).toEqual(['w1', 'w2']);
    expect(started[0].startupMs).toBeGreaterThan(0);
    expect(readFileSync(html, 'utf8')).toContain('class="tl-boot"');
  });

  it('--debug needs a terminal: exits 2 with a clear message when stdin is not a TTY', () => {
    const r = spawnSync(process.execPath, [bin, '--debug', '-D', 'env=local'], { cwd: project, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--debug needs an interactive terminal');
  });

  it('--debug-step and --inspect validate their arguments', () => {
    const r = spawnSync(process.execPath, [bin, '--inspect', '99999'], { cwd: project, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--inspect expects a port number');
  });

  it('--shard i/n runs a disjoint part of the plan, together all shards cover it, and bad specs exit 2', () => {
    const ids = (shard?: string) => {
      const r = spawnSync(process.execPath, [bin, 'plan', '--plan-format', 'json', ...(shard ? ['--shard', shard] : [])], { cwd: orchestration, encoding: 'utf8' });
      expect(r.status).toBe(0);
      return (JSON.parse(r.stdout) as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id);
    };
    const all = ids();
    const parts = ['1/3', '2/3', '3/3'].map((s) => ids(s));
    expect(parts.flat().sort()).toEqual([...all].sort());
    expect(new Set(parts.flat()).size).toBe(all.length);
    const bad = spawnSync(process.execPath, [bin, '--shard', '5/2'], { cwd: orchestration, encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--shard expects');
  });

  it('-f messages writes a valid Cucumber Messages stream (basic example: pickles, test cases, results)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-msg-'));
    const file = join(dir, 'm.ndjson');
    const r = spawnSync(process.execPath, [bin, '-f', `messages:${file}`, '-f', 'progress'], { cwd: join(orchestration, '..', 'basic'), encoding: 'utf8' });
    expect(r.status).toBe(0);
    const { parseEnvelope } = await import('@cucumber/messages');
    const envelopes = readFileSync(file, 'utf8').trim().split('\n').map((l) => parseEnvelope(l));
    const kinds = envelopes.map((e) => Object.keys(e)[0]!);
    expect(kinds[0]).toBe('meta');
    expect(kinds.at(-1)).toBe('testRunFinished');
    const count = (k: string) => kinds.filter((x) => x === k).length;
    expect(count('testCase')).toBe(count('testCaseStarted'));
    expect(count('testCaseStarted')).toBe(count('testCaseFinished'));
    expect(count('testStepStarted')).toBe(count('testStepFinished'));
    expect(count('gherkinDocument')).toBeGreaterThan(0);
    // every testCase refers to a pickle that was emitted earlier, and runs after its definition
    const pickles = new Set(envelopes.flatMap((e) => (e.pickle ? [e.pickle.id] : [])));
    const cases = envelopes.flatMap((e) => (e.testCase ? [e.testCase] : []));
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) expect(pickles.has(c.pickleId)).toBe(true);
    expect(kinds.indexOf('testRunStarted')).toBeLessThan(kinds.indexOf('testCase'));
    expect(kinds.lastIndexOf('testCase')).toBeLessThan(kinds.indexOf('testCaseStarted'));
    const statuses = new Set(envelopes.flatMap((e) => (e.testStepFinished ? [e.testStepFinished.testStepResult.status] : [])));
    expect([...statuses]).toEqual(['PASSED']);
    expect(envelopes.at(-1)!.testRunFinished!.success).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('-f messages reports retries as attempts with willBeRetried', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-msg-'));
    const file = join(dir, 'm.ndjson');
    spawnSync(process.execPath, [bin, '-f', `messages:${file}`, '-f', 'progress'], { cwd: resilience, encoding: 'utf8' });
    const { parseEnvelope } = await import('@cucumber/messages');
    const envelopes = readFileSync(file, 'utf8').trim().split('\n').map((l) => parseEnvelope(l));
    const started = envelopes.flatMap((e) => (e.testCaseStarted ? [e.testCaseStarted] : []));
    const finished = envelopes.flatMap((e) => (e.testCaseFinished ? [e.testCaseFinished] : []));
    expect(started.some((s) => s.attempt >= 1)).toBe(true);
    expect(finished.some((f) => f.willBeRetried)).toBe(true);
    expect(envelopes.some((e) => e.testStepFinished?.testStepResult.status === 'FAILED' && e.testStepFinished.testStepResult.exception)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('bddr docs renders the spec folders with results and the folder README', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bddr-docs-'));
    const basic = join(orchestration, '..', 'basic');
    const events = join(dir, 'e.ndjson');
    expect(spawnSync(process.execPath, [bin, '-f', `ndjson:${events}`, '-f', 'progress'], { cwd: basic, encoding: 'utf8' }).status).toBe(0);
    const out = join(dir, 'docs.html');
    const r = spawnSync(process.execPath, [bin, 'docs', '--results', events, '-o', out, '--title', 'Basic shop'], { cwd: basic, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('4 feature(s), 13 scenario(s)');
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('Basic shop');
    expect(html).toContain('Shopping basket');
    expect(html).toContain('13 passed');
    rmSync(dir, { recursive: true, force: true });
  });
});
