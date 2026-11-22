# Conformance suite

Language-neutral contract that every bddr engine (TypeScript now, Java later) must pass.

```
conformance/
  features/<name>.feature         the spec under test
  features/<name>.expected.json   the expected outcome
  data/                           files referenced by @data: tags (the data folder)
  ts/steps.ts                     TypeScript implementation of the shared step vocabulary
  ts/conformance.test.ts          runs every feature and compares with expected.json
```

## Shared step vocabulary

Every engine implements exactly these steps (see `ts/steps.ts` for the reference):

| Step | Behaviour |
| --- | --- |
| `a passing step` | does nothing |
| `a failing step` | throws `Error("boom")` |
| `a pending step` | marks pending |
| `a skipping step` | skips the scenario with reason `"skipped on purpose"` |
| `I record {string}` | appends the text to the run trace |
| `I record the row value {string}` | appends `"<name>=<value>"` from the outline row |
| `the table has {int} rows` | asserts data-table body row count |
| `the doc string says {string}` | asserts doc string content |
| `a step that sleeps {int} ms` | waits |
| `a step that passes on attempt {int}` | records `attempt <k>` (k = ctx.step.attempt); throws until k >= n |
| `a step that fails on repetition {int}` | records `repetition <k>`; throws when k = n |
| `a step that passes on scenario attempt {int}` | records `scenario attempt <k>` (k = ctx.scenario.attempt); throws until k >= n |

Step-level tags (`@repeat`, `@retry`, `@delay`, `@backoff`, `@timeout`, `@concurrency`) and `{{i}}`/`{{n}}` placeholders
are part of the contract (see `step-repeat-retry.feature`).

Hooks used by the suite (registered only for scenarios/features tagged as below):

| Tag | Hook |
| --- | --- |
| `@trace-hooks` (feature) | records `beforeFeature`, `afterFeature` |
| `@trace-hooks` (scenario) | records `before <name>`, `after <name>` |
| `@fail-before` (scenario) | Before hook throws `Error("before failed")` |
| `@fail-feature` (feature) | BeforeFeature hook throws `Error("feature setup failed")` |

## expected.json

```json
{
  "scenarios": { "<scenario id>": "passed | failed | skipped | pending | undefined | ambiguous" },
  "steps":     { "<scenario id>": ["passed", "failed", "skipped"] },
  "trace":     ["ordered", "strings", "recorded"],
  "config":    { "workers": 1, "groups": { "name": { "mode": "serial" } } },
  "success":   false
}
```

Only the keys present are compared. `config` = plan options (Phase 3); keep `workers: 1` when asserting `trace` order. Scenario ids follow the stable-id rules in docs/IMPLEMENTATION.md.
