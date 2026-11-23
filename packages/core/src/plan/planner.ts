import type { ScenarioInstance } from '../model.js';
import { compileTagExpression } from '../tags.js';
import { parseDuration } from '../step-tags.js';
import type { GroupConfig, Plan, PlanDependency, PlanError, PlanGroup, PlanNode, PlanOptions } from './types.js';

interface RawDep {
  ref: string;
  soft: boolean;
  group?: string;
  /** `@requires:<file>`: every scenario of that feature file. */
  file?: string;
}

/** `@requires:<file.feature>[:soft]` */
function parseRequires(value: string): RawDep {
  const soft = value.endsWith(':soft');
  const file = soft ? value.slice(0, -5) : value.endsWith(':hard') ? value.slice(0, -5) : value;
  return { ref: `requires:${file}`, soft, file };
}

/** Collapse `.` and `..` in a forward-slash path. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function parseDependsOn(value: string): RawDep {
  let v = value;
  let soft = false;
  if (v.endsWith(':soft')) {
    soft = true;
    v = v.slice(0, -5);
  } else if (v.endsWith(':hard')) v = v.slice(0, -5);
  if (v.startsWith('group:')) return { ref: value, soft, group: v.slice(6) };
  return { ref: v, soft };
}

/** Keep features together in first-appearance order; keep file order inside a feature. */
function baseOrder(scenarios: readonly ScenarioInstance[]): ScenarioInstance[] {
  const byUri = new Map<string, ScenarioInstance[]>();
  for (const s of scenarios) {
    const l = byUri.get(s.uri);
    if (l) l.push(s);
    else byUri.set(s.uri, [s]);
  }
  return [...byUri.values()].flat();
}

/**
 * Build and validate the execution plan.
 * @param all      every parsed scenario (needed to resolve dependency targets and pull them in)
 * @param selected the user's selection (tags, names, lines); dependencies are added when withDeps
 */
