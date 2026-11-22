import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Attachment,
  BddrEvent,
  ErrorInfo,
  GroupRetrying,
  HookFinished,
  Log,
  PlannedGroup,
  PlannedScenario,
  RunSummary,
  ScenarioFinished,
  ScenarioStarted,
  Status,
  StepAttemptFinished,
  StepFinished,
} from '@bddr/core';
import { HistoryRecorder, scenarioHistory, type HistoryRun } from '@bddr/core';
import { renderGraph, renderHistory, renderTimeline, trendDots, VIEW_CSS, type Interval, type Startup } from './html-views.js';
import { buildDatasets, DATA_CSS, renderArg, renderDatasetClose, renderDatasetOpen } from './html-data.js';
import { RESPONSIVE_CSS } from './html-responsive.js';
import { computeStats, dataJson, renderOverview, STATS_CSS, summaryText } from './html-stats.js';
import { attemptsNote, LogIndex, type ReportLogLevel } from './logs.js';
import type { Reporter, ReporterOptions } from './types.js';

/**
 * Self-contained HTML report (one file, no external assets).
 * Shows: run summary, groups, every scenario with steps, errors, logs (per step and per scenario), attachments
 * (images inline), skip reasons, hook failures and run-level logs. Filters: status, log level, framework logs, search.
 *
 * v3 layout: tabs (Overview with test statistics, Results, Execution, History), share actions (copy summary, copy
 * link to the current view/filters, download JSON, print/PDF, theme), per-scenario permalinks, keyboard shortcuts.
 * Statistics live in html-stats.ts.
 *
 * v2 views: execution timeline per worker lane (+ group spans), dependency graph, run history (pass-rate per run,
 * flakiest scenarios, per-scenario trend dots and flaky score).
 *
 * Options: outputFile (default reports/report.html), title, logLevel (lowest level embedded; default 'debug' so the
 * viewer can switch levels in the page), history (HistoryRun[] of PREVIOUS runs; the CLI passes it when
 * `history` is enabled in the config).
 */
export function htmlReporter(raw: ReporterOptions = {}): Reporter {
  const outputFile = String(raw['outputFile'] ?? 'reports/report.html');
  const title = String(raw['title'] ?? 'bddr report');
  const logs = new LogIndex((raw['logLevel'] as ReportLogLevel | undefined) ?? 'debug', true);
  const recorder = new HistoryRecorder();
  const opened = new Map<string, { ts: number; worker: string }>();
  const data: ReportData = {
    title,
    plan: [],
    groups: [],
    workers: 1,
    started: new Map(),
    results: new Map(),
    steps: new Map(),
    attempts: new Map(),
    retries: new Map(),
    groupRetries: [],
    attachments: [],
    hookFailures: [],
    logs,
    intervals: [],
    startups: [],
    history: Array.isArray(raw['history']) ? (raw['history'] as HistoryRun[]) : [],
  };
  let html = '';
  return {
    name: 'html',
    onEvent(e: BddrEvent) {
      recorder.onEvent(e);
      switch (e.type) {
        case 'runStarted':
          data.startedAt = e.ts;
          data.runId = e.runId;
          data.dryRun = e.dryRun;
          break;
        case 'planReady':
          data.plan.push(...e.scenarios);
          data.groups = e.groups ?? [];
          data.workers = e.workers ?? 1;
          break;
        case 'scenarioStarted':
          data.started.set(e.scenarioId, e);
          opened.set(`${e.scenarioId}#${e.attempt}`, { ts: e.ts, worker: e.workerId });
          break;
        case 'stepFinished':
          data.steps.set(`${e.scenarioId}|${e.stepId}`, e);
          break;
        case 'stepAttemptFinished': {
          const k = `${e.scenarioId}|${e.stepId}`;
          data.attempts.set(k, [...(data.attempts.get(k) ?? []), e]);
          break;
        }
        case 'scenarioFinished':
          {
            const k = `${e.scenarioId}#${e.attempt}`;
            const o = opened.get(k);
            if (o) {
              opened.delete(k);
              data.intervals.push({ id: e.scenarioId, attempt: e.attempt, worker: o.worker, start: o.ts, end: e.ts, status: e.status, ...(e.willRetry ? { retried: true } : {}) });
            }
          }
          {
            const previous = data.results.get(e.scenarioId); // group retry re-ran it
            if (previous && previous.status !== 'passed') data.retries.set(e.scenarioId, [...(data.retries.get(e.scenarioId) ?? []), previous]);
          }
          if (e.willRetry) data.retries.set(e.scenarioId, [...(data.retries.get(e.scenarioId) ?? []), e]);
          else data.results.set(e.scenarioId, e);
          break;
        case 'workerStarted':
          data.startups.push({ worker: e.workerId, start: e.ts - e.startupMs, end: e.ts });
          break;
        case 'groupRetrying':
          data.groupRetries.push(e);
          break;
        case 'attachment':
          data.attachments.push(e);
          break;
        case 'log':
          logs.add(e);
          break;
        case 'hookFinished':
          if (e.status === 'failed') data.hookFailures.push(e);
          break;
        case 'runFinished':
          data.summary = e.summary;
          data.success = e.success;
          if (e.error) data.runError = e.error;
          {
            const current = recorder.record();
            if (current && data.history.length) data.history = [...data.history.filter((h) => h.runId !== current.runId), current];
          }
          html = renderHtml(data);
          break;
        default:
          break;
      }
    },
    async close() {
      if (!html) return;
      mkdirSync(dirname(outputFile), { recursive: true });
      writeFileSync(outputFile, html, 'utf8');
    },
  };
}

