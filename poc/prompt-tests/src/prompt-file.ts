import { literalKey, normalizeProse, normalizeText, sha, type Literal } from './hash.js';

export interface CheckLine {
  id: string;
  text: string;
  line: number;
}

export interface PromptFile {
  path: string;
  id?: string;
  /** `key: value` lines at the top (id, tags, needs...). */
  header: Record<string, string>;
  /** The free text, without the header and without the checks block. */
  prose: string;
  checks: CheckLine[];
  /** Attributes written on the ```checks fence, e.g. approved-by. Informational only. */
  checksAttrs: Record<string, string>;
  /** Hash of header + prose (not the checks). */
  promptHash: string;
  /** Hash of the check lines. */
  checksHash: string;
  /** Quoted strings and numbers in the prose: the data the prompt pins. */
  literals: Literal[];
  errors: string[];
}

const HEADER = /^([a-zA-Z][\w-]*):\s*(.*)$/;
const CHECK = /^(C\d+)\s+(.+)$/;

export function parsePrompt(source: string, path = '<prompt>'): PromptFile {
  const lines = source.split(/\r?\n/);
  const header: Record<string, string> = {};
  const headerLines: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  for (; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]!.trim());
    if (!m) break;
    header[m[1]!] = m[2]!.trim();
    headerLines.push(`${m[1]}: ${m[2]!.trim()}`);
  }

  const proseLines: string[] = [];
  const checks: CheckLine[] = [];
  const checksAttrs: Record<string, string> = {};
  const errors: string[] = [];
  let inChecks = false;
  let sawChecks = false;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const t = raw.trim();
    if (!inChecks && /^```checks\b/.test(t)) {
      inChecks = true;
      sawChecks = true;
      for (const a of t.slice('```checks'.length).trim().split(/\s+/).filter(Boolean)) {
        const [k, v] = a.split('=');
        if (k) checksAttrs[k] = v ?? 'true';
      }
      continue;
    }
    if (inChecks) {
      if (t.startsWith('```')) {
        inChecks = false;
        continue;
      }
      if (t === '') continue;
      const m = CHECK.exec(t);
      if (!m) errors.push(`line ${i + 1}: a check line must look like "C1 what must hold"`);
      else checks.push({ id: m[1]!, text: m[2]!.trim(), line: i + 1 });
      continue;
    }
    proseLines.push(raw);
  }
  if (inChecks) errors.push('the ```checks block is not closed');

  const id = header.id;
  if (!id) errors.push('missing "id:" line at the top');
  if (!sawChecks || checks.length === 0) errors.push('no checks: a prompt test must say what to verify (a ```checks block)');
  const seen = new Set<string>();
  for (const c of checks) {
    if (seen.has(c.id)) errors.push(`check ${c.id} appears twice`);
    seen.add(c.id);
  }

  const prose = proseLines.join('\n').trim();
  return {
    path,
    ...(id ? { id } : {}),
    header,
    prose,
    checks,
    checksAttrs,
    promptHash: sha(normalizeText(headerLines.join('\n')) + '\n' + normalizeProse(prose)),
    checksHash: sha(normalizeText(checks.map((c) => `${c.id} ${c.text}`).join('\n'))),
    literals: proseLiterals(prose),
    errors,
  };
}

/** Quoted strings and numbers written in the prose. */
export function proseLiterals(prose: string): Literal[] {
  const out = new Map<string, Literal>();
  for (const m of prose.matchAll(/"([^"\n]+)"/g)) {
    const l: Literal = { kind: 'string', value: m[1]! };
    out.set(literalKey(l), l);
  }
  const withoutQuotes = prose.replace(/"[^"\n]*"/g, ' ');
  for (const m of withoutQuotes.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/g)) {
    const l: Literal = { kind: 'number', value: Number(m[1]) };
    out.set(literalKey(l), l);
  }
  return [...out.values()];
}