export function buildPlan(all: readonly ScenarioInstance[], selected: readonly ScenarioInstance[], options: PlanOptions = {}): Plan {
  const errors: PlanError[] = [];
  const err = (message: string, s?: ScenarioInstance) =>
    errors.push({ message, ...(s ? { scenarioId: s.id, uri: s.uri, line: s.line } : {}) });
  const configs = options.groups ?? {};
  const matchers = Object.entries(configs).flatMap(([name, g]) => {
    if (!g.match) return [];
    try {
      return [{ name, pred: compileTagExpression(g.match) }];
    } catch (e) {
      errors.push({ message: `groups.${name}.match: ${(e as Error).message}` });
      return [];
    }
  });

  // --- per-scenario facts from tags
  const info = new Map<
    ScenarioInstance,
    { groups: string[]; deps: RawDep[]; locks: string[]; priority?: number; exclusive: boolean; retry?: number; quarantined: boolean }
  >();
  const factsOf = (s: ScenarioInstance) => {
    let f = info.get(s);
    if (f) return f;
    const tagNames = s.tags.map((t) => t.name);
    const groups: string[] = [];
    const deps: RawDep[] = [];
    const locks: string[] = [];
    let priority: number | undefined;
    let exclusive = false;
    let retry: number | undefined;
    let quarantined = false;
    for (const t of s.tags) {
      if (t.key === 'retry') {
        const n = Number(t.value);
        if (!Number.isInteger(n) || n < 0) err(`@retry:${t.value ?? ''} on a scenario needs a whole number >= 0`, s);
        else retry = n;
        continue;
      }
      if (t.key === 'noRetry') {
        retry = 0;
        continue;
      }
      if (t.key === 'quarantine') {
        quarantined = true;
        continue;
      }
      if (t.key === 'group' && t.value) groups.push(t.value);
      else if (t.key === 'dependsOn' && t.value) deps.push(parseDependsOn(t.value));
      else if (t.key === 'requires' && t.value) deps.push(parseRequires(t.value));
      else if (t.key === 'lock' && t.value) locks.push(t.value);
      else if (t.key === 'priority' && t.value !== undefined) {
        const n = Number(t.value);
        if (Number.isFinite(n)) priority = n;
        else err(`@priority:${t.value} is not a number`, s);
      } else if (t.key === 'exclusive') exclusive = true;
    }
    for (const m of matchers) if (m.pred(tagNames)) groups.push(m.name);
    f = {
      groups: [...new Set(groups)],
      deps,
      locks: [...new Set(locks)],
      exclusive,
      quarantined,
      ...(priority !== undefined ? { priority } : {}),
      ...(retry !== undefined ? { retry } : {}),
    };
    info.set(s, f);
    return f;
  };

  // --- id index (exact ids and outline/data "families": `x` matches `x[...]`)
  const byId = new Map<string, ScenarioInstance>();
  const families = new Map<string, ScenarioInstance[]>();
  const owners = new Map<string, ScenarioInstance[]>();
  for (const s of all) {
    const same = owners.get(s.id);
    if (!same) owners.set(s.id, [s]);
    else if (!same.some((o) => o.uri === s.uri && o.line === s.line)) same.push(s);
    byId.set(s.id, s);
    const b = s.id.indexOf('[');
    if (b > 0) {
      const fam = s.id.slice(0, b);
      families.set(fam, [...(families.get(fam) ?? []), s]);
    }
  }
  // Ids are dependency targets and keys of results, so two scenarios must never share one.
  for (const [id, list] of owners) {
    if (list.length > 1) err(`Scenario id "${id}" is duplicated at ${list.map((s) => `${s.uri}:${s.line}`).join(', ')}`, list[1]);
  }
  const resolveRef = (ref: string): ScenarioInstance[] => {
    const exact = byId.get(ref);
    if (exact) return [exact];
    return families.get(ref) ?? [];
  };
  const groupMembersAll = (name: string) => all.filter((s) => factsOf(s).groups.includes(name));
  /**
   * Scenarios of the feature file a `@requires:<file>` names: exact path relative to the requiring file's folder, else
   * relative to the project root, else a unique path suffix (`@requires:login.feature` finds `features/auth/login.feature`).
   * An empty result means no file matched; `ambiguous` lists several files that matched equally well.
   */
  const fileMembers = (spec: string, from: ScenarioInstance): { members: ScenarioInstance[]; ambiguous?: string[] } => {
    const uris = [...new Set(all.map((s) => s.uri))];
    const dir = from.uri.includes('/') ? from.uri.slice(0, from.uri.lastIndexOf('/')) : '';
    const want = normalizePath(spec);
    const exact = [normalizePath(`${dir}/${spec}`), want].find((c) => uris.includes(c));
    let picked: string[] = exact ? [exact] : uris.filter((u) => u === want || u.endsWith(`/${want}`));
    if (picked.length > 1) return { members: [], ambiguous: picked };
    picked = picked.filter((u) => u !== from.uri);
    return { members: all.filter((s) => s.uri === picked[0]) };
  };

  // --- selection closure (withDeps)
  // Keyed by id (not object identity) so `selected` may come from a separate parse of the same files.
  const included = new Map<string, string[] | undefined>(); // value = pulledInBy
  const selectedNodes: ScenarioInstance[] = [];
  for (const sel of selected) {
    const s = byId.get(sel.id);
    if (!s) {
      errors.push({ message: `Selected scenario "${sel.id}" is not among all scenarios`, scenarioId: sel.id });
      continue;
    }
    included.set(s.id, undefined);
    selectedNodes.push(s);
  }
  if (options.withDeps ?? true) {
    const queue = [...selectedNodes];
    while (queue.length) {
      const s = queue.shift()!;
      const f = factsOf(s);
      const targets: ScenarioInstance[] = [];
      for (const d of f.deps) {
        if (d.soft) continue; // soft deps only order what is already selected
        targets.push(...(d.file !== undefined ? fileMembers(d.file, s).members : d.group ? groupMembersAll(d.group) : resolveRef(d.ref)));
      }
      for (const g of f.groups) {
        const cfg = configs[g];
        if (!cfg?.dependsOn || cfg.onDependencyFailure === 'run') continue;
        for (const dg of cfg.dependsOn) targets.push(...groupMembersAll(dg));
      }
      for (const t of targets) {
        if (t === s) continue;
        if (!included.has(t.id)) {
          included.set(t.id, [s.id]);
          queue.push(t);
        } else {
          const by = included.get(t.id);
          if (by && !by.includes(s.id)) by.push(s.id);
        }
      }
    }
  }

  // --- groups
  const groups = new Map<string, PlanGroup>();
  const groupTimeouts = new Map<string, number | undefined>();
  const DEFAULT = 'default';
  const useDefaultGroup = options.defaultMode !== undefined || DEFAULT in configs;
  const groupTimeout = (name: string, c: GroupConfig): number | undefined => {
    if (groupTimeouts.has(name)) return groupTimeouts.get(name);
    if (c.timeout === undefined) {
      groupTimeouts.set(name, undefined);
      return undefined;
    }
    try {
      const ms = typeof c.timeout === 'number' ? c.timeout : parseDuration(c.timeout);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error('must be greater than 0');
      groupTimeouts.set(name, ms);
      return ms;
    } catch (e) {
      errors.push({ message: `groups.${name}.timeout: ${(e as Error).message}` });
      groupTimeouts.set(name, undefined);
      return undefined;
    }
  };
  const ensureGroup = (name: string): PlanGroup => {
    let g = groups.get(name);
    if (!g) {
      const c: GroupConfig = configs[name] ?? {};
      g = {
        name,
        mode: c.mode ?? (name === DEFAULT ? options.defaultMode : undefined) ?? 'parallel',
        dependsOn: [...(c.dependsOn ?? [])],
        onDependencyFailure: c.onDependencyFailure ?? 'skip',
        priority: c.priority ?? 0,
        locks: [...(c.locks ?? [])],
        members: [],
        retry: c.retry ?? 0,
        retryMembers: c.retryMembers ?? 'all',
        configured: name in configs,
        ...(groupTimeout(name, c) !== undefined ? { timeoutMs: groupTimeout(name, c) } : {}),
        ...(name === DEFAULT && !(name in configs) ? { implicit: true } : {}),
        ...(c.workers !== undefined ? { workers: c.workers } : {}),
      };
      groups.set(name, g);
    }
    return g;
  };
  for (const name of Object.keys(configs)) ensureGroup(name);
  for (const [name, c] of Object.entries(configs)) {
    for (const dg of c.dependsOn ?? []) if (!(dg in configs)) errors.push({ message: `groups.${name}.dependsOn: unknown group "${dg}"` });
    if (c.workers !== undefined && (!Number.isInteger(c.workers) || c.workers < 1)) {
      errors.push({ message: `groups.${name}.workers must be a positive integer` });
    }
    for (const k of ['retry', 'scenarioRetry'] as const) {
      const v = c[k];
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) errors.push({ message: `groups.${name}.${k} must be a whole number >= 0` });
    }
  }

  // --- nodes
  const ordered = baseOrder(all.filter((s) => included.has(s.id)));
  const nodes: PlanNode[] = ordered.map((s, order) => {
    const f = factsOf(s);
    if (useDefaultGroup && !f.groups.length) f.groups = [DEFAULT];
    for (const g of f.groups) ensureGroup(g).members.push(s.id);
    const groupPriorities = f.groups.map((g) => configs[g]?.priority).filter((p): p is number => p !== undefined);
    const groupLocks = f.groups.flatMap((g) => configs[g]?.locks ?? []);
    const pulledInBy = included.get(s.id);
    const groupRetries = f.groups.map((g) => configs[g]?.scenarioRetry).filter((r): r is number => r !== undefined);
    const retry = f.retry ?? (groupRetries.length ? Math.max(...groupRetries) : undefined);
    return {
      quarantined: f.quarantined,
      ...(retry !== undefined ? { retry } : {}),
      id: s.id,
      scenario: s,
      groups: f.groups,
      deps: [],
      locks: [...new Set([...f.locks, ...groupLocks])],
      priority: f.priority ?? (groupPriorities.length ? Math.min(...groupPriorities) : 0),
      exclusive: f.exclusive || f.groups.some((g) => configs[g]?.mode === 'exclusive'),
      order,
      ...(pulledInBy ? { pulledInBy } : {}),
    };
  });
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // --- resolve dependencies to node ids
  for (const n of nodes) {
    const f = factsOf(n.scenario);
    const add = (target: string, soft: boolean, via: string) => {
      if (target === n.id) return;
      const existing = n.deps.find((d) => d.target === target);
      if (existing) existing.soft &&= soft; // hard wins
      else n.deps.push({ target, soft, via });
    };
    for (const d of f.deps) {
      if (d.file !== undefined) {
        const { members, ambiguous } = fileMembers(d.file, n.scenario);
        if (ambiguous) err(`@requires:${d.file}: matches several feature files (${ambiguous.join(', ')}); write more of the path`, n.scenario);
        else if (!members.length) err(`@requires:${d.file}: no feature file with this path (or it is this scenario's own file)`, n.scenario);
        for (const m of members) if (nodeById.has(m.id)) add(m.id, d.soft, `requires:${d.file}`);
        continue;
      }
      if (d.group) {
        if (!groups.has(d.group) && !all.some((s) => factsOf(s).groups.includes(d.group!))) {
          err(`@dependsOn:${d.ref}: unknown group "${d.group}"`, n.scenario);
          continue;
        }
        for (const m of groupMembersAll(d.group)) if (nodeById.has(m.id)) add(m.id, d.soft, `group:${d.group}`);
        continue;
      }
      const targets = resolveRef(d.ref);
      if (!targets.length) {
        err(`@dependsOn:${d.ref}: no scenario has this id (use @id:<name> on the target)`, n.scenario);
        continue;
      }
      for (const t of targets) if (nodeById.has(t.id)) add(t.id, d.soft, d.ref);
    }
    for (const g of n.groups) {
      const cfg = configs[g];
      for (const dg of cfg?.dependsOn ?? []) {
        for (const m of groupMembersAll(dg)) {
          if (nodeById.has(m.id) && !n.groups.includes(dg)) add(m.id, cfg!.onDependencyFailure === 'run', `group-config:${g}->${dg}`);
        }
      }
    }
  }

  // --- serial features / rules: each scenario waits for the previous one (soft: it runs whatever that one's result).
  // Added after selection, so running one scenario never pulls in the others; only selected ones are chained.
  const featureSerial = (s: ScenarioInstance): boolean => {
    const ft = s.feature.tags.map((t) => t.key);
    if (ft.includes('serial') && ft.includes('parallel')) err(`Feature "${s.feature.name}" has both @serial and @parallel`, s);
    if (ft.includes('serial')) return true;
    if (ft.includes('parallel')) return false;
    return options.featureMode === 'serial';
  };
  const ruleSerial = (s: ScenarioInstance): boolean => !!s.rule?.tags.some((t) => t.key === 'serial');
  const misplaced = new Set<string>();
  const chains = new Map<string, PlanNode[]>();
  for (const n of nodes) {
    const s = n.scenario;
    const own = s.tags.filter((t) => (t.key === 'serial' || t.key === 'parallel') && !s.feature.tags.some((f) => f.name === t.name) && !s.rule?.tags.some((r) => r.name === t.name));
    for (const t of own) {
      if (!misplaced.has(`${s.uri}:${t.name}`)) err(`${t.name} belongs on the Feature (or a Rule), not on a scenario`, s);
      misplaced.add(`${s.uri}:${t.name}`);
    }
    const kind = featureSerial(s) ? 'feature' : ruleSerial(s) ? 'rule' : undefined;
    if (!kind) continue;
    n.serial = kind;
    const key = kind === 'feature' ? `f:${s.uri}` : `r:${s.uri}:${s.rule!.id}`;
    chains.set(key, [...(chains.get(key) ?? []), n]);
  }
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.order - b.order);
    for (let i = 1; i < chain.length; i++) {
      const n = chain[i]!;
      const prev = chain[i - 1]!;
      if (!n.deps.some((d) => d.target === prev.id)) n.deps.push({ target: prev.id, soft: true, via: `serial:${n.serial}` });
    }
  }

  // --- cycle detection (iterative DFS, reports one cycle path per strongly connected loop)
  const state = new Map<string, 0 | 1 | 2>();
  const reported = new Set<string>();
  for (const start of nodes) {
    if (state.get(start.id)) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: start.id, i: 0 }];
    const path: string[] = [start.id];
    state.set(start.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const deps = nodeById.get(top.id)!.deps;
      if (top.i < deps.length) {
        const next = deps[top.i++]!.target;
        const st = state.get(next) ?? 0;
        if (st === 0) {
          state.set(next, 1);
          stack.push({ id: next, i: 0 });
          path.push(next);
        } else if (st === 1) {
          const cycle = [...path.slice(path.indexOf(next)), next];
          const key = [...cycle].sort().join('|');
          if (!reported.has(key)) {
            reported.add(key);
            const serial = cycle.slice(1).some((id, i) => nodeById.get(cycle[i]!)!.deps.find((d) => d.target === id)?.via.startsWith('serial:'));
            err(
              `Dependency cycle: ${cycle.join(' -> ')}${serial ? ' (a @serial feature or rule runs in file order, so a scenario cannot depend on a later one in it)' : ''}`,
              nodeById.get(next)!.scenario,
            );
          }
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
        path.pop();
      }
    }
  }

  const workers = options.workers ?? 1;
  if (!Number.isInteger(workers) || workers < 1) errors.push({ message: `workers must be a positive integer (got ${workers})` });

  return { nodes, byId: nodeById, groups, workers, errors };
}

