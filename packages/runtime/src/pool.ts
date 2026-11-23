/**
 * Worker processes (`pool: 'process'`).
 *
 * The parent (coordinator) owns the plan, the scheduler, run-level hooks and reporters. Each scheduler lane
 * ('w1'…'wN') is backed by one child process that loads the same config + support code, rebuilds the same plan,
 * and runs the nodes it is sent. Children stream every event back over IPC; the parent re-emits them.
 *
 * Protocol (structured-clone IPC):
 *   parent → child  {t:'init', init, seed, workerId, planFingerprint} | {t:'run', id, req} | {t:'close', id, scopes}
 *                   | {t:'shutdown', id}
 *   child  → parent {t:'ready'} | {t:'initError', error} | {t:'event', e} | {t:'result', id, value}
 *                   | {t:'error', id, error}
 *
 * Keep docs/IMPLEMENTATION.md §2f in sync.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventBus, toErrorInfo, type BddrEvent, type ErrorInfo, type Plan, type Status } from '@bddr/core';

/** What the coordinator sends to run one plan node on a worker. */
export interface NodeRequest {
  nodeId: string;
  workerId: string;
  /** Attempts already used (group retry re-runs continue the count). */
  attemptBase: number;
  /** Scheduler wait before this node started (see ScenarioStarted.waitedForMs). */
  waitedForMs?: number;
  /** An earlier attempt did not pass (so a pass now is flaky). */
  failedBefore: boolean;
  groupAttempts: Record<string, number>;
  /** Scenarios finished since this worker's last request: [id, status, exports]. Filled by the pool. */
  finished?: Array<[string, Status, Record<string, unknown> | undefined]>;
}

export interface NodeResult {
  status: Status;
  attempts: number;
  stepStatuses: Status[];
  flaky: boolean;
  failedBefore: boolean;
  exports?: Record<string, unknown>;
  /** A hook failed in the worker (rule/feature/group/worker level), which fails the run. */
  runFailed: boolean;
}

export interface ScopeRef {
  kind: 'rule' | 'feature' | 'group';
  /** feature: uri; rule: rule key; group: name. */
  key: string;
  /** Any member scenario (to look up feature / rule info). */
  scenarioId?: string;
}

export interface CloseResult {
  /** Keys whose After* hooks or cleanups failed. */
  failed: string[];
  runFailed: boolean;
}

/** Runs plan nodes somewhere else. Implemented by ProcessPool; the Executor's coordinator mode uses it. */
export interface RemotePool {
  /** Called once after BeforeAll with the (structured-cloneable part of the) run store. */
  start(seed: Record<string, unknown>): Promise<void>;
  /** Make a finished scenario's status + exports visible to workers (ctx.from). */
  publish(id: string, status: Status, exports: Record<string, unknown> | undefined): void;
  /** Rejects with WorkerInitError / WorkerCrashedError. */
  run(req: NodeRequest): Promise<NodeResult>;
  /** Close scopes in the given workers (those that may have opened them). Dead workers are ignored. */
  close(workerIds: readonly string[], scopes: readonly ScopeRef[]): Promise<CloseResult>;
  /** AfterWorker hooks + exit in every live worker. */
  stop(): Promise<{ runFailed: boolean }>;
  /** Cancel work on one lane (group/run timeout or external cancellation). */
  cancel?(workerId: string): void;
}

/** The stack would point into bddr internals; the message carries the cause. */
export class WorkerInitError extends Error {
  override name = 'WorkerInitError';
  constructor(message: string) {
    super(message);
    this.stack = `${this.name}: ${message}`;
  }
}
export class WorkerCrashedError extends Error {
  override name = 'WorkerCrashedError';
  constructor(message: string) {
    super(message);
    this.stack = `${this.name}: ${message}`;
  }
}

/** Identifies a plan (ids in order). Parent and workers must agree, or results would go to the wrong scenarios. */
export function planFingerprint(plan: Plan): string {
  return createHash('sha1').update(plan.nodes.map((n) => n.id).join('\n')).digest('hex');
}

// ------------------------------------------------------------------ parent side

