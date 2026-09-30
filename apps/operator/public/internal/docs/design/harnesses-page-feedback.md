# Harnesses page — designer feedback
URL: /internal/docs/design/harnesses-page-feedback

Concrete UX feedback on /installed/harnesses, captured live with 8 harnesses installed. Cross-cutting issues, per-defect notes, and a priority list.

:::note\[Partially addressed since capture]
The `/installed/harnesses` page still exists
(`apps/operator/app/installed/harnesses/page.tsx`, served via the
operator-vite route `routes/installed/harnesses.tsx`) but has changed
substantially since this capture. The table is now rendered by `RichGrid`
(`@papercusp/grid-core`), **not** the hand-rolled
`.pc-installed-harness-grid` divs the per-row notes inspect — though the
`pc-installed-harness-*` class names survive on the cells.

Most of the listed defects are now at least partially addressed in code —
the body below is a historical capture, not the live page:

* **C1 (hierarchy) — partial.** Department rows are now indented under
  their parent org: `parentSlugFor()` finds the parent by slug prefix, and
  the slug cell gets `paddingLeft: 18` plus a leading `--` glyph when a
  parent exists. Indent only — there's no collapse control yet.
* **C2 / V4 (State column) — addressed.** The column is now headed
  **`Activity`** (not `State`), and its values vary by existence:
  `● ready` (`var(--good)`) when the directory exists vs `○ missing`
  (`var(--fg-mute)`) when it's gone. The word "stale" only survives in the
  footer (`N stale entries`) and the `pc-installed-harness-state stale`
  class name, not in the cell label.
* **C3 (path noise) — addressed.** `displayPath()` collapses
  workspace-managed paths to `.papercusp/projects/<slug>` (stripping
  everything before the `/.papercusp/projects/` marker) and keeps the full
  path in a hover `title` tooltip; external paths still render in full.
* **C4 (no add action) — addressed.** A primary **`+ Add Pot`** button now
  sits top-right; it opens the `CreateHarnessPicker`, not a marketplace
  link.
* **C5 (filter / sort / search) — addressed.** The page renders a `Filter …`
  search input, kind-filter chips (All / coding / org / department), and a
  sort `Select` (Recent activity / Alphabetical / Kind), backed by the nuqs
  params `q`, `kind`, and `sort`.
* **C6 (click target) — addressed.** The whole row is clickable: `RichGrid`
  gets `onRowClick` plus `rowProps` with `role="link"`, `tabIndex`, and an
  Enter/Space `keydown` handler. The `Open` button remains as a hint.
* **C7 (empty state) — addressed.** An explicit empty state ships and links
  to **`/cupboard`** (the marketplace was replaced by the Cupboard).
* **V2 (kind chips) — addressed.** `Kind` now renders as a color-coded pill
  via `kindChipStyle` (`coding` → `var(--accent)`, `org` →
  `var(--accent-strong)`, `department` → `var(--fg-mute)`; `borderRadius:
  999` with `color-mix` tones).

Still open / unverified: C8 (heading redundancy), C9 (per-row activity
preview), C10 (real table semantics), and C1's collapse control.

Note also that all project-unit strings now route through `useLexicon`'s
`t('pot', …)`, which renders **`Pot`/`Pots`** when the `THE_HIVE` flag is
on (it defaults to `true`). So the H1, the `+ Add` button, and the
description sentence quoted below reflect the **pre-lexicon capture** — the
live page reads "Pots", "+ Add Pot", etc.
:::

Captured live by loading
`http://localhost:3070/installed/harnesses?ws=default` against the
running operator with **8 installed harnesses**: `sheets` (coding) +
`papercup-org` and 6 of its departments. Screenshots in
`/tmp/harnesses-page.png` (1440px wide) and `/tmp/harnesses-narrow.png`
(800px wide). Read alongside `app/installed/harnesses/page.tsx` and
the `pc-installed-harness-*` CSS blocks.

***

# What the page is

A flat list of installed harnesses with five columns:

