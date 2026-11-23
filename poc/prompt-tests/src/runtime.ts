import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssertionError, ContractError, ElementNotFound, EnvironmentError, MethodNotFound, RouteNotFound } from './errors.js';
import { expect } from './expect.js';

/**
 * How a run ended. The healer decides from this alone whether healing is even allowed.
 *  passed                every approved check ran once and held
 *  check-failed          a check's assertion did not hold          -> real failure, never healed
 *  check-target-missing  a check could not find what it inspects   -> failure; a heal can only be a proposal
 *  check-error           a check threw something else              -> failure
 *  contract-violation    unknown, repeated or missing check        -> failure
 *  action-failed         navigation/click/setup could not find its target -> may be healed
 *  action-error          action code threw something else          -> failure (a bug in the test or the app)
 *  environment           network or infrastructure                 -> retried, never healed
 *  load-error            the compiled file does not load
 */
export type Outcome =
  | 'passed'
  | 'check-failed'
  | 'check-target-missing'
  | 'check-error'
  | 'contract-violation'
  | 'action-failed'
  | 'action-error'
  | 'environment'
  | 'load-error';

export interface CheckResult {
  id: string;
  status: 'passed' | 'failed' | 'not-run';
  message?: string;
}

export interface RunResult {
  outcome: Outcome;
  checks: CheckResult[];
  /** The error that ended the run, when it failed. */
  error?: Error;
  /** The check that failed, when the failure was inside a check. */
  failedCheck?: string;
  ms: number;
}

export type TestFn = (fixtures: Record<string, unknown>) => Promise<void>;

class CheckFailure extends Error {
  constructor(
    readonly checkId: string,
    readonly inner: unknown,
  ) {
    super(`check ${checkId} failed`);
  }
}

let counter = 0;

/** Load a compiled test from source text. Each call gets a fresh module (no import cache reuse). */
export async function loadCompiled(code: string, tmpDir: string): Promise<TestFn> {
  mkdirSync(tmpDir, { recursive: true });
  const file = join(tmpDir, `compiled-${process.pid}-${++counter}.ts`);
  writeFileSync(file, code);
  try {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (typeof mod.default !== 'function') throw new Error('compiled file has no default export function');
    return mod.default as TestFn;
  } finally {
    rmSync(file, { force: true });
  }
}

/** Run compiled code once against fresh fixtures, enforcing the approved contract. */
export async function runCompiled(
  code: string,
  options: { contract: string[]; fixtures: Record<string, unknown>; tmpDir: string },
): Promise<RunResult> {
  const t0 = performance.now();
  const results = new Map<string, CheckResult>();
  const finish = (r: Omit<RunResult, 'checks' | 'ms'>): RunResult => ({
    ...r,
    checks: options.contract.map((id) => results.get(id) ?? { id, status: 'not-run' }),
    ms: Math.round(performance.now() - t0),
  });

  let fn: TestFn;
  try {
    fn = await loadCompiled(code, options.tmpDir);
  } catch (e) {
    return finish({ outcome: 'load-error', error: e as Error });
  }

  const check = async (id: string, body: () => unknown): Promise<void> => {
    if (!options.contract.includes(id)) throw new ContractError(`check ${id} is not in the approved contract`);
    if (results.has(id)) throw new ContractError(`check ${id} ran twice`);
    try {
      await body();
      results.set(id, { id, status: 'passed' });
    } catch (e) {
      results.set(id, { id, status: 'failed', message: (e as Error).message });
      throw new CheckFailure(id, e);
    }
  };

  try {
    await fn({ ...options.fixtures, check, expect });
  } catch (e) {
    if (e instanceof CheckFailure) {
      const inner = e.inner as Error;
      const outcome: Outcome =
        inner instanceof AssertionError ? 'check-failed' : inner instanceof ElementNotFound ? 'check-target-missing' : 'check-error';
      return finish({ outcome, error: inner, failedCheck: e.checkId });
    }
    if (e instanceof ContractError) return finish({ outcome: 'contract-violation', error: e });
    if (e instanceof EnvironmentError) return finish({ outcome: 'environment', error: e });
    if (e instanceof ElementNotFound || e instanceof RouteNotFound || e instanceof MethodNotFound) {
      return finish({ outcome: 'action-failed', error: e });
    }
    return finish({ outcome: 'action-error', error: e as Error });
  }

  const missing = options.contract.filter((id) => !results.has(id));
  if (missing.length) {
    return finish({ outcome: 'contract-violation', error: new ContractError(`approved checks never ran: ${missing.join(', ')}`) });
  }
  return finish({ outcome: 'passed' });
}

/** Run, retrying environment failures (never anything else) with a fresh app each time. */
export async function runWithRetry(
  code: string,
  options: { contract: string[]; fixtures: (attempt: number) => Record<string, unknown>; tmpDir: string; maxAttempts?: number },
): Promise<{ result: RunResult; retries: number }> {
  const max = options.maxAttempts ?? 3;
  let attempt = 1;
  let result = await runCompiled(code, { contract: options.contract, fixtures: options.fixtures(attempt), tmpDir: options.tmpDir });
  while (result.outcome === 'environment' && attempt < max) {
    attempt++;
    result = await runCompiled(code, { contract: options.contract, fixtures: options.fixtures(attempt), tmpDir: options.tmpDir });
  }
  return { result, retries: attempt - 1 };
}
