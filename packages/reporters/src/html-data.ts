/**
 * HTML report: data-driven scenarios (Examples tables, CSV / Excel / JSON rows from @data) as colour-coded table
 * rows, and step arguments (data tables, doc strings) as styled tables. Pure functions used by html.ts.
 *
 * Design: every example row stays an ordinary scenario card (so filters, permalinks, timeline links and the n/p
 * shortcuts keep working), but its summary line is laid out as a table row whose columns are the data parameters.
 * Rows of one outline / data source are wrapped in a "dataset" with a header that shows the source, the pass/fail
 * counts and a status bar.
 */
import type { PlannedScenario, Status, StepArgument } from '@bddr/core';
import { esc, fmtMs } from './html-views.js';
import { stackBar, STATUSES, zeroCounts } from './html-stats.js';

/** Datasets with more parameters than this scroll horizontally on every screen size. */
export const WIDE_COLUMNS = 5;

export interface Dataset {
  key: string;
  rows: PlannedScenario[];
  /** Parameter names, in order of first appearance across the rows. */
  columns: string[];
  title: string;
  /** The outline's steps with the row values turned back into <placeholders>. */
  templateSteps: string[];
  /** Data file (with sheet/selector) or "Examples: <block name>". */
  source: string;
  fromFile: boolean;
  /** Many columns: keep the table layout and scroll sideways (also on phones) instead of stacking each row. */
  wide: boolean;
  /** CSS grid-template-columns shared by the header and every row. */
  template: string;
  minWidth: number;
}

/** Scenario id without its trailing `[row]` suffix (outline rows are `<base>[<row>]`). */
export const baseId = (id: string): string => id.replace(/\[[^\]]*\]$/, '');

/** "Totals for 2 apples" + {qty:'2', item:'apples'} -> "Totals for <qty> <item>". Best effort, whole-word only. */
function deriveTitle(name: string, values: Record<string, string>): string {
  let out = name;
  const entries = Object.entries(values)
    .filter(([, v]) => v.trim().length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [k, v] of entries) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(^|[^\\w])' + escaped + '(?![\\w])', 'g'), '$1<' + k + '>');
  }
  return out;
}

/** Datasets by scenario id. Every outline row / data row belongs to exactly one dataset. */
export function buildDatasets(plan: readonly PlannedScenario[]): Map<string, Dataset> {
  const groups = new Map<string, PlannedScenario[]>();
  for (const sc of plan) {
    if (!sc.example) continue;
    const key = `${sc.uri}|${baseId(sc.id)}|${sc.example.name}`; // one table per Examples block
    groups.set(key, [...(groups.get(key) ?? []), sc]);
  }
  const byScenario = new Map<string, Dataset>();
  for (const [key, rows] of groups) {
    const columns: string[] = [];
    for (const r of rows) for (const c of Object.keys(r.example!.values)) if (!columns.includes(c)) columns.push(c);
    const first = rows[0]!.example!;
    const fromFile = !!first.source;
    const title = deriveTitle(rows[0]!.name, first.values);
    const ds: Dataset = {
      key,
      rows,
      columns,
      title,
      templateSteps: rows[0]!.steps.map((st) => `${st.keyword}${deriveTitle(st.text, first.values)}`),
      source: fromFile ? first.source! : `Examples${first.name ? `: ${first.name}` : ''}`,
      fromFile,
      wide: columns.length > WIDE_COLUMNS,
      template: ['78px', ...columns.map(() => 'minmax(90px,1fr)'), '100px', '130px', '26px'].join(' '),
      minWidth: 140 + columns.length * 100 + 270,
    };
    for (const r of rows) byScenario.set(r.id, ds);
  }
  return byScenario;
}

/** Escapes text and highlights <placeholder> tokens. */
function withPlaceholders(text: string): string {
  return esc(text).replace(/&lt;([^&\s]+?)&gt;/g, '<code class="ph">&lt;$1&gt;</code>');
}

/** Header strip + column titles. `statusOf` / `durationOf` give each row's final status and duration. */
export function renderDatasetOpen(ds: Dataset, statusOf: (id: string) => Status, durationOf: (id: string) => number): string {
  const counts = zeroCounts();
  let total = 0;
  for (const r of ds.rows) {
    counts[statusOf(r.id)]++;
    total += durationOf(r.id);
  }
  const pills = STATUSES.filter((s) => counts[s] > 0)
    .map((s) => `<span class="pill st-${s}">${counts[s]} ${s}</span>`)
    .join('');
  const heads = ds.columns.map((c) => `<span class="dc" title="${esc(c)}">${esc(c)}</span>`).join('');
  return `<section class="dataset"><div class="dset-head"><span class="dset-ico" aria-hidden="true">▦</span><b class="dset-title">${withPlaceholders(ds.title)}</b><span class="chip src" title="${ds.fromFile ? 'data source' : 'examples block'}">${ds.fromFile ? '📄 ' : ''}${esc(ds.source)}</span><span class="dset-n">${ds.rows.length} row${ds.rows.length === 1 ? '' : 's'}${ds.wide ? ` · ${ds.columns.length} columns` : ''}</span>${ds.wide ? '<span class="dset-scroll" title="scroll sideways to see all columns">↔ scroll sideways</span>' : ''}<span class="dset-pills">${pills}</span><span class="dset-bar">${stackBar(counts, ds.rows.length)}</span><span class="dset-time">${esc(fmtMs(total))}</span></div>
<details class="dtemplate"><summary>Scenario template</summary><ol>${ds.templateSteps.map((t) => `<li>${withPlaceholders(t)}</li>`).join('')}</ol></details>
<div class="dgrid${ds.wide ? ' wide' : ''}" style="--tpl:${ds.template};--minw:${ds.minWidth}px"><div class="dhead"><span class="pin"><span></span><span class="dc dc-row" title="${ds.fromFile ? 'row in the data file' : 'row in the examples'}">#</span></span>${heads}<span></span><span class="dc">time</span><span></span></div>`;
}

