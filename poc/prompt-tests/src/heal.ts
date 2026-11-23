import type { Approval } from './project.js';
import type { PromptFile } from './prompt-file.js';
import { runWithRetry, type Outcome, type RunResult } from './runtime.js';
import { staticGate } from './gate.js';

export interface HealTask {
  id: string;
  prompt: PromptFile;
  /** The code that failed (the latest candidate after the first attempt). */
  code: string;
  failure: RunResult;
  attempt: number;
}

/** Anything that can propose new code: a model, a coding agent, a heuristic. */
export interface Agent {
  name: string;
  propose(task: HealTask): Promise<string | undefined>;
}

export type HealStatus =
  | 'accepted' // passed every gate: may be written (locally) or opened as a PR (CI)
  | 'proposal' // works, but changes something a person must approve
  | 'rejected' // the candidate broke a rule; nothing is kept
  | 'gave-up' // no candidate passed within the budget
  | 'not-allowed'; // the failure was in a check: never healed

export interface HealOutcome {
  status: HealStatus;
  code?: string;
  attempts: number;
  /** Proposals the agent made (model calls, for cost accounting). */
  agentCalls: number;
  reasons: string[];
}

export interface HealOptions {
  agent: Agent;
  prompt: PromptFile;
  approval: Approval;
  /** Fresh fixtures for each run (a new app instance); attempt counts environment retries. */
  fixtures: (attempt: number) => Record<string, unknown>;
  tmpDir: string;
  maxAttempts?: number;
  replays?: number;
  /** Experiment switch: try healing even after a check failed (simulates a tool without the rule). */
  ignoreClassification?: boolean;
}

const HEALABLE: Outcome[] = ['action-failed', 'check-target-missing'];

export async function heal(code: string, failure: RunResult, o: HealOptions): Promise<HealOutcome> {
  const maxAttempts = o.maxAttempts ?? 3;
  const replays = o.replays ?? 3;
  const contract = Object.keys(o.approval.checkCode);
  if (!o.ignoreClassification && !HEALABLE.includes(failure.outcome)) {
    return { status: 'not-allowed', attempts: 0, agentCalls: 0, reasons: [`${failure.outcome}: a failed check is reported, not healed`] };
  }
  // A missing check target can only ever produce a proposal: the check itself would change.
  let ceiling: 'accepted' | 'proposal' = failure.outcome === 'check-target-missing' ? 'proposal' : 'accepted';

  let current = code;
  let last = failure;
  const reasons: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = await o.agent.propose({ id: o.prompt.id!, prompt: o.prompt, code: current, failure: last, attempt });
    if (!candidate) {
      reasons.push(`attempt ${attempt}: the agent had no proposal`);
      return { status: 'gave-up', attempts: attempt, agentCalls: attempt, reasons };
    }
    const gate = staticGate(candidate, o.prompt, o.approval);
    if (gate.reject.length) {
      reasons.push(...gate.reject.map((r) => `attempt ${attempt}: ${r}`));
      return { status: 'rejected', attempts: attempt, agentCalls: attempt, reasons };
    }
    if (gate.needsApproval.length) {
      ceiling = 'proposal';
      reasons.push(...gate.needsApproval.map((r) => `attempt ${attempt}: ${r}`));
    }

    const { result } = await runWithRetry(candidate, { contract, fixtures: o.fixtures, tmpDir: o.tmpDir });
    if (result.outcome === 'passed') {
      // G5: it must pass again, several times, with no agent in the loop.
      for (let r = 1; r <= replays; r++) {
        const { result: again } = await runWithRetry(candidate, { contract, fixtures: o.fixtures, tmpDir: o.tmpDir });
        if (again.outcome !== 'passed') {
          reasons.push(`attempt ${attempt}: G5 replay ${r} ended ${again.outcome}`);
          return { status: 'gave-up', attempts: attempt, agentCalls: attempt, reasons };
        }
      }
      return { status: ceiling, code: candidate, attempts: attempt, agentCalls: attempt, reasons };
    }
    if (!HEALABLE.includes(result.outcome) && !o.ignoreClassification) {
      reasons.push(`attempt ${attempt}: after the change the run ended ${result.outcome} (${result.error?.message ?? ''})`);
      return { status: 'gave-up', attempts: attempt, agentCalls: attempt, reasons };
    }
    if (result.outcome === 'check-target-missing') ceiling = 'proposal';
    reasons.push(`attempt ${attempt}: still ${result.outcome}: ${result.error?.message ?? ''}`);
    current = candidate;
    last = result;
  }
  return { status: 'gave-up', attempts: maxAttempts, agentCalls: maxAttempts, reasons };
}
