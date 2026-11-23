/**
 * Phase 2 gate: the same scenarios must come out identical whether the rows are written inline in
 * Examples, loaded from CSV or loaded from XLSX.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileDataLoader, parseSpecAsync } from '@bddr/core';

const HEADER = ['item', 'qty', 'note'];
// Awkward values on purpose: comma, quote, unicode, decimal, empty cell, leading zeros as text.
const ROWS: string[][] = [
  ['apple', '2', 'plain'],
  ['pear, ripe', '10', 'has a comma'],
  ['Zoë', '2.5', 'unicode'],
  ["o'neil", '0', 'quote'],
  ['plum', '7', ''],
];

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bddr-parity-'));
  const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  writeFileSync(join(dir, 'rows.csv'), [HEADER, ...ROWS].map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Rows');
  sheet.addRow(HEADER);
  for (const [item, qty, note] of ROWS) sheet.addRow([item, Number(qty), note]);
  await wb.xlsx.writeFile(join(dir, 'rows.xlsx'));
});

const body = `    Given I buy <qty> of "<item>"
    Then the note is "<note>"
`;

const inlineFeature = () =>
  `Feature: parity
  Scenario Outline: buy <item>
${body}
    Examples:
      | item | qty | note |
${ROWS.map((r) => `      | ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`).join('\n')}
`;

const dataFeature = (ref: string) => `Feature: parity
  Scenario Outline: buy <item>
${body}
    @data:${ref}
    Examples:
      | item | qty | note |
`;

async function run(source: string) {
  const spec = await parseSpecAsync(source, 'parity.feature', { dataLoader: createFileDataLoader({ dataDir: dir, rootDir: dir }) });
  expect(spec.errors).toEqual([]);
  return spec.scenarios.map((s) => ({ name: s.name, steps: s.steps.map((st) => `${st.keyword.trim()} ${st.text}`) }));
}

describe('data source parity (inline vs CSV vs XLSX)', () => {
  it('inline, CSV and XLSX produce identical scenarios, names and step text', async () => {
    const inline = await run(inlineFeature());
    const csv = await run(dataFeature('rows.csv'));
    const xlsx = await run(dataFeature('rows.xlsx#Rows'));
    expect(inline).toHaveLength(ROWS.length);
    expect(csv).toEqual(inline);
    expect(xlsx).toEqual(inline);
  });

  it('keeps the awkward values intact', async () => {
    const xlsx = await run(dataFeature('rows.xlsx#Rows'));
    expect(xlsx.map((s) => s.steps[0])).toEqual([
      'Given I buy 2 of "apple"',
      'Given I buy 10 of "pear, ripe"',
      'Given I buy 2.5 of "Zoë"',
      `Given I buy 0 of "o'neil"`,
      'Given I buy 7 of "plum"',
    ]);
  });
});