interface ReportData {
  title: string;
  runId?: string;
  startedAt?: number;
  dryRun?: boolean;
  plan: PlannedScenario[];
  groups: PlannedGroup[];
  workers: number;
  started: Map<string, ScenarioStarted>;
  results: Map<string, ScenarioFinished>;
  steps: Map<string, StepFinished>;
  attempts: Map<string, StepAttemptFinished[]>;
  retries: Map<string, ScenarioFinished[]>;
  groupRetries: GroupRetrying[];
  attachments: Attachment[];
  hookFailures: HookFinished[];
  logs: LogIndex;
  summary?: RunSummary;
  success?: boolean;
  runError?: ErrorInfo;
  intervals: Interval[];
  startups: Startup[];
  /** Previous runs + this one (last); empty without history. */
  history: HistoryRun[];
}

const LIGHT = '--bg:#f4f5f7;--fg:#1b1f24;--muted:#667085;--line:#e4e7ec;--card:#fff;--accent:#2563eb;--shadow:0 1px 2px rgba(16,24,40,.06);--passed:#15803d;--failed:#b91c1c;--skipped:#0e7490;--pending:#a16207;--undefined:#a16207;--ambiguous:#7e22ce;--debug:#6b7280;--info:#0369a1;--warn:#a16207;--error:#b91c1c';
const DARK = '--bg:#0d1117;--fg:#e6e8eb;--muted:#9aa3b2;--line:#262c36;--card:#151a22;--accent:#60a5fa;--shadow:none;--passed:#4ade80;--failed:#f87171;--skipped:#22d3ee;--pending:#facc15;--undefined:#facc15;--ambiguous:#c084fc;--debug:#9ca3af;--info:#38bdf8;--warn:#facc15;--error:#f87171';

const ICON: Record<Status, string> = { passed: '✔', failed: '✘', skipped: '↷', pending: '…', undefined: '?', ambiguous: '‼' };
const ORDER: Status[] = ['passed', 'failed', 'pending', 'undefined', 'ambiguous', 'skipped'];

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ms(n: number | undefined): string {
  if (n === undefined) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}

function renderLogs(list: Log[]): string {
  if (!list.length) return '';
  return `<div class="logs">${list
    .map((l) => {
      const level = l.level ?? 'info';
      const d =
        l.data === undefined ? '' : `<code class="data">${esc(JSON.stringify(l.data, null, 1)?.slice(0, 5000) ?? String(l.data))}</code>`;
      const a = l.attachment;
      const att = !a
        ? ''
        : a.mediaType.startsWith('image/')
          ? `<a class="logimg" href="data:${esc(a.mediaType)};base64,${a.body}" target="_blank" rel="noopener"><img loading="lazy" alt="${esc(a.name ?? l.message)}" src="data:${esc(a.mediaType)};base64,${a.body}"></a>`
          : `<a class="logfile" download="${esc(a.name ?? 'attachment')}" href="data:${esc(a.mediaType)};base64,${a.body}">📎 ${esc(a.name ?? a.mediaType)}</a>`;
      return `<div class="log lv-${level}${l.source === 'bddr' ? ' src-bddr' : ''}"><span class="lvl">${l.source === 'bddr' ? 'bddr:' : ''}${level}</span>${
        l.attempt ? `<span class="nth">#${l.attempt}</span>` : ''
      }<span class="msg">${esc(l.message)}</span>${d}${att}</div>`;
    })
    .join('')}</div>`;
}

function renderAttachments(list: Attachment[]): string {
  if (!list.length) return '';
  return `<div class="atts">${list
    .map((a) => {
      const name = esc(a.name ?? a.mediaType);
      if (a.encoding === 'base64' && a.mediaType.startsWith('image/')) {
        return `<figure><figcaption>${name}</figcaption><img loading="lazy" src="data:${esc(a.mediaType)};base64,${a.body}" alt="${name}"></figure>`;
      }
      if (a.encoding === 'identity') {
        let body = a.body;
        if (a.mediaType.includes('json')) {
          try {
            body = JSON.stringify(JSON.parse(a.body), null, 2);
          } catch {
            /* keep raw */
          }
        }
        return `<details class="att"><summary>📎 ${name}</summary><pre>${esc(body.slice(0, 100_000))}</pre></details>`;
      }
      return `<div class="att">📎 <a download="${name}" href="data:${esc(a.mediaType)};base64,${a.body}">${name}</a></div>`;
    })
    .join('')}</div>`;
}

/** Stack lines inside bddr itself or Node internals are noise for test authors. */
const INTERNAL_FRAME = /[\\/](node_modules[\\/]@bddr|packages[\\/](runtime|core|cli|reporters)[\\/](dist|src))[\\/]|node:internal|node:async_hooks/;

export function trimStack(stack: string): string {
  const lines = stack.split('\n');
  const kept = lines.filter((l) => !/^\s+at /.test(l) || !INTERNAL_FRAME.test(l));
  return kept.join('\n');
}

function renderError(e: ErrorInfo | undefined): string {
  return e ? `<pre class="err">${esc(e.stack ? trimStack(e.stack) : e.message)}</pre>` : '';
}

