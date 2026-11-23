import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BDDR_VERSION, explainNode, parseSpecFile, planToJSON, renderPlanMermaid, renderPlanText, selectScenarios } from '@bddr/core';
import { DEFAULTS, loadConfig, UsageError } from './config.js';
import { watchLoop } from './watch.js';
import { buildLivingDocs, discoverSpecs, historyReport, loadSupportCode, makeDataLoader, prepareRun, registerTypeScriptLoader, reportFromEvents, runBddr } from './run.js';
import { formatValidation, validateProject } from './validate.js';
import { formatMigration, migrateProject } from './migrate.js';
import { buildStepCatalogue, formatStepCatalogue } from './catalogue.js';
import type { Reporter } from '@bddr/reporters';

const HELP = `bddr ${BDDR_VERSION}

Usage:
  bddr [run] [paths...] [options]    Run scenarios (paths may be files, folders, globs, file:line)
  bddr list  [paths...] [options]    List selected scenarios with ids and tags, without running
  bddr snippets [paths...] [options] Print ready-to-paste code for every undefined step (runs nothing)
  bddr steps [--json] [options]      List every step, hook and fixture the support code registers, with file:line (for editors and tools)
  bddr validate [paths...] [options] Static checks: specs, plan, steps, hooks and unused definitions
  bddr history [--top <n>]           Flakiest and slowest scenarios from the recorded run history (config history: true)
  bddr docs [paths...] [options]     Living documentation: the spec folders as one HTML page (README.md per folder is the intro)
             -o reports/living-docs.html   --results <events.ndjson> (repeatable, colours scenarios)   --title <text>
  bddr report <events.ndjson...>     Build reports from event files; several files are merged (later runs win)
             -f html:reports/report.html -f junit:reports/junit.xml
  bddr migrate [dir] [--write]       Update a project from the old name bddx to bddr (previews unless --write)
  bddr plan  [paths...] [options]    Show the execution plan: groups, dependencies, locks (runs nothing)
             --plan-format text|json|mermaid    --explain <scenario id>

Options:
  -c, --config <file>     Config file (default: bddr.config.{ts,mts,js,mjs,json} in cwd)
  -p, --profile <name>    Use a profile from the config
  -t, --tags <expr>       Tag expression, e.g. "@smoke and not @wip"
      --name <regex>      Only scenarios whose name matches
  -f, --format <spec>     Add a reporter: console | progress | html[:file] | junit[:file] | ndjson[:file] | cucumber-json[:file] | messages[:file]  (repeatable)
  -D, --define k=v        Set ctx.params.k (repeatable)
      --dry-run           Match steps and report undefined ones, run nothing
      --fail-fast         Stop after the first failed scenario
      --no-strict         Pending/undefined steps do not fail the run
      --timeout <ms>      Default step/hook timeout
      --run-timeout <dur> Time budget for the complete run, e.g. 30m
  -w, --workers <n>       Max scenarios running at once (default 1)
      --pool <kind>       inline (default: one process) | process (one Node process per worker)
  -s, --set <path=value>  Override any config value (repeatable), e.g. --set groups.checkout.mode=serial
      --log-level <level> Console logs: debug | info (default) | warn | error | silent
      --no-deps           Do not pull in dependencies of selected scenarios
  -r, --retry <n>         Retry failed scenarios up to n times (config retry.scenario; @retry:N per scenario)
      --worker-crash-retry <n> Retry on a fresh process after a worker crash
      --fail-on-flaky     Fail the run when a scenario passed only after a retry
      --rerun-failed <f>  Run only scenarios that did not pass in events file <f> (+ their dependencies)
      --watch             Run, then re-run on file changes (each run in a fresh process). Keys: Enter all, f failed, q quit
      --debug             Interactive debugger: pause after a failing step (c/n/r/e/s/q at the prompt).
                          Runs one scenario at a time in this process, no retries or time budgets
      --debug-step        Like --debug, but pause before every step
      --inspect [port]    Open the Node inspector (default 9229) and wait for a debugger to attach
      --shard <i/n>       Run only shard i of n (CI matrix). Dependencies, group and lock members stay together; balanced
                          by recorded duration (config history: true). Also works with plan
      --fail-on-warnings   With validate, return exit 1 when warnings are found
  -h, --help              Show help
  -v, --version           Show version

Exit codes: 0 passed, 1 failed, 2 usage/config/parse error.
`;

