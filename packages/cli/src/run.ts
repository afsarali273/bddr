import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { glob } from 'tinyglobby';
import {
  EventBus,
  HistoryRecorder,
  loadHistory,
  rankScenarios,
  saveHistory,
  type HistoryRun,
  buildPlan,
  parseShard,
  shardPlan,
  scenarioHistory,
  idsToRerun,
  mergeEventStreams,
  parseDuration,
  parseNdjson,
  createFileDataLoader,
  type LogLevel,
  type Plan,
  type Status,
  parsePathWithLines,
  parseSpecFile,
  specFileGlobSuffix,
  type DataLoader,
  selectScenarios,
  type ParsedSpec,
  type RunSummary,
  type ScenarioInstance,
} from '@bddr/core';
import { createDebugController, terminalIO, type DebugIO } from './debug.js';
import { CancellationError, Executor, ProcessPool, TimeoutError, getGlobalRegistry, planFingerprint, type ExecuteOptions, type RetryOptions, type WorkerSetup } from '@bddr/runtime';
import { CONSOLE_REPORTERS, createReporter, renderLivingDocs, type Reporter, type ReporterSpec } from '@bddr/reporters';
import { applySetOverrides, DEFAULTS, loadConfig, mergeOptions, UsageError, type BddrOptions, type PluginSpec } from './config.js';

export interface RunRequest {
  cwd?: string;
  config?: string;
  profile?: string;
  /** Feature paths/globs, optionally with `:line` suffixes. Replace config `features` when given. */
  paths?: string[];
  tags?: string;
  name?: string;
  dryRun?: boolean;
  failFast?: boolean;
  strict?: boolean;
  /** Extra reporters (added to config reporters). */
  formats?: ReporterSpec[];
  params?: Record<string, string>;
  stepTimeoutMs?: number;
  /** Override all reporters (programmatic use / tests). */
  reporters?: Reporter[];
  /** Max concurrent scenarios (overrides config `workers`). */
  workers?: number;
  /** Pull in dependencies of selected scenarios (default true). */
  withDeps?: boolean;
  /** `--set path=value` overrides, applied after the profile and before the other CLI flags. */
  sets?: string[];
  /** Console log level (overrides config `logLevel`). */
  logLevel?: LogLevel;
  /** Extra attempts for failed scenarios (overrides config retry.scenario). */
  retry?: number;
  /** Extra attempts on a fresh process after a worker crash. */
  workerCrashRetry?: number;
  failOnFlaky?: boolean;
  /** NDJSON events of an earlier run: run only scenarios that did not pass there (plus their dependencies). */
  rerunFailed?: string;
  /** 'inline' (default) or 'process' (overrides config `pool`). */
  pool?: 'inline' | 'process';
  /**
   * Interactive debugging: pause after a failing step ('fail') or before every step ('step').
   * Forces one worker in this process, no retries and no scenario/group/run time budgets.
   */
  debug?: 'fail' | 'step';
  /** Debugger IO (tests). Default: the terminal; requires a TTY. */
  debugIO?: DebugIO;
  /** Open the Node inspector (port) and wait for a client before running. */
  inspect?: number | true;
  /** CI sharding: run only shard i of n (`'2/4'`). Durations come from the run history when configured. */
  shard?: string;
  /** Programmatic cancellation. CLI Ctrl+C uses the same path. */
  signal?: AbortSignal;
  /** Internal: no CLI diagnostics (worker processes repeat the parent's preparation). */
  quiet?: boolean;
}

export interface RunOutcome {
  success: boolean;
  summary?: RunSummary;
  /** 0 = passed, 1 = validation/scenarios failed, 2 = usage/config/parse error, 130 = SIGINT. */
  exitCode: 0 | 1 | 2 | 130;
  interrupted?: boolean;
  scenarios: ScenarioInstance[];
}

let loaderRegistered = false;

/** Lets Node import .ts config and step files (via tsx). Idempotent. */
export async function registerTypeScriptLoader(): Promise<void> {
  if (loaderRegistered) return;
  const { register } = await import('tsx/esm/api');
  register();
  loaderRegistered = true;
}

const toPosix = (p: string) => p.split('\\').join('/');

