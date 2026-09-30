# Spec: Spreadsheet Clone — Phase 1 (Local MVP)

## Goal

A single-page web app served at `http://localhost:5173/sheet/<id>` that
renders a 2D grid of cells. A user can:

1. Click a cell to select it
2. Type to overwrite / press F2 or Enter to edit
3. Enter a plain value (number, string) or a formula (prefixed with `=`)
4. See formulas evaluated and re-evaluated when dependencies change
5. Reload the page and see their data still there

The app is single-user, single-sheet per URL. Auth, collaboration, and
multi-sheet tabs are **Phase 2 or later**.

## Scope (in)

- **Grid:** 100 rows × 26 columns (A–Z). Fixed row + column headers. Scrollable.
- **Cell editing:**
  - Click selects a cell (shows a blue outline).
  - Typing a character replaces cell contents and enters edit mode.
  - `F2` or `Enter` on a selected cell enters edit mode without replacing.
  - `Esc` cancels the edit, restores prior value.
  - `Enter` commits and moves selection down one row.
  - `Tab` commits and moves selection right one column.
  - Arrow keys navigate between cells.
- **Cell values:** strings, numbers, booleans (TRUE/FALSE), formulas.
- **Formulas:** prefix `=`. Must support the exact function set in
  `AGENTS.md § supported-formulas`. Cell references `A1`, ranges `A1:B10`,
  arithmetic `+ - * / ^`, parentheses.
- **Auto-recalc:** when any cell changes, all cells that transitively
  depend on it update within 200 ms.
- **Error values:** invalid formulas render as `#NAME?`, cycles as
  `#CYCLE!`, division by zero as `#DIV/0!`, ref to out-of-range as
  `#REF!`, type mismatches as `#VALUE!`.
- **Persistence:**
  - `POST /api/sheet/{id}` stores the full cell map (debounced 500 ms on the
    client after any edit).
  - `GET /api/sheet/{id}` returns the cell map.
  - Visiting a new `<id>` creates an empty sheet on first write.
  - Backing store: SQLite (`sheets.db`, one row per sheet, `cells` TEXT JSON).
- **Grid rendering:** virtualized in both axes. The DOM must contain at most
  ~3× the visible cells at any time (so scrolling through a sheet never
  bogs the browser). Use `@tanstack/react-virtual` or `react-window`.
- **Clipboard:**
  - `Ctrl/Cmd+C` on a selected cell copies the raw value (if formula, the
    formula text — not the evaluated value).
  - `Ctrl/Cmd+V` pastes. Accepts tab-separated rows / newline-separated
    columns (Excel & Sheets both emit this on copy).

## Scope (out)

Everything not explicitly listed in Scope (in). Specifically excluded to
avoid scope creep:
- Auth, user accounts, access controls, sharing.
- Multiple sheets / tabs per document.
- Undo / redo.
- Cell formatting (bold, italic, colors, borders, number format, conditional
  formatting).
- Named ranges.
- Charts, pivot tables, data validation.
- Column resize / row resize / column reorder / insert-row / insert-column.
- Freeze panes.
- CSV import / export.
- Real-time multi-user collaboration.
- Mobile / touch support.
- Localization / non-ASCII number formats.

## Constraints

- **Frontend:** React 18 + TypeScript + Vite. State management: Zustand.
- **Virtualization:** `@tanstack/react-virtual` (2-axis). Do **not** use
  AG-Grid, react-data-grid, or any heavyweight third-party grid — they
  have their own opinions about editing that will fight the formula bar.
- **Formula engine:** see `AGENTS.md § formula-engine` for the mandated
  choice + license rationale. The agent **must not write a custom parser**
  unless explicitly directed by the supervisor.
- **Backend:** FastAPI + SQLite. Single-file DB committed to the repo is OK
  for this phase. No migrations; the schema is 2 columns.
- **Testing:**
  - Backend: `pytest` + `httpx` client. Every endpoint gets at least one
    happy-path + one 4xx test.
  - Frontend unit: `vitest` + `@testing-library/react`.
  - E2E: **Playwright** (installed via `@playwright/test`). Every
    user-facing assertion in the validation contract must have a Playwright
    test.
- **Run command:** `docker compose up` brings up frontend (port 5173) +
  backend (port 8000). Both must restart with `--build` after code changes.
- **Code style:** TypeScript strict mode. No `any` in user-facing types.
  Backend uses type hints + mypy passes.

## Acceptance bar

These are the high-level checks the **planner** will expand into a
full `validation-contract.md`. They are *representative*, not
exhaustive. The planner must add more.

### Rendering
- [ ] `GET http://localhost:5173/sheet/newsheet` returns 200 and renders a
      grid with visible row numbers 1–N and column headers A–Z.
- [ ] Scrolling to row 100 still renders correctly; row 1 is not in the
      DOM when row 100 is visible (virtualization).

### Entering values
- [ ] Click cell A1, type `42`, press Enter. A1 shows `42`. Selection
      moves to A2.
- [ ] Reload the page. A1 still shows `42`.

### Formulas
- [ ] In A1 enter `10`. In A2 enter `20`. In A3 enter `=A1+A2`. A3 shows `30`.
- [ ] Change A1 to `5`. A3 updates to `25` within 200 ms. No reload needed.
- [ ] A3 = `=SUM(A1:A2)`. A3 shows 25. Change A2 to 100. A3 shows 105.
- [ ] `=1/0` in any cell renders `#DIV/0!`.
- [ ] `=FOO()` in any cell renders `#NAME?`.
- [ ] `=A1` entered in A1 renders `#CYCLE!`.
- [ ] A1=`=B1`, B1=`=A1`. Both render `#CYCLE!`.
- [ ] Transitive dep: A1=`1`, B1=`=A1`, C1=`=B1`. Change A1 → both B1 and
      C1 reflect the new value after recalc.

### Clipboard
- [ ] Select A1, `Ctrl+C`, click A2, `Ctrl+V`. A2 now contains the value
      previously in A1. (Formula text, not evaluated value, if applicable.)
- [ ] Copy TSV `1\t2\n3\t4` from a terminal, click A1, paste. A1=1,
      B1=2, A2=3, B2=4.

### Persistence
- [ ] `curl -X POST http://localhost:8000/api/sheet/foo \
      -H 'content-type: application/json' \
      -d '{"cells":{"A1":"99"}}'` returns 200.
- [ ] `curl http://localhost:8000/api/sheet/foo` returns `{"cells":{"A1":"99"}}`.

### Non-functional
- [ ] 100-cell rapid-edit scenario: script types into 100 different cells
      back-to-back. All edits persist; recalc doesn't deadlock. Total wall
      time < 5 s.
- [ ] Opening a sheet with 2600 cells populated renders first paint in < 2 s
      on a mid-range laptop.

---

> **Harness:** the autonomous 3-agent harness at `~/autonomous-harness/`
> will expand this into 20–30 assertions and 15–25 features. Before
> running, check `AGENTS.md` for the non-negotiables.
