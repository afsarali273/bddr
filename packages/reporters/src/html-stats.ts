/**
 * HTML report: test result statistics (Overview tab) and the plain-text/JSON summaries used by the share buttons.
 * Pure functions, no external assets. `computeStats` is the single source for the cards, the "Copy summary" text and
 * the "Download JSON" export, so the numbers always agree.
 */
import type { HistoryRun, PlannedScenario, RunSummary, ScenarioFinished, Status, StepFinished } from '@bddr/core';
import { esc, fmtMs, type Interval } from './html-views.js';

export const STATUSES: Status[] = ['passed', 'failed', 'pending', 'undefined', 'ambiguous', 'skipped'];
const FAILING: Status[] = ['failed', 'undefined', 'ambiguous'];
const ICON: Record<Status, string> = { passed: '✔', failed: '✘', skipped: '↷', pending: '…', undefined: '?', ambiguous: '‼' };

export type Counts = Record<Status, number>;
export const zeroCounts = (): Counts => ({ passed: 0, failed: 0, skipped: 0, pending: 0, undefined: 0, ambiguous: 0 });

export interface StatsInput {
  plan: readonly PlannedScenario[];
  results: ReadonlyMap<string, ScenarioFinished>;
  steps: ReadonlyMap<string, StepFinished>;
  retries: ReadonlyMap<string, ScenarioFinished[]>;
  summary?: RunSummary;
  intervals: readonly Interval[];
  workers: number;
  /** Previous runs + this one (last). */
  history: readonly HistoryRun[];
}

export interface Row {
  label: string;
  /** Search text that selects this row's scenarios in the Results tab. */
  q: string;
  total: number;
  counts: Counts;
  durationMs: number;
}

export interface FailureCluster {
  message: string;
  scenarios: Array<{ id: string; name: string; status: Status }>;
}

export interface Stats {
  total: number;
  counts: Counts;
  /** Scenarios that actually ran (everything except skipped). */
  executed: number;
  /** passed / executed, null when nothing ran. */
  passRate: number | null;
  wallMs: number;
  /** Sum of all scenario attempt durations across workers. */
  busyMs: number;
  workers: number;
  /** busy / wall: how many scenarios ran at once on average. */
  parallelism: number | null;
  /** busy / (wall × workers). */
  efficiency: number | null;
  flaky: number;
  retried: number;
  quarantined: number;
  duration: { mean: number; p50: number; p90: number; p95: number; max: number } | null;
  histogram: Array<{ label: string; count: number }>;
  slowest: Array<{ id: string; name: string; ms: number; status: Status }>;
  clusters: FailureCluster[];
  byFeature: Row[];
  byTag: Row[];
  byGroup: Row[];
  steps?: RunSummary['steps'];
  previous?: { passRate: number | null; durationMs: number; success: boolean };
  unstable: Array<{ id: string; name: string; attempts: number; flaky: boolean }>;
}

const BUCKETS: Array<[number, string]> = [
  [100, '<100ms'],
  [250, '<250ms'],
  [500, '<500ms'],
  [1000, '<1s'],
  [2500, '<2.5s'],
  [5000, '<5s'],
  [10_000, '<10s'],
  [Infinity, '≥10s'],
];

const firstLine = (s: string): string => (s.split('\n')[0] ?? '').trim();

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

function failureMessage(sc: PlannedScenario, status: Status, i: StatsInput): string {
  let err = i.results.get(sc.id)?.error;
  if (!err) {
    for (const st of sc.steps) {
      const e = i.steps.get(`${sc.id}|${st.id}`)?.error;
      if (e) {
        err = e;
        break;
      }
    }
  }
  if (err) return firstLine(err.message) || status;
  return status === 'undefined' ? 'Undefined step' : status;
}

export function passRateOf(statuses: Iterable<Status>): number | null {
  let passed = 0;
  let ran = 0;
  for (const s of statuses) {
    if (s === 'skipped') continue;
    ran++;
    if (s === 'passed') passed++;
  }
  return ran ? passed / ran : null;
}

