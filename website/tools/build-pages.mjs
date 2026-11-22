#!/usr/bin/env node
/*
 * Authoring aid. Turns website/src/<slug>.page into docs/<slug>.html using docs/_template.html,
 * and marks the page ready in assets/js/nav.js. The generated HTML is committed; the site itself
 * needs no build. Usage: node tools/build-pages.mjs [slug ...]   (no slug = all pages)
 *
 * Source format:
 *   title: Page title
 *   section: Section name          (breadcrumb)
 *   desc: One sentence for <meta description>
 *   lede: One or two sentences under the title
 *   ---
 *   <body html>  h2/h3 get ids automatically.
 *   <cb lang="ts" title="path">raw code, no escaping needed</cb>   -> code-block figure
 *   <include src="diagrams/name.html"/>   -> inlines src/diagrams/name.html (made by tools/arch-diagrams.mjs)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(root, 'docs/_template.html'), 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Indent for readability, but never inside <pre> (it would change the code).
const indent = (html) => html.split(/(<pre[\s\S]*?<\/pre>)/).map((part, i) => (i % 2 ? part : part.split('\n').map((l, j) => (j === 0 || !l ? l : '        ' + l)).join('\n'))).join('');

const wanted = process.argv.slice(2);
const files = readdirSync(join(root, 'src')).filter((f) => f.endsWith('.page')).filter((f) => !wanted.length || wanted.includes(f.replace('.page', '')));
const built = [];
for (const file of files) {
  const slug = file.replace('.page', '');
  const [head, ...rest] = readFileSync(join(root, 'src', file), 'utf8').split(/^---\n/m);
  const meta = Object.fromEntries(head.trim().split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  let body = rest.join('---\n');
  body = body.replace(/<cb(?: lang="([^"]*)")?(?: title="([^"]*)")?>\n?([\s\S]*?)\n?<\/cb>/g, (_, lang = 'ts', title, code) =>
    `<figure class="code-block"${title ? ` data-title="${esc(title)}"` : ''}><pre><code class="lang-${lang}">${esc(code)}</code></pre></figure>`);
  body = body.replace(/<include src="([^"]+)"\s*\/>/g, (_, f) => readFileSync(join(root, 'src', f), 'utf8').trim());
  const used = new Set();
  body = body.replace(/<(h[23])(?![^>]*\sid=)([^>]*)>([\s\S]*?)<\/\1>/g, (_, tag, attrs, inner) => {
    let id = slugify(inner) || 'section'; let n = 2; const base = id;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return `<${tag} id="${id}"${attrs}>${inner}</${tag}>`;
  });
  const article = `<article class="doc-content">
        <p class="breadcrumb"><a href="../index.html">bddr</a> / ${meta.section}</p>
        <h1>${meta.title}</h1>
        <p class="lede">${meta.lede}</p>

${indent(body.trim())}

        <nav class="pager" aria-label="Previous and next page"></nav>
      </article>`;
  let html = template.replace(/<article class="doc-content">[\s\S]*<\/article>/, () => article);
  html = html.replace('<title>Page title | bddr</title>', `<title>${meta.title} | bddr</title>`)
    .replace('One sentence: what this page helps the reader do.', meta.desc.replace(/"/g, '&quot;'));
  writeFileSync(join(root, 'docs', `${slug}.html`), html);
  built.push(slug);
}
const navPath = join(root, 'assets/js/nav.js');
let nav = readFileSync(navPath, 'utf8');
for (const slug of built) nav = nav.replace(new RegExp(`(href: 'docs/${slug}\\.html', ready: )false`), '$1true');
writeFileSync(navPath, nav);
console.log(`built ${built.length}: ${built.join(', ')}`);
