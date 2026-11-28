# Findings: prompt-driven tests, discovery phase

> **Status: PARKED (2026-11-28).** Discovery is done and the results are kept on this branch. Do not build further until the owner resumes it. Next step when resumed: rerun the experiment with a real model (`BDDR_AGENT="claude -p"`).

Date: 2026-11-24. Branch: `poc/prompt-tests`. Raw numbers: [experiment/RESULTS.md](experiment/RESULTS.md)
(first run, before two fixes: [experiment/RESULTS-run1.md](experiment/RESULTS-run1.md)).

## Verdict

**The idea works and is worth continuing.** In this POC the compiled tests ran with no model. Healing repaired most
cosmetic breakages and never hid a real bug. The rule that makes that true is simple and mechanical: a failed check is
never healed, and an automatic heal may only change what the code targets, never its structure or its checks.

The open question is not the mechanism but the model: no model was reachable here, so compiling and healing were done
by Claude by hand (compile) and by a deterministic heuristic (heal). The next step is to run the same harness with a
real model on your machine.

## What was built

- A runtime for prompt tests: prompt parser, hashes, compiled-file parser (TypeScript AST), contract enforcement,
  failure classification, approvals, states, a heal loop with an acceptance gate, and a CLI.
- A small shop app (no browser) with 11 cosmetic changes, 12 real bugs and 1 environment fault.
- 12 prompt tests across checkout, coupons, sign-in, lockout, search and sign-up, compiled by hand.
- Two healers without a model (a conservative locator healer and a bolder one), a `CommandAgent` for real models, and
  6 adversarial agents that try to turn a red test green the wrong way.
- An experiment that measures all of this, and 15 unit tests. Type-check is clean.

## Results

| Question | Result |
| --- | --- |
| Do compiled tests run without a model? | 12 of 12 passed in 31 ms with 0 agent calls |
| Do hashes react to the right edits? | 14 of 14 cases as designed: whitespace and formatting keep a test current; intent, checks and check code each need their own action |
| How many cosmetic breakages heal automatically? | 36 of 43 (84%) with the conservative healer; 40 of 43 (93%) with the bolder one |
| Do healed tests still catch bugs? | Yes: 468 comparisons (516 for the bolder healer), 0 false heals |
| Are all real bugs caught? | 12 of 12 |
| Does any real bug end green after healing? | 0 |
| With the "never heal a failed check" rule switched off, can a misbehaving agent get a green? | First run: 1 of 84 attempts got through. After the fix: 0 of 84 |
| Environment faults | 12 of 12 recovered by retry, 0 agent calls |

The experiment runs in about 3 seconds.

## What we learned

1. **Classification does most of the work.** Every real bug failed inside a check, and a failed check is never
   handed to the healer. Of 14 failures caused by bugs, 12 were `check-failed` (never healed) and 2 were
   `check-target-missing` (an error message that should have appeared did not), where the healer found nothing.

2. **Checking that the code still contains the prompt's data is not enough.** In the first run an adversarial agent
   made the wrong-password test green under a real bug ("Wrong password for ann@example.com"). It deleted the line that
   typed the email, so the app showed the generic message. The email still appeared in the setup line, so the "data
   still present" rule passed. Two fixes, both in the gate:
   - **G4 counts uses**, not presence: each quoted value from the prompt must be used as often as in the approved code.
   - **G6 compares the code's shape**: the AST with strings and member names masked. A heal that only re-targets
     (a label, a route, an API name) keeps the shape and can be accepted. Anything that adds, removes or reorders
     steps becomes a proposal for a person.

   After the fix, 0 of 84 adversarial attempts were accepted. The lesson generalises: **auto-accept only changes whose
   kind you can prove harmless; everything else goes to a person.**

3. **Shape is a clean line between "re-targeting" and "rewriting".** Every cosmetic heal in this experiment kept the
   shape, including a redesign that broke three things at once (healed in 3 attempts). The adversaries that changed
   behaviour all changed the shape or a check.

4. **The safety rule has a visible cost.** When a cosmetic change moves something a check reads (the basket total's
   label), the heal changes check code, so it becomes a proposal. In this run: 3 of 43 breakages. This is the right
   trade, but it means people will review some heals.

5. **Semantic renames need a model.** "Coupon" to "Promo code" and "Create account" to "Sign up" share no words. The
   conservative healer gives up; the bolder one guesses from "the only text box on the page" and was right here, with
   0 false heals. A model should handle these without guessing. The false-heal comparison would catch it if it guessed
   wrong.

6. **A cosmetic change and a real bug together still fail correctly.** With the basket moved and the refusal message
   wrong, the healer fixed the route, the check then failed, and the heal ended as `gave-up` with the check failure as
   the reason. The test reported the bug.

7. **Hashing needed care.** The first version hashed prose line by line, so re-wrapping a paragraph forced a
   recompile. Prose is now compared paragraph by paragraph with all whitespace collapsed.

8. **The false-heal measurement is itself valuable.** Re-running every healed test against every known bug and
   comparing with the original is a cheap, objective check of any healer, model or not. It could become a bddr feature
   (`bddr heal --verify`).

## Limits of this POC

- **No model.** Compiling was done by hand; healing by a heuristic that only swaps strings. A model will heal more and
  can also make subtler mistakes, which is exactly what the gate and the false-heal measurement are for.
- **No browser.** The app has a screen model (roles, names, labels) instead of real pages. Real pages add timing,
  iframes and dynamic content.
- **One small app**, 12 tests, mutations designed by the same person who wrote the tests.
- **Weak checks stay weak.** If a prompt's checks miss a claim, no gate can find the bug. The approval step and a
  verifier agent (designed, not built) are the defence.
- **Not wired into bddr.** These tests do not yet run through bddr's planner, scheduler, reports or worker processes.

## Recommended next steps

1. Run the experiment with a real model as the healer (`BDDR_AGENT="claude -p"`) and add a compile step that turns a
   prompt into code and proposes its checks. Measure heal rate, false heals and attempts per heal.
2. Add a Playwright fixture and repeat with the Playwright showcase app in a real browser.
3. Build the verifier agent and a review screen for proposals (prompt, checks, diff, before and after screenshots).
4. If those hold up, wire prompt tests into bddr as a spec format so dependencies, sharding and reports apply.
