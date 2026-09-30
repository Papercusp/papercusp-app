# Design — UI library guide for agents
URL: /internal/docs/design/index

Which libraries the harness UI uses, when to reach for each, and what NOT to hand-roll.

import { Aside } from '@astrojs/starlight/components';

The harness has a deliberate library set chosen to handle accessibility,
keyboard nav, focus management, scroll lock, and portal positioning
correctly. **Do not hand-roll modals, dropdowns, tabs, tooltips, or
checkboxes.** Reach for the wrappers in `app/harness/` first.

The `design-phase:get_design_spec` / `design-phase:list_tokens` MCP tools currently
resolve an **empty DESIGN\_SPEC** and a stale **light-mode `react-tailwind` palette**
(`packages/*/design/tokens/base.json`) — neither matches this app. The operator UI
is themed with **CSS custom properties** (`var(--accent)`, `var(--fg-mute)`, …) +
hand-authored `pc-*` classes (see [design tokens](/internal/docs/design/tokens)),
not Tailwind. **For operator UI work, design-first means this page + the
[tokens page](/internal/docs/design/tokens) — not the `design-phase:*` IR/validate/lint
pipeline**, until that tooling is either pointed at the real `design-tokens/*.tokens.json`
source or explicitly re-scoped to new/standalone react-tailwind surfaces. See EI-604
for the full gap + proposed remedies.

## Why we have a library guide

Hand-rolled UI controls (a `<div role="dialog">`, a `<select>` styled to look custom, a `title=` attribute used as a tooltip) consistently break in subtle ways: focus traps leak, ESC handling races with other listeners, scroll locks miss iOS, screen readers narrate the wrong thing, the dark theme fights the OS-native control. We've seen all of those in this codebase.

The library set documented here was chosen, installed, and applied across the harness page in a multi-phase migration. Every centered modal goes through one wrapper. Every drawer goes through one library. Every command palette goes through one. **If you find yourself writing `position: 'fixed', inset: 0`, stop and read this page.**

## Decision matrix — which library for which pattern