/** Human explanation of why/when a node runs. */
export function explainNode(plan: Plan, id: string): string {
  const n = plan.byId.get(id);
  if (!n) {
    const close = [...plan.byId.keys()].filter((k) => k.includes(id)).slice(0, 5);
    return `"${id}" is not in the plan.${close.length ? ` Did you mean:\n  ${close.join('\n  ')}` : ''}`;
  }
  const lines = [`${n.id}`, `  ${n.scenario.uri}:${n.scenario.line}  "${n.scenario.name}"`];
  lines.push(n.pulledInBy ? `  included: not selected, pulled in as a dependency of ${n.pulledInBy.join(', ')}` : '  included: selected');
  lines.push(`  groups: ${n.groups.length ? n.groups.map((g) => `${g} (${plan.groups.get(g)?.mode})`).join(', ') : '(default)'}`);
  lines.push(`  priority: ${n.priority}${n.exclusive ? ', exclusive (runs alone)' : ''}`);
  if (n.locks.length) lines.push(`  locks: ${n.locks.join(', ')}`);
  if (!n.deps.length) lines.push('  waits for: nothing (ready at start)');
  else {
    lines.push('  waits for:');
    for (const d of n.deps) lines.push(`    - ${d.target} [${d.soft ? 'soft: runs whatever its result' : 'hard: skipped if it does not pass'}] via ${d.via}`);
  }
  const dependents = plan.nodes.filter((m) => m.deps.some((d) => d.target === n.id)).map((m) => m.id);
  if (dependents.length) lines.push(`  needed by: ${dependents.join(', ')}`);
  return lines.join('\n');
}

export type { PlanDependency };
