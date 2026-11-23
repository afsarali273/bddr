import { writeFileSync } from 'node:fs';
import { heal, type Agent, type HealOutcome } from './heal.js';
import { loadApprovals, scan, type Entry } from './project.js';
import { runWithRetry, type RunResult } from './runtime.js';

export interface TestReport {
  id: string;
  state: Entry['state'];
  /** compiled: ran the saved code; skipped: state is not current. */
  mode: 'compiled' | 'skipped';
  result?: RunResult;
  retries: number;
  heal?: HealOutcome;
  reasons: string[];
}

export interface RunOptions {
  dir: string;
  fixtures: (attempt: number) => Record<string, unknown>;
  tmpDir: string;
  /** off: report only. propose: heal but never write. write: write accepted heals into the compiled file. */
  heal?: 'off' | 'propose' | 'write';
  agent?: Agent;
  only?: string[];
}

/** Run every current prompt test from its compiled code. No agent is called unless healing is on and needed. */
export async function runAll(o: RunOptions): Promise<TestReport[]> {
  const approvals = loadApprovals(o.dir);
  const out: TestReport[] = [];
  for (const e of scan(o.dir, approvals)) {
    if (o.only && !o.only.includes(e.id)) continue;
    if (e.state !== 'current') {
      out.push({ id: e.id, state: e.state, mode: 'skipped', retries: 0, reasons: e.reasons });
      continue;
    }
    const contract = Object.keys(approvals[e.id]!.checkCode);
    const { result, retries } = await runWithRetry(e.code!, { contract, fixtures: o.fixtures, tmpDir: o.tmpDir });
    const report: TestReport = { id: e.id, state: e.state, mode: 'compiled', result, retries, reasons: [] };
    if (result.outcome !== 'passed' && o.heal && o.heal !== 'off' && o.agent) {
      report.heal = await heal(e.code!, result, {
        agent: o.agent,
        prompt: e.prompt,
        approval: approvals[e.id]!,
        fixtures: o.fixtures,
        tmpDir: o.tmpDir,
      });
      if (report.heal.status === 'accepted' && o.heal === 'write' && e.compiledPath) writeFileSync(e.compiledPath, report.heal.code!);
      if ((report.heal.status === 'proposal' || (report.heal.status === 'accepted' && o.heal === 'propose')) && e.compiledPath) {
        writeFileSync(e.compiledPath.replace(/\.ts$/, '.proposal.ts.txt'), report.heal.code!);
      }
    }
    out.push(report);
  }
  return out;
}