export function computeStats(i: StatsInput): Stats {
  const counts = zeroCounts();
  const durations: number[] = [];
  const rows = { feature: new Map<string, Row>(), tag: new Map<string, Row>(), group: new Map<string, Row>() };
  const bump = (m: Map<string, Row>, key: string, label: string, q: string, status: Status, ms: number) => {
    let r = m.get(key);
    if (!r) {
      r = { label, q, total: 0, counts: zeroCounts(), durationMs: 0 };
      m.set(key, r);
    }
    r.total++;
    r.counts[status]++;
    r.durationMs += ms;
  };
  const slowest: Stats['slowest'] = [];
  const clusters = new Map<string, FailureCluster>();
  const unstable: Stats['unstable'] = [];
  for (const sc of i.plan) {
    const r = i.results.get(sc.id);
    const status: Status = r?.status ?? 'skipped';
    const ms = r?.durationMs ?? 0;
    counts[status]++;
    if (status !== 'skipped') {
      durations.push(ms);
      slowest.push({ id: sc.id, name: sc.name, ms, status });
    }
    bump(rows.feature, sc.uri, sc.feature?.name ?? sc.featureName, sc.uri, status, ms);
    for (const t of sc.tags) bump(rows.tag, t, t, t, status, ms);
    for (const g of sc.groups ?? []) bump(rows.group, g, g, g, status, ms);
    if (FAILING.includes(status)) {
      const message = failureMessage(sc, status, i);
      const key = message.replace(/\d+(?:\.\d+)?/g, '#').slice(0, 160);
      const c = clusters.get(key) ?? { message, scenarios: [] };
      c.scenarios.push({ id: sc.id, name: sc.name, status });
      clusters.set(key, c);
    }
    const attempts = (i.retries.get(sc.id)?.length ?? 0) + 1;
    if (attempts > 1 || r?.flaky) unstable.push({ id: sc.id, name: sc.name, attempts, flaky: !!r?.flaky });
  }
  durations.sort((a, b) => a - b);
  const executed = counts.passed + counts.failed + counts.pending + counts.undefined + counts.ambiguous;
  const wallMs = i.summary?.durationMs ?? 0;
  const busyMs = i.intervals.filter((x) => x.worker !== 'scheduler' && x.end >= x.start).reduce((a, x) => a + (x.end - x.start), 0);
  const histogram = BUCKETS.map(([, label]) => ({ label, count: 0 }));
  for (const d of durations) histogram[BUCKETS.findIndex(([max]) => d < max)]!.count++;
  const prev = i.history.length >= 2 ? i.history[i.history.length - 2] : undefined;
  const sortRows = (m: Map<string, Row>) => [...m.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return {
    total: i.plan.length,
    counts,
    executed,
    passRate: executed ? counts.passed / executed : null,
    wallMs,
    busyMs,
    workers: i.workers,
    parallelism: wallMs > 0 && busyMs > 0 ? busyMs / wallMs : null,
    efficiency: wallMs > 0 && busyMs > 0 && i.workers > 0 ? busyMs / (wallMs * i.workers) : null,
    flaky: i.summary?.flaky ?? 0,
    retried: i.summary?.retried ?? 0,
    quarantined: i.summary?.quarantined ?? 0,
    duration: durations.length
      ? {
          mean: durations.reduce((a, b) => a + b, 0) / durations.length,
          p50: percentile(durations, 50),
          p90: percentile(durations, 90),
          p95: percentile(durations, 95),
          max: durations[durations.length - 1]!,
        }
      : null,
    histogram,
    slowest: slowest.sort((a, b) => b.ms - a.ms).slice(0, 8),
    clusters: [...clusters.values()].sort((a, b) => b.scenarios.length - a.scenarios.length),
    byFeature: sortRows(rows.feature),
    byTag: sortRows(rows.tag),
    byGroup: sortRows(rows.group),
    ...(i.summary ? { steps: i.summary.steps } : {}),
    ...(prev ? { previous: { passRate: passRateOf(Object.values(prev.scenarios).map((e) => e.s)), durationMs: prev.durationMs, success: prev.success } } : {}),
    unstable,
  };
}

// ------------------------------------------------------------------ rendering

const pct = (n: number | null): string => (n === null ? '—' : `${(n * 100).toFixed(n === 0 || n === 1 ? 0 : 1)}%`);

function delta(now: number | null, before: number | null | undefined, unit: 'pts' | '%', goodWhenUp: boolean): string {
  if (now === null || before === null || before === undefined) return '';
  const d = unit === 'pts' ? (now - before) * 100 : before > 0 ? ((now - before) / before) * 100 : 0;
  if (Math.abs(d) < 0.05) return ' · <span class="dl">no change vs previous run</span>';
  const up = d > 0;
  const good = up === goodWhenUp;
  return ` · <span class="dl ${good ? 'good' : 'bad'}">${up ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}${unit === 'pts' ? ' pts' : '%'} vs previous run</span>`;
}

function donut(counts: Counts, total: number, centre: string): string {
  const R = 15.9155;
  let offset = 0;
  const parts = STATUSES.filter((s) => counts[s] > 0).map((s) => {
    const share = (counts[s] / total) * 100;
    const seg = `<circle class="dn-seg" r="${R}" cx="21" cy="21" style="stroke:var(--${s})" stroke-dasharray="${share.toFixed(3)} ${(100 - share).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}"><title>${counts[s]} ${s}</title></circle>`;
    offset += share;
    return seg;
  });
  return `<svg class="donut" viewBox="0 0 42 42" role="img" aria-label="Scenario results"><circle r="${R}" cx="21" cy="21" class="dn-bg"/>${parts.join('')}<text x="21" y="21.5" class="dn-main">${esc(centre)}</text><text x="21" y="26" class="dn-sub">pass rate</text></svg>`;
}

export function stackBar(counts: Counts, total: number): string {
  if (!total) return '<div class="sbar"></div>';
  return `<div class="sbar">${STATUSES.filter((s) => counts[s] > 0)
    .map((s) => `<i style="width:${((counts[s] / total) * 100).toFixed(2)}%;background:var(--${s})" title="${counts[s]} ${s}"></i>`)
    .join('')}</div>`;
}

function breakdown(title: string, rows: Row[], limit: number): string {
  if (!rows.length) return '';
  const body = rows
    .slice(0, limit)
    .map((r) => {
      const ran = r.total - r.counts.skipped;
      return `<tr><td><a class="rowlink" href="#results?q=${encodeURIComponent(r.q)}" title="show these scenarios">${esc(r.label)}</a></td><td class="w">${stackBar(r.counts, r.total)}</td><td class="num">${r.counts.passed}/${r.total}</td><td class="num">${pct(ran ? r.counts.passed / ran : null)}</td><td class="num">${esc(fmtMs(r.durationMs))}</td></tr>`;
    })
    .join('');
  const more = rows.length > limit ? `<div class="legend">top ${limit} of ${rows.length} by scenario count</div>` : '';
  return `<section class="card"><h3>${esc(title)}</h3><table class="stable"><thead><tr><th></th><th></th><th class="num">passed</th><th class="num">rate</th><th class="num">time</th></tr></thead><tbody>${body}</tbody></table>${more}</section>`;
}

/** The Overview tab body. `alerts` is pre-rendered HTML for run-level problems (hook failures, run error). */
export function renderOverview(s: Stats, anchor: (id: string) => string, alerts = ''): string {
  const bad = s.counts.failed + s.counts.undefined + s.counts.ambiguous;
  const rateClass = s.passRate === null ? '' : s.passRate === 1 ? 'good' : bad ? 'bad' : '';
  const kpi = (label: string, value: string, sub: string, cls = '') =>
    `<div class="kpi"><div class="k-label">${label}</div><div class="k-val ${cls}">${value}</div><div class="k-sub">${sub}</div></div>`;
  const skippedNote = s.counts.skipped ? `${s.counts.skipped} skipped` : 'none skipped';
  const kpis = [
    kpi('Pass rate', pct(s.passRate), `${s.counts.passed} of ${s.executed} executed${delta(s.passRate, s.previous?.passRate, 'pts', true)}`, rateClass),
    kpi('Scenarios', String(s.total), `${bad ? `<span class="bad">${bad} failing</span> · ` : ''}${skippedNote}`),
    kpi('Steps', String(s.steps?.total ?? 0), s.steps ? `${s.steps.passed} passed${s.steps.failed ? ` · <span class="bad">${s.steps.failed} failed</span>` : ''}${s.steps.skipped ? ` · ${s.steps.skipped} skipped` : ''}` : ''),
    kpi('Duration', esc(fmtMs(s.wallMs)), `wall clock${delta(s.wallMs || null, s.previous?.durationMs, '%', false)}`),
    kpi(
      'Parallelism',
      s.parallelism === null ? '—' : `${s.parallelism.toFixed(1)}×`,
      s.efficiency === null ? `${s.workers} worker${s.workers === 1 ? '' : 's'}` : `${s.workers} worker${s.workers === 1 ? '' : 's'} · ${pct(s.efficiency)} busy · ${esc(fmtMs(s.busyMs))} of test time`,
    ),
    kpi('Stability', s.flaky || s.retried || s.quarantined ? String(s.flaky) : '0', `flaky · ${s.retried} retried · ${s.quarantined} quarantined`, s.flaky ? 'warn' : ''),
  ].join('');

  const legend = STATUSES.filter((st) => s.counts[st] > 0)
    .map((st) => `<a class="lrow" href="#results?hide=${encodeURIComponent(STATUSES.filter((x) => x !== st).join(','))}"><i style="background:var(--${st})"></i><span class="ln">${st}</span><b>${s.counts[st]}</b><span class="lp">${((s.counts[st] / Math.max(1, s.total)) * 100).toFixed(1)}%</span></a>`)
    .join('');
  const scenariosCard = `<section class="card"><h3>Scenario results</h3><div class="donutwrap">${s.total ? donut(s.counts, s.total, pct(s.passRate)) : ''}<div class="dlegend">${legend || '<div class="legend">no scenarios</div>'}</div></div></section>`;

  const stepsCard = s.steps
    ? `<section class="card"><h3>Steps</h3>${stackBar(s.steps, s.steps.total)}<div class="chiprow">${STATUSES.filter((st) => s.steps![st] > 0)
        .map((st) => `<span class="pill st-${st}">${s.steps![st]} ${st}</span>`)
        .join('')}</div></section>`
    : '';

  let durationCard = '';
  if (s.duration) {
    const max = Math.max(1, ...s.histogram.map((h) => h.count));
    const stat = (k: string, v: number) => `<div><span>${k}</span><b>${esc(fmtMs(v))}</b></div>`;
    durationCard = `<section class="card"><h3>Scenario duration</h3><div class="dstats">${stat('mean', s.duration.mean)}${stat('median', s.duration.p50)}${stat('p90', s.duration.p90)}${stat('p95', s.duration.p95)}${stat('max', s.duration.max)}</div><div class="hist2">${s.histogram
      .map((h) => `<div class="hcol" title="${h.count} scenario(s) ${esc(h.label)}"><div class="hfill" style="height:${Math.round((h.count / max) * 100)}%"></div><span class="hn">${h.count || ''}</span><span class="hl">${esc(h.label)}</span></div>`)
      .join('')}</div></section>`;
  }

  const clusterCard = s.clusters.length
    ? `<section class="card wide"><h3>Failures grouped by cause <span class="count bad">${bad}</span></h3>${s.clusters
        .slice(0, 8)
        .map(
          (c) =>
            `<div class="fc"><div class="fc-head"><span class="fc-n">${c.scenarios.length}×</span><code class="fc-msg">${esc(c.message.slice(0, 300))}</code></div><ul>${c.scenarios
              .slice(0, 6)
              .map((x) => `<li><a href="#${anchor(x.id)}"><span class="st-${x.status}"><span class="ico">${ICON[x.status]}</span></span> ${esc(x.name)}</a></li>`)
              .join('')}${c.scenarios.length > 6 ? `<li class="legend">+ ${c.scenarios.length - 6} more</li>` : ''}</ul></div>`,
        )
        .join('')}${s.clusters.length > 8 ? `<div class="legend">${s.clusters.length - 8} more causes</div>` : ''}<a class="btnlink" href="#results?hide=passed,skipped,pending">Show all failures in Results →</a></section>`
    : bad === 0 && s.executed > 0
      ? `<section class="card wide allgood"><h3>No failures</h3><div class="legend">All ${s.executed} executed scenarios passed${s.counts.skipped ? `; ${s.counts.skipped} skipped` : ''}.</div></section>`
      : '';

  const slowCard = s.slowest.length
    ? `<section class="card"><h3>Slowest scenarios</h3><ol class="slow">${s.slowest
        .map((x) => `<li><a href="#${anchor(x.id)}">${esc(x.name)}</a><span class="num">${esc(fmtMs(x.ms))}</span></li>`)
        .join('')}</ol></section>`
    : '';
  const unstableCard = s.unstable.length
    ? `<section class="card"><h3>Retried &amp; flaky</h3><ul class="plain">${s.unstable
        .slice(0, 10)
        .map((x) => `<li><a href="#${anchor(x.id)}">${esc(x.name)}</a> <span class="pill ${x.flaky ? 'flaky' : 'retried'}">${x.flaky ? 'flaky' : `${x.attempts} attempts`}</span></li>`)
        .join('')}</ul></section>`
    : '';

  return `${alerts}<div class="kpis">${kpis}</div>
<div class="grid">${clusterCard}${scenariosCard}${stepsCard}${durationCard}${slowCard}${unstableCard}</div>
<div class="grid wide3">${breakdown('By feature', s.byFeature, 15)}${breakdown('By tag', s.byTag, 15)}${breakdown('By group', s.byGroup, 15)}</div>`;
}

// ------------------------------------------------------------------ share

/** Markdown-flavoured text for chat / PR comments / tickets ("Copy summary"). */
export function summaryText(title: string, success: boolean | undefined, when: string, s: Stats): string {
  const bad = s.counts.failed + s.counts.undefined + s.counts.ambiguous;
  const lines = [
    `${success ? '✅' : '❌'} *${title}* — ${success ? 'PASSED' : 'FAILED'}`,
    `${when ? `${when} · ` : ''}${fmtMs(s.wallMs)} · ${s.workers} worker${s.workers === 1 ? '' : 's'}`,
    `Scenarios: ${s.total} — ${STATUSES.filter((st) => s.counts[st] > 0)
      .map((st) => `${s.counts[st]} ${st}`)
      .join(', ')} (pass rate ${pct(s.passRate)})`,
  ];
  if (s.steps) lines.push(`Steps: ${s.steps.total} — ${s.steps.passed} passed${s.steps.failed ? `, ${s.steps.failed} failed` : ''}${s.steps.skipped ? `, ${s.steps.skipped} skipped` : ''}`);
  if (s.flaky || s.retried || s.quarantined) lines.push(`Flaky: ${s.flaky} · retried: ${s.retried} · quarantined: ${s.quarantined}`);
  if (s.duration) lines.push(`Scenario time: median ${fmtMs(s.duration.p50)}, p90 ${fmtMs(s.duration.p90)}, max ${fmtMs(s.duration.max)}`);
  if (s.clusters.length) {
    lines.push('', `Failures (${bad}):`);
    for (const c of s.clusters.slice(0, 5)) {
      lines.push(`• ${c.scenarios.length}× ${c.message.slice(0, 200)}`);
      for (const x of c.scenarios.slice(0, 3)) lines.push(`    - ${x.name}`);
      if (c.scenarios.length > 3) lines.push(`    - … ${c.scenarios.length - 3} more`);
    }
    if (s.clusters.length > 5) lines.push(`• … ${s.clusters.length - 5} more causes`);
  }
  if (s.slowest.length) lines.push('', `Slowest: ${s.slowest.slice(0, 3).map((x) => `${x.name} (${fmtMs(x.ms)})`).join('; ')}`);
  return lines.join('\n');
}

/** JSON embedded in the page (`#bddr-data`) and offered by "Download JSON". `</` is escaped so it can sit in a <script>. */
export function dataJson(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, '\\u003c').replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028').replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

export const STATS_CSS = `
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:0 0 14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}
.k-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.k-val{font-size:28px;font-weight:700;line-height:1.2;margin:2px 0}
.k-sub{color:var(--muted);font-size:12px}.k-val.good,.good{color:var(--passed)}.k-val.bad,.bad{color:var(--failed)}.k-val.warn,.warn{color:var(--pending)}
.dl{font-weight:600}.dl.good{color:var(--passed)}.dl.bad{color:var(--failed)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin:0 0 14px;align-items:start}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow);min-width:0}
.grid.wide3{grid-template-columns:repeat(auto-fit,minmax(440px,1fr))}.card.wide{grid-column:1/-1}.card h3{margin:0 0 8px;font-size:14px}.card.allgood{border-color:var(--passed)}
.donutwrap{display:flex;gap:18px;align-items:center;flex-wrap:wrap}.donut{width:150px;height:150px;flex:none}
.dn-bg{fill:none;stroke:var(--line);stroke-width:5}.dn-seg{fill:none;stroke-width:5;transform:rotate(-90deg);transform-origin:21px 21px}
.dn-main{font:700 6.2px system-ui,sans-serif;fill:var(--fg);text-anchor:middle}.dn-sub{font:3px system-ui,sans-serif;fill:var(--muted);text-anchor:middle}
.dlegend{flex:1;min-width:150px}.lrow{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:6px;color:var(--fg);text-decoration:none}
.lrow:hover{background:var(--bg)}.lrow i{width:10px;height:10px;border-radius:3px;flex:none}.lrow .ln{flex:1;text-transform:capitalize}.lrow .lp{color:var(--muted);width:3.8em;text-align:right;font-size:12px}
.sbar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line);min-width:90px}.sbar i{display:block;height:100%}
.chiprow{margin-top:8px}.chiprow .pill{margin:0 6px 4px 0;cursor:default}
.dstats{display:flex;flex-wrap:wrap;gap:6px 18px;margin-bottom:10px}.dstats div{display:flex;flex-direction:column}.dstats span{color:var(--muted);font-size:11px;text-transform:uppercase}.dstats b{font-size:15px}
.hist2{display:flex;gap:6px;align-items:flex-end;height:120px;padding-top:4px}.hcol{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0}
.hfill{width:100%;background:var(--accent);border-radius:4px 4px 0 0;min-height:1px;opacity:.85}.hn{font-size:11px;height:14px}.hl{font-size:10px;color:var(--muted);white-space:nowrap}
.fc{border-top:1px solid var(--line);padding:8px 0}.fc:first-of-type{border-top:0}.fc-head{display:flex;gap:10px;align-items:baseline}
.fc-n{font-weight:700;color:var(--failed);min-width:2.6em}.fc-msg{white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.fc ul,.plain{margin:4px 0 0 2.6em;padding:0;list-style:none;font-size:13px}.plain{margin-left:0}.fc li{padding:1px 0}
.btnlink{display:inline-block;margin-top:8px;font-weight:600}
.slow{margin:0;padding:0;list-style:none;counter-reset:s}.slow li{display:flex;gap:8px;padding:4px 0;border-top:1px solid var(--line);counter-increment:s}
.slow li:first-child{border-top:0}.slow li::before{content:counter(s);color:var(--muted);width:1.4em}.slow a{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stable{border-collapse:collapse;width:100%;font-size:13px}.stable th{color:var(--muted);font-weight:500;text-align:left;font-size:11px;text-transform:uppercase;padding:2px 6px}
.stable td{border-top:1px solid var(--line);padding:5px 6px}.stable .w{width:26%}.stable td:first-child{min-width:130px;overflow-wrap:anywhere}.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.rowlink{color:var(--fg);text-decoration:none;font-weight:500;word-break:break-word}.rowlink:hover{color:var(--accent);text-decoration:underline}
.count{display:inline-block;min-width:1.6em;text-align:center;border-radius:9px;padding:0 6px;font-size:11px;background:var(--line);color:var(--fg)}.count.bad{background:var(--failed);color:#fff}
.alert{border:1px solid var(--failed);background:color-mix(in srgb,var(--failed) 8%,var(--card));border-radius:12px;padding:10px 14px;margin:0 0 14px}.alert h3{margin:0 0 4px;font-size:14px;color:var(--failed)}
`;