export function renderHtml(d: ReportData): string {
  const s = d.summary;
  const attBy = new Map<string, Attachment[]>();
  for (const a of d.attachments) {
    const k = `${a.scenarioId ?? ''}|${a.stepId ?? ''}`;
    attBy.set(k, [...(attBy.get(k) ?? []), a]);
  }
  const anchorIds = new Map(d.plan.map((p, i) => [p.id, `sc-${i}`]));
  const anchor = (id: string) => anchorIds.get(id) ?? 'top';
  const hasHistory = d.history.length >= 2;
  const datasetOf = buildDatasets(d.plan);
  const byFeature = new Map<string, PlannedScenario[]>();
  for (const sc of d.plan) byFeature.set(sc.uri, [...(byFeature.get(sc.uri) ?? []), sc]);

  const features = [...byFeature.entries()]
    .map(([uri, scenarios]) => {
      const statuses = scenarios.map((x) => d.results.get(x.id)?.status ?? 'skipped');
      const counts = ORDER.filter((st) => statuses.includes(st))
        .map((st) => `<span class="pill st-${st}">${statuses.filter((x) => x === st).length} ${st}</span>`)
        .join('');
      const itemHtml = scenarios
        .map((sc) => {
          const r = d.results.get(sc.id);
          const status: Status = r?.status ?? 'skipped';
          const started = d.started.get(sc.id);
          const row = sc.example
            ? sc.example.source
              ? `${sc.example.source} row ${sc.example.sourceRow}`
              : `${sc.example.name ? `${sc.example.name} ` : ''}#${sc.example.index}`
            : '';
          const chips = [
            ...(sc.groups ?? []).map((g) => `<span class="chip grp">group:${esc(g)}</span>`),
            ...sc.tags.map((t) => `<a class="chip" href="#results?q=${encodeURIComponent(t)}" title="show scenarios with this tag">${esc(t)}</a>`),
          ].join('');
          const prior = d.retries.get(sc.id) ?? [];
          const flags = [
            r?.flaky ? '<span class="pill flaky">flaky</span>' : '',
            r?.quarantined ? '<span class="pill quarantined">quarantined</span>' : '',
            prior.length ? `<span class="pill retried">${prior.length + 1} attempts</span>` : '',
          ].join('');
          const hist = hasHistory ? scenarioHistory(d.history, sc.id) : undefined;
          const histHtml = hist && hist.runs > 1 ? `${hist.score > 0 ? `<span class="pill fscore" title="flakiness score over ${hist.runs} runs">flaky score ${hist.score.toFixed(2)}</span>` : ''}${trendDots(hist.trend)}` : '';
          const priorHtml = prior.length
            ? `<details class="tries"><summary>earlier attempts (${prior.length})</summary><ol>${prior
                .map((a) => `<li class="st-failed"><span class="ico">✘</span> attempt ${a.attempt} <span class="dur">${ms(a.durationMs)}</span>${a.error ? `<div class="terr">${esc(a.error.message)}</div>` : ''}</li>`)
                .join('')}</ol></details>`
            : '';
          const deps = sc.dependsOn?.length
            ? `<div class="deps">waits for ${sc.dependsOn.map((x) => `<code>${esc(x.id)}</code>${x.soft ? ' (soft)' : ''}`).join(', ')}</div>`
            : '';
          const steps = sc.steps
            .map((st) => {
              const sf = d.steps.get(`${sc.id}|${st.id}`);
              const sst: Status = sf?.status ?? 'skipped';
              const snippet = sf?.snippet ? `<pre class="snippet">${esc(sf.snippet)}</pre>` : '';
              const tries = d.attempts.get(`${sc.id}|${st.id}`) ?? [];
              const note = sf ? attemptsNote(sf, tries[0]?.of) : '';
              const triesHtml = tries.length
                ? `<details class="tries"><summary>${esc(note || `${tries.length} attempt(s)`)}</summary><ol>${tries
                    .map(
                      (t) =>
                        `<li class="st-${t.status}"><span class="ico">${ICON[t.status]}</span> #${t.attempt} <span class="txt">${esc(t.text)}</span> <span class="dur">${ms(
                          t.durationMs,
                        )}</span>${t.error ? `<div class="terr">${esc(t.error.message)}</div>` : ''}</li>`,
                    )
                    .join('')}</ol></details>`
                : '';
              return `<li class="step st-${sst}"><div class="line"><span class="ico">${ICON[sst]}</span><span class="kw">${esc(
                st.keyword.trim(),
              )}</span> <span class="txt">${esc(st.text)}</span><span class="dur">${ms(sf?.durationMs)}</span></div>${renderError(
                sst === 'failed' || sst === 'ambiguous' ? sf?.error : undefined,
              )}${snippet}${renderArg(st.arg, sst)}${triesHtml}${renderLogs(d.logs.forStep(sc.id, st.id))}${renderAttachments(attBy.get(`${sc.id}|${st.id}`) ?? [])}</li>`;
            })
            .join('');
          const ds = datasetOf.get(sc.id);
          const firstErr = r?.error ?? sc.steps.map((st) => d.steps.get(`${sc.id}|${st.id}`)?.error).find((e) => !!e);
          const rowNote =
            status === 'skipped' && r?.reason
              ? `<span class="dc-err" style="color:var(--skipped)">${esc(r.reason)}</span>`
              : firstErr && status !== 'passed' && status !== 'skipped'
                ? `<span class="dc-err">${esc(firstErr.message.split('\n')[0] ?? '')}</span>`
                : '';
          const dataSummary = ds
            ? `<summary><span class="pin"><span class="ico">${ICON[status]}</span><span class="dc dc-row">${esc(String(sc.example!.sourceRow ?? sc.example!.index))}</span></span>${ds.columns
                .map((c) => `<span class="dc" data-label="${esc(c)}" title="${esc(`${c}: ${sc.example!.values[c] ?? ''}`)}">${esc(sc.example!.values[c] ?? '')}</span>`)
                .join('')}<span class="dc dc-flags">${flags}${histHtml}</span><span class="meta">${ms(r?.durationMs)}${started ? ` · ${esc(started.workerId)}` : ''}</span><button class="perma" type="button" data-link="${anchor(sc.id)}" title="Copy link to this scenario" aria-label="Copy link to this scenario">🔗</button>${rowNote}</summary>`
            : '';
          const text = esc(`${sc.name} ${sc.id} ${sc.uri} ${sc.tags.join(' ')} ${(sc.groups ?? []).join(' ')} ${Object.values(sc.example?.values ?? {}).join(' ')} ${sc.example?.source ?? ''}`.toLowerCase());
          const open = status === 'failed' || status === 'ambiguous' || status === 'undefined' ? ' open' : '';
          return `<details class="scenario st-${status}" id="${anchor(sc.id)}" data-status="${status}" data-text="${text}"${open}>
${ds ? dataSummary : `<summary><span class="ico">${ICON[status]}</span><span class="name">${esc(sc.name)}</span>${
            sc.ruleName ? `<span class="rule">Rule: ${esc(sc.ruleName)}</span>` : ''
          }${row ? `<span class="row">${esc(row)}</span>` : ''}${flags}${histHtml}<span class="meta">${ms(r?.durationMs)}${started ? ` · ${esc(started.workerId)}` : ''}</span><button class="perma" type="button" data-link="${anchor(sc.id)}" title="Copy link to this scenario" aria-label="Copy link to this scenario">🔗</button></summary>`}
<div class="body"><div class="where"><code>${esc(sc.id)}</code> · ${esc(sc.uri)}:${sc.line}</div>${chips ? `<div class="chips">${chips}</div>` : ''}${deps}${
            r?.reason ? `<div class="reason">Skipped: ${esc(r.reason)}</div>` : ''
          }${priorHtml}${renderError(status === 'failed' && !sc.steps.some((st) => d.steps.get(`${sc.id}|${st.id}`)?.error) ? r?.error : undefined)}${renderLogs(
            d.logs.scenarioOnly(sc.id),
          )}${renderAttachments(attBy.get(`${sc.id}|`) ?? [])}<ol class="steps">${steps}</ol></div></details>`;
        });
      const items: string[] = [];
      for (let i = 0; i < scenarios.length; ) {
        const ds = datasetOf.get(scenarios[i]!.id);
        if (!ds) {
          items.push(itemHtml[i]!);
          i++;
          continue;
        }
        let j = i;
        while (j < scenarios.length && datasetOf.get(scenarios[j]!.id) === ds) j++;
        items.push(
          renderDatasetOpen(ds, (id) => d.results.get(id)?.status ?? 'skipped', (id) => d.results.get(id)?.durationMs ?? 0) + itemHtml.slice(i, j).join('\n') + renderDatasetClose(),
        );
        i = j;
      }
      return `<section class="feature"><h2>${esc(scenarios[0]!.feature?.name ?? scenarios[0]!.featureName)} <span class="uri">${esc(uri)}</span> ${counts}</h2>${
        scenarios[0]!.feature?.description ? `<p class="desc">${esc(scenarios[0]!.feature.description)}</p>` : ''
      }${items.join('\n')}</section>`;
    })
    .join('\n');

  const totals = s
    ? ORDER.filter((st) => s.scenarios[st] > 0)
        .map((st) => `<label class="pill st-${st}"><input type="checkbox" data-filter="${st}" checked> ${s.scenarios[st]} ${st}</label>`)
        .join('') +
      (s.flaky ? `<span class="pill flaky">${s.flaky} flaky</span>` : '') +
      (s.quarantined ? `<span class="pill quarantined">${s.quarantined} quarantined</span>` : '')
    : '';
  const groups = d.groups.length
    ? `<div class="groups">${d.groups
        .map((g) => `<span class="chip grp">${esc(g.name)}: ${esc(g.mode)}${g.workers ? ` ×${g.workers}` : ''} (${g.members.length})${g.dependsOn.length ? ` after ${esc(g.dependsOn.join(', '))}` : ''}</span>`)
        .join('')}</div>`
    : '';
  const hookFailures = d.hookFailures.filter((h) => !h.scenarioId);
  const statusOf = (id: string): Status => d.results.get(id)?.status ?? 'skipped';
  const timeline = renderTimeline(d.intervals, d.plan, d.groups, anchor, d.startups);
  const graph = renderGraph(d.plan, d.groups, statusOf, anchor);
  const historyView = hasHistory ? renderHistory(d.history, anchor, (id) => anchorIds.has(id)) : '';
  const views = [
    timeline ? `<details class="view" open><summary>Timeline</summary>${timeline}</details>` : '',
    graph ? `<details class="view"${d.plan.length <= 60 ? ' open' : ''}><summary>Dependencies</summary>${graph}</details>` : '',
  ].join('\n');
  const historyPanel = historyView ? `<details class="view" open><summary>History</summary>${historyView}</details>` : '';
  const onlyFrameworkLogs = !hookFailures.length && !d.runError && !d.groupRetries.length && d.logs.run.every((l) => l.source === 'bddr');
  const runSection =
    hookFailures.length || d.logs.run.length || d.runError || d.groupRetries.length
      ? `<section class="feature run${onlyFrameworkLogs ? ' only-fw' : ''}"><h2>Run</h2>${renderError(d.runError)}${d.groupRetries
          .map((g) => `<div class="reason">↻ group ${esc(g.group)}: attempt ${g.attempt}, re-ran ${g.scenarioIds.map((x) => `<code>${esc(x)}</code>`).join(', ')}</div>`)
          .join('')}${hookFailures
          .map((h) => `<div class="reason">${esc(h.kind)} ${esc(h.level)} hook "${esc(h.hookName)}"${h.uri ? ` (${esc(h.uri)})` : ''} failed</div>${renderError(h.error)}`)
          .join('')}${renderLogs(d.logs.run)}</section>`
      : '';
  const when = d.startedAt ? new Date(d.startedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '';

  // ---- statistics (Overview tab) + share payload
  const stats = computeStats({
    plan: d.plan,
    results: d.results,
    steps: d.steps,
    retries: d.retries,
    ...(s ? { summary: s } : {}),
    intervals: d.intervals,
    workers: d.workers,
    history: d.history,
  });
  const failing = stats.counts.failed + stats.counts.undefined + stats.counts.ambiguous;
  const alerts =
    hookFailures.length || d.runError
      ? `<div class="alert"><h3>Run-level problems</h3>${d.runError ? `<div class="reason">${esc(d.runError.message.split('\n')[0])}</div>` : ''}${hookFailures
          .map((h) => `<div class="reason">${esc(h.kind)} ${esc(h.level)} hook "${esc(h.hookName.replace(/ \(.*\)$/, ''))}" failed: ${esc((h.error?.message ?? '').split('\n')[0])}</div>`)
          .join('')}<a class="btnlink" href="#results">Details in Results →</a></div>`
      : '';
  const overview = renderOverview(stats, anchor, alerts);
  const summary = summaryText(d.title, d.success, when, stats);
  const payload = {
    title: d.title,
    success: d.success ?? false,
    ...(d.runId ? { runId: d.runId } : {}),
    ...(d.startedAt ? { startedAt: new Date(d.startedAt).toISOString() } : {}),
    dryRun: d.dryRun ?? false,
    summary,
    stats,
    scenarios: d.plan.map((sc) => {
      const r = d.results.get(sc.id);
      return {
        id: sc.id,
        name: sc.name,
        uri: sc.uri,
        line: sc.line,
        tags: sc.tags,
        groups: sc.groups ?? [],
        status: r?.status ?? 'skipped',
        durationMs: r?.durationMs ?? 0,
        attempts: (d.retries.get(sc.id)?.length ?? 0) + 1,
        flaky: !!r?.flaky,
        ...(r?.error ? { error: r.error.message.split('\n')[0] } : {}),
      };
    }),
  };
  const tab = (id: string, label: string, extra = '') => `<a href="#${id}" data-tab="${id}"${id === 'overview' ? ' class="on"' : ''}>${label}${extra}</a>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(d.title)}</title>
<style>
:root{${LIGHT};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{${DARK}}:root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
a{color:var(--accent)}.wrap{max-width:1360px;margin:0 auto;padding:0 20px}
header.top{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding-top:10px}
.titlebar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}
h1{font-size:19px;margin:0}h1 .badge{font-size:12px;padding:2px 9px;border-radius:10px;color:#fff;margin-left:8px;vertical-align:middle;letter-spacing:.03em}
.ok{background:var(--passed)}.ko{background:var(--failed)}.sub{color:var(--muted);font-size:12px;margin-top:2px}
.actions{display:flex;flex-wrap:wrap;gap:6px}
.tabs{display:flex;gap:2px;margin-top:6px;overflow-x:auto}.tabs a{padding:7px 14px;border-bottom:2px solid transparent;color:var(--muted);text-decoration:none;font-weight:600;white-space:nowrap}
.tabs a:hover{color:var(--fg)}.tabs a.on{color:var(--fg);border-bottom-color:var(--accent)}.tabs .count{margin-left:6px}
.panel{display:none}.panel.on{display:block}
main{max-width:1360px;margin:0 auto;padding:16px 20px 60px}
.toolbar{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:0 0 12px;box-shadow:var(--shadow)}
.tb-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:2px 0}.presets{margin-left:auto;display:flex;gap:6px}
.pill{display:inline-block;border:1px solid currentColor;border-radius:10px;padding:0 8px;font-size:12px;margin-left:4px;cursor:pointer}
.pill input{margin:0 2px 0 0;vertical-align:-1px}
input[type=search],select{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:5px 10px}input[type=search]{min-width:260px;flex:1;max-width:460px}
button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:5px 11px;cursor:pointer;font:inherit;font-size:13px}button:hover{border-color:var(--accent)}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:8px 16px;border-radius:20px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:9}#toast.show{opacity:.95}
.feature{margin:18px 0}.feature h2{font-size:15px;margin:0 0 6px}.uri{color:var(--muted);font-weight:normal;font-size:12px}
.desc{color:var(--muted);margin:0 0 8px;white-space:pre-wrap}.groups{margin:4px 0 12px}
details.scenario{border:1px solid var(--line);border-left:4px solid var(--line);border-radius:8px;margin:6px 0;background:var(--card);scroll-margin-top:120px}
details.scenario>summary{cursor:pointer;padding:7px 10px;display:flex;gap:8px;align-items:baseline;list-style:none}
details.scenario>summary::-webkit-details-marker{display:none}details.scenario>summary:hover{background:var(--bg)}
.name{font-weight:600}.rule,.row,.meta{color:var(--muted);font-size:12px}.meta{margin-left:auto;white-space:nowrap}
.perma{padding:0 5px;font-size:12px;opacity:.45;border-color:transparent;background:transparent}details.scenario:hover .perma,.perma:focus{opacity:1}
.body{padding:0 12px 10px}.where{color:var(--muted);font-size:12px;margin-bottom:4px}
.chips{margin:4px 0}.chip{display:inline-block;font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 5px;margin:0 4px 2px 0;color:var(--muted);text-decoration:none}
a.chip:hover{border-color:var(--accent);color:var(--accent)}.grp{border-color:var(--info);color:var(--info)}.deps{font-size:12px;color:var(--muted);margin:2px 0}
.reason{color:var(--skipped);font-size:13px;margin:4px 0}
ol.steps{list-style:none;margin:6px 0 0;padding:0}.step{padding:3px 0;border-top:1px dashed var(--line)}
.line{display:flex;gap:6px;align-items:baseline}.kw{font-weight:600}.dur{margin-left:auto;color:var(--muted);font-size:12px}
.ico{width:1.1em;text-align:center}
${(['passed', 'failed', 'skipped', 'pending', 'undefined', 'ambiguous'] as const).map((st) => `.st-${st}>.ico,.st-${st}>.line>.ico,.pill.st-${st}{color:var(--${st})}details.st-${st}{border-left-color:var(--${st})}`).join('\n')}
pre{margin:4px 0 4px 22px;padding:6px 8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;overflow:auto;font-size:12px;max-height:360px;position:relative}
pre.err{border-color:var(--failed);color:var(--failed)}pre.snippet{border-style:dashed}pre .cp{position:absolute;top:4px;right:4px;font-size:11px;padding:1px 7px;opacity:.7}
.logs{margin:2px 0 2px 22px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.log{display:flex;gap:6px;flex-wrap:wrap;padding:1px 0}.lvl{min-width:5.2em;font-weight:600;text-transform:uppercase;font-size:10.5px}
.lv-debug .lvl{color:var(--debug)}.lv-info .lvl{color:var(--info)}.lv-warn .lvl{color:var(--warn)}.lv-error .lvl{color:var(--error)}
.log .msg{white-space:pre-wrap}.log .data{color:var(--muted);white-space:pre-wrap;flex-basis:100%;margin-left:5.8em}
.logimg{flex-basis:100%;margin-left:5.8em}.logimg img{max-width:min(100%,640px);max-height:420px;border:1px solid var(--line);border-radius:4px;margin:3px 0}.logfile{margin-left:4px}
.pill.flaky{color:var(--pending)}.pill.quarantined{color:var(--skipped)}.pill.retried{color:var(--muted)}
.tries{margin:2px 0 2px 22px;font-size:12px}.tries summary{cursor:pointer;color:var(--muted)}.tries ol{margin:2px 0;padding-left:18px;max-height:240px;overflow:auto}
.tries li{list-style:none}.tries .ico{display:inline-block}.terr{color:var(--failed);margin-left:1.6em;white-space:pre-wrap}.nth{color:var(--muted);font-size:11px}
.atts{margin:2px 0 2px 22px}figure{margin:6px 0}figcaption{font-size:12px;color:var(--muted)}figure img{max-width:min(100%,900px);border:1px solid var(--line);border-radius:4px}
.att summary{cursor:pointer;font-size:12px}
body.min-info .lv-debug,body.min-warn .lv-debug,body.min-warn .lv-info,body.min-error .lv-debug,body.min-error .lv-info,body.min-error .lv-warn{display:none}
body:not(.show-bddr) .src-bddr,body:not(.show-bddr) .only-fw{display:none}details.scenario.flash{box-shadow:0 0 0 3px var(--accent)}.hidden{display:none!important}
.empty{color:var(--muted);text-align:center;padding:30px 0}
@media print{header.top{position:static}.tabs,.actions,.toolbar,.perma,pre .cp{display:none}.panel{display:block!important;margin-bottom:24px}body{background:#fff}.card,.kpi{box-shadow:none;break-inside:avoid}}
${STATS_CSS}
${DATA_CSS}
${RESPONSIVE_CSS}
${VIEW_CSS}</style></head>
<body class="min-info">
<header class="top"><div class="wrap">
<div class="titlebar"><h1>${esc(d.title)}<span class="badge ${d.success ? 'ok' : 'ko'}">${d.success ? 'PASSED' : 'FAILED'}</span>${d.dryRun ? '<span class="badge ko">DRY RUN</span>' : ''}</h1>
<div class="actions"><button id="share" title="Copy a short text summary for Slack, a PR or a ticket">Copy summary</button><button id="copylink" title="Copy a link to this view (tab, search and filters)">Copy link</button><button id="json" title="Download results and statistics as JSON">Download JSON</button><button id="print" title="Print or save as PDF">Print / PDF</button><button id="theme" title="Switch theme">Theme: auto</button></div></div>
<div class="sub">${esc(when)} · ${ms(s?.durationMs)} · ${s?.scenarios.total ?? 0} scenarios, ${s?.steps.total ?? 0} steps · workers ${d.workers}${d.runId ? ` · run ${esc(d.runId.slice(0, 8))}` : ''}</div>

</div></header>
<nav class="tabbar"><div class="wrap"><div class="tabs">${tab('overview', 'Overview', failing ? `<span class="count bad">${failing}</span>` : '')}${tab('results', 'Results', `<span class="count">${stats.total}</span>`)}${tab('execution', 'Execution')}${historyPanel ? tab('history', 'History') : ''}</div><div class="tb-status"><span class="badge ${d.success ? 'ok' : 'ko'}">${d.success ? 'PASSED' : 'FAILED'}</span><span class="tb-rate">${stats.passRate === null ? '—' : `${(stats.passRate * 100).toFixed(stats.passRate === 0 || stats.passRate === 1 ? 0 : 1)}%`} · ${ms(s?.durationMs)}</span></div></div></nav>
<main>
<div class="panel on" id="tab-overview">${overview}</div>
<div class="panel" id="tab-results">
<div class="toolbar">
<div class="tb-row">${totals}<span class="tb-count" id="shown"></span><span class="presets"><button type="button" data-preset="all">All</button><button type="button" data-preset="failures">Failures only</button></span></div>
<div class="tb-row"><input type="search" id="q" placeholder="Search name, tag, id, group, data…" title="Shortcuts: / search · n / p next / previous failure · 1-4 switch tab">
<label class="sub">logs <select id="lvl"><option value="debug">debug</option><option value="info" selected>info</option><option value="warn">warn</option><option value="error">error</option><option value="none">none</option></select></label>
<label class="sub"><input type="checkbox" id="bddr"> framework logs</label>
<button id="expand">Expand all</button><button id="collapse">Collapse all</button></div>
</div>
${features}
<div id="nomatch">No scenarios match the current filters. <a href="#results?">Reset filters</a></div>
${runSection}
</div>
<div class="panel" id="tab-execution">${groups}${views || '<div class="empty">No timeline data for this run.</div>'}</div>
${historyPanel ? `<div class="panel" id="tab-history">${historyPanel}</div>` : ''}
</main>
<div id="toast" role="status"></div>
<button id="totop" type="button" aria-label="Back to top" title="Back to top">↑</button>
<script type="application/json" id="bddr-data">${dataJson(payload)}</script>
<script>
(function(){
  var body=document.body,root=document.documentElement,q=document.getElementById('q');
  var data={};try{data=JSON.parse(document.getElementById('bddr-data').textContent)}catch(e){}
  var TABS=['overview','results','execution','history'],current='overview',fi=-1;
  function $$(s){return Array.prototype.slice.call(document.querySelectorAll(s))}
  function on(id,fn){var el=document.getElementById(id);if(el)el.addEventListener('click',fn)}
  function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.h);toast.h=setTimeout(function(){t.classList.remove('show')},1800)}
  function copy(text,msg){
    function done(){toast(msg||'Copied')}
    function fallback(){var a=document.createElement('textarea');a.value=text;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();try{document.execCommand('copy');done()}catch(e){toast('Copy failed')}a.remove()}
    if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(done,fallback)}else fallback();
  }
  function showTab(name){
    if(TABS.indexOf(name)<0||!document.getElementById('tab-'+name))name='overview';
    TABS.forEach(function(t){var p=document.getElementById('tab-'+t);if(p)p.classList.toggle('on',t===name);var l=document.querySelector('[data-tab="'+t+'"]');if(l){l.classList.toggle('on',t===name);if(t===name)l.setAttribute('aria-current','page');else l.removeAttribute('aria-current')}});
    current=name;return name;
  }
  function hiddenStatuses(){var off=[];$$('[data-filter]').forEach(function(c){if(!c.checked)off.push(c.getAttribute('data-filter'))});return off}
  function syncHash(){
    if(current!=='results')return;
    var p=[],v=q.value.trim(),h=hiddenStatuses();
    if(v)p.push('q='+encodeURIComponent(v));if(h.length)p.push('hide='+h.join(','));
    try{history.replaceState(null,'','#results'+(p.length?'?'+p.join('&'):''))}catch(e){}
  }
  function apply(skipHash){
    var off={};hiddenStatuses().forEach(function(x){off[x]=1});
    var text=q.value.trim().toLowerCase();
    $$('details.scenario').forEach(function(d){
      var hide=off[d.getAttribute('data-status')]||(text&&d.getAttribute('data-text').indexOf(text)<0);
      d.classList.toggle('hidden',!!hide);
    });
    var vis=0,all=0;$$('details.scenario').forEach(function(d){all++;if(!d.classList.contains('hidden'))vis++});
    $$('section.dataset,section.feature:not(.run)').forEach(function(sec){sec.classList.toggle('hidden',!sec.querySelector('details.scenario:not(.hidden)'))});
    var sh=document.getElementById('shown');if(sh)sh.textContent=vis===all?all+' scenarios':vis+' of '+all+' shown';
    var nm=document.getElementById('nomatch');if(nm)nm.classList.toggle('show',all>0&&vis===0);
    if(skipHash!==true)syncHash();
  }
  function flash(t){t.open=true;t.classList.remove('hidden');t.scrollIntoView({block:'start'});t.classList.add('flash');setTimeout(function(){t.classList.remove('flash')},1400)}
  function route(scroll){
    var raw=location.hash.slice(1),qi=raw.indexOf('?'),name=decodeURIComponent(qi<0?raw:raw.slice(0,qi)),ps=new URLSearchParams(qi<0?'':raw.slice(qi+1));
    if(name.indexOf('sc-')===0){showTab('results');var t=document.getElementById(name);if(t)flash(t);return}
    showTab(name||'overview');
    if(current==='results'&&qi>=0){
      q.value=ps.get('q')||'';var hide=(ps.get('hide')||'').split(',');
      $$('[data-filter]').forEach(function(c){c.checked=hide.indexOf(c.getAttribute('data-filter'))<0});apply(true);
    }
    if(scroll!==false)window.scrollTo(0,0);
  }
  function jump(dir){
    showTab('results');
    var l=$$('details.scenario.st-failed:not(.hidden),details.scenario.st-undefined:not(.hidden),details.scenario.st-ambiguous:not(.hidden)');
    if(!l.length){toast('No failures to show');return}
    l.sort(function(a,b){return a.compareDocumentPosition(b)&2?1:-1});
    fi=(fi+dir+l.length)%l.length;flash(l[fi]);
  }
  document.querySelectorAll('[data-filter]').forEach(function(c){c.addEventListener('change',function(){apply()})});
  q.addEventListener('input',function(){apply()});
  $$('[data-preset]').forEach(function(b){b.addEventListener('click',function(){
    var only=b.getAttribute('data-preset')==='failures';
    $$('[data-filter]').forEach(function(c){var k=c.getAttribute('data-filter');c.checked=!only||(k!=='passed'&&k!=='skipped'&&k!=='pending')});
    apply();
  })});
  document.getElementById('lvl').addEventListener('change',function(e){
    body.classList.remove('min-info','min-warn','min-error');var v=e.target.value;
    $$('.logs').forEach(function(l){l.classList.toggle('hidden',v==='none')});
    if(v!=='debug'&&v!=='none')body.classList.add('min-'+v);
  });
  document.getElementById('bddr').addEventListener('change',function(e){body.classList.toggle('show-bddr',e.target.checked)});
  on('expand',function(){$$('details.scenario:not(.hidden)').forEach(function(d){d.open=true})});
  on('collapse',function(){$$('details.scenario').forEach(function(d){d.open=false})});
  on('share',function(){copy(data.summary||'','Summary copied')});
  on('copylink',function(){copy(location.href,'Link copied')});
  on('print',function(){window.print()});
  on('json',function(){
    var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download='bddr-results.json';document.body.appendChild(a);a.click();a.remove();
  });
  var themes=['auto','light','dark'],ti=0;
  try{var saved=localStorage.getItem('bddr-theme');if(saved)ti=Math.max(0,themes.indexOf(saved))}catch(e){}
  function setTheme(){var t=themes[ti];if(t==='auto')root.removeAttribute('data-theme');else root.setAttribute('data-theme',t);document.getElementById('theme').textContent='Theme: '+t}
  on('theme',function(){ti=(ti+1)%themes.length;try{localStorage.setItem('bddr-theme',themes[ti])}catch(e){}setTheme()});
  setTheme();
  $$('pre.err').forEach(function(p){
    var b=document.createElement('button'),text=p.textContent;b.type='button';b.className='cp';b.textContent='copy';b.title='Copy error';
    b.addEventListener('click',function(){copy(text,'Error copied')});p.appendChild(b);
  });
  document.addEventListener('click',function(e){
    var el=e.target&&e.target.closest?e.target:null;if(!el)return;
    var link=el.closest('[data-link]');
    if(link){e.preventDefault();e.stopPropagation();copy(location.href.split('#')[0]+'#'+link.getAttribute('data-link'),'Link to scenario copied');return}
    var a=el.closest('a[href^="#"]');
    if(a){e.preventDefault();var h=a.getAttribute('href');if(location.hash!==h)history.pushState(null,'',h);route()}
  });
  window.addEventListener('popstate',function(){route()});
  window.addEventListener('hashchange',function(){route()});
  document.addEventListener('keydown',function(e){
    var tag=e.target&&e.target.tagName;
    if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'){if(e.key==='Escape')e.target.blur();return}
    if(e.metaKey||e.ctrlKey||e.altKey)return;
    if(e.key==='/'){e.preventDefault();showTab('results');q.focus()}
    else if(e.key==='n'||e.key==='p'){jump(e.key==='n'?1:-1)}
    else if(e.key>='1'&&e.key<='4'){var t=TABS[Number(e.key)-1];if(document.getElementById('tab-'+t)){history.pushState(null,'','#'+t);route()}}
  });
  var totop=document.getElementById('totop');
  window.addEventListener('scroll',function(){totop.classList.toggle('show',window.scrollY>700)},{passive:true});
  totop.addEventListener('click',function(){window.scrollTo({top:0,behavior:'smooth'})});
  apply(true);
  route(false);
})();
</script>
</body></html>
`;
}
