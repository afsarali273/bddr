# Design note: prompt-driven tests (DISCOVERY, branch `poc/prompt-tests`)

Status: proof of concept, 2026-11-24. Not scheduled; kept only if it shows potential.
Full research and design: the claude.ai doc "bddr: prompt-driven tests (research and design)".
POC, how to run it, and results: [poc/prompt-tests/README.md](../../poc/prompt-tests/README.md),
[poc/prompt-tests/FINDINGS.md](../../poc/prompt-tests/FINDINGS.md).

## Idea

A test is a prompt with an `id:` line and a ```` ```checks ```` block of numbered claims. An agent compiles it into
TypeScript saved next to it, with the prompt's hash in a header. While hashes match, the code runs with no model.
When the code breaks, an agent repairs it under a gate. A person approves the checks once.

## Rules (as built in the POC)

- Prompt and compiled file are paired by `id`, never by file name.
- Three things are hashed separately: the prompt text, the check lines, and each check's code.
  `approvals.json` (written only by `approve`) is the authority; the compiled file's header is informational.
- Failures are classified by where they happened. Only action-code failures are healed. A failed check is reported.
  A check that cannot find its target can only produce a proposal.
- A heal is accepted automatically only if checks are unchanged (G3), the prompt's quoted data is used as often as
  before (G4), it passes 3 more times without the agent (G5), and the code's shape is unchanged (G6). Otherwise it is
  rejected or becomes a proposal for a person.
- Environment failures are retried, never healed.

## Result in one line

84% of cosmetic breakages healed with no model and no false heals; 0 of 12 real bugs ended green; 0 of 84 adversarial
heal attempts accepted after adding the count and shape rules (one got through before).