/** Resolve feature paths/globs into files + per-file line filters. URIs are relative to rootDir. */
export async function discoverSpecs(rootDir: string, patterns: string[]): Promise<{ files: string[]; lines: Record<string, number[]> }> {
  const lines: Record<string, number[]> = {};
  const globs: string[] = [];
  for (const raw of patterns) {
    const { path, lines: ls } = parsePathWithLines(raw);
    const abs = isAbsolute(path) ? path : resolve(rootDir, path);
    const st = await stat(abs).catch(() => undefined);
    if (st?.isDirectory()) {
      globs.push(toPosix(relative(rootDir, abs) || '.') + `/**/*.${specFileGlobSuffix()}`);
    } else if (st?.isFile()) {
      const uri = toPosix(relative(rootDir, abs));
      globs.push(uri);
      if (ls.length) lines[uri] = [...(lines[uri] ?? []), ...ls];
    } else {
      globs.push(toPosix(path));
    }
  }
  const files = (await glob(globs, { cwd: rootDir, absolute: false, dot: false })).map(toPosix).sort();
  return { files, lines };
}

export async function discoverSupportFiles(rootDir: string, patterns: string[]): Promise<string[]> {
  const files = await glob(patterns, { cwd: rootDir, absolute: true, ignore: ['**/node_modules/**', '**/*.d.ts'] });
  return files.sort();
}

/** The whole `bddr run` pipeline, usable programmatically. */
export interface PreparedRun {
  rootDir: string;
  /** Set with --rerun-failed: the ids that did not pass in the earlier run. */
  rerunIds?: string[] | undefined;
  opts: BddrOptions;
  specs: ParsedSpec[];
  all: ScenarioInstance[];
  selected: ScenarioInstance[];
  plan: Plan;
}

