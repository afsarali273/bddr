/**
 * Living documentation: the spec folder tree rendered as one offline HTML page.
 * Folders are requirement areas (their README.md is the introduction), features are requirements,
 * scenarios are the examples. Optional run results colour every scenario and roll up per folder.
 *
 * Pure rendering: the CLI collects the data (`bddr docs`). Safe by construction: all text is escaped,
 * Markdown links only allow http(s), mailto and relative targets.
 */
import type { Status, StepArgument } from '@bddr/core';

export interface DocsScenario {
  id: string;
  name: string;
  keyword: string;
  line: number;
  rule?: string;
  tags: string[];
  steps: Array<{ keyword: string; text: string; arg?: StepArgument }>;
  /** Outline row values. */
  example?: Record<string, string>;
  status?: Status | 'flaky';
  durationMs?: number;
}

export interface DocsFeature {
  uri: string;
  name: string;
  description: string;
  tags: string[];
  scenarios: DocsScenario[];
}

export interface DocsInput {
  title: string;
  generatedAt: number;
  features: DocsFeature[];
  /** Folder path ('' = root, 'features/checkout') -> README.md source. */
  readmes: Record<string, string>;
  /** Where the statuses came from, shown in the header (e.g. the events file). */
  resultsSource?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Small, safe Markdown: headings, paragraphs, lists, fenced code, quotes, **bold**, *italic*, `code`, [links](url). */
export function renderMarkdown(src: string): string {
  const inline = (t: string): string =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
        const raw = url.replace(/&amp;/g, '&');
        const ok = /^(https?:|mailto:|#|\.{0,2}\/|[\w.-]+(\/|$))/i.test(raw) && !/^\s*(javascript|data|vbscript):/i.test(raw);
        return ok ? `<a href="${url}" rel="noopener noreferrer"${/^https?:/i.test(raw) ? ' target="_blank"' : ''}>${text}</a>` : text;
      });
  const out: string[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) {
      i++;
    } else if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/^#+/)![0].length + 1, 6); // page title is h1
      out.push(`<h${level}>${inline(line.replace(/^#+\s+/, ''))}</h${level}>`);
      i++;
    } else if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/).test(lines[i]!)) {
        items.push(`<li>${inline(lines[i]!.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    } else {
      const buf: string[] = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]!) && !/^(```|#{1,6}\s|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]!)) buf.push(lines[i++]!);
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  features: DocsFeature[];
}

function buildTree(features: DocsFeature[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], features: [] };
  for (const f of features) {
    const parts = f.uri.split('/').slice(0, -1);
    let node = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.folders.find((x) => x.path === path);
      if (!child) {
        child = { name: p, path, folders: [], features: [] };
        node.folders.push(child);
      }
      node = child;
    });
    node.features.push(f);
  }
  const sort = (n: Folder) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.features.sort((a, b) => a.uri.localeCompare(b.uri));
    n.folders.forEach(sort);
  };
  sort(root);
  // Collapse single-child chains at the top ("features/" only) so the tree starts at real areas.
  let top = root;
  while (!top.features.length && top.folders.length === 1) top = top.folders[0]!;
  return top === root ? root : { ...top, name: top.name, path: top.path };
}

type Counts = Record<'passed' | 'failed' | 'skipped' | 'pending' | 'undefined' | 'ambiguous' | 'flaky' | 'notrun', number>;
const zero = (): Counts => ({ passed: 0, failed: 0, skipped: 0, pending: 0, undefined: 0, ambiguous: 0, flaky: 0, notrun: 0 });
const ORDER: Array<keyof Counts> = ['passed', 'flaky', 'failed', 'ambiguous', 'undefined', 'pending', 'skipped', 'notrun'];
const LABEL: Record<keyof Counts, string> = { passed: 'passed', flaky: 'flaky', failed: 'failed', ambiguous: 'ambiguous', undefined: 'undefined', pending: 'pending', skipped: 'skipped', notrun: 'no result' };

