import { describe, expect, it } from 'vitest';
import { renderLivingDocs, renderMarkdown, type DocsInput } from '@bddr/reporters';

describe('renderMarkdown', () => {
  it('renders headings, lists, code, emphasis and safe links', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *it* and `code`.\n\n- a\n- b\n\n1. x\n\n```\n<b>raw</b>\n```\n\n[docs](https://example.com/a?b=1&c=2) and [rel](../other.md)');
    expect(html).toContain('<h2>Title</h2>'); // page title is h1, so README headings start at h2
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>it</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('<ol><li>x</li></ol>');
    expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;');
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain('href="../other.md"');
  });

  it('escapes HTML and drops dangerous link targets', () => {
    const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) [y](data:text/html;base64,AAAA) <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="data');
  });
});

const INPUT: DocsInput = {
  title: 'Shop <docs>',
  generatedAt: Date.UTC(2026, 10, 15, 4, 0),
  readmes: { 'features/checkout': '# Checkout\n\nPaying for a basket.' },
  features: [
    {
      uri: 'features/basket/basket.feature',
      name: 'Basket',
      description: 'Adding things.',
      tags: ['@smoke'],
      scenarios: [
        { id: 'a', name: 'Add <one>', keyword: 'Scenario', line: 3, tags: ['@fast'], steps: [{ keyword: 'Given ', text: 'a basket' }, { keyword: 'Then ', text: 'a table', arg: { kind: 'dataTable', rows: [['k', 'v'], ['1', '2']] } }], status: 'passed', durationMs: 12 },
        { id: 'b', name: 'Fails', keyword: 'Scenario', line: 9, tags: [], steps: [{ keyword: 'Given ', text: 'x' }], status: 'failed' },
      ],
    },
    {
      uri: 'features/checkout/pay.feature',
      name: 'Pay',
      description: '',
      tags: [],
      scenarios: [{ id: 'c', name: 'Pay', keyword: 'Scenario', line: 3, tags: [], steps: [{ keyword: 'When ', text: 'I pay' }] }],
    },
  ],
};

describe('renderLivingDocs', () => {
  const html = renderLivingDocs(INPUT);

  it('builds a folder tree with the README title, features, scenarios and step tables', () => {
    expect(html).toContain('Checkout</a>'); // folder named by its README heading
    expect(html).toContain('Paying for a basket.');
    expect(html).toContain('<h1>Basket</h1>');
    expect(html).toContain('<table class="argtable">');
    expect(html).toContain('<h1>Shop &lt;docs&gt;</h1>');
    expect(html).toContain('Add &lt;one&gt;'); // escaped
    expect(html).not.toContain('Add <one>');
  });

  it('colours scenarios by status and rolls them up', () => {
    expect(html).toContain('sc s-passed');
    expect(html).toContain('sc s-failed');
    expect(html).toContain('sc s-notrun'); // no result for "Pay"
    expect(html).toContain('1 passed');
    expect(html).toContain('1 failed');
    expect(html).toContain('3 scenarios');
  });

  it('is one self-contained file: no external requests', () => {
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).not.toContain('<link ');
  });
});