/** Config + discovery + parsing + selection + plan. Shared by `run`, `plan` and `list`. */
export async function prepareRun(req: RunRequest = {}): Promise<PreparedRun> {
  const cwd = req.cwd ?? process.cwd();
  await registerTypeScriptLoader();
  const loaded = await loadConfig(req.config, cwd, req.profile);
  const rootDir = loaded.rootDir;

  let opts: BddrOptions = req.sets?.length ? applySetOverrides(loaded.options, req.sets) : loaded.options;
  const cliOverrides: BddrOptions = {};
  if (req.logLevel) cliOverrides.logLevel = req.logLevel;
  if (req.retry !== undefined || req.workerCrashRetry !== undefined || req.failOnFlaky !== undefined) {
    cliOverrides.retry = {
      ...(req.retry !== undefined ? { scenario: req.retry } : {}),
      ...(req.workerCrashRetry !== undefined ? { workerCrash: req.workerCrashRetry } : {}),
      ...(req.failOnFlaky !== undefined ? { failOnFlaky: req.failOnFlaky } : {}),
    };
  }
  if (req.tags) cliOverrides.tags = req.tags;
  if (req.name) cliOverrides.name = req.name;
  if (req.params) cliOverrides.params = req.params;
  if (req.failFast !== undefined) cliOverrides.failFast = req.failFast;
  if (req.strict !== undefined) cliOverrides.strict = req.strict;
  if (req.stepTimeoutMs !== undefined) cliOverrides.stepTimeoutMs = req.stepTimeoutMs;
  if (req.workers !== undefined) cliOverrides.workers = req.workers;
  if (req.pool !== undefined) cliOverrides.pool = req.pool;
  opts = mergeOptions(opts, cliOverrides);
  if (req.debug) opts = forDebugging(opts);

  // CLI paths are relative to cwd; config globs are relative to rootDir.
  const featurePatterns = req.paths?.length
    ? req.paths.map((p) => {
        const { path, lines } = parsePathWithLines(p);
        const abs = resolve(cwd, path);
        return toPosix(relative(rootDir, abs)) + (lines.length ? `:${lines.join(':')}` : '');
      })
    : asArray(opts.features ?? DEFAULTS.features);
  const { files, lines } = await discoverSpecs(rootDir, featurePatterns);
  if (!files.length) throw new UsageError(`No spec files found for: ${featurePatterns.join(', ')} (root: ${rootDir})`);

  // Dependencies may live in files outside the selected paths: parse every configured spec for resolution.
  const allFiles = req.paths?.length
    ? [...new Set([...files, ...(await discoverSpecs(rootDir, asArray(opts.features ?? DEFAULTS.features))).files])]
    : files;
  const dataLoader = makeDataLoader(rootDir, opts, req.profile);
  const specs: ParsedSpec[] = [];
  for (const uri of allFiles) {
    const source = await readFile(resolve(rootDir, uri), 'utf8');
    specs.push(await parseSpecFile(source, uri, { dataLoader, ...(opts.language ? { language: opts.language } : {}) }));
  }
  const inPaths = new Set(files);
  const all = specs.flatMap((s) => s.scenarios);
  let rerunIds: string[] | undefined;
  if (req.rerunFailed) {
    const file = resolve(cwd, req.rerunFailed);
    const text = await readFile(file, 'utf8').catch(() => {
      throw new UsageError(`--rerun-failed: cannot read ${file}`);
    });
    rerunIds = idsToRerun(parseNdjson(text));
  }
  const selected = selectScenarios(
    all.filter((s) => inPaths.has(s.uri)),
    {
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(Object.keys(lines).length ? { lines } : {}),
      ...(rerunIds ? { ids: rerunIds } : {}),
    },
  );
  let plan = buildPlan(all, selected, {
    workers: opts.workers ?? 1,
    withDeps: req.withDeps ?? true,
    ...(opts.groups ? { groups: opts.groups } : {}),
    ...(opts.defaultMode ? { defaultMode: opts.defaultMode } : {}),
    ...(opts.featureMode ? { featureMode: opts.featureMode } : {}),
  });
  let shardNote: string[] = [];
  if (req.shard) {
    let spec;
    try {
      spec = parseShard(req.shard);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const h = historySettings(opts, rootDir);
    const runs = h ? loadHistory(h.dir, h.keep) : [];
    const durations = new Map<string, number>();
    for (const n of plan.nodes) {
      const ms = scenarioHistory(runs, n.id).avgMs;
      if (ms > 0) durations.set(n.id, ms);
    }
    const sh = shardPlan(plan, spec, durations);
    const total = plan.nodes.length;
    const keep = new Set(sh.ids);
    plan = buildPlan(all, all.filter((s) => keep.has(s.id)), {
      workers: opts.workers ?? 1,
      withDeps: false,
      ...(opts.groups ? { groups: opts.groups } : {}),
      ...(opts.defaultMode ? { defaultMode: opts.defaultMode } : {}),
    ...(opts.featureMode ? { featureMode: opts.featureMode } : {}),
    });
    shardNote = [
      `shard ${spec.index}/${spec.count}: ${sh.ids.length} of ${total} scenario(s); estimated load per shard: ${sh.loads.map((l) => `${Math.round(l)}ms`).join(', ')}`,
      ...(!runs.length ? ['shard: no run history, scenarios weighted equally (enable `history: true` and run once for duration-based balancing)'] : []),
      ...(sh.largestUnit.ids.length > total / spec.count && spec.count > 1
        ? [`shard: one dependency/group/lock cluster has ${sh.largestUnit.ids.length} scenarios and limits the speed-up`]
        : []),
    ];
  }
  if (!req.quiet) for (const line of shardNote) process.stderr.write(`bddr: ${line}\n`);
  cliDebug(req.quiet ? undefined : opts.logLevel, [
    `config: ${loaded.configFile ?? '(none, defaults)'}${req.profile ? `, profile ${req.profile}` : ''}`,
    ...(req.sets?.length ? [`--set: ${req.sets.join(' ')}`] : []),
    `specs: ${files.length} selected file(s), ${allFiles.length} parsed; scenarios: ${all.length} total, ${selected.length} selected`,
    `plan: ${plan.nodes.length} node(s), workers=${plan.workers}${opts.defaultMode ? `, defaultMode=${opts.defaultMode}` : ''}`,
    ...(rerunIds ? [`rerun: ${rerunIds.length} scenario(s) did not pass in ${req.rerunFailed}`] : []),
  ]);
  return { rootDir, opts, rerunIds, specs: specs.filter((s) => inPaths.has(s.uri) || plan.nodes.some((n) => n.scenario.uri === s.uri)), all, selected, plan };
}

const loadedPlugins = new Set<string>();

/** Import and set up plugins (once per process). Module specs resolve from the project folder. */
async function loadPlugins(rootDir: string, specs: PluginSpec[]): Promise<string[]> {
  const names: string[] = [];
  const req = createRequire(resolve(rootDir, 'package.json'));
  for (const spec of specs) {
    const [ref, options] = Array.isArray(spec) ? spec : [spec, {}];
    let plugin: { name: string; setup(o: Record<string, unknown>): unknown };
    let key: string;
    if (typeof ref === 'string') {
      let file: string;
      try {
        file = ref.startsWith('.') || isAbsolute(ref) ? resolve(rootDir, ref) : req.resolve(ref);
      } catch {
        throw new UsageError(`plugin "${ref}" not found. Install it in your project (npm i -D ${ref}) or fix the path in "plugins".`);
      }
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; plugin?: unknown };
      const p = (mod.default ?? mod.plugin) as typeof plugin | undefined;
      if (!p || typeof p.setup !== 'function') throw new UsageError(`plugin "${ref}" has no default export created with definePlugin({ name, setup })`);
      plugin = p;
      key = file;
    } else {
      plugin = ref as typeof plugin;
      key = `object:${plugin.name}`;
    }
    names.push(plugin.name);
    if (loadedPlugins.has(key)) continue;
    loadedPlugins.add(key);
    try {
      await plugin.setup(options ?? {});
    } catch (e) {
      throw new UsageError(`plugin "${plugin.name}" failed to set up: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return names;
}

/** Debugging is one scenario at a time in this process, with nothing that fires while you think. */
export function forDebugging(opts: BddrOptions): BddrOptions {
  const { scenarioTimeout: _s, runTimeout: _r, retry: _re, ...rest } = opts;
  const groups = opts.groups
    ? Object.fromEntries(Object.entries(opts.groups).map(([k, g]) => {
        const { timeout: _t, retry: _gr, scenarioRetry: _sr, ...g2 } = g;
        return [k, g2];
      }))
    : undefined;
  return { ...rest, workers: 1, pool: 'inline', ...(groups ? { groups } : {}) };
}

export interface DocsRequest extends Pick<RunRequest, 'cwd' | 'config' | 'profile' | 'paths' | 'tags' | 'name' | 'sets'> {
  /** NDJSON event files whose results colour the scenarios (merged; later runs win). Default: the latest history run, if any. */
  results?: string[];
  output?: string;
  title?: string;
}

/** `bddr docs`: render the spec folder tree (with README.md per folder) as one offline HTML page. */
export async function buildLivingDocs(req: DocsRequest = {}): Promise<{ file: string; features: number; scenarios: number }> {
  const { rootDir, opts, specs, selected } = await prepareRun({ ...req, withDeps: false });
  const cwd = req.cwd ?? process.cwd();
  const status = new Map<string, { status: Status | 'flaky'; ms: number }>();
  let source: string | undefined;
  if (req.results?.length) {
    const streams = [];
    for (const f of req.results) {
      const text = await readFile(resolve(cwd, f), 'utf8').catch(() => {
        throw new UsageError(`--results: cannot read ${f}`);
      });
      streams.push(parseNdjson(text));
    }
    for (const e of mergeEventStreams(streams)) {
      if (e.type === 'scenarioFinished' && !e.willRetry) status.set(e.scenarioId, { status: e.flaky ? 'flaky' : e.status, ms: e.durationMs });
    }
    source = req.results.join(', ');
  } else {
    const h = historySettings(opts, rootDir);
    const last = h ? loadHistory(h.dir, h.keep).at(-1) : undefined;
    if (last) {
      for (const [id, en] of Object.entries(last.scenarios)) status.set(id, { status: en.f ? 'flaky' : en.s, ms: en.d });
      source = `last recorded run (${new Date(last.startedAt).toISOString().slice(0, 16).replace('T', ' ')})`;
    }
  }
  const ids = new Set(selected.map((s) => s.id));
  const features = specs
    .filter((s) => s.feature)
    .map((s) => ({
      uri: s.uri,
      name: s.feature!.name,
      description: s.feature!.description,
      tags: s.feature!.tags.map((t) => t.name),
      scenarios: s.scenarios
        .filter((sc) => ids.has(sc.id))
        .map((sc) => {
          const featureTags = new Set(s.feature!.tags.map((t) => t.name));
          const r = status.get(sc.id);
          return {
            id: sc.id,
            name: sc.name,
            keyword: sc.keyword,
            line: sc.line,
            ...(sc.rule ? { rule: sc.rule.name } : {}),
            tags: sc.tags.map((t) => t.name).filter((t) => !featureTags.has(t)),
            steps: sc.steps.map((st) => ({ keyword: st.keyword, text: st.text, ...(st.argument ? { arg: st.argument } : {}) })),
            ...(sc.example ? { example: sc.example.values } : {}),
            ...(r ? { status: r.status, durationMs: r.ms } : {}),
          };
        }),
    }))
    .filter((f) => f.scenarios.length);
  const readmes: Record<string, string> = {};
  const dirs = new Set<string>();
  for (const f of features) {
    const parts = f.uri.split('/').slice(0, -1);
    for (let i = 0; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of dirs) {
    for (const name of ['README.md', 'readme.md', 'Readme.md']) {
      const file = resolve(rootDir, d, name);
      if (existsSync(file)) {
        readmes[d] = await readFile(file, 'utf8');
        break;
      }
    }
  }
  const html = renderLivingDocs({
    title: req.title ?? (await readProjectName(rootDir)) ?? 'Living documentation',
    generatedAt: Date.now(),
    features,
    readmes,
    ...(source ? { resultsSource: source } : {}),
  });
  const file = resolve(cwd, req.output ?? 'reports/living-docs.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html, 'utf8');
  return { file, features: features.length, scenarios: features.reduce((n, f) => n + f.scenarios.length, 0) };
}

async function readProjectName(rootDir: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(resolve(rootDir, 'package.json'), 'utf8')) as { name?: string };
    return pkg.name;
  } catch {
    return undefined;
  }
}

/** The whole `bddr run` pipeline, usable programmatically. */
export async function runBddr(req: RunRequest = {}): Promise<RunOutcome> {
  const { rootDir, opts, specs, plan, rerunIds } = await prepareRun(req);
  if (req.shard && !plan.nodes.length) {
    process.stdout.write(`Nothing to run in shard ${req.shard}.\n`);
    return { success: true, exitCode: 0, scenarios: [] };
  }
  if (rerunIds && !plan.nodes.length) {
    process.stdout.write(`Nothing to rerun: every scenario passed in ${req.rerunFailed}.\n`);
    return { success: true, exitCode: 0, scenarios: [] };
  }
  if (plan.errors.length) {
    process.stderr.write(`bddr: invalid execution plan:\n${plan.errors.map((e) => `  ${e.uri ? `${e.uri}:${e.line} ` : ''}${e.message}`).join('\n')}\n`);
    return { success: false, exitCode: 2, scenarios: plan.nodes.map((n) => n.scenario) };
  }

  let debugIO: (DebugIO & { close?(): void }) | undefined;
  if (req.debug) {
    if (req.dryRun) throw new UsageError('--debug cannot be combined with --dry-run');
    if (!req.debugIO && !(process.stdin.isTTY && process.stdout.isTTY)) {
      throw new UsageError('--debug needs an interactive terminal (stdin and stdout must be a TTY)');
    }
    debugIO = req.debugIO ?? terminalIO();
  }
  if (req.inspect !== undefined) await openInspector(req.inspect);
  const registry = await loadSupportCode(rootDir, opts, req.quiet);

  const history = req.dryRun ? undefined : historySettings(opts, rootDir);
  const previousRuns = history ? loadHistory(history.dir, history.keep) : [];
  const reporters =
    req.reporters ??
    [...(opts.reporters ?? ['console']), ...(req.formats ?? [])].map((spec) =>
      createReporter(withHistory(withLogLevel(resolveOutputFile(spec, rootDir), opts.logLevel), history ? previousRuns : undefined)),
    );
  const bus = new EventBus();
  for (const r of reporters) bus.on((e) => r.onEvent(e));
  const recorder = history ? new HistoryRecorder() : undefined;
  if (recorder) bus.on((e) => recorder.onEvent(e));

  const hasParseErrors = specs.some((s) => s.errors.length > 0);
  const useProcesses = opts.pool === 'process' && !req.dryRun && plan.nodes.length > 0;
  const pool = useProcesses
    ? new ProcessPool({
        ...workerEntry(),
        init: workerInit(req),
        planFingerprint: planFingerprint(plan),
        onEvent: (e) => bus.emit(e),
      })
    : undefined;
  const controller = new AbortController();
  let interrupted = false;
  const forwardAbort = () => controller.abort(req.signal?.reason ?? new CancellationError());
  if (req.signal?.aborted) forwardAbort();
  else req.signal?.addEventListener('abort', forwardAbort, { once: true });
  const runTimeoutMs = opts.runTimeout !== undefined ? toMs(opts.runTimeout, 'runTimeout') : 0;
  const runTimer = runTimeoutMs > 0 ? setTimeout(() => controller.abort(new TimeoutError('Run', runTimeoutMs)), runTimeoutMs) : undefined;
  const onSignal = () => {
    interrupted = true;
    controller.abort(new CancellationError('Interrupted by SIGINT'));
    pool?.kill();
  };
  process.once('SIGINT', onSignal);
  let result;
  try {
    result = await new Executor({
      ...executorOptions(opts, req),
      registry,
      bus,
      specs,
      plan,
      signal: controller.signal,
      ...(debugIO ? { debug: createDebugController({ stepMode: req.debug === 'step', io: debugIO, quit: () => controller.abort(new CancellationError('Debug session ended')) }) } : {}),
      ...(pool ? { pool } : {}),
    }).execute(plan.nodes.map((n) => n.scenario));
  } finally {
    process.off('SIGINT', onSignal);
    req.signal?.removeEventListener('abort', forwardAbort);
    if (runTimer) clearTimeout(runTimer);
    pool?.kill();
    debugIO?.close?.();
  }

  const listenerErrors = await bus.flush();
  for (const r of reporters) await r.close?.();
  const record = recorder?.record();
  if (history && record && !interrupted) {
    try {
      saveHistory(history.dir, record, history.keep);
    } catch (e) {
      process.stderr.write(`bddr: could not write run history to ${history.dir}: ${(e as Error).message}\n`);
    }
  }
  for (const e of listenerErrors) process.stderr.write(`Reporter error: ${e instanceof Error ? e.stack : String(e)}\n`);

  const exitCode: 0 | 1 | 2 | 130 = interrupted ? 130 : hasParseErrors ? 2 : result.success ? 0 : 1;
  return {
    success: result.success && !hasParseErrors && !interrupted,
    summary: result.summary,
    exitCode,
    scenarios: plan.nodes.map((n) => n.scenario),
    ...(interrupted ? { interrupted: true } : {}),
  };
}

/** Support code: steps, hooks, parameter types. They register on the global registry. */
export async function loadSupportCode(rootDir: string, opts: BddrOptions, quiet = false) {
  const registry = getGlobalRegistry();
  const plugins = await loadPlugins(rootDir, opts.plugins ?? []);
  const supportFiles = await discoverSupportFiles(rootDir, asArray(opts.steps ?? DEFAULTS.steps));
  for (const f of supportFiles) await import(pathToFileURL(f).href);
  if (!quiet) {
    cliDebug(opts.logLevel, [
      ...(plugins.length ? [`plugins: ${plugins.join(', ')}`] : []),
      `support code: ${supportFiles.length} file(s), ${registry.stepDefinitions.length} step(s), ${registry.hookDefinitions.length} hook(s), ${registry.fixtureDefinitions.size} fixture(s)`,
    ]);
  }
  if (opts.stepTimeoutMs !== undefined) registry.defaultTimeoutMs = opts.stepTimeoutMs;
  return registry;
}

function executorOptions(opts: BddrOptions, req: RunRequest): Omit<ExecuteOptions, 'registry' | 'bus'> {
  return {
    dryRun: !!req.dryRun,
    failFast: !!opts.failFast,
    strict: opts.strict ?? true,
    params: opts.params ?? {},
    ...(opts.retry ? { retry: toRetryOptions(opts.retry) } : {}),
    ...(opts.scenarioTimeout !== undefined ? { scenarioTimeoutMs: toMs(opts.scenarioTimeout, 'scenarioTimeout') } : {}),
  };
}

/** What a worker process needs to rebuild the same run (structured-cloneable; no reporters). */
function workerInit(req: RunRequest): RunRequest {
  const { reporters: _r, formats: _f, dryRun: _d, signal: _s, ...rest } = req;
  return { ...rest, cwd: resolve(req.cwd ?? process.cwd()), quiet: true };
}

/** dist/worker.js when built; src/worker.ts (through tsx) when running from source (tests). */
function workerEntry(): { entry: string; execArgv: string[] } {
  const js = fileURLToPath(new URL('./worker.js', import.meta.url));
  if (existsSync(js)) return { entry: js, execArgv: [] };
  return { entry: fileURLToPath(new URL('./worker.ts', import.meta.url)), execArgv: ['--import', 'tsx'] };
}

/** Worker process side: prepare the same run, load support code, build an Executor in worker mode. */
export async function prepareWorker(init: unknown, bus: EventBus): Promise<WorkerSetup> {
  const req = init as RunRequest;
  const prepared = await prepareRun(req);
  const registry = await loadSupportCode(prepared.rootDir, prepared.opts, true);
  const executor = new Executor({
    ...executorOptions(prepared.opts, req),
    failFast: false, // the coordinator stops scheduling
    registry,
    bus,
    plan: prepared.plan,
    remoteWorker: true,
  });
  return { executor, plan: prepared.plan };
}

/** Resolved `history` option, or undefined when off. */
export function historySettings(opts: BddrOptions, rootDir: string): { dir: string; keep: number } | undefined {
  const h = opts.history;
  if (!h) return undefined;
  const o = h === true ? {} : h;
  const keep = o.keep ?? 50;
  if (!Number.isInteger(keep) || keep < 1) throw new UsageError('history.keep must be a whole number >= 1');
  return { dir: resolve(rootDir, o.dir ?? '.bddr/history'), keep };
}

/** The HTML reporter gets previous runs for trends and flakiness scores (unless its options already say otherwise). */
function withHistory(spec: ReporterSpec, runs: HistoryRun[] | undefined): ReporterSpec {
  if (!runs) return spec;
  if (spec === 'html') return ['html', { history: runs }];
  if (Array.isArray(spec) && spec[0] === 'html' && spec[1]['history'] === undefined) return ['html', { ...spec[1], history: runs }];
  return spec;
}

/** `bddr history`: flakiest and slowest scenarios from the recorded runs. */
export async function historyReport(req: RunRequest & { top?: number } = {}): Promise<string> {
  const cwd = req.cwd ?? process.cwd();
  await registerTypeScriptLoader();
  const loaded = await loadConfig(req.config, cwd, req.profile);
  const opts = req.sets?.length ? applySetOverrides(loaded.options, req.sets) : loaded.options;
  const h = historySettings({ ...opts, history: opts.history || true }, loaded.rootDir)!;
  const runs = loadHistory(h.dir, h.keep);
  if (!runs.length) {
    return `No run history in ${relative(cwd, h.dir) || h.dir}. Enable it with \`history: true\` in the config (or --set history=true).\n`;
  }
  const top = req.top ?? 10;
  const ranked = rankScenarios(runs);
  const unstable = ranked.filter((r) => r.score > 0 || r.failed > 0).slice(0, top);
  const slow = [...ranked].sort((a, b) => b.avgMs - a.avgMs).slice(0, top);
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  const dots = (t: ReadonlyArray<string>) => t.slice(-12).map((x) => (x === 'passed' ? '●' : x === 'failed' ? '✘' : x === 'flaky' ? '◐' : '·')).join('');
  const fmt = (n: number) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
  const passRuns = runs.filter((r) => r.success).length;
  const out = [
    `Run history: ${runs.length} run(s) in ${relative(cwd, h.dir) || h.dir}, ${passRuns} passed, ${runs.length - passRuns} failed`,
    '',
    'Flakiest / failing (score = share of runs whose outcome flipped or passed only after a retry):',
    ...(unstable.length
      ? unstable.map((r) => `  ${r.score.toFixed(2)}  ${pad(dots(r.trend), 12)}  ${pad(`${r.passed}/${r.runs} passed`, 14)} ${r.name}  (${r.id})`)
      : ['  none: every scenario had the same outcome in every run']),
    '',
    'Slowest (average of passed/failed runs):',
    ...slow.map((r) => `  ${pad(fmt(r.avgMs), 9)} ${r.name}  (${r.id})`),
    '',
    'Legend: ● passed  ✘ failed  ◐ flaky  · other',
    '',
  ];
  return out.join('\n');
}

export function makeDataLoader(rootDir: string, opts: BddrOptions, profile?: string): DataLoader {
  return createFileDataLoader({
    rootDir,
    dataDir: resolve(rootDir, opts.dataDir ?? '.'),
    ...(profile ? { profile } : {}),
  });
}

/** Console reporters get the effective log level unless their own options set one. */
function withLogLevel(spec: ReporterSpec, level: BddrOptions['logLevel']): ReporterSpec {
  if (!level) return spec;
  if (typeof spec === 'string' && CONSOLE_REPORTERS.includes(spec)) return [spec, { logLevel: level }];
  if (Array.isArray(spec) && CONSOLE_REPORTERS.includes(spec[0]) && spec[1]['logLevel'] === undefined) {
    return [spec[0], { ...spec[1], logLevel: level }];
  }
  return spec;
}

/** Report paths in the config are relative to the config folder, not to the shell's cwd. */
/** The messages reporter re-reads the feature files; they live under the project root. */
function sourceRootFor(name: string, rootDir: string): { sourceRoot?: string } {
  return name === 'messages' || name === 'cucumber-messages' ? { sourceRoot: rootDir } : {};
}

function resolveOutputFile(spec: ReporterSpec, rootDir: string): ReporterSpec {
  if (typeof spec === 'string') {
    const i = spec.indexOf(':');
    return i > 0 ? [spec.slice(0, i), { outputFile: resolve(rootDir, spec.slice(i + 1)), ...sourceRootFor(spec.slice(0, i), rootDir) }] : sourceRootFor(spec, rootDir).sourceRoot ? [spec, sourceRootFor(spec, rootDir)] : spec;
  }
  if (Array.isArray(spec) && typeof spec[1]['outputFile'] === 'string') {
    return [spec[0], { ...sourceRootFor(spec[0], rootDir), ...spec[1], outputFile: resolve(rootDir, spec[1]['outputFile']) }];
  }
  return spec;
}

function toMs(v: string | number, name: string): number {
  if (typeof v === 'number') return v;
  try {
    return parseDuration(v);
  } catch (e) {
    throw new UsageError(`${name}: ${(e as Error).message}`);
  }
}

function toRetryOptions(r: NonNullable<BddrOptions['retry']>): RetryOptions {
  const out: RetryOptions = {};
  if (r.scenario !== undefined) {
    if (!Number.isInteger(r.scenario) || r.scenario < 0) throw new UsageError(`retry.scenario must be a whole number >= 0`);
    out.scenario = r.scenario;
  }
  if (r.delay !== undefined) out.delayMs = toMs(r.delay, 'retry.delay');
  if (r.backoff !== undefined) {
    if (!Number.isFinite(r.backoff) || r.backoff < 1) throw new UsageError(`retry.backoff must be a number >= 1`);
    out.backoff = r.backoff;
  }
  if (r.workerCrash !== undefined) {
    if (!Number.isInteger(r.workerCrash) || r.workerCrash < 0) throw new UsageError(`retry.workerCrash must be a whole number >= 0`);
    out.workerCrash = r.workerCrash;
  }
  if (r.on) out.on = r.on.map((x) => (/^\/.+\/[a-z]*$/.test(x) ? new RegExp(x.slice(1, x.lastIndexOf('/')), x.slice(x.lastIndexOf('/') + 1)) : x));
  if (r.failOnFlaky !== undefined) out.failOnFlaky = r.failOnFlaky;
  return out;
}

/** Replay one or more NDJSON event files (merged: later runs win) into reporters. */
export async function reportFromEvents(files: string[], formats: ReporterSpec[], cwd = process.cwd()): Promise<0 | 1 | 2> {
  if (!files.length) throw new UsageError('bddr report: give at least one NDJSON events file');
  const streams = [];
  for (const f of files) {
    const text = await readFile(resolve(cwd, f), 'utf8').catch(() => {
      throw new UsageError(`bddr report: cannot read ${f}`);
    });
    streams.push(parseNdjson(text));
  }
  const merged = mergeEventStreams(streams);
  const reporters = (formats.length ? formats : ['console']).map((spec) => createReporter(resolveOutputFile(spec, cwd)));
  for (const e of merged) for (const r of reporters) await r.onEvent(e);
  for (const r of reporters) await r.close?.();
  const end = merged.at(-1);
  return end?.type === 'runFinished' && end.success ? 0 : 1;
}

/** CLI-side diagnostics (before the event bus exists) go to stderr at --log-level debug. */
function cliDebug(level: BddrOptions['logLevel'], lines: string[]): void {
  if (level !== 'debug') return;
  for (const l of lines) process.stderr.write(`[bddr:debug] ${l}\n`);
}

function asArray(x: string | string[]): string[] {
  return Array.isArray(x) ? x : [x];
}

/** Open the Node inspector and wait for a debugger (Chrome devtools, VS Code "attach") to connect. */
async function openInspector(port: number | true): Promise<void> {
  const inspector = await import('node:inspector');
  if (inspector.url()) return; // already started with --inspect
  inspector.open(port === true ? 9229 : port, '127.0.0.1', true);
  process.stderr.write(`bddr: inspector listening at ${inspector.url()}; waiting for a debugger to attach...\n`);
}
