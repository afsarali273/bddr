import type { ScenarioInstance } from '../model.js';

/**
 * Orchestration vocabulary (Phase 3).
 *
 * Tags on Feature / Rule / Scenario / Examples (inherited like any tag):
 *   @group:<name>                 membership (repeatable)
 *   @id:<id>                      stable id, the target of dependencies
 *   @dependsOn:<id>               hard dependency on a scenario id (all outline/data rows when the id has rows)
 *   @dependsOn:<id>:soft          soft dependency: waits for it, runs whatever its result
 *   @dependsOn:group:<name>[:soft] dependency on every member of a group
 *   @requires:<file.feature>[:soft] dependency on every scenario of another feature file (path relative to this file,
 *                                 to the project root, or the end of a unique path)
 *   @lock:<name>                  never runs at the same time as another holder of <name> (repeatable)
 *   @priority:<n>                 lower runs first among ready scenarios (default: group priority, else 0)
 *   @exclusive                    runs alone: nothing else in flight
 *
 * Config (bddr.config.ts `groups`):
 *   groups: { checkout: { mode: 'parallel', workers: 4, dependsOn: ['setup'], match: '@checkout' } }
 */
export type GroupMode = 'parallel' | 'serial' | 'exclusive';

export interface GroupConfig {
  /** parallel (default): members run concurrently up to `workers`; serial: one at a time; exclusive: alone in the run. */
  mode?: GroupMode;
  /** Max members of this group running at once (parallel mode). Default: unlimited (global workers apply). */
  workers?: number;
  /** Groups that must finish before any member starts. */
  dependsOn?: string[];
  /** 'skip' (default): members are skipped when a dependency group has a failure. 'run': soft dependency. */
  onDependencyFailure?: 'skip' | 'run';
  priority?: number;
  /** Locks every member holds. */
  locks?: string[];
  /** Tag expression: scenarios matching it join the group (in addition to @group tags). */
  match?: string;
  /**
   * Group retry: when the group has finished and any member did not pass, run the group again
   * (BeforeGroup/AfterGroup included) up to this many extra times. Dependents of members wait until the group settles.
   */
  retry?: number;
  /** Which members a group retry re-runs: 'all' (default) or only 'failed' ones. */
  retryMembers?: 'all' | 'failed';
  /** Default scenario retry for members (each member retried on its own, before any group retry). */
  scenarioRetry?: number;
  /** Time budget for one complete group attempt, e.g. '2m'. */
  timeout?: string | number;
}

export interface PlanOptions {
  groups?: Record<string, GroupConfig>;
  /** Max scenarios running at once in the whole run. Default 1 (serial). */
  workers?: number;
  /** Include dependencies of selected scenarios even if not selected. Default true. */
  withDeps?: boolean;
  /**
   * How scenarios WITHOUT any group run. Shorthand for `groups.default.mode`.
   * When set (or when `groups.default` is configured), ungrouped scenarios join the group `default`.
   * Unset: ungrouped scenarios are unconstrained (parallel up to `workers`).
   */
  defaultMode?: GroupMode;
  /**
   * How the scenarios INSIDE a feature run. 'parallel' (default): independent. 'serial': one after another in file
   * order (each waits for the previous one to finish, whatever its result), while different features still run in
   * parallel and scenarios keep their groups. Per feature: `@serial` / `@parallel` on the Feature (or `@serial` on a Rule).
   */
  featureMode?: 'parallel' | 'serial';
}

export interface PlanDependency {
  /** Node id this node waits for. */
  target: string;
  soft: boolean;
  /** The reference as written: 'create-order', 'group:setup', 'group-config:setup'. */
  via: string;
}

export interface PlanNode {
  id: string;
  scenario: ScenarioInstance;
  /** Named groups only (the implicit default group is not listed). */
  groups: string[];
  deps: PlanDependency[];
  locks: string[];
  priority: number;
  exclusive: boolean;
  /** Position in the base order (features together, file order). Final tie-breaker. */
  order: number;
  /** Set when the node was not selected but pulled in as a dependency of these node ids. */
  pulledInBy?: string[];
  /** Scenario retries from `@retry:N` (or `@noRetry` = 0), else the max `scenarioRetry` of its groups. Unset = config default. */
  retry?: number;
  /** Tagged @quarantine. */
  quarantined: boolean;
  /** Runs in file order within its feature (@serial feature, `featureMode: 'serial'`) or rule (@serial rule). */
  serial?: 'feature' | 'rule';
}

export interface PlanGroup {
  name: string;
  mode: GroupMode;
  workers?: number;
  dependsOn: string[];
  onDependencyFailure: 'skip' | 'run';
  priority: number;
  locks: string[];
  members: string[];
  /** Declared in config (vs. only seen in tags). */
  configured: boolean;
  /** The automatic `default` group created by `defaultMode`: scheduling only, no hooks/events/store. */
  implicit?: boolean;
  /** Group retry (extra runs of the group). 0 = none. */
  retry: number;
  retryMembers: 'all' | 'failed';
  /** Time budget for one group attempt in milliseconds. */
  timeoutMs?: number;
}

export interface PlanError {
  message: string;
  scenarioId?: string;
  uri?: string;
  line?: number;
}

export interface Plan {
  /** In base order. */
  nodes: PlanNode[];
  byId: Map<string, PlanNode>;
  groups: Map<string, PlanGroup>;
  workers: number;
  errors: PlanError[];
}