| You're building…                                                                                      | Use                                                                                                                                                                                                                                       | Wrapper / entry point                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hover/focus tooltip on a button or label                                                              | `@radix-ui/react-tooltip`                                                                                                                                                                                                                 | `<Tooltip label="…">{button}</Tooltip>` from `app/harness/Tooltip.tsx`                                                                                                                                                           |
| Centered modal dialog                                                                                 | `@radix-ui/react-dialog`                                                                                                                                                                                                                  | `<Modal open onOpenChange title>…</Modal>` from `app/harness/Modal.tsx`                                                                                                                                                          |
| Side-slide drawer (right- or left-anchored panel)                                                     | `vaul`                                                                                                                                                                                                                                    | `<Drawer.Root direction="right">` from `vaul`                                                                                                                                                                                    |
| Command palette / fuzzy launcher                                                                      | `cmdk` + `@radix-ui/react-dialog`                                                                                                                                                                                                         | See `app/_components/CommandPalette.tsx`                                                                                                                                                                                         |
| Tabs (real tabs with content panels)                                                                  | `@radix-ui/react-tabs`                                                                                                                                                                                                                    | `<Tabs.Root><Tabs.List><Tabs.Trigger><Tabs.Content>`                                                                                                                                                                             |
| Filter pills / scoped filters                                                                         | `@radix-ui/react-tabs` (asChild) **OR** native button + `aria-pressed`                                                                                                                                                                    | See gotchas page                                                                                                                                                                                                                 |
| Single-select dropdown (replacement for `<select>`)                                                   | `@radix-ui/react-select`                                                                                                                                                                                                                  | `<Select value onChange options>` from `app/harness/Select.tsx`                                                                                                                                                                  |
| Checkbox (replacement for `<input type=checkbox>`)                                                    | `@radix-ui/react-checkbox`                                                                                                                                                                                                                | `<Checkbox checked onChange>` from `app/harness/Checkbox.tsx` (supports indeterminate)                                                                                                                                           |
| Text / number / email / search input                                                                  | native `<input>` (styled via global baseline) **OR** `<TextInput>` for leading/trailing slots                                                                                                                                             | `<TextInput>` / `<TextArea>` from `app/harness/TextInput.tsx`; unwrapped `<input>` inherits the same look from `globals.css`                                                                                                     |
| Action button                                                                                         | native `<button>` (neutral, baseline-styled) for inline form/grid actions; `<Button variant="primary">` for the page's primary CTA; `<Button variant="destructive">` for delete/clear/forget; `<Button variant="ghost">` for low-emphasis | `<Button>` from `app/harness/Button.tsx`; unwrapped `<button>` inherits the same look from `globals.css`                                                                                                                         |
| Expandable / collapsible section                                                                      | `@radix-ui/react-collapsible`                                                                                                                                                                                                             | `<Collapsible.Root><Collapsible.Trigger><Collapsible.Content>`                                                                                                                                                                   |
| Toast / notification                                                                                  | `sonner`                                                                                                                                                                                                                                  | `import { toast } from 'sonner'` — `toast.success()`, `toast.error()`                                                                                                                                                            |
| Hover card (rich content on hover)                                                                    | `@radix-ui/react-hover-card`                                                                                                                                                                                                              | Direct import (installed but currently unused — no live consumer; re-source an example when you add the first one)                                                                                                               |
| Icons                                                                                                 | `lucide-react`                                                                                                                                                                                                                            | `import { ChevronRight } from 'lucide-react'`                                                                                                                                                                                    |
| Single-submit form (one Submit button, atomic persist)                                                | `react-hook-form` + `zod` (or `ajv` for plugin schemas)                                                                                                                                                                                   | `useFormWith(schema)` + `<FormField>` + `<SubmitButton>` from `@/lib/forms`                                                                                                                                                      |
| Per-field auto-save settings page (no Submit button)                                                  | Independent `useState` + debounced save                                                                                                                                                                                                   | `useDebouncedSave(value, persist)` from `app/harness/useDebouncedSave.tsx`                                                                                                                                                       |
| Tabular list with custom-styled rows (status pills, action buttons, hover popovers, expand-to-detail) | `@papercusp/grid-core` `RichGrid`                                                                                                                                                                                                         | `<RichGrid<Row> rows columns={[{key, header, render: ({ row }) => …}]} getRowId />`                                                                                                                                              |
| Static admin table with declarative cell types (text, stepper, price, checkbox, expand)               | `@papercusp/grid-core` `GridTable`                                                                                                                                                                                                        | `<GridTable headers data columnTypes={{ qty: 'stepper' }} />`                                                                                                                                                                    |
| 5000+ rows of mostly-scalar data, performance is the constraint                                       | `@papercusp/grid-core` `DataGridShell` (canvas)                                                                                                                                                                                           | `<DataGridShell headers data formatters />`                                                                                                                                                                                      |
| Kanban board (drag cards between status columns)                                                      | vendored Kibo UI primitives on `@dnd-kit`                                                                                                                                                                                                 | `<KanbanProvider columns data onDataChange overlay>` + `KanbanBoard`/`KanbanHeader`/`KanbanCards`/`KanbanCard` from `app/harness/Kanban.tsx` (token CSS in `Kanban.css`; consumer example: `app/admin/plans/PlanKanbanView.tsx`) |

## Token quick-reference

The design section **does** have a full token-system page: [design tokens](/internal/docs/design/tokens). Use that page when changing tokens or themes. This short version is for component authors:

* Component code uses **semantic CSS variables**: `--bg*` for surfaces, `--fg*` for text, `--border*` for borders, `--accent*` for interactive accent, `--good` / `--warn` / `--bad` for status.
* Do not use brand primitives like `--sky-400` in components. Those are source palette values generated into `_brand-primitives.css`; themes swap the semantic layer, not the primitive layer.
* Do not hardcode sky/cyan literals (`#38bdf8`, `#7dd3fc`, `#bae6fd`, `rgba(103,232,249,…)`) in app UI. Use `var(--accent*)` or `color-mix()` over a semantic token.
* `var(--token, #fallback)` is allowed. The fallback is only for rendering outside a themed root; the token still wins in the app.
* Raw brand/product/media colors are allowed only for actual brand marks, avatars, user-generated media, screenshots, color swatches, or generated token CSS. When in doubt, route through a semantic token.