| Column | What it shows                               |
| ------ | ------------------------------------------- |
| Slug   | Harness slug (e.g. `papercup-org-business`) |
| Kind   | `coding` / `org` / `department`             |
| Path   | Full filesystem path on disk                |
| State  | `● live` (always — see #2 below)            |
| Added  | Timestamp or `—` (see #3)                   |

Plus an `Open` button per row that links to
`/harness?project=<slug>`.

It's the list a user lands on when they click "Harnesses" in the
nav. It is also the shortest path between *"I want to keep working
on a harness"* and *that harness's Mission Control page*.

***

# Cross-cutting / structural issues

## C1. The hierarchy is invisible

The 8 rows include `papercup-org` and 6 of its child departments.
Visually they're sorted alphabetically as peers. A user with no
prior context can't tell that `papercup-org-business`,
`papercup-org-rd`, `papercup-org-technology`, etc. are all *part of*
`papercup-org`. They look like 7 unrelated `org`/`department`
projects.

**Fix:** indent department rows under their org row. Or group by
parent slug with a small `▾ papercup-org (6 departments)` collapse
control. The Kind taxonomy (`org` / `department`) is data we already
have; expose the relationship visually.

## C2. State column is dead weight

Every row reads `● live`. If the column never carries information,
remove it. If state DOES vary (paused, stalled, errored, in
progress), the dot color and label should reflect that — and
ideally the state should be richer than a single word (e.g.,
*"running · 4 features in flight"*).

**Fix:** replace `State` with `Activity` and surface live data
the harness already exposes — *idle / running / blocked / paused*
plus a one-line summary if running.

## C3. Path column is noisy and not actionable

Six of seven `papercup-org-*` rows show the same prefix:

```
/home/dev/.papercusp-workspaces/default/.papercusp/projects/papercup-org-XXX
```

Only the last segment differs. The prefix is workspace-internal
plumbing the user can't act on (they don't open files there
manually; they use Mission Control). Showing it eats horizontal
space and dilutes the slug column.

**Fix:** show only the meaningful tail:

* For workspace-managed: `.papercusp/projects/<slug>` or just hide.
* For external (like `sheets` at `/home/dev/sheets-clone`):
  show the full path because that's where the user actually works.

If the full path is needed for "copy to clipboard" or "reveal in
Finder," put it behind a hover affordance or a kebab menu, not a
permanent column.

## C4. No primary action; no way to add a new harness

The page lists what exists; there's no `+ New harness` button. To
install one, the user navigates to Marketplace. Since this is the
"Harnesses" page in the nav, the create action belongs here at the
top right.

**Fix:** primary button top-right: *"Install harness"* → links to
`/marketplace/templates`. Or open an inline picker.

## C5. No filter / sort / search

8 fits comfortably on screen. If a user has 20+ harnesses, scroll
is the only way to find one. No search box, no kind filter, no
"sort by recent activity."

**Fix:** small filter row above the table:

* Search input ("Filter harnesses…")
* Kind filter chips (All / Coding / Org / Department)
* Sort dropdown (Recent activity / Alphabetical / Date added)

8 harnesses isn't the threshold where this matters, but the page
is the canonical "browse" surface — make it scale.

## C6. Click target is just the "Open" button

To enter a harness, the user has to aim for the small "Open"
button at the row's right edge. Less precise targets (the full
row) are friendlier.

**Fix:** make the entire row clickable (anchor wraps the row).
The "Open" button can stay as a visual hint at the right edge but
isn't the only target.

## C7. No empty state visible

This page must render something useful when 0 harnesses are
installed. Worth verifying it doesn't show "Slug Kind Path State
Added" headers and an empty body — that'd be confusing for a new
user. (Couldn't test from this state; flag for the designer to
verify.)

**Fix:** explicit empty state: *"No harnesses yet. Browse the
marketplace to install your first."* with a CTA.

## C8. Heading + nav redundancy

The sidebar nav says "Harnesses". The H1 says "Harnesses". The
page is at `/installed/harnesses`. Three repetitions of the same
word as orientation. Drop the H1 (the rail/breadcrumb already
tells the user where they are), or repurpose to an *action* H1
("Open one to keep working" or similar).

## C9. No "what's happening" preview per row

Clicking a row sends the user to Mission Control to see what's
happening with that harness. But if the user is asking *"which
harness do I open next?"*, the answer requires opening one to
peek. The row could show:

* Last activity: *"Worker fixed F-FIX-009 · 2h ago"*
* Pending: *"3 features in queue"*
* Spend today: *"$2.40"*

**Fix:** add a *"Last activity"* sub-line under the slug or as a
new column. The data exists in operator audit log + harness
features.json; surface enough that the user can pick without
clicking through.

## C10. No accessibility semantics for tabular data

