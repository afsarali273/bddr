# POC: prompt-driven tests

> **Status: PARKED (2026-11-28).** Discovery is done and the results are kept on this branch. Do not build further until the owner resumes it. Next step when resumed: rerun the experiment with a real model (`BDDR_AGENT="claude -p"`).

Discovery work on the branch `poc/prompt-tests`. Nothing here is part of bddr yet; nothing outside this folder
depends on it, and `npm run verify` ignores it.

The idea: a test is a **prompt**. An agent compiles it once into ordinary TypeScript, which is saved next to the
prompt. While the hashes match, the compiled code runs with **no model at all**. When the app changes and the code
breaks, an agent repairs it within a budget, and the repair must pass a gate that keeps the prompt's checks intact.
Design: [docs/design/prompt-driven-tests.md](../../docs/design/prompt-driven-tests.md). Results: [FINDINGS.md](FINDINGS.md).

## Try it

Run from a checkout with `npm install` done (the POC uses the repo's `tsx`, `typescript` and `vitest`).

```bash
cd poc/prompt-tests
npx tsx src/cli.ts status                       # state of every prompt test
npx tsx src/cli.ts run                          # run the compiled tests: 12 pass, 0 agent calls
npx tsx src/cli.ts run --mutate basket-route --heal propose     # a cosmetic change: broken, then healed
npx tsx src/cli.ts run --mutate refusal-message --heal propose  # a real bug: fails, never healed
npx tsx src/cli.ts approve --by you             # approve checks (after editing a prompt's checks)
npx tsx experiment/run-experiment.ts            # the full experiment, writes experiment/RESULTS.md
npx vitest run                                  # unit tests
npx tsc -p tsconfig.json                        # type-check
```

`--mutate` takes any names from `app/shop.ts` (cosmetic changes, real bugs, `flaky-network`), comma-separated.
`--heal propose` writes accepted heals to `*.proposal.ts.txt`; `--heal write` writes them into the compiled file.

To try a real model as the healer, set `BDDR_AGENT` to a command that reads the task on stdin and prints the new
file, for example `BDDR_AGENT="claude -p" npx tsx src/cli.ts run --mutate coupon-labels --heal propose`.
This could not be tested here: no model is reachable from the POC environment.

## The two files

A prompt, `tests/coupon-discount.prompt.md`. Only `id:` is required; the text is free.

````markdown
id: coupon-discount
tags: payments

A customer with 50.00 in the wallet puts one melon (20.00) in the basket and applies the coupon "SAVE10".
The basket total drops to 18.00, and after paying 32.00 is left in the wallet.

```checks
C1 the basket total shows 18.00 after the coupon
C2 after paying, the wallet holds 32.00
```
````

Its compiled test, `tests/coupon-discount.test.ts`. The two are paired by `id`, never by file name.

```ts
// @bddr-compiled: generated from a prompt. Edit the prompt, not this file.
// id: coupon-discount
// prompt: 7552c96c6f23
// checks: 8a75f1cae3ff
export default async ({ ui, api, check, expect }: any) => {
  const customer = api.createCustomer({ name: 'Di', email: 'di@example.com', password: 'pw', wallet: 50.0 });
  api.loginAs(customer.id);
  ui.goto('/shop');
  ui.click({ role: 'button', name: 'Add Melon to basket' });
  ui.goto('/basket');
  ui.fill({ role: 'textbox', label: 'Coupon' }, 'SAVE10');
  ui.click({ role: 'button', name: 'Apply' });
  await check('C1', () => expect(ui.text({ role: 'status', name: 'Total' })).toBe('18.00'));
  ui.click({ role: 'button', name: 'Pay 18.00' });
  await check('C2', () => expect(api.walletBalance(customer.id)).toBeCloseTo(32.0));
};
```

`tests/approvals.json` records what a person approved: the checks' hash, the hash of each check's code, the
action code's data, and the code's shape. The healer never writes it.

## States

| State | Meaning | What happens |
| --- | --- | --- |
| `current` | Prompt, checks and check code all match what was approved | Runs from compiled code, no model |
| `prompt-changed` | The prompt's text (not its checks) changed | Recompile |
| `checks-unapproved` | Checks are new or changed | Waits for `approve` |
| `check-code-changed` | Someone or something edited how a check is verified | Waits for `approve` |
| `not-compiled` | No compiled file has this id | Compile |
| `invalid` | No id, no checks, a duplicate id, or a syntax error | Fix the file |

## How a failure is handled

| Failure | Healed? |
| --- | --- |
| `action-failed`: navigation, a click or setup could not find its target | Yes, within the budget (3 attempts) |
| `check-target-missing`: a check could not find what it inspects | Only as a proposal for a person |
| `check-failed`: a check's assertion did not hold | Never. This is the bug the test exists to catch |
| `contract-violation`: a check is missing, unknown or ran twice | Never |
| `environment`: network or infrastructure | Retried (up to 3 runs), never healed |

A heal candidate must pass the gate (`src/gate.ts`, `src/heal.ts`):

| Rule | Checks | On failure |
| --- | --- | --- |
| G1 | The file parses and keeps its id | Rejected |
| G3 | Every check body equals the approved one; none added or removed | Removed or added: rejected. Changed: proposal |
| G4 | Every value the prompt quotes is used as often as before; no new numbers in the action code | Rejected |
| G5 | It passes, then passes again 3 times with no agent | Gave up |
| G6 | The code's shape is unchanged: only targets (strings, member names) differ | Proposal |

The gate never trusts the candidate's header; `approvals.json` is the only authority.

## Layout

| Path | What |
| --- | --- |
| `src/prompt-file.ts` | Prompt parser and hashes |
| `src/compiled.ts` | Compiled-file parser: header, check bodies, action literals, shape (TypeScript AST) |
| `src/runtime.ts` | Runs compiled code, enforces the contract, classifies failures |
| `src/project.ts` | Pairs prompts and compiled files by id, works out states, `approve` |
| `src/gate.ts`, `src/heal.ts` | Acceptance gate and heal loop |
| `src/agents.ts` | `LocatorHealer` (no model) and `CommandAgent` (any CLI, such as a coding agent) |
| `src/runner.ts`, `src/cli.ts` | Run a folder; command line |
| `app/shop.ts` | The app under test: an in-memory shop with a screen model, plus cosmetic, bug and environment mutations |
| `tests/` | 12 prompts, their compiled tests, `approvals.json` |
| `experiment/` | The experiment, adversarial agents, results |
| `unit/` | Unit tests |
