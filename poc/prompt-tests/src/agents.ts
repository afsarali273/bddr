import { spawnSync } from 'node:child_process';
import { ElementNotFound, MethodNotFound, RouteNotFound } from './errors.js';
import type { Agent, HealTask } from './heal.js';

const tokens = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function lev(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length]!;
}

/** 0..1: the best of token overlap, edit distance and containment. */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = new Set(tokens(x));
  const tb = new Set(tokens(y));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  const editRatio = 1 - lev(x, y) / Math.max(x.length, y.length);
  const contained = [...ta].every((t) => tb.has(t)) || [...tb].every((t) => ta.has(t)) ? 0.8 : 0;
  return Math.max(jaccard, editRatio, contained);
}

/** The best candidate, or undefined when none clears the bar or two tie (ambiguous). */
function best<T>(items: T[], score: (t: T) => number, min = 0.5): T | undefined {
  const ranked = items.map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s);
  if (!ranked.length || ranked[0]!.s < min) return undefined;
  if (ranked[1] && Math.abs(ranked[1].s - ranked[0]!.s) < 1e-9) return undefined;
  return ranked[0]!.t;
}

const quoteAll = (code: string, from: string, to: string) =>
  code.split(`'${from}'`).join(`'${to.replace(/'/g, "\\'")}'`).split(`"${from}"`).join(`"${to.replace(/"/g, '\\"')}"`);

/**
 * A deterministic healer with no model: it reads the failure (what the code asked for and what
 * the screen, router or API actually offers) and swaps in the closest match. A real model would
 * use the same inputs; this agent is a floor for what healing can do, not a ceiling.
 */
export class LocatorHealer implements Agent {
  /**
   * soleCandidate: when nothing is similar enough, take the only element of the same kind on the
   * screen. Bolder, and exactly the kind of guess that causes false heals, so the experiment runs
   * with it off and on.
   */
  constructor(readonly options: { soleCandidate?: boolean } = {}) {}
  get name() {
    return this.options.soleCandidate ? 'locator-healer+sole-candidate' : 'locator-healer';
  }
  async propose(task: HealTask): Promise<string | undefined> {
    const e = task.failure.error;
    if (e instanceof ElementNotFound) {
      const key = e.selector.name ?? e.selector.label ?? e.selector.testId;
      if (!key) return undefined;
      const field: 'name' | 'label' | 'testId' = e.selector.name ? 'name' : e.selector.label ? 'label' : 'testId';
      const pool = e.available.filter((a) => (!e.selector.role || a.role === e.selector.role) && a[field]);
      const hit = best(pool, (a) => similarity(key, a[field]!)) ?? (this.options.soleCandidate && pool.length === 1 ? pool[0] : undefined);
      return hit ? quoteAll(task.code, key, hit[field]!) : undefined;
    }
    if (e instanceof RouteNotFound) {
      const word = e.route.replace(/^\//, '');
      const hit = best(e.routes, (r) => Math.max(similarity(word, r.path.replace(/^\//, '')), similarity(word, r.title)));
      return hit ? quoteAll(task.code, e.route, hit.path) : undefined;
    }
    if (e instanceof MethodNotFound) {
      const hit = best(e.available, (m) => similarity(e.method, m));
      return hit ? task.code.split(`api.${e.method}(`).join(`api.${hit}(`) : undefined;
    }
    return undefined;
  }
}

/**
 * Runs any command as the agent: the task goes to stdin as JSON plus instructions, the command
 * prints the whole new file on stdout. Example: BDDR_AGENT="claude -p" (not testable in the POC
 * environment, where no model is reachable).
 */
export class CommandAgent implements Agent {
  constructor(readonly command: string) {}
  get name() {
    return `command: ${this.command}`;
  }
  async propose(task: HealTask): Promise<string | undefined> {
    const instructions = [
      'You repair one compiled test. Reply with the complete new file and nothing else.',
      'Rules: never change any check(...) call or its body; never remove a check; never change the header;',
      'keep every quoted value and number that the prompt mentions; change only how the test gets there',
      '(selectors, routes, API names, waits).',
      '',
      `Prompt:\n${task.prompt.prose}`,
      `Failure (${task.failure.outcome}): ${task.failure.error?.message ?? ''}`,
      `Details: ${JSON.stringify(task.failure.error ?? {})}`,
      '',
      `Current file:\n${task.code}`,
    ].join('\n');
    const r = spawnSync(this.command, { shell: true, input: instructions, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0 || !r.stdout.trim()) return undefined;
    return r.stdout.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
  }
}
