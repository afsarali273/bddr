# Instructions for AI assistants working on this repo

This file is read automatically by Claude Code (and is useful to any AI agent). Follow it before writing code.

## Where to work

The ONLY working copy is the user's folder `/Users/afsarali/Repository/AI_Projects/BDD_Framework`.
Write all code and docs there directly (in a cloud session: `device_bash` under `$HOME/mnt/BDD_Framework`).
Do not build in a separate workspace and hand over zips.

## Resume protocol (do this first, every session)

1. Read `docs/STATUS.md` (what exists, what remains), then `docs/PROGRESS.md` top to bottom. The **"Next up"**
   section of PROGRESS.md says exactly what to do.
2. Skim `docs/IMPLEMENTATION.md` for the module you will touch.
3. Run `npm install && npm run verify`. Everything must be green before you start.
   If it is not, fixing that IS the next task. Record it in PROGRESS.md.
4. Work in small steps. After each completed step:
   - `npm run verify` must pass,
   - tick the item in `docs/ROADMAP.md`,
   - add a dated entry to the **Session log** in `docs/PROGRESS.md` (what changed, files touched, anything half-done),
   - update **Next up**, and `docs/STATUS.md` when a feature lands or a remaining item changes.
5. If you stop mid-task (context limit, error you cannot solve), write a **"Stopped mid-task"** entry in
   PROGRESS.md: the goal, what is done, the exact failing command/output, and your best hypothesis.

## Rules

- **Event schema is a contract** (`packages/core/src/events.ts`). Additive changes only; breaking changes need a
  new `EVENT_SCHEMA_VERSION` and an ADR in `docs/DECISIONS.md`.
- **Conformance first** for behaviour changes: add or update a feature + `.expected.json` in `conformance/features/`
  so the Java port inherits the rule. Update the step vocabulary table in `conformance/README.md` if you add steps.
- **Failure semantics** live in the header comment of `packages/runtime/src/executor.ts` and in IMPLEMENTATION.md.
  Change both together.
- Any non-obvious choice (library, format, behaviour) gets an ADR in `docs/DECISIONS.md`.
- Keep packages layered: `core` imports nothing internal; `runtime` and `reporters` import only `core`;
  `cli` imports all. Reporters must work from events alone.
- TypeScript strict mode, ESM, NodeNext resolution. Relative imports end in `.js`.
- Tests: vitest. Unit tests next to each package in `test/`. Tests import packages by name (`@bddr/core`);
  `vitest.config.ts` aliases those to `src`, so tests need no build. CLI end-to-end tests use the built `dist`
  and are skipped when it is missing.
- Never commit `node_modules`, `dist`, `reports`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | `tsc -b` all packages |
| `npm test` | all vitest suites |
| `npm run typecheck` | build + type-check tests/examples |
| `npm run example` | run `examples/basic` through the CLI |
| `npm run example:orchestration` / `example:orchestration:process` / `example:resilience` | the other examples (inline / worker processes) |
| `npm run verify` | typecheck + test + all examples (what must be green before and after every change) |
| `node packages/cli/dist/bin.js --help` | CLI help |

## Documentation map

| File | Read it for |
| --- | --- |
| `docs/STATUS.md` | Everything done so far and everything remaining, on one page |
| `docs/PROGRESS.md` | Current state, **Next up**, known gaps, session log |
| `docs/IMPLEMENTATION.md` | How each module works (packages, orchestration, resilience, worker processes, logging, events) |
| `docs/DECISIONS.md` | ADRs: why things are the way they are |
| `docs/ROADMAP.md` | Phase checklists (tick items here) |
| `docs/design/code-linked-markdown.md` | Parked design (owner decides when to start) |
| `conformance/README.md` | Conformance step vocabulary |