Inspecting the DOM: `.pc-installed-harness-grid` is `<div>`s with
spans, not a `<table>` with `<thead>`/`<tbody>`. The aria snapshot
shows it as a row/cell tree, but screen readers prefer real
table semantics for tabular data — *"of 8, row 3, column Slug:
papercup-org-business"* navigation.

**Fix:** real `<table>` element, OR continue with divs but add
`role="grid"` + `role="row"` + `role="gridcell"` properly. Right
now the role attributes are inconsistent.

***

# Per-row visual issues

## V1. The `sheets` row's `Added` is `—`

The first row has `—` for Added because `sheets` is an external
project (`/home/dev/sheets-clone`) the user imported, not
one the workspace scaffolded. The dash is correct *information*
but reads as a missing value or rendering bug.

**Fix:** for external projects, render *"imported"* or
*"external"* in italic gray. Pair with a small chip on the slug
*"external"* so the user understands why this row's metadata is
different from the others.

## V2. `Kind` values are bare lowercase words

`coding` / `org` / `department` — no badge styling. Visually
identical to body text. Two reasons to fix:

* Hard to scan for "show me coding harnesses" because the eye has
  no anchor.
* Lowercase matches no other casing convention on the page (slug
  is lowercase but with hyphens; State capitalizes "live" weirdly
  with the dot).

**Fix:** small pill or color-coded chip:

* `coding` → blue
* `org` → purple
* `department` → muted gray

## V3. Header row probably isn't visually distinct

The aria tree shows `row "Slug Kind Path State Added"` as the
first row, then 8 data rows. If the header reuses the same row
styling, scrolling drops the header out of view and there's no
sticky behavior.

**Fix:** sticky header (`position: sticky; top: 0`) with subtle
background tint + bottom border. Visually distinct so the user
can always tell which column they're scanning.

## V4. The State `●` dot is a single color

Always green. If the user ever sees red/amber, the visual signal
will land — but right now it teaches them "the dot is always
green and means nothing."

**Fix:** see C2. Make the dot earn its presence.

***

# Narrow-viewport (mobile / docked-panel)

Captured at 800×600 (`/tmp/harnesses-narrow.png`). Couldn't fully
introspect the layout from the browser session (it bounced), but
the page uses `display: block` on `.pc-installed-harness-grid`
with no `gridTemplateColumns` set — meaning each "row" is a
single block, and rows lay out using flex internally. On narrow
viewports this either:

1. Wraps awkwardly (path text wraps to multiple lines, breaking
   alignment with the header), or
2. Truncates with ellipsis only if `text-overflow: ellipsis +
   white-space: nowrap` is set (it isn't currently — the inspector
   showed `white-space: normal`).

**Fix:** at narrow widths, collapse to card layout — each harness
becomes a card with `slug` as title, kind chip below, path/state
on a second line. Or keep rows but make the path column scroll
horizontally within its cell.

The screenshot at 800px will tell the designer which case
actually fires; recommend they review it.

***

# What's working well

* Clean column choice for the data model (Slug / Kind / Path / State / Added is reasonable).
* "Open" button label is unambiguous.
* The page loads fast and renders all 8 rows immediately.
* One-line description under the H1 is clear: *"Locally-installed
  harnesses. Each is a project scaffolded into this workspace."*

***

# Top-priority list

If the designer ships **one** thing:

> **C1 + V2 — group by parent + add kind chips.** The single
> biggest comprehension win. Today the relationship between
> `papercup-org` and its 6 departments is invisible; making it
> visual makes the page actually structurally readable.

If they can ship **three**:

1. **C2 — replace dead `State` column with live activity.**
2. **C3 — collapse or hide the path prefix for workspace-managed harnesses.**
3. **C6 — make the entire row clickable.**

Three more cheap wins:

4. **C4 — primary "Install harness" button top-right.**
5. **C5 — search + kind filter row.**
6. **V3 — sticky header.**

***

# How I gathered this

* Loaded `http://localhost:3070/installed/harnesses?ws=default` in Edge.
* Captured the full visible text + accessibility tree.
* Inspected DOM classes: `.pc-installed-harness-grid`,
  `.pc-installed-harness-slug`, `.pc-installed-harness-kind`,
  `.pc-installed-harness-path`, `.pc-installed-harness-state.live`,
  `.pc-button.pc-installed-harness-open`.
* Took screenshots at 1440px (`/tmp/harnesses-page.png`) and 800px
  (`/tmp/harnesses-narrow.png`).
* Did not modify any harness or click through.
