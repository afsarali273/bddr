/**
 * `bddr --watch`: run, then re-run when files change.
 * Every run is a fresh child process (same CLI, no --watch), so edited step code, page objects and config always reload.
 *   - a changed .feature / data file re-runs just that file (its dependencies are pulled in by the plan),
 *   - a changed step/support/config file re-runs the original selection.
 * Keys while idle: Enter or `a` = run everything again, `f` = only scenarios that failed last time, `q` = quit.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { watch as fsWatch, mkdtempSync, rmSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

const IGNORED = ['node_modules', '.git', '.bddr', 'dist', 'reports', 'test-results', 'playwright-report', 'coverage'];
const FEATURE_FILE = /\.(feature|md)$/i;

export function isIgnored(rel: string): boolean {
  return rel.split(/[\\/]/).some((p) => IGNORED.includes(p) || p.startsWith('.#') || p.endsWith('~') || p.endsWith('.swp'));
}

export interface WatchRunPlan {
  /** Re-run exactly these spec files (relative to the root); undefined = the original selection. */
  paths?: string[];
}

/** What to run for a batch of changed files (relative paths, posix or native separators). */
export function planWatchRun(changed: string[]): WatchRunPlan {
  const rel = changed.filter((c) => !isIgnored(c));
  if (!rel.length) return { paths: [] };
  const onlyFeatures = rel.every((f) => FEATURE_FILE.test(f));
  if (onlyFeatures) return { paths: [...new Set(rel.map((f) => f.split(sep).join('/')))].sort() };
  // Step code, config, data (a data file can feed any feature) or anything else: the original selection.
  return {};
}

export interface WatchOptions {
  rootDir: string;
  /** CLI arguments for one run, WITHOUT --watch and without spec paths. */
  baseArgs: string[];
  /** The spec paths the user gave (empty = config features). */
  userPaths: string[];
  /** The CLI entry (bin.js) and Node flags used to start each run. */
  entry: string;
  execArgv?: string[];
  cwd: string;
  debounceMs?: number;
  /** Test hooks. */
  spawnRun?: (args: string[]) => ChildProcess;
  stdin?: NodeJS.ReadableStream;
  out?: (text: string) => void;
  signal?: AbortSignal;
}

interface RunRequest {
  paths?: string[];
  failedOnly?: boolean;
}

export async function watchLoop(o: WatchOptions): Promise<number> {
  const out = o.out ?? ((t: string) => void process.stdout.write(t));
  const debounce = o.debounceMs ?? 250;
  const tmp = mkdtempSync(join(tmpdir(), 'bddr-watch-'));
  const eventsFile = join(tmp, 'last.ndjson');
  const spawnRun =
    o.spawnRun ??
    ((args: string[]) => spawn(process.execPath, [...(o.execArgv ?? []), o.entry, ...args], { cwd: o.cwd, stdio: 'inherit', env: { ...process.env, FORCE_COLOR: process.env['FORCE_COLOR'] ?? '1' } }));

  let running: ChildProcess | undefined;
  let pending: RunRequest | undefined; // coalesced request waiting for the current run
  let quit = false;
  let lastFailedKnown = false;
  const changed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const input = o.stdin ?? process.stdin;
  const watchers: FSWatcher[] = [];
  let rl: ReturnType<typeof createInterface> | undefined;
  let stop: () => void = () => {};
  const done = new Promise<number>((resolveDone) => {
    stop = () => {
      if (quit) return;
      quit = true;
      clearTimeout(timer);
      for (const w of watchers) w.close();
      rl?.close();
      // An open stdin pipe would keep Node alive after we are done.
      (input as { pause?: () => void; unref?: () => void } | undefined)?.pause?.();
      (input as { unref?: () => void } | undefined)?.unref?.();
      running?.kill();
      process.off('SIGINT', stop);
      rmSync(tmp, { recursive: true, force: true });
      resolveDone(0);
    };
    o.signal?.addEventListener('abort', stop, { once: true });
    process.once('SIGINT', stop);
  });

  const startRun = (req: RunRequest) => {
    if (quit) return;
    const args = [...o.baseArgs, '-f', `ndjson:${eventsFile}`];
    if (req.failedOnly) args.push('--rerun-failed', eventsFile);
    const paths = req.paths ?? o.userPaths;
    args.push(...(req.failedOnly ? [] : paths));
    out(`\n\x1b[2m─── bddr watch: ${req.failedOnly ? 'rerunning failed scenarios' : req.paths ? `running ${req.paths.join(', ')}` : 'running'} ───\x1b[22m\n`);
    const child = spawnRun(args);
    running = child;
    child.on('exit', (code) => {
      running = undefined;
      lastFailedKnown = code === 1;
      out(`\n\x1b[2mbddr watch: ${code === 0 ? 'passed' : code === 1 ? 'failed' : `exit ${code}`}. Waiting for changes (Enter = all, f = failed, q = quit)\x1b[22m\n`);
      if (pending) {
        const next = pending;
        pending = undefined;
        startRun(next);
      }
    });
  };
  /** Requests that arrive while a run is busy are merged: file lists union, anything else becomes a full run. */
  const merge = (a: RunRequest | undefined, b: RunRequest): RunRequest => {
    if (!a) return b;
    if (a.paths && b.paths) return { paths: [...new Set([...a.paths, ...b.paths])] };
    if (a.failedOnly && b.failedOnly) return a;
    return {};
  };
  const request = (req: RunRequest) => {
    if (running) pending = merge(pending, req);
    else startRun(req);
  };

  watchers.push(
    fsWatch(o.rootDir, { recursive: true }, (_ev, file) => {
      if (!file || isIgnored(String(file))) return;
      changed.add(relative(o.rootDir, join(o.rootDir, String(file))));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const batch = planWatchRun([...changed]);
        changed.clear();
        if (batch.paths && !batch.paths.length) return;
        request(batch);
      }, debounce);
    }),
  );

  if (input) {
    rl = createInterface({ input });
    rl.on('line', (l) => {
      const k = l.trim().toLowerCase();
      if (k === 'q') stop();
      else if (k === 'f') {
        if (lastFailedKnown) request({ failedOnly: true });
        else out('bddr watch: nothing failed in the last run\n');
      } else if (k === '' || k === 'a') request({});
    });
  }

  out(`bddr watch: watching ${o.rootDir} (ignoring ${IGNORED.join(', ')}). Ctrl+C to stop.\n`);
  startRun({});
  return done;
}
