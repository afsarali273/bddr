/**
 * External data for scenarios (Phase 2).
 *
 * Tag syntax (on a Scenario, Scenario Outline, or an Examples block):
 *
 *   @data:<file>[#<selector>][?<query>]
 *
 *   @data:users.csv
 *   @data:users.xlsx#Admins              selector = sheet name
 *   @data:users.json#data.items          selector = dotted path to an array
 *   @data:users.csv?role=admin           keep rows whose column equals the value (several = AND)
 *   @data:users.csv?rows=1-3,7           keep data rows by 1-based number (header excluded)
 *
 *   @dataField:<placeholder>=<column>    rename a source column for <placeholder> substitution
 *
 * Resolution: `<dataDir>/<profile>/<file>` first (when a profile is active), then `<dataDir>/<file>`,
 * then relative to the spec file's folder. dataDir defaults to the config folder.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { parseCsv } from './csv.js';

export interface DataRef {
  /** File as written in the tag. */
  source: string;
  selector?: string;
  query: Record<string, string>;
  /** Raw tag value, for messages. */
  raw: string;
}

export interface DataRow {
  /** 1-based number of the row in the source (header excluded), stable under filtering. */
  number: number;
  values: Record<string, string>;
}

export interface DataSet {
  columns: string[];
  rows: DataRow[];
}

export interface DataLoadContext {
  /** URI of the spec that references the data (relative to rootDir). */
  uri: string;
}

export interface DataLoader {
  load(ref: DataRef, ctx: DataLoadContext): Promise<DataSet>;
}

/** Reads one file format. `selector` is the part after '#'. Return rows WITHOUT filtering. */
export type DataProvider = (file: string, selector: string | undefined) => Promise<{ columns: string[]; rows: Record<string, string>[] }>;

export function parseDataRef(value: string): DataRef {
  let rest = value;
  const query: Record<string, string> = {};
  const q = rest.indexOf('?');
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split('&').filter(Boolean)) {
      const eq = part.indexOf('=');
      if (eq <= 0) throw new Error(`Bad data query "${part}" in "${value}" (expected key=value)`);
      query[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
    }
    rest = rest.slice(0, q);
  }
  const h = rest.indexOf('#');
  const ref: DataRef = { source: h >= 0 ? rest.slice(0, h) : rest, query, raw: value };
  if (h >= 0) ref.selector = rest.slice(h + 1);
  if (!ref.source) throw new Error(`Empty data source in "@data:${value}"`);
  return ref;
}

const stringify = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

function fromObjects(items: unknown, file: string, selector?: string) {
  if (!Array.isArray(items)) {
    throw new Error(`${file}${selector ? `#${selector}` : ''} is not an array of objects`);
  }
  const columns: string[] = [];
  const rows = items.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${file}: item ${i + 1} is not an object`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      if (!columns.includes(k)) columns.push(k);
      out[k] = stringify(v);
    }
    return out;
  });
  return { columns, rows };
}

function pick(obj: unknown, path: string | undefined, file: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in (cur as object))) {
      throw new Error(`${file}: path "${path}" not found (missing "${key}")`);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function fromTable(table: string[][], file: string) {
  const [header, ...body] = table;
  if (!header || !header.length) throw new Error(`${file} has no header row`);
  const columns = header.map((h) => h.trim());
  const rows = body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])));
  return { columns, rows };
}

export const builtInDataProviders: Record<string, DataProvider> = {
  '.csv': async (file) => fromTable(parseCsv(await readFile(file, 'utf8')), file),
  '.tsv': async (file) => fromTable(parseCsv(await readFile(file, 'utf8'), '\t'), file),
  '.json': async (file, selector) => fromObjects(pick(JSON.parse(await readFile(file, 'utf8')), selector, file), file, selector),
  '.yaml': async (file, selector) => {
    const { parse } = await import('yaml');
    return fromObjects(pick(parse(await readFile(file, 'utf8')), selector, file), file, selector);
  },
  '.yml': async (file, selector) => builtInDataProviders['.yaml']!(file, selector),
  '.xlsx': async (file, selector) => {
    let ExcelJS: typeof import('exceljs');
    try {
      ExcelJS = (await import('exceljs')).default;
    } catch {
      throw new Error(`${file}: reading .xlsx files needs the optional package "exceljs". Install it in your project: npm i -D exceljs`);
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const sheet = selector ? wb.getWorksheet(selector) : wb.worksheets[0];
    if (!sheet) {
      throw new Error(`${file}: sheet "${selector}" not found. Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}`);
    }
    const table: string[][] = [];
    const width = sheet.columnCount;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) cells.push(row.getCell(c).text ?? '');
      table.push(cells);
    });
    // Ignore trailing empty header columns.
    const header = table[0] ?? [];
    let last = header.length;
    while (last > 0 && !header[last - 1]) last--;
    return fromTable(table.map((r) => r.slice(0, last)), file);
  },
};

export interface FileDataLoaderOptions {
  /** Folder that data paths are relative to. */
  dataDir: string;
  /** Spec URIs are relative to this folder (for spec-relative fallback). */
  rootDir: string;
  /** Active profile: `<dataDir>/<profile>/<file>` is tried first. */
  profile?: string;
  /** Extra or replacement providers by extension ('.xml': …). */
  providers?: Record<string, DataProvider>;
}

/** Applies `?rows=` and `?col=value` filters. Unknown columns are an error (typo protection). */
export function applyQuery(set: { columns: string[]; rows: Record<string, string>[] }, ref: DataRef): DataSet {
  let rows: DataRow[] = set.rows.map((values, i) => ({ number: i + 1, values }));
  for (const [key, value] of Object.entries(ref.query)) {
    if (key === 'rows') {
      const wanted = parseRanges(value);
      rows = rows.filter((r) => wanted(r.number));
    } else {
      if (!set.columns.includes(key)) {
        throw new Error(`Filter column "${key}" not found in ${ref.source}. Columns: ${set.columns.join(', ')}`);
      }
      rows = rows.filter((r) => r.values[key] === value);
    }
  }
  return { columns: set.columns, rows };
}

function parseRanges(spec: string): (n: number) => boolean {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) throw new Error(`Bad rows filter "${spec}" (use e.g. 1-3,7)`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return [a, b] as const;
  });
  return (n) => parts.some(([a, b]) => n >= a && n <= b);
}

export function createFileDataLoader(options: FileDataLoaderOptions): DataLoader {
  const providers = { ...builtInDataProviders, ...(options.providers ?? {}) };
  return {
    async load(ref, ctx) {
      const candidates: string[] = [];
      if (isAbsolute(ref.source)) candidates.push(ref.source);
      else {
        if (options.profile) candidates.push(resolve(options.dataDir, options.profile, ref.source));
        candidates.push(resolve(options.dataDir, ref.source));
        candidates.push(resolve(options.rootDir, dirname(ctx.uri), ref.source));
      }
      const file = candidates.find((c) => existsSync(c));
      if (!file) throw new Error(`Data file "${ref.source}" not found. Looked in:\n  ${candidates.join('\n  ')}`);
      const ext = extname(file).toLowerCase();
      const provider = providers[ext];
      if (!provider) throw new Error(`No data provider for "${ext}" files. Known: ${Object.keys(providers).join(', ')}`);
      return applyQuery(await provider(file, ref.selector), ref);
    },
  };
}