export async function main(argv: string[]): Promise<number> {
  const noStrict = argv.includes('--no-strict');
  const noDeps = argv.includes('--no-deps');
  const args = argv.filter((a) => a !== '--no-strict' && a !== '--no-deps');
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        config: { type: 'string', short: 'c' },
        profile: { type: 'string', short: 'p' },
        tags: { type: 'string', short: 't' },
        name: { type: 'string' },
        format: { type: 'string', short: 'f', multiple: true },
        define: { type: 'string', short: 'D', multiple: true },
        'dry-run': { type: 'boolean' },
        debug: { type: 'boolean' },
        watch: { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        results: { type: 'string', multiple: true },
        title: { type: 'string' },
        shard: { type: 'string' },
        'debug-step': { type: 'boolean' },
        inspect: { type: 'string' },
        'fail-fast': { type: 'boolean' },
        timeout: { type: 'string' },
        'run-timeout': { type: 'string' },
        workers: { type: 'string', short: 'w' },
        pool: { type: 'string' },
        set: { type: 'string', short: 's', multiple: true },
        retry: { type: 'string', short: 'r' },
        'worker-crash-retry': { type: 'string' },
        'fail-on-flaky': { type: 'boolean' },
        'rerun-failed': { type: 'string' },
        'fail-on-warnings': { type: 'boolean' },
        write: { type: 'boolean' },
        json: { type: 'boolean' },
        top: { type: 'string' },
        'log-level': { type: 'string' },
        'plan-format': { type: 'string' },
        explain: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${BDDR_VERSION}\n`);
    return 0;
  }

  let command = 'run';
  let paths = positionals;
  if (['run', 'list', 'snippets', 'validate', 'plan', 'report', 'history', 'docs', 'migrate', 'steps'].includes(positionals[0] ?? '')) {
    command = positionals[0]!;
    paths = positionals.slice(1);
  }

  try {
    const params: Record<string, string> = {};
    for (const d of values.define ?? []) {
      const i = d.indexOf('=');
      if (i <= 0) throw new UsageError(`-D expects key=value, got "${d}"`);
      params[d.slice(0, i)] = d.slice(i + 1);
    }

    if (command === 'migrate') {
      const root = resolve(paths[0] ?? '.');
      if (!existsSync(root)) throw new UsageError(`migrate: folder not found: ${root}`);
      const result = await migrateProject(root, values.write === true);
      process.stdout.write(formatMigration(result));
      return 0;
    }
    if (command === 'steps') {
      await registerTypeScriptLoader();
      const loaded = await loadConfig(values.config, process.cwd(), values.profile);
      const registry = await loadSupportCode(loaded.rootDir, loaded.options, true);
      const catalogue = buildStepCatalogue(registry, loaded.rootDir);
      process.stdout.write(values.json ? `${JSON.stringify(catalogue, null, 2)}\n` : formatStepCatalogue(catalogue));
      return 0;
    }
    if (command === 'list') return await list(paths, values.config, values.profile, values.tags, values.name);
    if (command === 'snippets') return await snippets(paths, values.config, values.profile, values.tags, values.name);
    if (command === 'docs') {
      const r = await buildLivingDocs({
        ...(values.config ? { config: values.config } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(paths.length ? { paths } : {}),
        ...(values.tags ? { tags: values.tags } : {}),
        ...(values.name ? { name: values.name } : {}),
        ...(values.set ? { sets: values.set } : {}),
        ...(values.results ? { results: values.results } : {}),
        ...(values.output ? { output: values.output } : {}),
        ...(values.title ? { title: values.title } : {}),
      });
      process.stdout.write(`Living documentation: ${r.features} feature(s), ${r.scenarios} scenario(s) -> ${r.file}\n`);
      return 0;
    }
    if (command === 'report') return await reportFromEvents(paths, values.format ?? []);
    if (command === 'history') {
      const top = values.top !== undefined ? Number(values.top) : undefined;
      if (top !== undefined && (!Number.isInteger(top) || top < 1)) throw new UsageError(`--top expects a positive integer, got "${values.top}"`);
      process.stdout.write(
        await historyReport({
          ...(values.config ? { config: values.config } : {}),
          ...(values.profile ? { profile: values.profile } : {}),
          ...(values.set ? { sets: values.set } : {}),
          ...(top ? { top } : {}),
        }),
      );
      return 0;
    }
    const retry = values.retry !== undefined ? Number(values.retry) : undefined;
    if (retry !== undefined && (!Number.isInteger(retry) || retry < 0)) throw new UsageError(`--retry expects a whole number >= 0, got "${values.retry}"`);
    const workerCrashRetry = values['worker-crash-retry'] !== undefined ? Number(values['worker-crash-retry']) : undefined;
    if (workerCrashRetry !== undefined && (!Number.isInteger(workerCrashRetry) || workerCrashRetry < 0)) {
      throw new UsageError(`--worker-crash-retry expects a whole number >= 0, got "${values['worker-crash-retry']}"`);
    }
    const workers = values.workers !== undefined ? Number(values.workers) : undefined;
    const logLevel = values['log-level'];
    if (logLevel !== undefined && !['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) {
      throw new UsageError(`--log-level must be debug, info, warn, error or silent (got "${logLevel}")`);
    }
    const common = {
      ...(values.set ? { sets: values.set } : {}),
      ...(logLevel ? { logLevel: logLevel as 'debug' } : {}),
    };
    const pool = values.pool;
    if (pool !== undefined && pool !== 'inline' && pool !== 'process') throw new UsageError(`--pool must be inline or process (got "${pool}")`);
    if (workers !== undefined && (!Number.isInteger(workers) || workers < 1)) throw new UsageError(`--workers expects a positive integer, got "${values.workers}"`);
    if (command === 'validate') {
      const result = await validateProject({
        ...common,
        ...(values.config ? { config: values.config } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(paths.length ? { paths } : {}),
        ...(values.tags ? { tags: values.tags } : {}),
        ...(values.name ? { name: values.name } : {}),
        ...(workers ? { workers } : {}),
      });
      process.stdout.write(formatValidation(result));
      return result.errors || (values['fail-on-warnings'] && result.warnings) ? 1 : 0;
    }
    if (command === 'plan') {
      const { plan } = await prepareRun({
        ...common,
        ...(values.config ? { config: values.config } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(paths.length ? { paths } : {}),
        ...(values.tags ? { tags: values.tags } : {}),
        ...(values.name ? { name: values.name } : {}),
        ...(workers ? { workers } : {}),
        ...(values.shard ? { shard: values.shard } : {}),
        ...(noDeps ? { withDeps: false } : {}),
      });
      if (values.explain) process.stdout.write(`${explainNode(plan, values.explain)}\n`);
      else {
        const fmt = values['plan-format'] ?? 'text';
        if (fmt === 'json') process.stdout.write(`${JSON.stringify(planToJSON(plan), null, 2)}\n`);
        else if (fmt === 'mermaid') process.stdout.write(renderPlanMermaid(plan));
        else if (fmt === 'text') process.stdout.write(renderPlanText(plan));
        else throw new UsageError(`--plan-format must be text, json or mermaid (got "${fmt}")`);
      }
      return plan.errors.length ? 2 : 0;
    }

    if (values.watch) {
      if (command !== 'run') throw new UsageError('--watch works with the run command');
      if (values.debug || values['debug-step'] || values.inspect !== undefined) throw new UsageError('--watch cannot be combined with --debug');
      if (values['dry-run']) throw new UsageError('--watch cannot be combined with --dry-run');
      const { rootDir } = await loadConfig(values.config, process.cwd(), values.profile);
      const rest = [...argv].filter((a) => a !== '--watch');
      const idx = rest.indexOf('run');
      if (idx >= 0 && idx <= rest.length - 1 && positionals[0] === 'run') rest.splice(idx, 1);
      for (const p of paths) {
        const i = rest.indexOf(p);
        if (i >= 0) rest.splice(i, 1);
      }
      return await watchLoop({
        rootDir,
        baseArgs: rest,
        userPaths: paths,
        entry: fileURLToPath(new URL('./bin.js', import.meta.url)),
        cwd: process.cwd(),
      });
    }

    const outcome = await runBddr({
      ...common,
      ...(values.config ? { config: values.config } : {}),
      ...(values.profile ? { profile: values.profile } : {}),
      ...(paths.length ? { paths } : {}),
      ...(values.tags ? { tags: values.tags } : {}),
      ...(values.name ? { name: values.name } : {}),
      ...(values.format ? { formats: values.format } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      ...(values['dry-run'] ? { dryRun: true } : {}),
      ...(values.shard ? { shard: values.shard } : {}),
      ...(values['debug-step'] ? { debug: 'step' as const } : values.debug || values.inspect !== undefined ? { debug: 'fail' as const } : {}),
      ...(values.inspect !== undefined ? { inspect: inspectPort(values.inspect) } : {}),
      ...(values['fail-fast'] ? { failFast: true } : {}),
      ...(noStrict ? { strict: false } : {}),
      ...(values.timeout ? { stepTimeoutMs: Number(values.timeout) } : {}),
      ...(values['run-timeout'] ? { sets: [...(common.sets ?? []), `runTimeout=${values['run-timeout']}`] } : {}),
      ...(workers ? { workers } : {}),
      ...(pool ? { pool: pool as 'inline' | 'process' } : {}),
      ...(noDeps ? { withDeps: false } : {}),
      ...(retry !== undefined ? { retry } : {}),
      ...(workerCrashRetry !== undefined ? { workerCrashRetry } : {}),
      ...(values['fail-on-flaky'] ? { failOnFlaky: true } : {}),
      ...(values['rerun-failed'] ? { rerunFailed: values['rerun-failed'] } : {}),
    });
    return outcome.exitCode;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`bddr: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`bddr: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 2;
  }
}

async function list(paths: string[], config?: string, profile?: string, tags?: string, name?: string): Promise<number> {
  const cwd = process.cwd();
  await registerTypeScriptLoader();
  const loaded = await loadConfig(config, cwd, profile);
  const opts = loaded.options;
  const patterns = paths.length ? paths.map((p) => resolve(cwd, p)) : Array.isArray(opts.features) ? opts.features : [opts.features ?? DEFAULTS.features].flat();
  const { files, lines } = await discoverSpecs(loaded.rootDir, patterns);
  let errors = 0;
  const dataLoader = makeDataLoader(loaded.rootDir, opts, profile);
  for (const uri of files) {
    const spec = await parseSpecFile(await readFile(resolve(loaded.rootDir, uri), 'utf8'), uri, { dataLoader });
    for (const e of spec.errors) {
      errors++;
      process.stderr.write(`${e.uri}:${e.line ?? '?'} ${e.message}\n`);
    }
    const tagExpr = [opts.tags, tags].filter(Boolean).map((t) => `(${t})`).join(' and ');
    const selected = selectScenarios(spec.scenarios, {
      ...(tagExpr ? { tags: tagExpr } : {}),
      ...((name ?? opts.name) ? { name: (name ?? opts.name)! } : {}),
      ...(Object.keys(lines).length ? { lines } : {}),
    });
    for (const s of selected) {
      const tags = s.tags.map((t) => t.name).join(' ');
      process.stdout.write(`${s.id}\t${s.uri}:${s.line}${tags ? `\t${tags}` : ''}\n`);
    }
  }
  return errors ? 2 : 0;
}

async function snippets(paths: string[], config?: string, profile?: string, tags?: string, name?: string): Promise<number> {
  const found = new Map<string, string[]>();
  const collector: Reporter = {
    name: 'snippets',
    onEvent(e) {
      if (e.type === 'planReady') for (const sc of e.scenarios) for (const st of sc.steps) where.set(`${sc.id}|${st.id}`, `${sc.uri}:${st.line}`);
      if (e.type === 'stepFinished' && e.snippet) {
        const list = found.get(e.snippet) ?? [];
        list.push(where.get(`${e.scenarioId}|${e.stepId}`) ?? e.scenarioId);
        found.set(e.snippet, list);
      }
    },
  };
  const where = new Map<string, string>();
  const outcome = await runBddr({
    ...(config ? { config } : {}),
    ...(profile ? { profile } : {}),
    ...(paths.length ? { paths } : {}),
    ...(tags ? { tags } : {}),
    ...(name ? { name } : {}),
    dryRun: true,
    strict: false,
    reporters: [collector],
  });
  if (!found.size) {
    process.stdout.write('All steps are defined.\n');
    return outcome.exitCode;
  }
  process.stdout.write(`// ${found.size} undefined step pattern(s)\nimport { Given, When, Then, type DataTable } from '@bddr/runtime';\n\n`);
  for (const [snippet, locations] of found) {
    process.stdout.write(`// used at: ${[...new Set(locations)].join(', ')}\n${snippet}\n\n`);
  }
  return outcome.exitCode;
}

function inspectPort(v: string): number | true {
  if (v === '') return true;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`--inspect expects a port number, got "${v}"`);
  return n;
}
