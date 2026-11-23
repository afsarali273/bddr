import { parseCompiled } from './compiled.js';
import { literalKey } from './hash.js';
import type { Approval } from './project.js';
import type { PromptFile } from './prompt-file.js';

export interface GateResult {
  /** Rule violations that make the candidate unacceptable even as a proposal. */
  reject: string[];
  /** Changes that need a person: the candidate can at most be a proposal. */
  needsApproval: string[];
}

/**
 * The static half of the acceptance gate. Runs without executing the candidate.
 *  G1 the file parses and keeps the header id
 *  G3 every check body is byte-for-byte (after formatting) the approved one; no check added or removed
 *  G4 the data the prompt pins is used as often as before, and no new numbers appear in the action code
 *  G6 the code's shape is unchanged (only targets changed); otherwise the candidate is a proposal
 * Nothing here trusts the candidate's own header: approvals.json is the only authority.
 */
export function staticGate(candidate: string, prompt: PromptFile, approval: Approval): GateResult {
  const reject: string[] = [];
  const needsApproval: string[] = [];
  const c = parseCompiled(candidate);
  if (c.errors.length) reject.push(...c.errors.map((e) => `G1 ${e}`));
  if (c.header.id !== prompt.id) reject.push(`G1 header id changed to "${c.header.id}"`);

  for (const id of Object.keys(approval.checkCode)) {
    if (!(id in c.checkCode)) reject.push(`G3 check ${id} was removed`);
    else if (c.checkCode[id] !== approval.checkCode[id]) needsApproval.push(`G3 check ${id} code changed`);
  }
  for (const id of Object.keys(c.checkCode)) if (!(id in approval.checkCode)) reject.push(`G3 check ${id} is not approved`);

  const count = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  const approved = count(approval.actionLiterals);
  const now = count(c.actionLiterals.map(literalKey));
  for (const l of prompt.literals) {
    const k = literalKey(l);
    const before = approved.get(k) ?? 0;
    const after = now.get(k) ?? 0;
    if (after < before) reject.push(`G4 the prompt's ${l.kind} ${JSON.stringify(l.value)} is used ${after} time(s) instead of ${before}`);
  }
  const promptNums = new Set(prompt.literals.filter((l) => l.kind === 'number').map(literalKey));
  for (const l of c.actionLiterals) {
    if (l.kind !== 'number') continue;
    const k = literalKey(l);
    if (!approved.has(k) && !promptNums.has(k) && l.value !== 0 && l.value !== 1) reject.push(`G4 new number ${l.value} in the action code`);
  }
  if (!reject.length && c.shape !== approval.shape) needsApproval.push('G6 the change is more than re-targeting (steps or logic changed)');
  return { reject, needsApproval };
}