function countOf(features: DocsFeature[]): Counts {
  const c = zero();
  for (const f of features) for (const s of f.scenarios) c[s.status ?? 'notrun']++;
  return c;
}
const allFeatures = (n: Folder): DocsFeature[] => [...n.features, ...n.folders.flatMap(allFeatures)];
const total = (c: Counts) => ORDER.reduce((a, k) => a + c[k], 0);

function bar(c: Counts): string {
  const t = total(c) || 1;
  return `<span class="bar" role="img" aria-label="${esc(ORDER.filter((k) => c[k]).map((k) => `${c[k]} ${LABEL[k]}`).join(', '))}">${ORDER.filter((k) => c[k])
    .map((k) => `<i class="s-${k}" style="width:${((c[k] / t) * 100).toFixed(2)}%"></i>`)
    .join('')}</span>`;
}
function pills(c: Counts): string {
  return ORDER.filter((k) => c[k] && !(k === 'notrun' && total(c) === c[k])).map((k) => `<span class="pill s-${k}">${c[k]} ${LABEL[k]}</span>`).join('');
}

function renderArg(arg: StepArgument): string {
  if (arg.kind === 'dataTable') {
    const [head, ...body] = arg.rows;
    if (!head) return '';
    return `<div class="tw"><table class="argtable"><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
  }
  return `<pre class="doc">${esc(arg.content)}</pre>`;
}

function renderScenario(s: DocsScenario, key: string): string {
  const st = s.status ?? 'notrun';
  const text = `${s.name} ${s.tags.join(' ')} ${s.steps.map((x) => x.text).join(' ')}`.toLowerCase();
  return `<details class="sc s-${st}" data-text="${esc(text)}" data-status="${st}" id="${key}">
<summary><span class="dot s-${st}" title="${LABEL[st]}"></span><span class="kw">${esc(s.keyword)}</span> <span class="nm">${esc(s.name)}</span>${s.rule ? ` <span class="rule">${esc(s.rule)}</span>` : ''}${s.tags.map((t) => `<button class="tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}${s.durationMs !== undefined ? `<span class="dur">${s.durationMs < 1000 ? `${Math.round(s.durationMs)} ms` : `${(s.durationMs / 1000).toFixed(1)} s`}</span>` : ''}</summary>
${s.example ? `<div class="ex">${Object.entries(s.example).map(([k, v]) => `<span><b>${esc(k)}</b> ${esc(v)}</span>`).join('')}</div>` : ''}
<ol class="steps">${s.steps.map((x) => `<li><span class="skw">${esc(x.keyword.trim())}</span> ${esc(x.text)}${x.arg ? renderArg(x.arg) : ''}</li>`).join('')}</ol>
</details>`;
}

export function renderLivingDocs(input: DocsInput): string {
  const tree = buildTree(input.features);
  const sections: string[] = [];
  /** The top folder is the project: its README title, else the page title. Other folders: README title, else the folder name. */
  const label = (n: Folder): string => titleOf(input.readmes[n.path], n === tree ? input.title : n.name);
  let seq = 0;
  const hasResults = input.features.some((f) => f.scenarios.some((s) => s.status));

  const navFolder = (n: Folder, depth: number): { nav: string; id: string } => {
    const id = `d${seq++}`;
    const inner: string[] = [];
    const c = countOf(allFeatures(n));
    const fnav = n.features.map((f) => {
      const fid = `f${seq++}`;
      const fc = countOf([f]);
      sections.push(
        `<section id="${fid}" class="page" hidden><nav class="crumbs">${crumbs(f.uri)}</nav><h1>${esc(f.name)}</h1>${f.tags.length ? `<p>${f.tags.map((t) => `<button class="tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</p>` : ''}<p class="src">${esc(f.uri)}</p>${f.description ? `<div class="md">${renderMarkdown(f.description.trim())}</div>` : ''}<div class="summary">${bar(fc)}<span class="pills">${pills(fc)}</span></div>${groupByRule(f, fid)}</section>`,
      );
      return `<a class="nav f" href="#${fid}" data-id="${fid}" data-text="${esc(`${f.name} ${f.uri}`.toLowerCase())}"><span class="dot s-${worst(fc)}"></span>${esc(f.name)}<span class="n">${f.scenarios.length}</span></a>`;
    });
    const dnav = n.folders.map((d) => navFolder(d, depth + 1).nav);
    inner.push(...dnav, ...fnav);
    const readme = input.readmes[n.path];
    sections.push(
      `<section id="${id}" class="page" hidden><nav class="crumbs">${crumbs(n.path ? `${n.path}/x` : '')}</nav><h1>${esc(label(n))}</h1><div class="summary">${bar(c)}<span class="pills">${pills(c)}</span></div>${readme ? `<div class="md">${renderMarkdown(stripTitle(readme))}</div>` : ''}${listChildren(n)}</section>`,
    );
    return {
      id,
      nav: `<details class="dir"${depth < 1 ? ' open' : ''}><summary><a class="nav d" href="#${id}" data-id="${id}"><span class="dot s-${worst(c)}"></span>${esc(label(n))}<span class="n">${total(c)}</span></a></summary>${inner.join('')}</details>`,
    };
  };

  function listChildren(n: Folder): string {
    const items = [
      ...n.folders.map((d) => `<li><a data-go="${esc(d.path)}" href="#">${esc(titleOf(input.readmes[d.path], d.name))}</a> <span class="muted">${total(countOf(allFeatures(d)))} scenarios</span></li>`),
      ...n.features.map((f) => `<li><a data-go="${esc(f.uri)}" href="#">${esc(f.name)}</a> <span class="muted">${f.scenarios.length} scenarios</span></li>`),
    ];
    return items.length ? `<h2>Contents</h2><ul class="contents">${items.join('')}</ul>` : '';
  }
  function groupByRule(f: DocsFeature, fid: string): string {
    const groups = new Map<string, DocsScenario[]>();
    for (const s of f.scenarios) groups.set(s.rule ?? '', [...(groups.get(s.rule ?? '') ?? []), s]);
    let n = 0;
    return [...groups.entries()]
      .map(([rule, list]) => `${rule ? `<h2 class="rulehead">Rule: ${esc(rule)}</h2>` : ''}${list.map((s) => renderScenario(s, `${fid}-s${n++}`)).join('')}`)
      .join('');
  }
  const crumbs = (path: string) => {
    const parts = path.split('/').slice(0, -1).filter(Boolean);
    return [`<a data-go="" href="#">${esc(input.title)}</a>`, ...parts.map((p, i) => `<a data-go="${esc(parts.slice(0, i + 1).join('/'))}" href="#">${esc(p)}</a>`)].join(' / ');
  };
  const titleOf = (readme: string | undefined, fallback: string): string => {
    const m = readme ? /^#\s+(.+)$/m.exec(readme) : null;
    return m ? m[1]!.trim() : fallback;
  };
  const stripTitle = (readme: string) => readme.replace(/^\s*#\s+.+\n?/, '');
  const worst = (c: Counts): string => (c.failed || c.ambiguous ? 'failed' : c.undefined || c.pending ? 'pending' : c.flaky ? 'flaky' : c.passed && !c.notrun ? 'passed' : c.passed ? 'passed' : 'notrun');

  const { nav } = navFolder(tree, 0);
  // Path -> section id map for in-page links (folder README listings and breadcrumbs).
  const ids: Record<string, string> = {};
  const walk = (n: Folder) => {
    ids[n.path] = [...sections].find((s) => s.includes(`<h1>${esc(label(n))}</h1>`))?.match(/id="([^"]+)"/)?.[1] ?? '';
    n.folders.forEach(walk);
    for (const f of n.features) ids[f.uri] = [...sections].find((s) => s.includes(`<p class="src">${esc(f.uri)}</p>`))?.match(/id="([^"]+)"/)?.[1] ?? '';
  };
  walk(tree);
  ids[''] = ids[tree.path] ?? '';
  const all = countOf(input.features);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}: living documentation</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--mut:#656d76;--line:#d8dee4;--card:#f6f8fa;--link:#0969da;--passed:#1a7f37;--failed:#cf222e;--skipped:#8c959f;--pending:#bf8700;--undefined:#bf8700;--ambiguous:#bc4c00;--flaky:#8250df;--notrun:#afb8c1}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8d96a0;--line:#30363d;--card:#161b22;--link:#58a6ff;--passed:#3fb950;--failed:#f85149;--skipped:#6e7681;--pending:#d29922;--undefined:#d29922;--ambiguous:#db6d28;--flaky:#a371f7;--notrun:#484f58}}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
a{color:var(--link)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
.layout{display:grid;grid-template-columns:320px minmax(0,1fr);min-height:100vh}
aside{border-right:1px solid var(--line);background:var(--card);position:sticky;top:0;height:100vh;overflow:auto;padding:12px}
aside input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.nav{display:flex;gap:8px;align-items:center;padding:5px 6px;border-radius:6px;color:var(--fg);text-decoration:none}.nav:hover{background:rgba(128,128,128,.14)}.nav.cur{background:rgba(9,105,218,.16);font-weight:600}
.nav .n{margin-left:auto;color:var(--mut);font-size:.8em}.dir>summary{list-style:none;cursor:pointer}.dir>summary::-webkit-details-marker{display:none}.dir>:not(summary){margin-left:14px}
.dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block;background:var(--notrun)}
.s-passed.dot,.dot.s-passed{background:var(--passed)}.dot.s-failed{background:var(--failed)}.dot.s-skipped{background:var(--skipped)}.dot.s-pending,.dot.s-undefined{background:var(--pending)}.dot.s-ambiguous{background:var(--ambiguous)}.dot.s-flaky{background:var(--flaky)}
main{padding:24px 32px 80px;max-width:1000px;width:100%}h1{margin:.2em 0 .3em;font-size:1.8em}h2{margin:1.4em 0 .4em;font-size:1.2em}
.crumbs,.src,.muted{color:var(--mut);font-size:.88em}.crumbs a{color:var(--mut)}
.summary{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:10px 0 18px}.bar{display:flex;height:8px;min-width:160px;flex:0 1 260px;border-radius:4px;overflow:hidden;background:var(--line)}.bar i{display:block}
.bar .s-passed{background:var(--passed)}.bar .s-failed{background:var(--failed)}.bar .s-skipped{background:var(--skipped)}.bar .s-pending,.bar .s-undefined{background:var(--pending)}.bar .s-ambiguous{background:var(--ambiguous)}.bar .s-flaky{background:var(--flaky)}.bar .s-notrun{background:var(--notrun)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:.8em;margin-right:6px}
.pill.s-passed{color:var(--passed)}.pill.s-failed{color:var(--failed)}.pill.s-flaky{color:var(--flaky)}.pill.s-pending,.pill.s-undefined{color:var(--pending)}.pill.s-ambiguous{color:var(--ambiguous)}
.md{margin:.5em 0 1em}.md pre,pre.doc{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto}.md blockquote{border-left:3px solid var(--line);margin:0;padding:0 12px;color:var(--mut)}
.sc{border:1px solid var(--line);border-left:4px solid var(--notrun);border-radius:6px;margin:8px 0;background:var(--bg)}
.sc.s-passed{border-left-color:var(--passed)}.sc.s-failed{border-left-color:var(--failed)}.sc.s-skipped{border-left-color:var(--skipped)}.sc.s-pending,.sc.s-undefined{border-left-color:var(--pending)}.sc.s-ambiguous{border-left-color:var(--ambiguous)}.sc.s-flaky{border-left-color:var(--flaky)}
.sc>summary{cursor:pointer;padding:9px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.kw{color:var(--mut)}.nm{font-weight:600}.rule{color:var(--mut);font-size:.85em}.dur{margin-left:auto;color:var(--mut);font-size:.8em}
.tag{border:1px solid var(--line);background:var(--card);color:var(--mut);border-radius:999px;padding:0 8px;font:inherit;font-size:.78em;cursor:pointer}.tag:hover{color:var(--link)}
.ex{display:flex;gap:8px;flex-wrap:wrap;padding:0 12px 6px;font-size:.85em;color:var(--mut)}.ex span{background:var(--card);border-radius:4px;padding:1px 8px}.ex b{color:var(--fg);font-weight:600;margin-right:4px}
.steps{margin:0;padding:4px 12px 12px 36px;list-style:none}.steps li{padding:2px 0}.skw{color:var(--link);font-weight:600;margin-right:4px}.tw{overflow-x:auto;margin:4px 0}
.argtable{border-collapse:collapse;font-size:.9em}.argtable th,.argtable td{border:1px solid var(--line);padding:2px 10px;text-align:left;white-space:nowrap}.argtable th{background:var(--card)}
.contents{padding-left:20px}.rulehead{border-bottom:1px solid var(--line);padding-bottom:4px}
#results h2{margin-top:0}.hit{display:block;padding:6px 8px;border-radius:6px;text-decoration:none;color:var(--fg)}.hit:hover{background:var(--card)}
.top{display:none}
@media(max-width:860px){.layout{grid-template-columns:1fr}aside{position:static;height:auto;max-height:46vh;border-right:0;border-bottom:1px solid var(--line)}main{padding:16px}.dur{margin-left:0}}
@media print{aside,.top{display:none}.layout{display:block}.page[hidden]{display:block!important}.sc:not([open])>*:not(summary){display:block}main{max-width:none}}
</style></head><body>
<div class="layout"><aside><input id="q" type="search" placeholder="Search scenarios, steps, tags…" aria-label="Search"><p class="muted" style="margin:8px 4px">${input.features.length} features · ${total(all)} scenarios${hasResults ? ` · ${all.passed + all.flaky} passing` : ' · no results loaded'}</p>${nav}</aside>
<main><div id="results" hidden></div><div id="pages">${sections.join('\n')}</div>
<p class="muted">Generated ${esc(new Date(input.generatedAt).toISOString().slice(0, 16).replace('T', ' '))} UTC by bddr${input.resultsSource ? ` · results from ${esc(input.resultsSource)}` : ''}</p></main></div>
<script>
(function(){
var IDS=${JSON.stringify(ids).replace(/</g, '\\u003c')};
var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var pages=$$('.page'),navs=$$('a.nav'),q=$('#q'),res=$('#results');
function show(id){
  if(!id||!document.getElementById(id))id=IDS['']||pages[0].id;
  pages.forEach(function(p){p.hidden=p.id!==id});
  navs.forEach(function(a){a.classList.toggle('cur',a.getAttribute('data-id')===id)});
  var p=document.getElementById(id);if(p){var d=p.querySelector('.sc:target');if(d)d.open=true}
  window.scrollTo(0,0);
}
function route(){
  var h=location.hash.slice(1),m=/^(f\\d+)-s\\d+$/.exec(h);
  if(m){show(m[1]);var s=document.getElementById(h);if(s){s.open=true;s.scrollIntoView({block:'center'})}}else show(h);
  q.value='';search();
}
function search(){
  var t=q.value.trim().toLowerCase();
  if(!t){res.hidden=true;$('#pages').hidden=false;navs.forEach(function(a){a.hidden=false});return}
  var hits=$$('.sc').filter(function(s){return s.getAttribute('data-text').indexOf(t)>=0});
  $('#pages').hidden=true;res.hidden=false;
  res.innerHTML='<h2>'+hits.length+' scenario'+(hits.length===1?'':'s')+' match “'+t.replace(/[<&]/g,'')+'”</h2>'+hits.slice(0,200).map(function(s){
    var pg=s.closest('.page');return '<a class="hit" href="#'+s.id+'"><span class="dot s-'+s.getAttribute('data-status')+'"></span> '+s.querySelector('.nm').innerHTML+' <span class="muted">'+pg.querySelector('h1').textContent+'</span></a>'}).join('');
}
q.addEventListener('input',search);
document.addEventListener('click',function(e){
  var t=e.target.closest&&e.target.closest('.tag');
  if(t){q.value=t.getAttribute('data-tag');search();e.preventDefault();return}
  var g=e.target.closest&&e.target.closest('[data-go]');
  if(g){e.preventDefault();var id=IDS[g.getAttribute('data-go')];if(id)location.hash=id}
});
window.addEventListener('hashchange',route);route();
})();
</script></body></html>`;
}
