# Serial features

Run the scenarios of a feature one after another, in file order, while that feature still runs in parallel with
other features and its scenarios keep their groups.

```gherkin
@serial
Feature: Checkout journey
  Scenario: add to basket      # 1st
  Scenario: pay                # starts when "add to basket" has finished (passed or not)
  Scenario: see the receipt    # then this
```

| where | effect |
|---|---|
| `@serial` on a Feature | every scenario in the feature waits for the previous one |
| `@serial` on a Rule | only that rule's scenarios are chained |
| config `featureMode: 'serial'` | every feature is serial; `@parallel` on a Feature opts it out |

Rules and guarantees:

- Order is file order (outline and data rows in row order). One scenario of the feature runs at a time.
- A failed scenario does not stop the next one: the chain orders, it does not depend. Use `@dependsOn:<id>` when a
  scenario really needs an earlier one to pass (a declared dependency still wins: it is skipped if that one failed).
- Different features, and other groups, run in parallel as usual (`workers`, `pool: 'process'`). A parallel group
  with two serial features runs the two features side by side, each in order.
- Groups, locks, priorities, retries and `@exclusive` still apply on top. A scenario retry happens before the next
  scenario starts.
- Selecting a subset (`-t`, `--name`, `file:line`, `--rerun-failed`) chains only what is selected; it never pulls in the
  other scenarios of the feature.
- `--shard` keeps a serial feature on one shard.
- Errors (exit 2): `@serial` on a single scenario, `@serial` and `@parallel` together, and a scenario that
  `@dependsOn` a later scenario in the same serial feature (a cycle).
- `bddr plan` shows the chain as `<- previous (feature runs in file order)`.

To share one browser session (context, page, login) across a serial feature, use feature-scoped fixtures
(docs/FIXTURES.md); with Playwright: `@serial @reuseContext` on the Feature, or the plugin option
`reuseContext: 'serial'`. In the process pool every scenario of a serial feature runs in the same worker process, so the
session survives between them.

Implementation: `core/src/plan/planner.ts` adds soft dependencies `via: 'serial:feature' | 'serial:rule'` between
consecutive selected scenarios after selection; `PlanNode.serial` marks them. Tests: `runtime/test/serial-feature.test.ts`.
