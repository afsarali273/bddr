import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompiled, stampHeader, type CompiledFile } from './compiled.js';
import { parsePrompt, type PromptFile } from './prompt-file.js';

/** What a person approved for one test. Lives in approvals.json, which the healer never writes. */
export interface Approval {
  checksHash: string;
  /** check id -> hash of the approved check body. */
  checkCode: Record<string, string>;
  /** Action-code literals that were approved, to pin the prompt's data. */
  actionLiterals: string[];
  /** Shape hash of the approved code: a heal that keeps it only re-targets. */
  shape: string;
  by: string;
  on: string;
}

export type Approvals = Record<string, Approval>;

export type State =
  | 'current'
  | 'not-compiled'
  | 'prompt-changed'
  | 'checks-unapproved'
  | 'check-code-changed'
  | 'invalid';

export interface Entry {
  id: string;
  prompt: PromptFile;
  promptPath: string;
  compiledPath?: string;
  code?: string;
  compiled?: CompiledFile;
  state: State;
  reasons: string[];
}

export function loadApprovals(dir: string): Approvals {
  const f = join(dir, 'approvals.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Approvals) : {};
}

export function saveApprovals(dir: string, approvals: Approvals): void {
  const sorted = Object.fromEntries(Object.entries(approvals).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(dir, 'approvals.json'), `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Pair every prompt with its compiled file BY ID (never by file name) and work out its state.
 */
export function scan(dir: string, approvals = loadApprovals(dir)): Entry[] {
  const files = readdirSync(dir);
  const compiledById = new Map<string, { path: string; code: string; parsed: CompiledFile }>();
  for (const f of files.filter((f) => f.endsWith('.ts'))) {
    const path = join(dir, f);
    const code = readFileSync(path, 'utf8');
    const parsed = parseCompiled(code, f);
    if (parsed.isCompiled && parsed.header.id) compiledById.set(parsed.header.id, { path, code, parsed });
  }

  const entries: Entry[] = [];
  const seen = new Map<string, string>();
  for (const f of files.filter((f) => f.endsWith('.prompt.md')).sort()) {
    const promptPath = join(dir, f);
    const prompt = parsePrompt(readFileSync(promptPath, 'utf8'), promptPath);
    const id = prompt.id ?? f;
    const reasons: string[] = [...prompt.errors];
    if (prompt.id && seen.has(prompt.id)) reasons.push(`id "${prompt.id}" is also used by ${seen.get(prompt.id)}`);
    if (prompt.id) seen.set(prompt.id, f);
    const c = prompt.id ? compiledById.get(prompt.id) : undefined;
    const entry: Entry = { id, prompt, promptPath, state: 'current', reasons };
    if (c) Object.assign(entry, { compiledPath: c.path, code: c.code, compiled: c.parsed });
    entry.state = stateOf(entry, approvals[id]);
    entries.push(entry);
  }
  return entries;
}

export function stateOf(e: Entry, approval: Approval | undefined): State {
  if (e.reasons.length) return 'invalid';
  if (!e.compiled) {
    e.reasons.push('no compiled file with this id');
    return 'not-compiled';
  }
  if (e.compiled.errors.length) {
    e.reasons.push(...e.compiled.errors);
    return 'invalid';
  }
  if (!approval || approval.checksHash !== e.prompt.checksHash) {
    e.reasons.push(approval ? 'the checks changed since they were approved' : 'the checks were never approved');
    return 'checks-unapproved';
  }
  if (e.compiled.header.prompt !== e.prompt.promptHash) {
    e.reasons.push(`prompt hash ${e.prompt.promptHash} does not match the compiled file (${e.compiled.header.prompt ?? 'none'})`);
    return 'prompt-changed';
  }
  if (e.compiled.header.checks !== e.prompt.checksHash) {
    e.reasons.push('the compiled file was built from other checks');
    return 'prompt-changed';
  }
  const changed = Object.keys({ ...approval.checkCode, ...e.compiled.checkCode }).filter(
    (k) => approval.checkCode[k] !== e.compiled!.checkCode[k],
  );
  if (changed.length) {
    e.reasons.push(`check code differs from the approved version: ${changed.join(', ')}`);
    return 'check-code-changed';
  }
  return 'current';
}

/** Record a person's approval of the checks AND of the check code currently in the compiled file. */
export function approve(dir: string, ids: string[] | 'all', by: string, on: string): string[] {
  const approvals = loadApprovals(dir);
  const done: string[] = [];
  for (const e of scan(dir, {})) {
    if (ids !== 'all' && !ids.includes(e.id)) continue;
    if (!e.compiled || !e.code || !e.compiledPath || e.prompt.errors.length) continue;
    // Approving also stamps the header so the compiled file records which prompt it was built from.
    const stamped = stampHeader(e.code, { id: e.id, prompt: e.prompt.promptHash, checks: e.prompt.checksHash });
    writeFileSync(e.compiledPath, stamped);
    const parsed = parseCompiled(stamped);
    approvals[e.id] = {
      checksHash: e.prompt.checksHash,
      checkCode: parsed.checkCode,
      actionLiterals: parsed.actionLiterals.map((l) => (l.kind === 'number' ? `n:${l.value}` : `s:${l.value}`)),
      shape: parsed.shape,
      by,
      on,
    };
    done.push(e.id);
  }
  saveApprovals(dir, approvals);
  return done;
}
