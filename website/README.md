# bddr documentation site

Static HTML, no build step. Open `index.html` in a browser, or serve the folder with any static host
(GitHub Pages, Netlify, S3, `npx serve website`).

```
website/
├─ index.html                 landing page
├─ docs/
│  ├─ _template.html          start every new page from this
│  ├─ getting-started.html
│  └─ components.html         every component with its markup: the theme reference
└─ assets/
   ├─ css/theme.css           tokens (colours, type, spacing), layout, components; light and dark
   ├─ js/nav.js               the sidebar: sections and pages, in reading order
   ├─ js/site.js              theme toggle, sidebar, table of contents, code colours, copy buttons, tabs
   ├─ fonts/                  IBM Plex Sans, Sans Condensed, Mono (SIL Open Font License, see LICENSE)
   └─ img/                    favicon; generated diagrams and screenshots go here
```

## Adding a page

Pages are written in `src/<slug>.page` and turned into `docs/<slug>.html` by a small script (an authoring aid; the site
itself still needs no build, and the generated HTML is committed):

```bash
node tools/build-pages.mjs            # all pages
node tools/build-pages.mjs groups     # one page
```

A `.page` file has a header (`title`, `section`, `desc`, `lede`), a line with `---`, then the page body in HTML. Code goes in
`<cb lang="ts" title="path">…</cb>`: write the code as it is, with no escaping. `h2`/`h3` get ids automatically, and the script
sets `ready: true` for the page in `assets/js/nav.js`. Build content only from what `docs/components.html` shows. The sidebar,
"On this page", heading anchors and Previous/Next links are generated in the browser.

`getting-started.html`, `components.html`, `_template.html` and `index.html` are hand-written HTML (not from `src/`).
To add a page by hand instead: copy `docs/_template.html`, edit it, and set `ready: true` in `nav.js`.

## Images

Pages show a placeholder where an image belongs (`figure.placeholder`):
- `data-kind="ai"`: a diagram or illustration. The caption has a prompt for an AI image tool and the file name.
- `data-kind="screenshot"`: a real screenshot (report, terminal, IDE). The caption says what to run and capture.

When the image exists, save it under `assets/img/` and replace the placeholder with
`<figure><img src="../assets/img/name.png" alt="what it shows"><figcaption>…</figcaption></figure>`.
