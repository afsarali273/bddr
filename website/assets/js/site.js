/*
 * bddr docs: behaviour shared by every page. No dependencies, works from file:// and any static host.
 *   - theme toggle (light / dark, remembered)
 *   - sidebar from nav.js, mobile menu, Previous / Next links
 *   - "On this page" table of contents with the current section marked, heading anchors
 *   - code blocks: title bar, syntax colours (ts, js, gherkin, bash, powershell, json, html), copy button
 *   - tabs (macOS / Windows ...) kept in sync across a page and remembered
 *   - copy buttons on AI prompts in image placeholders
 * Each page sets <body data-root="../"> (or "") so links can be built from the site root.
 */
(function () {
  'use strict';
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: fine */ } },
  };
  var root = document.body.getAttribute('data-root') || '';
  var here = location.pathname.replace(/\\/g, '/');

  /* ---------- syntax colours: small tokenizers, enough for docs ---------- */
  var LABELS = { ts: 'TypeScript', js: 'JavaScript', gherkin: 'Gherkin', bash: 'Terminal', powershell: 'PowerShell', json: 'JSON', html: 'HTML', text: '' };
  var JS_KW = 'import|from|export|default|const|let|var|function|return|async|await|if|else|for|of|in|new|class|extends|implements|interface|type|this|throw|try|catch|finally|static|private|readonly|public|as|typeof|keyof|declare|module|while|switch|case|break|continue';
  var RULES = {
    ts: [
      ['com', /\/\/[^\n]*|\/\*[\s\S]*?\*\//],
      ['str', /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/],
      ['tag', /@[A-Za-z]\w*/],
      ['key', new RegExp('\\b(?:' + JS_KW + ')\\b')],
      ['kw2', /\b(?:true|false|null|undefined|void|number|string|boolean|unknown|never|any|Promise)\b/],
      ['num', /\b\d[\d_]*(?:\.\d+)?\b/],
      ['fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/],
    ],
    gherkin: [
      ['com', /(?<=^[ \t]*)#[^\n]*/],
      ['tag', /(?<=^[ \t]*|[ \t])@[^\s]+/],
      ['key', /(?<=^[ \t]*)(?:Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios):/],
      ['fn', /(?<=^[ \t]*)(?:Given|When|Then|And|But|\*)(?= )/],
      ['str', /"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/],
      ['kw2', /<[\w -]+>/],
      ['dim', /\|/],
      ['num', /\b\d+(?:\.\d+)?\b/],
    ],
    bash: [
      ['prompt', /^(?:\$|PS>) /],
      ['com', /(?<=^|\s)#[^\n]*/],
      ['str', /'[^'\n]*'|"(?:\\.|[^"\\\n])*"/],
      ['kw2', /\$[A-Za-z_]\w*|\$env:\w+|\$\{[^}]+\}/],
      ['fn', /(?<=^(?:\$ |PS> )?)(?:npx|npm|node|git|cd|brew|winget|choco|nvm|fnm|mkdir|cp|ls|cat|export|set|safaridriver|corepack|bddr)(?= |$)/],
      ['tag', /(?<=\s)--?[A-Za-z][\w-]*/],
      ['num', /\b\d+(?:\.\d+)*\b/],
    ],
    json: [
      ['key', /"(?:\\.|[^"\\])*"(?=\s*:)/],
      ['str', /"(?:\\.|[^"\\])*"/],
      ['kw2', /\b(?:true|false|null)\b/],
      ['num', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/],
    ],
    html: [
      ['com', /<!--[\s\S]*?-->/],
      ['key', /<\/?[A-Za-z][\w-]*|\/?>/],
      ['str', /"[^"]*"|'[^']*'/],
      ['tag', /(?<=\s)[A-Za-z_:][\w:.-]*(?==)/],
    ],
  };
  RULES.js = RULES.ts;
  RULES.powershell = RULES.bash;

  /* ---------- theme ---------- */
  var toggle = document.querySelector('.theme-toggle');
  if (toggle) {
    var sync = function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.setAttribute('aria-label', dark ? 'Use light theme' : 'Use dark theme');
    };
    sync();
    toggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      store.set('bddr-theme', next);
      sync();
    });
  }

  /* ---------- sidebar ---------- */
  var sidebar = document.querySelector('.sidebar');
  var flat = [];
  var current = -1;
  if (sidebar && window.BDDR_NAV) {
    var html = '';
    window.BDDR_NAV.forEach(function (section) {
      html += '<section><h2>' + esc(section.title) + '</h2><ul>';
      section.items.forEach(function (item) {
        if (!item.ready) {
          html += '<li><span class="soon">' + esc(item.title) + ' <small>(coming)</small></span></li>';
          return;
        }
        var isHere = here.slice(-item.href.length) === item.href;
        if (isHere) current = flat.length;
        flat.push(item);
        html += '<li><a href="' + root + item.href + '"' + (isHere ? ' aria-current="page"' : '') + '>' + esc(item.title) + '</a></li>';
      });
      html += '</ul></section>';
    });
    sidebar.innerHTML = html;
    var active = sidebar.querySelector('[aria-current="page"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'center' });
  }

  var menu = document.querySelector('.menu-button');
  if (menu) {
    menu.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      menu.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('nav-open')) {
        document.body.classList.remove('nav-open');
        menu.setAttribute('aria-expanded', 'false');
        menu.focus();
      }
    });
  }

  var pager = document.querySelector('.pager');
  if (pager && current >= 0) {
    var prev = flat[current - 1];
    var next = flat[current + 1];
    pager.innerHTML =
      (prev ? '<a class="prev" href="' + root + prev.href + '"><small>Previous</small><span>' + esc(prev.title) + '</span></a>' : '') +
      (next ? '<a class="next" href="' + root + next.href + '"><small>Next</small><span>' + esc(next.title) + '</span></a>' : '');
  }

  /* ---------- headings: anchors and table of contents ---------- */
  var content = document.querySelector('.doc-content');
  var toc = document.querySelector('.toc');
  if (content) {
    var heads = content.querySelectorAll('h2, h3');
    var items = '';
    heads.forEach(function (h) {
      if (!h.id) h.id = slug(h.textContent);
      var a = document.createElement('a');
      a.className = 'anchor';
      a.href = '#' + h.id;
      a.setAttribute('aria-label', 'Link to this section');
      a.textContent = '#';
      h.prepend(a);
      items += '<li><a href="#' + h.id + '"' + (h.tagName === 'H3' ? ' class="sub"' : '') + '>' + esc(h.textContent.replace(/^#/, '')) + '</a></li>';
    });
    if (toc && heads.length > 1) {
      toc.innerHTML = '<h2>On this page</h2><ol>' + items + '</ol>';
      if ('IntersectionObserver' in window) {
        var links = toc.querySelectorAll('a');
        var seen = new Map();
        var observer = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) { seen.set(en.target.id, en.isIntersecting); });
          var first = null;
          heads.forEach(function (h) { if (!first && seen.get(h.id)) first = h.id; });
          if (first) links.forEach(function (l) { l.classList.toggle('current', l.getAttribute('href') === '#' + first); });
        }, { rootMargin: '-60px 0px -65% 0px' });
        heads.forEach(function (h) { observer.observe(h); });
      }
    } else if (toc) {
      toc.remove();
    }
  }

  /* ---------- code blocks ---------- */
  document.querySelectorAll('.code-block').forEach(function (fig) {
    var code = fig.querySelector('code');
    if (!code) return;
    var lang = (code.className.match(/lang-([\w-]+)/) || [])[1] || '';
    var title = fig.getAttribute('data-title');
    var source = code.textContent.replace(/^\n/, '').replace(/\s+$/, '');
    code.innerHTML = highlight(source, lang);
    var copy = copyButton(function () {
      // copy commands without their "$ " / "PS> " prompts
      return lang === 'bash' || lang === 'powershell' ? source.replace(/^(\$|PS>) /gm, '') : source;
    });
    if (title || LABELS[lang]) {
      var bar = document.createElement('div');
      bar.className = 'code-bar';
      bar.innerHTML = (title ? '<span class="title">' + esc(title) + '</span>' : '') + '<span class="lang">' + esc(LABELS[lang] || lang) + '</span>';
      bar.appendChild(copy);
      fig.prepend(bar);
    } else {
      fig.appendChild(copy);
    }
  });

  document.querySelectorAll('.placeholder .prompt').forEach(function (p) {
    var text = p.textContent.trim();
    p.appendChild(copyButton(function () { return text; }));
  });

  /* ---------- tabs ---------- */
  document.querySelectorAll('.tabs').forEach(function (box, n) {
    var group = box.getAttribute('data-group');
    var panels = box.querySelectorAll(':scope > [data-tab]');
    var list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    panels.forEach(function (panel, i) {
      var id = 'tab-' + n + '-' + i;
      var b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.setAttribute('role', 'tab');
      b.setAttribute('data-tab', panel.getAttribute('data-tab'));
      b.textContent = panel.getAttribute('data-label') || panel.getAttribute('data-tab');
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', id);
      b.addEventListener('click', function () { select(group, panel.getAttribute('data-tab'), box); });
      b.addEventListener('keydown', function (e) {
        var tabs = list.querySelectorAll('[role="tab"]');
        var at = Array.prototype.indexOf.call(tabs, b);
        var to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : -2;
        if (to === -2) return;
        var t = tabs[(to + tabs.length) % tabs.length];
        t.focus();
        t.click();
      });
      list.appendChild(b);
    });
    box.prepend(list);
    var saved = group && store.get('bddr-tab-' + group);
    var start = saved && box.querySelector(':scope > [data-tab="' + saved + '"]') ? saved : guess(group, panels);
    show(box, start);
  });

  function select(group, value, box) {
    if (!group) return show(box, value);
    store.set('bddr-tab-' + group, value);
    document.querySelectorAll('.tabs[data-group="' + group + '"]').forEach(function (b) {
      if (b.querySelector(':scope > [data-tab="' + value + '"]')) show(b, value);
    });
  }
  function show(box, value) {
    box.querySelectorAll(':scope > [role="tablist"] > [role="tab"]').forEach(function (t) {
      var on = t.getAttribute('data-tab') === value;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    box.querySelectorAll(':scope > [data-tab]').forEach(function (p) { p.hidden = p.getAttribute('data-tab') !== value; });
  }
  function guess(group, panels) {
    var first = panels[0].getAttribute('data-tab');
    if (group !== 'os') return first;
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var os = /win/i.test(p) ? 'windows' : /mac/i.test(p) ? 'macos' : /linux/i.test(p) ? 'linux' : first;
    return Array.prototype.some.call(panels, function (x) { return x.getAttribute('data-tab') === os; }) ? os : first;
  }

  /* ---------- helpers ---------- */
  function copyButton(text) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy';
    b.textContent = 'Copy';
    b.addEventListener('click', function () {
      var value = text();
      var done = function () {
        b.textContent = 'Copied';
        b.setAttribute('data-copied', '');
        setTimeout(function () { b.textContent = 'Copy'; b.removeAttribute('data-copied'); }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(value).then(done, fallback);
      else fallback();
      function fallback() {
        var t = document.createElement('textarea');
        t.value = value;
        t.style.position = 'fixed';
        t.style.opacity = '0';
        document.body.appendChild(t);
        t.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* nothing to do */ }
        t.remove();
      }
    });
    return b;
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function slug(s) { return s.toLowerCase().replace(/^#/, '').trim().replace(/[^\w]+/g, '-').replace(/^-|-$/g, ''); }

  function highlight(source, lang) {
    var rules = RULES[lang];
    if (!rules) return esc(source);
    var re = new RegExp(rules.map(function (r) { return '(' + r[1].source + ')'; }).join('|'), 'gm');
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(source))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      var kind = 0;
      while (m[kind + 1] === undefined) kind++;
      out += esc(source.slice(last, m.index)) + '<span class="tok-' + rules[kind][0] + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    return out + esc(source.slice(last));
  }
})();
