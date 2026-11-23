# Dependency mapping: what the tests cover

Dependencies, `@requires`, group `dependsOn`, `@serial` chains and locks all turn into one thing: edges in the plan
(`buildPlan`, `core/src/plan/planner.ts`), which the scheduler (`runtime/src/scheduler.ts`) then obeys. These tests pin
that behaviour at three levels.

| Level | File | Tests | What it checks |
| --- | --- | --- | --- |
| Plan (unit) | `packages/core/test/plan-corners.test.ts` | 86 | How tags and config become edges; what a selection pulls in; errors; rendering; sharding |
| Plan (basics) | `packages/core/test/plan.test.ts`, `shard.test.ts` | 15 + 6 | The original happy paths, plus `@requires` |
| Run time (unit) | `packages/runtime/test/dependency-matrix.test.ts` | 50 | Order under concurrency, skips and their reasons, retries, groups, serial, outlines, exports, locks, scale |
| Pool (unit) | `packages/runtime/test/pool.test.ts` | 4 of 14 | The same rules through coordinator and worker lanes, including a worker crash |
| End to end | `packages/cli/test/dependencies-e2e.test.ts` | 11 | A multi-file graph through the real CLI: inline pool and real worker processes must agree on every result |
| Other | `orchestration.test.ts`, `resilience.test.ts` | 13 + 13 | Concurrency, locks, group retry (older tests) |

## Corner cases by area

- **Ids:** exact id, default id (`file::slug`), outline family (`rows` matches `rows[1]`...), one row (`rows[2]`), case
  sensitivity, unknown id, empty tag value, self reference, an outline depending on its own family, duplicate ids across
  files, repeated references (hard wins over soft), inheritance from feature, rule and Examples tags.
- **Groups:** `@dependsOn:group:x` (hard and `:soft`), config `dependsOn`, `onDependencyFailure: 'run'`, transitive chains,
  a scenario in both groups, empty groups, unknown groups, group cycles, `match` expressions, group priorities and locks.
- **Selection:** transitive pull-in, diamonds (`pulledInBy`), `--no-deps`, soft edges neither pull in nor stay when the
  target is not selected, a tag filter such as `not @wip` does not stop a dependency being pulled in, selection from a
  separate parse, a 3000-scenario chain.
- **`@serial` and `@parallel`:** file-order chain with soft edges, only selected scenarios chained, rules, `featureMode`,
  explicit hard edges inside a serial feature, a dependency on a later scenario (reported as a cycle with an explanation).
- **`@requires`:** relative, root-relative and path-ending resolution, `./` and `..`, exact path beats path ending,
  ambiguous and missing files, self reference, cycles, `:soft`, on scenario or rule, transitive pull-in, with `@serial`.
- **Cycles:** direct, long, soft, through groups, through `@requires`, several at once, diamonds that are not cycles,
  20000-node chains with and without a cycle (no stack overflow). The scheduler's own safety net skips cycle members.
- **Run time:** diamond and fan-out/fan-in ordering, a 100-scenario chain on 8 workers, priority never beats a
  dependency, skip reasons and cascades, every non-passing status (pending, skipped, undefined, ambiguous), scenario retry,
  group retry, quarantine, dry run, `--fail-fast`, outline rows, exports, locks, `@exclusive`, serial and capped groups,
  300-chain and 200x200 fan-in speed.
- **Sharding:** dependencies (hard and soft), `@requires`, serial features, groups, locks, pulled-in scenarios, determinism.

## Behaviours the tests pin (worth knowing, and worth challenging)

1. A hard dependency in any status other than `passed` skips the dependent: `failed`, `pending`, `undefined`,
   `ambiguous` and `skipped`, even with `--no-strict`.
2. A failing `@quarantine` scenario still counts as failed for its dependents.
3. With several failing dependencies the skip reason names the first one in declaration order.
4. `--fail-fast` wins over a dependency reason, and it stops soft dependents too.
5. A group named in a config `dependsOn` must itself be declared in the config; a group that only appears in tags is an
   error (`groups.x.dependsOn: unknown group`).
6. An empty `@dependsOn` and a scenario depending on itself are ignored without a message.
7. A hard dependency is pulled in even when the tag filter would exclude it.
8. The executor refuses a plan with errors (unknown id, duplicate id, cycle) rather than running part of it.
9. An empty shard prints "Nothing to run", exits 0 and writes no events file.
10. Soft edges never pull targets in and are dropped when the target is not in the plan.

## Does the suite catch bugs?

Ten deliberate bugs were injected one at a time (hard no longer beating soft, soft treated as hard, soft pulling targets
in, serial chain hard, family matching removed, cycle detection off, duplicate check off, sharding ignoring edges, the
scheduler ignoring dependencies, `@requires` path ending beating an exact path). Every one made tests fail.

## Found while writing these

- The planner accepted the same `@id` in two files (only `bddr validate` reported it), so two scenarios shared one plan
  id and a dependent could wait on the wrong one. It is now a plan error, and `validate` reports it once.