export const renderDatasetClose = (): string => '</div></section>';

/** A step's data table or doc string. The status colours the table so a failing step's data stands out. */
export function renderArg(arg: StepArgument | undefined, status: Status): string {
  if (!arg) return '';
  if (arg.kind === 'docString') {
    return `<div class="docstring" style="--st:var(--${status})">${arg.mediaType ? `<span class="dmt">${esc(arg.mediaType)}</span>` : ''}<pre>${esc(arg.content.slice(0, 20_000))}</pre></div>`;
  }
  const [head, ...body] = arg.rows;
  if (!head) return '';
  const hasHeader = body.length > 0;
  const cells = (row: string[], tag: 'th' | 'td') => `<tr>${row.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`;
  return `<div class="argwrap"><table class="argtable" style="--st:var(--${status})">${hasHeader ? `<thead>${cells(head, 'th')}</thead><tbody>${body.map((r) => cells(r, 'td')).join('')}</tbody>` : `<tbody>${cells(head, 'td')}</tbody>`}</table></div>`;
}

export const DATA_CSS = `
.dataset{margin:10px 0 14px;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:var(--shadow);overflow:hidden}
.dset-head{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--line)}
.dset-ico{color:var(--accent)}.dset-title{font-size:14px}.dset-n,.dset-time{color:var(--muted);font-size:12px}.dset-pills .pill{margin:0 0 0 4px;cursor:default}
.dset-bar{width:140px}.dset-bar .sbar{min-width:0}.dset-time{margin-left:auto}.chip.src{border-color:var(--accent);color:var(--accent)}
.dtemplate{padding:4px 12px;border-bottom:1px solid var(--line);font-size:13px}.dtemplate summary{cursor:pointer;color:var(--muted);font-size:12px}.dtemplate ol{margin:4px 0 4px 18px;padding:0;list-style:none}.dtemplate li{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;padding:1px 0}
.ph{background:color-mix(in srgb,var(--accent) 14%,var(--card));color:var(--accent);border-radius:4px;padding:0 4px;font-size:.95em}
.dgrid{overflow-x:auto;padding:8px 8px 8px}
.dset-scroll{font-size:11px;color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:0 8px}
/* wide data sets: always scroll sideways, keep the status icon and row number pinned, visible scrollbar */
.dgrid.wide{scrollbar-width:thin}.dgrid.wide::-webkit-scrollbar{height:10px}.dgrid.wide::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}.dgrid.wide::-webkit-scrollbar-thumb:hover{background:var(--muted)}
.pin{display:flex;gap:10px;align-items:baseline;min-width:0}.pin .dc-row{width:46px;flex:none}.pin>:first-child{width:22px;flex:none}
.dgrid.wide{padding-left:0;padding-right:0}
.dgrid.wide .pin{position:sticky;left:0;z-index:2;background:inherit;padding:2px 10px 2px 14px;margin:-2px -10px -2px -14px;width:auto}
.dgrid.wide .dhead{background:var(--card);z-index:3}.dgrid.wide .dhead .pin{background:var(--card)}
.dgrid.wide .dc-err{grid-column:1/-1;position:sticky;left:14px;max-width:calc(100vw - 64px);width:max-content}
.dgrid.wide>details>.body{position:sticky;left:14px;max-width:min(calc(100vw - 56px),1300px)}
.dhead,.dgrid>details.scenario>summary{display:grid;grid-template-columns:var(--tpl);column-gap:10px;align-items:center}
.dhead{min-width:var(--minw);padding:6px 10px 6px 14px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;position:sticky;top:0}
.dgrid>details.scenario{min-width:var(--minw);margin:3px 0}
.dgrid>details.scenario>summary{padding:6px 10px}
.dc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dgrid summary .dc-row{color:var(--muted);font-size:12px}.dgrid summary .dc-flags{overflow:hidden}.dgrid summary .dc-flags .pill{margin:0 4px 0 0}
.dgrid summary .meta{margin-left:0;text-align:right}.dgrid summary .perma{justify-self:end}
.dc-err{grid-column:2/-1;color:var(--failed);font-size:12px;white-space:normal;overflow-wrap:anywhere;margin-top:-2px}
.dgrid details.scenario>summary{background:color-mix(in srgb,var(--passed) 5%,var(--card))}
${(['failed', 'skipped', 'pending', 'undefined', 'ambiguous'] as const).map((st) => `.dgrid details.scenario.st-${st}>summary{background:color-mix(in srgb,var(--${st}) 10%,var(--card))}`).join('\n')}
.dgrid details.scenario[open]>summary{border-bottom:1px solid var(--line)}
.argwrap{margin:4px 0 4px 22px;overflow-x:auto;max-width:100%;scrollbar-width:thin}.argwrap::-webkit-scrollbar{height:10px}.argwrap::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}
.argtable{border-collapse:collapse;font-size:12.5px;border-left:3px solid var(--st)}
.argtable th,.argtable td{border:1px solid var(--line);padding:3px 12px;text-align:left;white-space:nowrap}
.argtable th{background:color-mix(in srgb,var(--st) 14%,var(--card));font-weight:600}.argtable td{background:color-mix(in srgb,var(--st) 6%,var(--card))}
.docstring{margin:4px 0 4px 22px;border-left:3px solid var(--st)}.docstring pre{margin:0;border-left:0;border-radius:0 6px 6px 0}.dmt{display:inline-block;font-size:11px;color:var(--muted);padding:0 8px}
`;
