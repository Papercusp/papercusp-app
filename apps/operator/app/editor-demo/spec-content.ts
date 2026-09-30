export const SPEC_CONTENT = `# Spec: Spreadsheet Clone — Phase 1 (Local MVP)

## Goal

A single-page web app served at \`http://localhost:5173/sheet/<id>\` that
renders a 2D grid of cells. A user can:

1. Click a cell to select it
2. Type to overwrite / press F2 or Enter to edit
3. Enter a plain value (number, string) or a formula (prefixed with \`=\`)
4. See formulas evaluated and re-evaluated when dependencies change
5. Reload the page and see their data still there

The app is single-user, single-sheet per URL. Auth, collaboration, and
multi-sheet tabs are **Phase 2 or later**.

## Scope (in)

- **Grid:** 100 rows × 26 columns (A–Z). Fixed row + column headers. Scrollable.
- **Cell editing:**
  - Click selects a cell (shows a blue outline).
  - Typing a character replaces cell contents and enters edit mode.
  - \`F2\` or \`Enter\` on a selected cell enters edit mode without replacing.
  - \`Esc\` cancels the edit, restores prior value.
  - \`Enter\` commits and moves selection down one row.
  - \`Tab\` commits and moves selection right one column.
  - Arrow keys navigate between cells.
- **Cell values:** strings, numbers, booleans (TRUE/FALSE), formulas.
- **Formulas:** prefix \`=\`. Must support the exact function set in
  \`AGENTS.md § supported-formulas\`. Cell references \`A1\`, ranges \`A1:B10\`,
  arithmetic \`+ - * / ^\`, parentheses.
- **Auto-recalc:** when any cell changes, all cells that transitively
  depend on it update within 200 ms.
- **Error values:** invalid formulas render as \`#NAME?\`, cycles as
  \`#CYCLE!\`, division by zero as \`#DIV/0!\`, ref to out-of-range as
  \`#REF!\`, type mismatches as \`#VALUE!\`.
- **Persistence:**
  - \`POST /api/sheet/{id}\` stores the full cell map (debounced 500 ms).
  - \`GET /api/sheet/{id}\` returns the cell map.
  - Backing store: SQLite (\`sheets.db\`, one row per sheet).

## Scope (out)

Everything not explicitly listed in Scope (in). Specifically excluded:
- Auth, user accounts, access controls, sharing.
- Multiple sheets / tabs per document.
- Undo / redo.
- Cell formatting (bold, italic, colors, borders).
- Charts, pivot tables, data validation.
- Real-time multi-user collaboration.

## Constraints

- **Frontend:** React 18 + TypeScript + Vite. State management: Zustand.
- **Virtualization:** \`@tanstack/react-virtual\` (2-axis).
- **Formula engine:** see \`AGENTS.md § formula-engine\`.
- **Backend:** FastAPI + SQLite.
- **Testing:**
  - Backend: \`pytest\` + \`httpx\`.
  - Frontend unit: \`vitest\` + \`@testing-library/react\`.
  - E2E: **Playwright**.
- **Run command:** \`docker compose up\` brings up frontend (5173) + backend (8900).
- **Code style:** TypeScript strict mode. No \`any\` in user-facing types.

## Acceptance bar

### Rendering
- [ ] \`GET http://localhost:5173/sheet/newsheet\` returns 200 and renders a grid.
- [ ] Scrolling to row 100 still renders correctly; row 1 is not in the DOM.

### Entering values
- [ ] Click cell A1, type \`42\`, press Enter. A1 shows \`42\`.
- [ ] Reload the page. A1 still shows \`42\`.

### Formulas
- [ ] In A1 enter \`10\`. In A2 enter \`20\`. In A3 enter \`=A1+A2\`. A3 shows \`30\`.
- [ ] Change A1 to \`5\`. A3 updates to \`25\` within 200 ms.
- [ ] A3 = \`=SUM(A1:A2)\`. A3 shows 25. Change A2 to 100. A3 shows 105.
- [ ] \`=1/0\` in any cell renders \`#DIV/0!\`.
- [ ] \`=FOO()\` in any cell renders \`#NAME?\`.
- [ ] \`=A1\` entered in A1 renders \`#CYCLE!\`.

### Persistence
- [ ] \`curl -X POST http://localhost:8900/api/sheet/foo -d '{"cells":{"A1":"99"}}'\` returns 200.
- [ ] \`curl http://localhost:8900/api/sheet/foo\` returns \`{"cells":{"A1":"99"}}\`.

### Non-functional
- [ ] 100-cell rapid-edit scenario: total wall time < 5 s.
- [ ] Opening a sheet with 2600 cells populated renders first paint in < 2 s.

---

> **Harness:** the autonomous 3-agent harness will expand this into 20–30 assertions and 15–25 features.

## Proposal: Undo/Redo

- Enter \`42\` in A1, \`Ctrl+Z\` → A1 renders empty. \`Ctrl+Shift+Z\` → A1 renders \`42\`.
- After 20 distinct edits across 20 cells, 20 consecutive \`Ctrl+Z\` presses fully restore the empty sheet.
- A paste that fills a range is a single undo step.
- Undo stack is bounded (≥ 100 steps) and in-memory only.
- **Implied features**: F-UNDO-001 (history model), F-UNDO-002 (range/paste grouped).
- **Estimated cost**: M
- **Risk**: Undo that silently desynchronizes displayed value and persisted value.

## Proposal: CSV Import/Export

- Sheet page has a "Download CSV" control. Clicking it triggers download of \`<sheet-id>.csv\`.
- Sheet page has an "Import CSV" control that opens a file picker.
- Round-trip invariant: export → re-import → cell values match.
- Filenames and cell contents containing non-ASCII (e.g. \`한국\`, emoji) round-trip without 500s.
- **Implied features**: F-CSV-001, F-CSV-002, F-CSV-003.
- **Estimated cost**: S

## Proposal: Range Selection

- Click A1, shift-click C3 → cells A1:C3 are visibly highlighted as a range.
- Mousedown on A1, drag to C3, mouseup → same A1:C3 selection.
- With A1:C3 selected, \`Ctrl/Cmd+A\` extends to the whole grid.
- Pressing \`Delete\` clears all 9 cells in one persisted, atomic operation.
- **Implied features**: F-RANGE-001, F-RANGE-002, F-RANGE-003.
- **Estimated cost**: M

## Proposal: Multi-Sheet Tabs

- The route \`/sheet/<id>\` always opens the document's first/active tab.
- A \`+\` control appends a new sheet (\`Sheet2\`, \`Sheet3\`, …).
- Cross-sheet formulas: \`=Sheet2!B2\` evaluates to whatever B2 on Sheet2 currently holds.
- Renaming \`Sheet2\` to \`Revenue\` rewrites all formulas referencing it.
- Tab name spec: 1–31 chars, no \`:\` \`/\` \`\\\` \`?\` \`*\` \`[\` \`]\`.
- **Implied features**: F-TABS-001 through F-TABS-004.
- **Estimated cost**: L

## Proposal: Sort & Filter

- Click a column header → sort menu appears with \`Sort A→Z\`, \`Sort Z→A\`, \`Filter…\`.
- Sort is *value-aware*: numbers sort numerically; strings case-insensitively.
- Sort rewrites the cell map; formulas referencing moved cells get rewritten.
- Filter: opens a panel listing the column's distinct values with checkboxes.
- **Implied features**: F-SORT-001, F-FILT-001, F-SORT-FILT-002.
- **Estimated cost**: M
`;
