/**
 * HTML report v2 views (Phase 5): execution timeline per worker lane, dependency graph, run history.
 * Pure functions producing inline SVG/HTML (no external assets), used by html.ts.
 */
import { scenarioHistory, worstStatus, type HistoryRun, type PlannedGroup, type PlannedScenario, type Status } from '@bddr/core';

export interface Interval {
  id: string;
  attempt: number;
  worker: string;
  start: number;
  end: number;
  status: Status;
  /** This attempt failed and the scenario ran again. */
  retried?: boolean;
}

/** Worker process startup (fork → ready), from workerStarted events. */
export interface Startup {
  worker: string;
  start: number;
  end: number;
}

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function fmtMs(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

const laneOrder = (a: string, b: string) => (Number(a.replace(/\D/g, '')) || 0) - (Number(b.replace(/\D/g, '')) || 0) || a.localeCompare(b);

// ------------------------------------------------------------------ timeline

/**
 * One row per worker lane (bars = scenario attempts, coloured by status; retried attempts hatched), then one row per
 * named group (span from its first member start to its last member end). Bars link to the scenario (#anchor).
 */
export function renderTimeline(
  intervals: readonly Interval[],
  plan: readonly PlannedScenario[],
  groups: readonly PlannedGroup[],
  anchor: (id: string) => string,
  startups: readonly Startup[] = [],
): string {
  // A non-passing attempt followed by another attempt of the same scenario (scenario OR group retry) was retried.
  const lastAttempt = new Map<string, number>();
  for (const i of intervals) lastAttempt.set(i.id, Math.max(lastAttempt.get(i.id) ?? 0, i.attempt));
  const real = intervals
    .filter((i) => i.worker !== 'scheduler' && i.end >= i.start)
    .map((i) => (i.status !== 'passed' && i.attempt < (lastAttempt.get(i.id) ?? 0) ? { ...i, retried: true } : i));
  if (!real.length) return '';
  const t0 = Math.min(...real.map((i) => i.start), ...startups.map((s) => s.start));
  const t1 = Math.max(...real.map((i) => i.end), t0 + 1);
  const span = t1 - t0;
  const names = new Map(plan.map((p) => [p.id, p.name]));
  const lanes = [...new Set(real.map((i) => i.worker))].sort(laneOrder);
  const groupRows = groups
    .filter((g) => g.name !== 'default' && g.members.length)
    .map((g) => {
      const mine = real.filter((i) => g.members.includes(i.id));
      if (!mine.length) return undefined;
      return { name: g.name, mode: g.mode, start: Math.min(...mine.map((i) => i.start)), end: Math.max(...mine.map((i) => i.end)), status: worstStatus(mine.filter((i) => !i.retried).map((i) => i.status)) };
    })
    .filter((g): g is NonNullable<typeof g> => !!g);

  const W = 1000;
  const L = 92; // label column
  const R = 8;
  const rowH = 22;
  const top = 22;
  const x = (t: number) => L + ((t - t0) / span) * (W - L - R);
  const rows = lanes.length + (groupRows.length ? groupRows.length + 1 : 0);
  const H = top + rows * rowH + 6;

  const ticks = Array.from({ length: 6 }, (_, k) => t0 + (span * k) / 5)
    .map(
      (t, k) =>
        `<line x1="${x(t)}" y1="${top - 4}" x2="${x(t)}" y2="${H}" class="tl-grid"/><text x="${x(t)}" y="12" class="tl-tick" text-anchor="${k === 0 ? 'start' : k === 5 ? 'end' : 'middle'}">${esc(fmtMs(t - t0))}</text>`,
    )
    .join('');

  const busy = (w: string) => real.filter((i) => i.worker === w).reduce((n, i) => n + (i.end - i.start), 0);
  const laneSvg = lanes
    .map((w, r) => {
      const y = top + r * rowH;
      const util = Math.round((busy(w) / span) * 100);
      const bars = real
        .filter((i) => i.worker === w)
        .map((i) => {
          const bx = x(i.start);
          const bw = Math.max(2, x(i.end) - bx);
          const tip = `${names.get(i.id) ?? i.id} · attempt ${i.attempt} · ${i.retried ? 'failed, retried' : i.status} · ${fmtMs(i.end - i.start)}`;
          return `<a href="#${anchor(i.id)}" class="tl-link"><rect x="${bx.toFixed(1)}" y="${y + 3}" width="${bw.toFixed(1)}" height="${rowH - 6}" rx="2" class="tl-bar tb-${i.retried ? 'retried' : i.status}"><title>${esc(tip)}</title></rect></a>`;
        })
        .join('');
      const boot = startups
        .filter((s) => s.worker === w)
        .map((s) => {
          const bx = x(s.start);
          const bw = Math.max(2, x(s.end) - bx);
          return `<rect x="${bx.toFixed(1)}" y="${y + 6}" width="${bw.toFixed(1)}" height="${rowH - 12}" rx="2" class="tl-boot"><title>${esc(`worker process start-up · ${fmtMs(s.end - s.start)}`)}</title></rect>`;
        })
        .join('');
      return `${boot}<text x="4" y="${y + rowH / 2 + 4}" class="tl-lane">${esc(w)}<title>busy ${util}% of the run</title></text><text x="${L - 6}" y="${y + rowH / 2 + 4}" class="tl-util" text-anchor="end">${util}%</text>${bars}`;
    })
    .join('');

  const groupSvg = groupRows.length
    ? `<text x="4" y="${top + lanes.length * rowH + rowH / 2 + 4}" class="tl-head">groups</text>` +
      groupRows
        .map((g, k) => {
          const y = top + (lanes.length + 1 + k) * rowH;
          const bx = x(g.start);
          const bw = Math.max(2, x(g.end) - bx);
          return `<text x="4" y="${y + rowH / 2 + 4}" class="tl-lane">${esc(g.name)}</text><rect x="${bx.toFixed(1)}" y="${y + 6}" width="${bw.toFixed(1)}" height="${rowH - 12}" rx="2" class="tl-group tb-${g.status}"><title>${esc(
            `group ${g.name} (${g.mode}) · ${fmtMs(g.end - g.start)} · ${g.status}`,
          )}</title></rect>`;
        })
        .join('')
    : '';

  return `<svg class="timeline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" role="img" aria-label="Execution timeline">
<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--failed)" opacity=".35"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--failed)" stroke-width="3"/></pattern></defs>
${ticks}${laneSvg}${groupSvg}</svg>
<div class="legend"><span class="lg tb-passed"></span>passed <span class="lg tb-failed"></span>failed <span class="lg tb-retried"></span>failed, retried <span class="lg tb-skipped"></span>skipped/other${startups.length ? ' <span class="lg tl-boot-lg"></span>worker start-up' : ''} · wall time ${esc(fmtMs(span))} · lanes ${lanes.length}</div>`;
}

// ------------------------------------------------------------------ dependency graph

interface GNode {
  key: string;
  label: string;
  kind: 'scenario' | 'group';
  status: Status;
  layer: number;
  row: number;
}

/**
 * Scenarios that take part in dependencies (@dependsOn) plus groups that depend on / are depended on, laid out left →
 * right by longest path. Edge = "waits for" (arrow points from the prerequisite to the dependent); soft = dashed.
 */
export function renderGraph(
  plan: readonly PlannedScenario[],
  groups: readonly PlannedGroup[],
  statusOf: (id: string) => Status,
  anchor: (id: string) => string,
  maxNodes = 150,
): string {
  const edges: Array<{ from: string; to: string; soft: boolean }> = [];
  const groupKey = (g: string) => `group:${g}`;
  const groupByName = new Map(groups.map((g) => [g.name, g]));
  for (const sc of plan) for (const d of sc.dependsOn ?? []) edges.push({ from: d.id, to: sc.id, soft: d.soft });
  for (const g of groups) for (const dep of g.dependsOn) edges.push({ from: groupKey(dep), to: groupKey(g.name), soft: false });
  if (!edges.length) return '';

  const byId = new Map(plan.map((p) => [p.id, p]));
  const keys = new Set<string>();
  for (const e of edges) keys.add(e.from).add(e.to);
  const groupStatus = (name: string) => worstStatus((groupByName.get(name)?.members ?? []).map(statusOf));
  const nodes = new Map<string, GNode>();
  for (const k of keys) {
    const isGroup = k.startsWith('group:');
    const name = isGroup ? k.slice(6) : (byId.get(k)?.name ?? k);
    nodes.set(k, { key: k, label: isGroup ? `group ${name}` : name, kind: isGroup ? 'group' : 'scenario', status: isGroup ? groupStatus(name) : statusOf(k), layer: 0, row: 0 });
  }
  // longest-path layering (the plan is acyclic; guard anyway)
  for (let pass = 0; pass < nodes.size; pass++) {
    let changed = false;
    for (const e of edges) {
      const a = nodes.get(e.from)!;
      const b = nodes.get(e.to)!;
      if (b.layer < a.layer + 1) {
        b.layer = a.layer + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const all = [...nodes.values()].sort((a, b) => a.layer - b.layer || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  const shown = all.slice(0, maxNodes);
  const shownKeys = new Set(shown.map((n) => n.key));
  const perLayer = new Map<number, number>();
  for (const n of shown) {
    n.row = perLayer.get(n.layer) ?? 0;
    perLayer.set(n.layer, n.row + 1);
  }
  const NW = 190;
  const NH = 26;
  const GX = 60;
  const GY = 12;
  const pos = (n: GNode) => ({ x: 8 + n.layer * (NW + GX), y: 8 + n.row * (NH + GY) });
  const layers = Math.max(...shown.map((n) => n.layer)) + 1;
  const maxRows = Math.max(...perLayer.values());
  const W = 16 + layers * NW + (layers - 1) * GX;
  const H = 16 + maxRows * NH + (maxRows - 1) * GY;

  const edgeSvg = edges
    .filter((e) => shownKeys.has(e.from) && shownKeys.has(e.to))
    .map((e) => {
      const a = pos(nodes.get(e.from)!);
      const b = pos(nodes.get(e.to)!);
      const x1 = a.x + NW;
      const y1 = a.y + NH / 2;
      const x2 = b.x;
      const y2 = b.y + NH / 2;
      const mx = (x1 + x2) / 2;
      return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 4},${y2}" class="g-edge${e.soft ? ' soft' : ''}" marker-end="url(#arrow)"/>`;
    })
    .join('');
  const nodeSvg = shown
    .map((n) => {
      const p = pos(n);
      const label = n.label.length > 28 ? `${n.label.slice(0, 27)}…` : n.label;
      const box = `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="${n.kind === 'group' ? 13 : 4}" class="g-node g-${n.kind} gs-${n.status}"/><text x="${p.x + 10}" y="${p.y + 17}" class="g-label">${esc(label)}</text><title>${esc(
        `${n.label} (${n.key}) · ${n.status}`,
      )}</title>`;
      return n.kind === 'scenario' && byId.has(n.key) ? `<a href="#${anchor(n.key)}" class="tl-link">${box}</a>` : `<g>${box}</g>`;
    })
    .join('');
  const undrawn = plan.filter((p) => !keys.has(p.id)).length;
  const standalone = undrawn ? `<div class="legend">${undrawn} of ${plan.length} scenario${plan.length === 1 ? '' : 's'} ha${undrawn === 1 ? 's' : 've'} no dependencies and ${undrawn === 1 ? 'is' : 'are'} not drawn here.</div>` : '';
  const more = all.length > shown.length ? `<div class="legend">showing ${shown.length} of ${all.length} nodes</div>` : '';
  return `<div class="graph-wrap"><svg class="graph" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Dependency graph">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="g-arrow"/></marker></defs>
${edgeSvg}${nodeSvg}</svg></div>${more}${standalone}
<div class="legend">arrows point from a prerequisite to the scenario/group that waits for it · dashed = soft dependency · rounded = group</div>`;
}

// ------------------------------------------------------------------ history

const DOT: Record<string, string> = { passed: 'h-pass', failed: 'h-fail', flaky: 'h-flaky' };

export function trendDots(trend: ReadonlyArray<Status | 'flaky'>, last = 12): string {
  return `<span class="trend">${trend
    .slice(-last)
    .map((t) => `<i class="${DOT[t] ?? 'h-other'}" title="${esc(t)}"></i>`)
    .join('')}</span>`;
}

/** Per-run pass-rate bars + flakiest scenarios table. `runs` includes the current run (last). */
export function renderHistory(runs: readonly HistoryRun[], anchor: (id: string) => string, inPlan: (id: string) => boolean, top = 10): string {
  if (runs.length < 2) return '';
  const bars = runs
    .slice(-30)
    .map((r) => {
      const all = Object.values(r.scenarios);
      const passed = all.filter((e) => e.s === 'passed').length;
      const rate = all.length ? passed / all.length : 0;
      const h = Math.max(2, Math.round(rate * 40));
      return `<span class="hbar ${r.success ? 'ok' : 'ko'}" style="height:${h}px" title="${esc(
        `${new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 19)} · ${passed}/${all.length} passed · ${fmtMs(r.durationMs)}${r.success ? '' : ' · FAILED'}`,
      )}"></span>`;
    })
    .join('');
  const ids = new Set<string>();
  for (const r of runs) for (const id of Object.keys(r.scenarios)) ids.add(id);
  const ranked = [...ids]
    .map((id) => scenarioHistory(runs, id))
    .filter((h) => h.score > 0 || h.failed > 0)
    .sort((a, b) => b.score - a.score || b.failed - a.failed)
    .slice(0, top);
  const rows = ranked
    .map(
      (h) =>
        `<tr><td class="num">${h.score.toFixed(2)}</td><td>${inPlan(h.id) ? `<a href="#${anchor(h.id)}">${esc(h.name)}</a>` : esc(h.name)}<div class="hid">${esc(h.id)}</div></td><td>${trendDots(h.trend)}</td><td class="num">${h.passed}/${h.runs}</td><td class="num">${h.flaky}</td><td class="num">${esc(fmtMs(h.avgMs))}</td></tr>`,
    )
    .join('');
  return `<div class="hist"><div class="hbars" title="pass rate per run, oldest → newest">${bars}</div><div class="legend">last ${Math.min(30, runs.length)} of ${runs.length} recorded runs (incl. this one) · bar height = pass rate</div></div>${
    rows
      ? `<table class="htable"><thead><tr><th class="num">flaky score</th><th>scenario</th><th>trend</th><th class="num">passed</th><th class="num">flaky</th><th class="num">avg</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="legend">No unstable or failing scenarios in the recorded runs.</div>'
  }`;
}

export const VIEW_CSS = `
.view{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:0 0 14px;padding:4px 12px}
.view>summary{cursor:pointer;font-weight:600;padding:6px 0}
.timeline{width:100%;display:block;font:11px system-ui,sans-serif}
.tl-grid{stroke:var(--line);stroke-width:1}.tl-tick{fill:var(--muted)}.tl-boot{fill:var(--muted);opacity:.35}.lg.tl-boot-lg{background:var(--muted);opacity:.35}
.tl-lane{fill:var(--fg);font-weight:600}.tl-util,.tl-head{fill:var(--muted)}
.tl-bar{stroke:var(--card);stroke-width:.5}.tl-link:hover .tl-bar,.tl-link:hover .g-node{opacity:.75}
.tb-passed{fill:var(--passed)}.tb-failed{fill:var(--failed)}.tb-retried{fill:url(#hatch)}
.tb-skipped,.tb-pending,.tb-undefined,.tb-ambiguous{fill:var(--skipped)}.tl-group{opacity:.55}
.legend{color:var(--muted);font-size:12px;margin:4px 0 8px}.lg{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 3px 0 8px;vertical-align:-1px}
.lg.tb-passed{background:var(--passed)}.lg.tb-failed{background:var(--failed)}.lg.tb-skipped{background:var(--skipped)}
.lg.tb-retried{background:repeating-linear-gradient(45deg,var(--failed) 0 2px,transparent 2px 5px)}
.graph-wrap{overflow:auto;max-height:620px}.graph{font:12px system-ui,sans-serif;display:block}
.g-node{fill:var(--card);stroke-width:2}.g-group{stroke-dasharray:0;fill:var(--bg)}.g-label{fill:var(--fg)}
.gs-passed{stroke:var(--passed)}.gs-failed{stroke:var(--failed)}.gs-skipped,.gs-pending,.gs-undefined,.gs-ambiguous{stroke:var(--skipped)}
.g-edge{fill:none;stroke:var(--muted);stroke-width:1.3}.g-edge.soft{stroke-dasharray:4 3}.g-arrow{fill:var(--muted)}
.hbars{display:flex;align-items:flex-end;gap:3px;height:44px;margin:6px 0 2px}.hbar{width:10px;border-radius:2px 2px 0 0}
.hbar.ok{background:var(--passed)}.hbar.ko{background:var(--failed)}
.htable{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 10px}.htable th{text-align:left;color:var(--muted);font-weight:500;border-bottom:1px solid var(--line);padding:4px 6px}
.htable td{border-bottom:1px solid var(--line);padding:4px 6px;vertical-align:top}.htable .num{text-align:right;white-space:nowrap}.hid{color:var(--muted);font-size:11px}
.trend{display:inline-flex;gap:2px;vertical-align:middle}.trend i{width:8px;height:8px;border-radius:50%;display:inline-block}
.h-pass{background:var(--passed)}.h-fail{background:var(--failed)}.h-flaky{background:var(--pending)}.h-other{background:var(--skipped)}
.pill.fscore{color:var(--pending)}
`;
