import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileDataLoader, parseCsv, parseDataRef, parseSpec, parseSpecAsync } from '@bddr/core';

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bddr-data-'));
  writeFileSync(join(dir, 'users.csv'), '﻿name,role,city\r\nann,admin,"Kuala Lumpur"\r\nbob,user,Paris\r\n"o""neil",admin,"New\nYork"\r\n');
  writeFileSync(join(dir, 'users.json'), JSON.stringify({ data: { items: [{ name: 'ann', age: 30 }, { name: 'bob', age: 41, extra: true }] } }));
  writeFileSync(join(dir, 'users.yaml'), '- name: ann\n  age: 30\n- name: cy\n  age: 22\n');
  mkdirSync(join(dir, 'qa'));
  writeFileSync(join(dir, 'qa', 'users.csv'), 'name,role,city\nqa-user,admin,Test\n');
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Admins');
  sheet.addRow(['name', 'limit']);
  sheet.addRow(['ann', 100]);
  sheet.addRow(['dee', 250.5]);
  wb.addWorksheet('Empty');
  await wb.xlsx.writeFile(join(dir, 'users.xlsx'));
});

const loader = (profile?: string) => createFileDataLoader({ dataDir: dir, rootDir: dir, ...(profile ? { profile } : {}) });

describe('parseCsv', () => {
  it('handles BOM, CRLF, quotes, escaped quotes and embedded newlines', () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\n"multi\nline",\n\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
      ['multi\nline', ''],
    ]);
    expect(() => parseCsv('"open')).toThrow(/Unterminated/);
  });
});

describe('parseDataRef', () => {
  it('splits source, selector and query', () => {
    expect(parseDataRef('u.xlsx#Admins?role=admin&rows=1-3')).toMatchObject({
      source: 'u.xlsx',
      selector: 'Admins',
      query: { role: 'admin', rows: '1-3' },
    });
    expect(() => parseDataRef('?x=1')).toThrow(/Empty data source/);
  });
});