## Hard rules

1. **Never write `<div role="dialog">` or `aria-modal="true"` by hand.** Use `<Modal>` (centered) or `<Drawer.Root>` (side panel). Both wire focus trap, scroll lock, ESC, outside-click, and portal correctly.

2. **Never write `<input type="checkbox">` for harness UI.** Use `<Checkbox>`. The native control can't represent indeterminate state declaratively, and won't pick up the focus ring our other controls use. *(Carve-out: native checkboxes inside rendered markdown task lists — and other places a React wrapper can't legitimately reach — are acceptable. Note there is now a **global `accent-color` baseline** in `globals.css` (`:where(input[type="checkbox"], input[type="radio"], input[type="range"]) { accent-color: var(--accent) }`), so a stray native checkbox at least picks up the app accent tint automatically; some sites layer additional scoped refinements on top (e.g. `.pc-template-manifest-structured input[type=checkbox]` adds a `drop-shadow` glow — fully tokenized, the old `#22d3ee` hardcode is gone). The wrapper rule is still absolute for harness UI; the carve-out is for content rendered from text — see the markdown-rendering components like `app/_components/MarkdownEditor.tsx` and `app/settings/SettingsMarkdownEditor.tsx`.)*

3. **Never write `<select>` with `<option>` for harness UI.** Use `<Select>`. The native dropdown is OS-themed (white on macOS, system-chrome on Windows) and clashes hard with the dark UI. Radix Select renders a portaled listbox that we control.

4. **Never use `title=""` on an interactive element.** Use `<Tooltip label="…">`. Native `title=` has 1.5s delay, can't be styled, doesn't work on touch, and isn't keyboard-accessible. The lone exception is in grid cells (see gotchas).

5. **Never call `window.alert()`, `window.confirm()`, or `window.prompt()`.** Use `toast.error()` / `toast.success()` / `toast.info()` from sonner, or open a `<Modal>` for a confirm dialog.

6. **Never write a `<details>` block in a tsx file.** Use `<Collapsible.Root>`. Native `<details>` works but doesn't share the focus styles or animation system the rest of the harness uses; if you need a disclosure, use the same primitive everyone else uses.

7. **Pick the form pattern that matches the page's submission model.** There is no single "use RHF for forms" rule — that conflates two genuinely different submission models. Pick by how the page persists:

   * **Single-submit forms** (one Submit button, atomic persist, validation on submit, dirty tracking, redirect-or-stay on success): use `react-hook-form` via `useFormWith(zodSchema)` — or the AJV resolver for plugin-author JSON Schemas. Wrappers live in `apps/operator/lib/forms/`. *Canonical sites: `app/settings/profile/page.tsx`, `app/settings/oracle/OracleClient.tsx`, `app/settings/operator/page.tsx`, `app/settings/api-keys/page.tsx`.* (Note: `/login` is **not** one — it uses plain `useState` fields with an `onSubmit` handler, not `useFormWith`.)

   * **Per-field auto-save settings pages** (each control persists independently — toggle a switch, it saves — there is no "Submit"): use independent `useState` per field and `useDebouncedSave(value, persist)` from `app/harness/useDebouncedSave.tsx`. This is the right model for the macOS-System-Preferences / iOS-Settings shape of page. HR1/HR2/HR3/HR6 still apply — only the centralized form-state model from RHF is dropped. Test/preview buttons read the state vars directly (no `getValues()` bridge). *Canonical site: `app/settings/agent/page.tsx` — currently the only live `useDebouncedSave` consumer.* (`/settings/voice` and `/settings/backups` also auto-save per field, but via bespoke per-section save callbacks — e.g. `savePrefsPatch` in voice — not the `useDebouncedSave` hook; and `/settings/operator` is a single-submit `useFormWith` page, not auto-save.)

   * **Wizard flows** (multi-step with progress, each step its own slice of state): RHF per step with the step's local Zod slice, plus a parent state coordinator. *Canonical site: `app/_components/SetupWizard`.*

   Exceptions to all three: single-textarea chat composers and Monaco code editors — both explicitly out of scope; use plain `useState`.

8. **Never hand-roll a `<table>` for tabular data.** Use the appropriate component from `@papercusp/grid-core` — see the next section for which one. Hand-rolled tables miss out on consistent dark-theme styling, shared sort UX (`applySort`), virtualization (free in `RichGrid` and `DataGridShell`), and the conventions other panels follow (sticky header, alt-row striping, hover state). Exception: Markdown content rendering (the markdown-rendering components, e.g. `app/_components/MarkdownEditor.tsx` and `app/settings/SettingsMarkdownEditor.tsx`) — those are content-author tables, not UI tables.

9. **Buttons are flat — no 3D.** In-page action buttons and pills are flat: a solid (or `color-mix`-tinted) background, a 1px border, readable text. Do **not** give them an embossed bevel (`box-shadow: inset 0 1px 0 …`), a raised drop-shadow / glow (`box-shadow: 0 8px … rgba(0,0,0,…)`), a hover-lift or press (`transform: translateY(…)`), or a vertical "sheen" gradient fill (`linear-gradient(180deg, rgba(255,255,255,.05), …)`) — those read as 3D and hurt legibility. Hover/active = change the background/border colour, not the elevation. Keyboard focus rings (`:focus-visible`) are the one box-shadow/outline that stays. *Carve-out: the large top-level **page/tab nav** (e.g. the `/adv` tab strip) is a different category — it may keep its accent treatment.* See [buttons](#buttons) below for the flat recipe.

10. **Anchored panels use the anchored-panel primitive.** If a panel opens under or beside a trigger button, use `<Popover>` from `app/harness/Popover.tsx` or the matching Radix primitive. Do not write a trigger plus a sibling `open && <div role="dialog">…</div>` by hand; that loses portal positioning, outside-click handling, and focus restoration. *Carve-out: cursor-anchored context/status menus that are anchored to generated document content may use a local fixed-position menu if they use menu semantics (`role="menu"` / `menuitem*`), ESC/outside-click close, and a narrow comment explaining why a trigger-based popover is not a fit.*

11. **`aria-modal="true"` is only for real modals.** Use it through `<Modal>` / Dialog, not on non-trapping panels. A top deck, non-blocking overlay, popover, or menu should not claim modal semantics unless it traps focus and prevents interaction with the rest of the app.

12. **Animation libraries are restricted.** For normal app UI use CSS (`[data-anim]`), `@formkit/auto-animate`, or `motion`. Do not add `gsap` / `@gsap/react`. Cross-route flourish effects belong behind `FLAGS.TESTING`; production navigation should be direct and predictable.

13. **Declare UI dependencies before importing them.** A dependency imported by app source must be declared in the owning package's `package.json`. Do not rely on a transitive or extraneous package that happens to exist in the workspace install tree.

14. **Know which rules are lint-enforced.** `app/_lints/design-primitives.test.ts` covers a subset: native selects/tables/checkboxes/radios, direct confirm, action `title=` tooltips, some typography rules, and selected token leaks. `app/_lints/css-tokens.test.ts` validates token references. The rest of this page is still binding review policy even when no test catches it.

## Buttons

Buttons are **flat**. The look is a solid or `color-mix`-tinted surface, a 1px border, and readable text — no embossing, no elevation, no sheen.

```css
/* Flat button recipe — neutral in-page action button */
.my-btn {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--fg-dim);
  cursor: pointer;
  /* No box-shadow. No background gradient. No transform on hover/active. */
}
.my-btn:hover { color: var(--fg); border-color: var(--accent); }   /* colour, not lift */
.my-btn.is-active,                                                 /* selected = tinted fill */
.my-btn[aria-pressed="true"] {
  color: var(--fg);
  background: color-mix(in oklab, var(--accent), transparent 84%);
  border-color: color-mix(in oklab, var(--accent), transparent 55%);
}
.my-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; } /* the one ring that stays */
```

**Anti-patterns** (these are what "3D" means — don't):

* `box-shadow: inset 0 1px 0 rgba(255,255,255,…)` — top bevel/emboss.
* `box-shadow: 0 8px 18px rgba(0,0,0,…)` / `… rgba(<accent>,…)` — raised drop-shadow or glow.
* `transform: translateY(-1px)` on hover / `translateY(1px)` on active — lift / press.
* `background: linear-gradient(180deg, rgba(255,255,255,.05), …)` — vertical "sheen" fill.
* Low-contrast text on a tinted fill (e.g. `rgba(214,236,248,0.78)`) — use `var(--fg-dim)` → `var(--fg)`.

**Reach for the wrapper:** `<Button>` from `app/harness/Button.tsx` for emphasis variants; a bare `<button>` inherits the flat baseline. Token reference: [design tokens](/internal/docs/design/tokens#the-bluefrost-semantic-scale).

**`/adv` enforcement:** the `/adv` shell ships flat buttons via per-component flat-button recipes rather than a single scoped strip-everything rule — `.pc-advpanel__iconbtn` (flat 28×28 frost icon button) in `app/adv/harnesses/adv-panel-chrome.css` is the canonical flat *icon*-button recipe panels reuse. A flat **labeled** button is just `<Button>` (`app/harness/Button.tsx`) — the old `.pc-advpanel__btn` merely re-implemented its neutral look and was folded into the primitive (design-simplification P-015). (The body wrapper is `pc-adv-harnesses__body`, not the old `.pc-advshell__body`; the `pc-advshell__*` class family no longer exists in any live CSS or component — it survives only in stale e2e selectors. There is no scoped `box-shadow`-stripping backstop, so author buttons flat at the source.) The large top **tab strip** is page-level nav, a different category, and keeps its accent treatment.

## Soft rules (judgment calls)

* **Tooltips on grid-cell text.** When you're rendering thousands of rows in `RichGrid` and want truncation tooltips, `title="…"` on the cell `<span>` is fine. Wrapping each row in a Radix Tooltip mounts thousands of portals and listeners — bad perf. The "no native title=" rule is for *action elements*, not data cells.

* **Native `<datalist>` is allowed for progressive enhancement.** There is no shared combobox primitive yet. If you need browser autocomplete for a plain text input, `<datalist>` is acceptable as long as the field remains usable without it and the option set is small. If the user must choose from a controlled list, use `<Select>` or build a real combobox primitive first.

* **Filter pills vs real tabs.** If clicking the pill swaps which list of items is shown but the surrounding layout is the same, `<Tabs.Root>` + `<Tabs.List>` + `<Tabs.Trigger>` is correct (live example: `app/adv/sessions/AdvSessionsClient.tsx`, the session detail-panel tab strip). If clicking swaps fundamentally different content panels, add a `<Tabs.Content>` per panel. If the pills are mutually-exclusive boolean toggles where each one filters a single list, native `<button aria-pressed>` is also acceptable — `@radix-ui/react-toggle-group` would be ideal but is not currently installed.

* **HoverCard vs Tooltip.** Use Tooltip for short text labels. Use HoverCard for rich content (multi-line, links, badges, images). `@radix-ui/react-hover-card` is installed but has no live consumer right now — re-source a concrete example here once one lands.

* **Where to put the shared CSS.** Radix sets `data-state="active"` (when there's a matching `<Tabs.Content>`) and `aria-selected="true"` (always, on the trigger). Some of our existing CSS uses `.on` to mean active. We bridge with `[data-state="active"]` and `[aria-selected="true"]` attribute selectors at the bottom of `harness.css`. Add new aliases there, not inline.

## Grids — `RichGrid` vs `GridTable` vs `DataGridShell`

Three grid components in `@papercusp/grid-core`. Pick by what your cells need to do, not by row count alone.

| Use…                | When                                                                                                                                                 | Cell style                         | Virtualization             | Examples                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`RichGrid`**      | You want JSX cells: status pills, hover popovers, action buttons, multi-line content, per-row expand                                                 | Anything you can render in React   | Optional via `virtualMode` | `app/admin/plans/RunsPanel.tsx`, `app/adv/harnesses/WorkItemsPanel.tsx`, `app/adv/harnesses/AcceptancePanel.tsx`, `app/harness/insights/BootHistoryTable.tsx` |
| **`GridTable`**     | Static admin page, low row count (under 200), declarative cell *types* (`text`, `stepper`, `price`, `checkbox`, `expand`), SSR-rendered HTML matters | Built-in via column `type:`        | None                       | small admin tables, settings pages                                                                                                                            |
| **`DataGridShell`** | Catalog-style scrolling, 5000+ rows of mostly-scalar data, DOM perf hurts                                                                            | Canvas pixels (cells aren't React) | Built-in (canvas)          | Exported from `@papercusp/grid-core`; no live consumer in the operator app today                                                                              |

Authoring style differs:

```tsx
// RichGrid — you write the cell render function
<RichGrid<Project>
  rows={projects}
  getRowId={(p) => p.id}
  columns={[
    { key: 'name',   header: 'Project', width: 3, render: ({ row }) => <b>{row.name}</b> },
    { key: 'status', header: 'Status',  width: 1, render: ({ row }) => <StatusPill value={row.status} /> },
    { key: 'budget', header: 'Budget',  width: 1, align: 'right', render: ({ row }) => formatCents(row.budgetCents) },
  ]}
/>

// GridTable — declarative columns, one of a fixed set of cell types
<GridTable
  headers={['name', 'qty', 'priceCents', 'select']}
  data={items}
  columnTypes={{ qty: 'stepper', priceCents: 'price', select: 'checkbox' }}
/>

// DataGridShell — canvas, formatters override scalar cells
<DataGridShell
  headers={['name', 'status', 'budgetCents']}
  data={projects}
  formatters={{ budgetCents: (v) => formatCents(v) }}
/>
```

### What RichGrid consumers get for free

Beyond JSX cells, `@papercusp/grid-core` ships opt-in machinery (all from `grid-core/src/index.ts`):

* **Built-in sortable headers** — set a column's `sortKey` and pass `sortState` / `onSortChange`; the header becomes a sort button. (The standalone `applySort` helper is still exported for small in-memory datasets, but live consumers drive sort through the built-in `sortState` props rather than calling `applySort` directly.)
* **Per-column client-side filtering** — `applyColumnFilters` (with `deriveEnumOptions`, `encodeColumnFilters` / `decodeColumnFilters`, `filterChipLabel`). The consumer holds the `ColumnFilterState` (e.g. in a nuqs URL param), calls `applyColumnFilters` before passing rows in, and opts a column in via `ColumnDef.filter`. Live consumers: `app/adv/harnesses/WorkItemsPanel.tsx`, `app/adv/harnesses/AdvAgentsPanel.tsx`, `app/adv/harnesses/AdvLogsPanel.tsx`.
* **Persisted drag-resized column widths** — `usePersistedColumnWidths` pairs with RichGrid's controlled `columnWidths` / `onColumnWidthsChange` so widths survive remounts.
* **Print + Ctrl+C copy** — RichGrid ships a print mirror and TSV+HTML copy payloads (Ctrl+A / Ctrl+C) without extra wiring.

### Decision tree

1. Are your cells *just text and numbers* with maybe a date format? → `GridTable`
2. Do you need pills / icons / hover cards / action buttons / per-row expand? → `RichGrid`
3. Do you have 5000+ rows where scrolling perf is the bottleneck? → `DataGridShell`

If you're tempted by both #2 and #3, you're in the wrong place — that's the `@papercusp/bloom-grid` use case (search-driven catalog with rich cells).

### Critical gotcha for `RichGrid`

The render signature is **`render: ({ row }) =>`** — destructure. Writing `render: (row) =>` *looks* like it works but actually receives the cell context object, so `row.name` etc. silently come back `undefined`. This bites every new contributor at least once.

For full sort, virtualization, multi-row expand, and theme-token reference, see [`libs/generic/papergrid/grid-core/README.md`](https://github.com/...) — the canonical grid docs.

## Where to look for examples

All file paths below are live (relative to `apps/operator/`). The pre-migration example files (`FeatureList.tsx`, `ProposalsPanel.tsx`, `ArchivesPanel.tsx`, `IssuesList.tsx`, `SnapshotsPanel.tsx`, `ArchitectInbox.tsx`, `TriageQueue.tsx`, the `*Banner`/`*Dashboard` panels, `FeatureLink.tsx`, etc.) were deleted as orphans during the adv-harness migration and now live only under `libs/papercusp/_retired/apps-web/` — don't reach for them.

| Need an example of…                                        | File                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Tooltip on a button                                        | `app/harness/PiTerminalsDock.tsx`, `app/admin/plans/PlanActions.tsx`                                                                        |
| Tooltip in the harness editor                              | `app/harness/FeatureEditor.tsx`                                                                                                             |
| Modal with header / body / actions                         | `app/admin/plans/PlanConflictModal.tsx`, `app/admin/plans/RevisionDiffModal.tsx`                                                            |
| Vaul side drawer                                           | `app/admin/plans/PlanDetail.tsx`                                                                                                            |
| cmdk command palette                                       | `app/_components/CommandPalette.tsx`, `app/_components/GlobalCommandPalette.tsx`                                                            |
| Real Radix Tabs (Tabs.List / Trigger)                      | `app/adv/sessions/AdvSessionsClient.tsx` (session detail-panel tab strip)                                                                   |
| Radix Select wrapper                                       | `app/harness/FeatureEditor.tsx`, `app/admin/plans/PlanActions.tsx`, `app/_components/OperatorPanel.tsx`                                     |
| Radix Select with grouped options                          | `app/admin/plans/PlansClient.tsx`, `app/adv/harnesses/HarnessesWorkspace.tsx`                                                               |
| Radix Checkbox                                             | `app/adv/harnesses/AcceptancePanel.tsx`, `app/installed/plugins/[slug]/permissions/page.tsx`                                                |
| Sonner toast.success / toast.error                         | `app/admin/plans/PlanActions.tsx`, `app/admin/_components/TableAdmin.tsx`                                                                   |
| `useFormWith` + Zod (single-submit form)                   | `app/settings/profile/page.tsx`, `app/settings/oracle/OracleClient.tsx`, `app/settings/operator/page.tsx`, `app/settings/api-keys/page.tsx` |
| `useDebouncedSave` (per-field settings)                    | `app/settings/agent/page.tsx` (the sole live consumer)                                                                                      |
| Per-field auto-save via bespoke callbacks                  | `app/settings/voice/page.tsx` (`savePrefsPatch`), `app/settings/backups/page.tsx`                                                           |
| `useForm` + `makeAjvResolver` (plugin JSON Schema)         | `app/settings/plugins/page.tsx`, `app/harness/HarnessPluginsSection.tsx`                                                                    |
| `Controller` for non-native widgets (MarkdownEditor, etc.) | `app/settings/oracle/OracleClient.tsx`                                                                                                      |
| Radix Collapsible                                          | `app/harness/FeatureEditor.tsx`, `app/admin/plans/PlanItemsList.tsx`, `app/_components/SetupWizard/StepTelemetry.tsx`                       |
| `RichGrid` with built-in sort                              | `app/adv/harnesses/WorkItemsPanel.tsx`, `app/admin/plans/RunsPanel.tsx`                                                                     |
| `RichGrid` with per-column filters                         | `app/adv/harnesses/AdvAgentsPanel.tsx`, `app/adv/harnesses/AdvLogsPanel.tsx`                                                                |
| `RichGrid` with persisted column widths                    | `app/adv/harnesses/WorkItemsPanel.tsx`, `app/adv/harnesses/AdvAgentsPanel.tsx`                                                              |
| Kanban board                                               | `app/admin/plans/PlanKanbanView.tsx`                                                                                                        |

## Pages

* [Library reference](/internal/docs/design/libraries) — per-library notes, install location, version, and why we picked it
* [Performance](/internal/docs/performance) — render / bundle / network / layout / measurement rules every agent must follow (top-level page; there is no `design/performance`)
* [Gotchas](/internal/docs/design/gotchas) — known sharp edges, the data-state-vs-aria-selected trap, and migration anti-patterns
