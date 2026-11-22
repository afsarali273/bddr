# Design note: code-linked Markdown specs (PARKED — later phase)

Status: idea captured 2026-11-15 from the project owner; not scheduled yet. Plugs in as a second `SpecParser`
(see `packages/core/src/ports.ts`), so nothing built today needs to change to support it.

## The idea

Write specs as **ordinary Markdown documents** (no Gherkin keywords, no fixed template). Where the document describes
an action or a check, it **references the actual automation code**: a function/method name, a file + line, or a link.
bddr resolves those references to step implementations (TypeScript now, Java later) and runs them in document order.
The same document, annotated with results, becomes the report.

Why it matters:
- **AI-driven automation**: an AI agent can write or update a spec by narrating intent in prose and pointing at existing
  code it found in the step catalogue, instead of inventing step sentences that then need glue code.
- **No translation layer**: the binding is explicit (a symbol), not a regex/expression match on English text.
- **Living documentation**: reports are the original Markdown, rendered nicely, with pass/fail beside each reference.

## Example (illustrative syntax, to be settled)

````markdown
# Checkout

Customers can pay for a basket with their wallet balance.

## Paying within the balance

A customer starts with [20.00 in their wallet](../steps/checkout.steps.ts#CheckoutSteps.fund "20.00").
They [pay 7.50](../steps/checkout.steps.ts#CheckoutSteps.pay "7.50") at the till.

Then `CheckoutSteps.left("12.50")` should hold, and a receipt is issued: `ReceiptSteps.receipt()`.

| product | qty |      <- a table right after a reference = that step's data table
| apple   | 2   |
````

## Binding forms (candidates)

| Form | Example | Notes |
| --- | --- | --- |
| Markdown link to a symbol | `[pay 7.50](../steps/checkout.steps.ts#CheckoutSteps.pay "7.50")` | Link text is prose; title carries args. Clickable in GitHub/IDEs |
| Link to file + line | `[pay](../steps/checkout.steps.ts#L42)` | Easy for humans, fragile when code moves; `bddr bind --fix` can rewrite to symbols |
| Inline code call | `` `CheckoutSteps.pay("7.50")` `` | Args inline, type-checked against the method signature |
| Fenced block | ```` ```bddr ```` with one call per line | For longer sequences |
| Java | `com.acme.CheckoutSteps#pay("7.50")` | Same resolver, JVM side |

Resolution prefers **symbols** (class.method / exported function) over line numbers, which drift.

## Mapping to the model

- Document = feature. A heading that contains at least one binding = a scenario (heading text = name).
  Headings without bindings = documentation sections (kept for reports).
- Each binding, in reading order = one `StepInstance` (`text` = the link text / prose sentence; `keyword` = '').
- Tags: front matter (`tags: [smoke, owner:payments]`) and/or `<!-- @smoke -->` comments under a heading.
- `@data`, groups, dependencies, retries: same tags, same semantics as Gherkin.
- Step dispatch: a new matcher keyed by symbol instead of expression. Needs the registry to index definitions by
  symbol name (class + method, function name) in addition to pattern — additive.

## Open questions

1. Which binding forms to support first (proposal: symbol links + inline calls).
2. File selection: a suffix (`.spec.md`) vs. any `.md` with front matter `bddr: true` vs. config globs only.
3. Argument typing: strings only, or parse literals against the TS/Java signature?
4. How a heading with bindings in nested sub-headings is split into scenarios.
5. Report renderer: Markdown → HTML with status badges inline, attachments collapsed under each binding.
6. Tooling: `bddr validate` (every reference resolves), step catalogue export with symbols for AI, an MCP tool.