export interface ProcessPoolOptions {
  /** Worker entry module (calls serveWorker). */
  entry: string;
  /** Opaque, structured-cloneable payload for the worker factory (e.g. the CLI run request). */
  init: unknown;
  planFingerprint: string;
  /** Events from workers. */
  onEvent: (e: BddrEvent) => void;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

class Lane {
  readonly pending = new Map<number, Pending>();
  synced = 0;
  dead = false;
  exit: Promise<void>;
  ready: Promise<void>;
  private nextId = 1;

  constructor(
    readonly workerId: string,
    readonly child: ChildProcess,
    onEvent: (e: BddrEvent) => void,
  ) {
    let readyResolve!: () => void;
    let readyReject!: (e: unknown) => void;
    this.ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    this.ready.catch(() => undefined);
    child.on('message', (m: ChildMessage) => {
      switch (m.t) {
        case 'event':
          onEvent(m.e);
          break;
        case 'ready':
          readyResolve();
          break;
        case 'initError':
          readyReject(new WorkerInitError(`worker ${workerId} failed to start: ${m.error.message}${m.error.stack ? `\n${m.error.stack}` : ''}`));
          break;
        case 'result':
        case 'error': {
          const p = this.pending.get(m.id);
          if (!p) break;
          this.pending.delete(m.id);
          if (m.t === 'result') p.resolve(m.value);
          else p.reject(Object.assign(new Error(m.error.message), m.error));
          break;
        }
      }
    });
    this.exit = new Promise<void>((res) => {
      child.on('exit', (code, signal) => {
        this.dead = true;
        const err = new WorkerCrashedError(`worker ${workerId} (pid ${child.pid}) exited unexpectedly (${signal ?? `code ${code}`})`);
        readyReject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        res();
      });
    });
  }

  request<T>(msg: Record<string, unknown>): Promise<T> {
    if (this.dead) return Promise.reject(new WorkerCrashedError(`worker ${this.workerId} is not running`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.send({ ...msg, id });
    });
  }
}

export class ProcessPool implements RemotePool {
  private readonly lanes = new Map<string, Lane>();
  private readonly log: Array<[string, Status, Record<string, unknown> | undefined]> = [];
  private seed: Record<string, unknown> = {};

  constructor(private readonly opts: ProcessPoolOptions) {}

  async start(seed: Record<string, unknown>): Promise<void> {
    this.seed = seed;
  }

  publish(id: string, status: Status, exports: Record<string, unknown> | undefined): void {
    this.log.push([id, status, exports]);
  }

