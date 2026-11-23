import { createHash } from 'node:crypto';

/** Short sha256, enough to compare versions in a POC. */
export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Trim lines, collapse runs of spaces, drop blank lines: formatting-only edits keep the hash. */
export function normalizeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l.length > 0)
    .join('\n');
}

export type Literal = { kind: 'string'; value: string } | { kind: 'number'; value: number };

export function literalKey(l: Literal): string {
  return l.kind === 'number' ? `n:${l.value}` : `s:${l.value}`;
}

/** Prose: paragraphs are separated by blank lines; inside a paragraph any whitespace is one space. */
export function normalizeProse(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