describe('@data expansion', () => {
  it('turns a plain Scenario into one instance per CSV row, with stable source#row ids', async () => {
    const spec = await parseSpecAsync(
      `Feature: Users
  @data:users.csv
  Scenario: login as <name>
    Given user "<name>" with role <role> lives in "<city>"
`,
      'users.feature',
      { dataLoader: loader() },
    );
    expect(spec.errors).toEqual([]);
    expect(spec.scenarios.map((s) => s.id)).toEqual([
      'users.feature::login-as-name[users.csv#1]',
      'users.feature::login-as-name[users.csv#2]',
      'users.feature::login-as-name[users.csv#3]',
    ]);
    expect(spec.scenarios.map((s) => s.name)).toEqual(['login as ann', 'login as bob', 'login as o"neil']);
    expect(spec.scenarios[2]!.steps[0]!.text).toBe('user "o"neil" with role admin lives in "New\nYork"');
    expect(spec.scenarios[0]!.example).toMatchObject({ source: 'users.csv', sourceRow: 1, values: { city: 'Kuala Lumpur' } });
  });

  it('filters rows by column and by row number, keeping original row numbers in ids', async () => {
    const spec = await parseSpecAsync(
      `Feature: f
  @data:users.csv?role=admin
  Scenario: a
    Given <name>
  @data:users.csv?rows=2-3
  Scenario: b
    Given <name>
`,
      'f.feature',
      { dataLoader: loader() },
    );
    expect(spec.scenarios.map((s) => s.id)).toEqual([
      'f.feature::a[users.csv#1]',
      'f.feature::a[users.csv#3]',
      'f.feature::b[users.csv#2]',
      'f.feature::b[users.csv#3]',
    ]);
  });

  it('fills an Examples block from XLSX (sheet selector) keeping its header, with @dataField renames', async () => {
    const spec = await parseSpecAsync(
      `Feature: f
  Scenario Outline: credit for <who>
    Given <who> may spend <limit>

    @data:users.xlsx#Admins @dataField:who=name
    Examples:
      | who | limit |
`,
      'f.feature',
      { dataLoader: loader() },
    );
    expect(spec.errors).toEqual([]);
    expect(spec.scenarios.map((s) => s.steps[0]!.text)).toEqual(['ann may spend 100', 'dee may spend 250.5']);
    expect(spec.scenarios[1]!.id).toBe('f.feature::credit-for-who[users.xlsx#Admins#2]');
  });

  it('reads JSON (dotted selector) and YAML', async () => {
    const spec = await parseSpecAsync(
      `Feature: f
  @data:users.json#data.items
  Scenario: j <name>
    Given <age>
  @data:users.yaml
  Scenario: y <name>
    Given <age>
`,
      'f.feature',
      { dataLoader: loader() },
    );
    expect(spec.errors).toEqual([]);
    expect(spec.scenarios.map((s) => `${s.name}:${s.steps[0]!.text}`)).toEqual(['j ann:30', 'j bob:41', 'y ann:30', 'y cy:22']);
  });

  it('prefers <dataDir>/<profile>/<file> when a profile is active', async () => {
    const spec = await parseSpecAsync(`Feature: f\n  @data:users.csv\n  Scenario: <name>\n    Given x\n`, 'f.feature', { dataLoader: loader('qa') });
    expect(spec.scenarios.map((s) => s.name)).toEqual(['qa-user']);
  });

  it('reports data problems as parse errors on the tag line and drops only that scenario', async () => {
    const spec = await parseSpecAsync(
      `Feature: f
  @data:missing.csv
  Scenario: a
    Given x

  @data:users.csv?colour=red
  Scenario: b
    Given x

  @data:users.csv?role=nobody
  Scenario: c
    Given x

  Scenario Outline: d
    Given <nope>
    @data:users.csv
    Examples:
      | nope |

  Scenario: fine
    Given x
`,
      'f.feature',
      { dataLoader: loader() },
    );
    expect(spec.scenarios.map((s) => s.name)).toEqual(['fine']);
    expect(spec.errors.map((e) => [e.line, e.message.split('\n')[0]])).toEqual([
      [2, 'Data file "missing.csv" not found. Looked in:'],
      [6, 'Filter column "colour" not found in users.csv. Columns: name, role, city'],
      [10, '@data:users.csv?role=nobody matched no rows'],
      [16, 'Column "nope" not found in users.csv. Columns: name, role, city'],
    ]);
  });

  it('the sync parser flags @data scenarios instead of silently running them', () => {
    const spec = parseSpec(`Feature: f\n  @data:users.csv\n  Scenario: a\n    Given x\n`, 'f.feature');
    expect(spec.errors[0]!.message).toMatch(/no data loader is configured/);
  });
});

describe('ports', () => {
  it('picks spec parsers by longest suffix and reports unknown files as parse errors', async () => {
    const { registerSpecParser, specParserFor, parseSpecFile, specFileGlobSuffix } = await import('@bddr/core');
    expect(specParserFor('a/b.feature')?.name).toBe('gherkin (cucumber)');
    expect(specParserFor('a/b.feature.md')?.name).toBe('gherkin (cucumber)');
    registerSpecParser({ name: 'test-md', extensions: ['.spec.md'], parse: async (_s, uri) => ({ uri, scenarios: [], errors: [] }) });
    expect(specParserFor('x.spec.md')?.name).toBe('test-md');
    expect(specFileGlobSuffix()).toBe('{spec.md,feature,feature.md}');
    const unknown = await parseSpecFile('x', 'notes.txt');
    expect(unknown.errors[0]!.message).toMatch(/No spec parser for "notes.txt"/);
  });

  it('tag expression engine is swappable', async () => {
    const { setTagExpressionEngine, compileTagExpression, cucumberTagExpressions } = await import('@bddr/core');
    setTagExpressionEngine({ name: 'any-of', compile: (e) => (tags) => e.split(',').some((t) => tags.includes(t)) });
    expect(compileTagExpression('@a,@b')(['@b'])).toBe(true);
    setTagExpressionEngine(cucumberTagExpressions);
    expect(compileTagExpression('@a and @b')(['@b'])).toBe(false);
  });
});