  private async lane(workerId: string): Promise<Lane> {
    let lane = this.lanes.get(workerId);
    if (!lane || lane.dead) {
      const index = Number(workerId.replace(/\D/g, '')) || 1;
      const child = fork(this.opts.entry, [], {
        serialization: 'advanced',
        execArgv: this.opts.execArgv ?? process.execArgv,
        env: { ...process.env, ...this.opts.env, BDDR_WORKER_ID: workerId, BDDR_WORKER_INDEX: String(index) },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      lane = new Lane(workerId, child, this.opts.onEvent);
      this.lanes.set(workerId, lane);
      const forked = Date.now();
      child.send({ t: 'init', init: this.opts.init, seed: this.seed, workerId, planFingerprint: this.opts.planFingerprint });
      lane.ready.then(
        () => this.opts.onEvent({ type: 'workerStarted', ts: Date.now(), workerId, pid: child.pid ?? 0, startupMs: Date.now() - forked }),
        () => undefined,
      );
    }
    await lane.ready;
    return lane;
  }

  async run(req: NodeRequest): Promise<NodeResult> {
    const lane = await this.lane(req.workerId);
    const finished = this.log.slice(lane.synced);
    lane.synced = this.log.length;
    return lane.request<NodeResult>({ t: 'run', req: { ...req, finished } });
  }

  async close(workerIds: readonly string[], scopes: readonly ScopeRef[]): Promise<CloseResult> {
    const out: CloseResult = { failed: [], runFailed: false };
    const results = await Promise.all(
      workerIds.map((w) => {
        const lane = this.lanes.get(w);
        if (!lane || lane.dead) return undefined;
        return lane.request<CloseResult>({ t: 'close', scopes }).catch(() => undefined);
      }),
    );
    for (const r of results) {
      if (!r) continue;
      for (const k of r.failed) if (!out.failed.includes(k)) out.failed.push(k);
      out.runFailed ||= r.runFailed;
    }
    return out;
  }

  async stop(): Promise<{ runFailed: boolean }> {
    let runFailed = false;
    await Promise.all(
      [...this.lanes.values()].map(async (lane) => {
        if (lane.dead) return;
        try {
          const r = await lane.request<{ runFailed: boolean }>({ t: 'shutdown' });
          runFailed ||= r.runFailed;
        } catch {
          // crashed during shutdown: nothing to collect
        }
        const timer = setTimeout(() => lane.child.kill(), 5000);
        await lane.exit;
        clearTimeout(timer);
      }),
    );
    this.lanes.clear();
    return { runFailed };
  }

  /** Kill every worker (used when the parent is interrupted). */
  kill(): void {
    for (const lane of this.lanes.values()) if (!lane.dead) lane.child.kill();
  }

  cancel(workerId: string): void {
    const lane = this.lanes.get(workerId);
    if (lane && !lane.dead) lane.child.kill();
  }
}

// ------------------------------------------------------------------ child side

type ChildMessage =
  | { t: 'event'; e: BddrEvent }
  | { t: 'ready' }
  | { t: 'initError'; error: ErrorInfo }
  | { t: 'result'; id: number; value: unknown }
  | { t: 'error'; id: number; error: ErrorInfo };

type ParentMessage =
  | { t: 'init'; init: unknown; seed: Record<string, unknown>; workerId: string; planFingerprint: string }
  | { t: 'run'; id: number; req: NodeRequest }
  | { t: 'close'; id: number; scopes: ScopeRef[] }
  | { t: 'shutdown'; id: number };

/** The part of the Executor a worker process drives (see Executor "worker mode"). */
export interface WorkerExecutor {
  initWorker(seed: Record<string, unknown>): Promise<void>;
  runAssigned(req: NodeRequest): Promise<NodeResult>;
  closeScopes(scopes: readonly ScopeRef[]): Promise<CloseResult>;
  shutdownWorker(): Promise<{ runFailed: boolean }>;
}

export interface WorkerSetup {
  executor: WorkerExecutor;
  plan: Plan;
}

/**
 * Child-process entry helper: receives the init payload, lets `factory` build an Executor in worker mode
 * (with `remoteWorker: true` and the given bus), then serves run/close/shutdown requests.
 */
export function serveWorker(factory: (init: unknown, bus: EventBus) => Promise<WorkerSetup>): void {
  const send = (m: ChildMessage) => {
    try {
      process.send!(m);
    } catch {
      // not structured-cloneable (e.g. a function in log data): fall back to JSON
      process.send!(JSON.parse(JSON.stringify(m)) as ChildMessage);
    }
  };
  let executor: WorkerExecutor | undefined;
  let queue = Promise.resolve();
  process.on('message', (m: ParentMessage) => {
    // one message at a time, in order (a lane runs one node at a time anyway)
    queue = queue.then(() => handle(m)).catch(() => undefined);
  });
  // The parent going away (crash / Ctrl+C) must not leave orphans.
  process.on('disconnect', () => process.exit(0));

  async function handle(m: ParentMessage): Promise<void> {
    if (m.t === 'init') {
      try {
        const bus = new EventBus();
        bus.on((e) => send({ t: 'event', e }));
        const setup = await factory(m.init, bus);
        const fp = planFingerprint(setup.plan);
        if (fp !== m.planFingerprint) {
          throw new Error(
            'the plan built in the worker differs from the parent plan (spec files or data sources changed during the run, or non-deterministic data)',
          );
        }
        executor = setup.executor;
        await executor.initWorker(m.seed);
        send({ t: 'ready' });
      } catch (e) {
        send({ t: 'initError', error: toErrorInfo(e) });
        setTimeout(() => process.exit(1), 50);
      }
      return;
    }
    try {
      if (!executor) throw new Error('worker not initialised');
      const value =
        m.t === 'run' ? await executor.runAssigned(m.req) : m.t === 'close' ? await executor.closeScopes(m.scopes) : await executor.shutdownWorker();
      send({ t: 'result', id: m.id, value });
      if (m.t === 'shutdown') setTimeout(() => process.exit(0), 10);
    } catch (e) {
      send({ t: 'error', id: m.id, error: toErrorInfo(e) });
    }
  }
}
