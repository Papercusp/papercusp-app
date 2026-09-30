# AGENTS.md — non-negotiables

This file is read by every worker and validator. It supersedes inference
from the codebase. When in doubt, follow this over what you think the
code wants.

## formula-engine

**Use `hyperformula` (npm).** Do not write a formula parser. Do not use
Formula.js, fast-formula-parser, Luckysheet, Univer, or anything else
without explicit supervisor approval.

Why: hyperformula gives us the full dependency graph + topological recalc +
~400 Excel-compatible functions + error handling. Writing any of that
yourself is a multi-week project and the validator will surface the bugs
for 20 hours before you catch up.

Import: `import { HyperFormula } from 'hyperformula';`

**License note:** hyperformula is dual-licensed: GPLv3, or a paid
commercial license from Handsontable. Building and running this project
locally for yourself creates no obligations. If you DISTRIBUTE it, the
GPLv3 applies to the combined work: ship it under GPLv3 or buy the
commercial license. Being non-commercial does not waive that. Do not
vendor hyperformula into Papercusp itself, which is released under the
Elastic License 2.0 and is incompatible with GPLv3. If distribution
comes up, stop and ask the supervisor which licence route to take.

## supported-formulas

Phase 1 minimum — every one of these must work:

- Arithmetic: `+`, `-`, `*`, `/`, `^`, parentheses
- Cell refs: single (`A1`, `$A$1`), ranges (`A1:B10`)
- `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`
- `IF(cond, then, else)`, `AND`, `OR`, `NOT`
- `CONCAT`, `LEN`, `UPPER`, `LOWER`, `TRIM`
- `ROUND`, `ABS`, `SQRT`
- `TODAY()`, `NOW()`

Any others are bonus; hyperformula supports them out of the box. Don't
disable anything.

## virtualization

**Use `@tanstack/react-virtual`** with a 2D (rows + cols) virtualizer. At
any given moment the DOM should have ≤3× the visible cell count.

You MUST NOT render all 2600 cells as DOM nodes. The validator will
programmatically check `document.querySelectorAll('[data-cell]').length`
while scrolled to different regions and fail you if it's >500 at any
single scroll position.

## state management

Use **Zustand** for client state. Keep the grid data in a `Map<string, Cell>`
keyed by `A1`-style references. Do not store computed values in state — let
hyperformula compute on demand and return results.

## testing

- Every user-facing assertion in `validation-contract.md` must have a
  Playwright test.
- Every endpoint must have at least one happy-path + one 4xx test.
- Tests live in `tests/` (backend), `src/**/*.test.tsx` (frontend unit),
  `e2e/` (Playwright).
- `npm test` in `apps/web` must run unit + e2e. `pytest` in `apps/api`
  must run the backend suite.

## project structure

```
sheets-clone/
├── apps/
│   ├── web/                # React + Vite frontend
│   │   ├── src/
│   │   ├── e2e/            # Playwright
│   │   └── package.json
│   └── api/                # FastAPI backend
│       ├── main.py
│       ├── tests/
│       └── pyproject.toml
├── docker-compose.yml
├── SPEC.md                 # Input
└── AGENTS.md               # This file
```

## known traps the validator should check

The following are known rough edges. Validators must specifically probe
them, not rely on implementers doing so:

1. **Transitive recalc.** A1=1, B1==A1*2, C1==B1*2. Change A1 to 5 → C1
   must become 20. A naive recalc updates direct deps only and leaves C1
   at its stale value.
2. **Cycle vs non-cycle disambiguation.** `=A1` in A1 is a cycle.
   `=A1+A2` in A3 is not. `=A1:A10` in A5 is not (the range self-include
   is only a cycle if A5 is USED in the sum, which is language-dependent).
   Follow Google Sheets conventions.
3. **Formula text persistence.** Copying a cell with `=SUM(A1:A10)` and
   pasting into another cell must copy the **formula text**, not the
   evaluated number. Excel/Sheets both do this.
4. **Paste range expansion.** Pasting TSV into a single cell expands into
   multiple cells. `1\t2\n3\t4` pasted into A1 → fills A1, B1, A2, B2.
5. **Keyboard focus after Enter.** After `Enter`, selection must move to
   the cell below but the input field must NOT remain focused — a
   subsequent keypress should overwrite the newly selected cell.
6. **Double-click edit mode preserves cursor position.** Double-clicking
   a cell enters edit mode with the cursor inside the existing text (not
   replacing it). Typing alone without double-click *does* replace.

## what the validator should NOT do

- Don't read the source to decide if something works. Run it first.
- Don't accept "I can't test this locally" as a reason to pass a feature.
  If Playwright can't reach it, fail it.
- Don't approve a feature whose tests are marked `skip` or `xfail`.
- Don't auto-approve based on "the worker said they tested it" — they
  probably did, poorly.

## escalation triggers (auto-ping supervisor)

- Any feature at `attempts >= 4` with consistent failure on the same
  assertion → supervisor should clarify the spec, not just reset attempts.
- Validator reports the worker is using a different formula engine than
  `hyperformula` → halt immediately.
- Any feature implementing UI that's not cell-editing-related before Phase
  1 core features are passed → scope drift; halt.
