# Proposals tab — designer feedback (round 2)
URL: /internal/docs/design/proposals-tab-feedback

After the designer integrated round-1 feedback. Acknowledges what shipped (almost everything), flags the two items still pending, and adds a few polish notes.

:::caution\[Surface superseded — the proposals queue+detail UI is not currently rendered]
This memo critiques the proposals queue + detail surface
(`.h-proposal-detail`, the `proposals-sidebar` / `proposal-detail`
panes) on the legacy Next `/harness?…&panel=proposals` page. That URL now
**redirects to `/adv`**, and the full queue+detail UI no longer ships:
the dock only registers a `view:proposals` **SamplePanel stub** (see
`apps/operator/app/harness/dock/sample-panels.tsx` — "Real
implementations replace these as the corresponding feature panels are
extracted from HarnessDashboard"). The `h-proposals.css`
(`.h-proposal-detail`) survives but is no longer rendered by any live
component. Treat the notes below as historical design intent for a
proposals panel that has yet to be re-extracted; the cited selectors and
the 6,806px detail-pane bug (V3.r2) describe the retired surface.
:::

Captured live at
`http://localhost:3070/harness?ws=default&project=sheets&panel=proposals`
on the same workspace as round 1, now with **9 proposals** in the
queue (2 pending, 7 applied) plus more recent activity. Screenshot
in `/tmp/proposals-r2.png`.

The designer integrated nearly every round-1 issue. Big jump in
quality of the page. This memo is mostly *"keep it"* with one
remaining bug + a couple of polish items.

***

# What shipped — don't churn

Round-1 issues that are now resolved:

| Round-1 §    | What was wrong                                                                                                      | Now                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1**       | Brainstorm + Architect inbox + Proposals queue all on one tab                                                       | Brainstorm + Architect inbox **gone** from this tab. Page is now `proposals-sidebar` (queue) + `proposal-detail` (detail). Two functional areas, one purpose.                                                                     |
| **C2**       | Proposal titles were timestamp fragments (`T22 58 32Z`)                                                             | Real titles: *"Cell merge / unmerge"*, *"R2 file upload + `=IMAGE()` cell embedding"*, *"Drag-to-reorder rows and columns"*.                                                                                                      |
| **C2 bonus** | (no sub-line at all)                                                                                                | User-story sub-line on every row: *"As a user, I can select a range of cells and merge them…"* — fantastic addition not asked for.                                                                                                |
| **C3**       | Filter pill sub-labels at 8.5px (unreadable)                                                                        | Sub-labels deleted. Pills now read `All 9`, `Pending 2`, `Applied 7`, `Rejected 0` — clean.                                                                                                                                       |
| **C4**       | `Pending · reviewer: accept (not applied) · 13d ago` jammed lifecycle + reviewer signal + redundant "(not applied)" | Detail pane now has two distinct sections: **Lifecycle** (*"Pending — Needs a product decision"*) and **Reviewer signal** (*"No signal — No reviewer recommendation has been recorded for this proposal."*). Explicit, separable. |
| **C5**       | 3-step Generate → Review → Replan explainer was permanent                                                           | *"Got it"* dismiss button added. Power users can hide it.                                                                                                                                                                         |
| **C6**       | Keyboard shortcut ribbon (`j/k move…`) sat in the active band                                                       | Now behind a `? shortcuts` button. Available without competing with content.                                                                                                                                                      |
| **C7**       | `Queue 9/9 1/9` unparseable header                                                                                  | Now reads *"Proposal queue · 9 proposals · viewing 1 of 9"*. Clean.                                                                                                                                                               |
| **C8**       | Detail-pane title was the timestamp                                                                                 | Detail title is now the proposal's actual name (e.g., *"Cell merge / unmerge"*). Timestamp moved to metadata as *"source: 2026-05-07T00-00-00Z.md"*.                                                                              |
| **P2**       | Star icon was filled `★` on all 9 rows                                                                              | Now `☆` outline + `role="checkbox"` with `aria-checked="false"`. The star IS the multi-select control (P3 below).                                                                                                                 |
| **P3**       | "Select 2 pending proposals" with no UI affordance                                                                  | Now reads *"Select 2 pending for bulk review"* + the ☆ checkboxes are visible on every row. Discoverable.                                                                                                                         |
| **P4**       | "Sort · next pending · starred 0 visible" jammed three controls together                                            | Now visually separated: *Sort: Newest first · next pending · star visible*. Still dense but cleaner separation.                                                                                                                   |
| **V1**       | Three "loading…" placeholders in brainstorm column                                                                  | Brainstorm column is gone. Loading states gone with it.                                                                                                                                                                           |
| **V2**       | Pending vs applied rows differed by 3-unit RGB shift                                                                | Now: pending = sky-blue border-left at 52% opacity; applied = same hue at 7.5% opacity. Real visual differentiation. (Could be stronger — see V2 below — but no longer "almost identical".)                                       |

**New bonus content the designer added that I didn't ask for:**

* **Header sub-line** — *"2 pending decisions · 7 in SPEC.md · 6 auto-accepted · 1 reviewer accept signal still pending"*. Single-line summary of queue state. Surfaces the new auto-accept feature provenance + reviewer signals at a glance. Strong.
* **User-story sub-lines on each row.** Pulled from the proposal markdown's "As a user…" framing. Triage-friendly without clicking through.
* **Explicit "Lifecycle" + "Reviewer signal" sections** in the detail pane with explanatory descriptions. Goes beyond what round-1 asked for.

***

# Still open

## V3.r2 — Detail pane is still 6,806px tall  *(round-1 V3, partial fix)*

The detail pane's computed height is **6,806 pixels** — about 9× a 720px viewport. Better than the 38,781px from round 1 but still wrong; the user can't scroll the detail pane independently of the page.

DOM shows:

```css
.h-proposal-detail { width: 723px; height: 6806px; overflow-y: hidden; max-height: 100% }
```

`overflow-y: hidden` + a 6806px height = the content overflows but isn't scrollable. `max-height: 100%` is relative to a parent that's also extending, so it's effectively unbounded.

**Fix:** scroll the detail pane internally:

```css
.h-proposal-detail {
  max-height: calc(100vh - <chrome-height>);
  overflow-y: auto;
}
```

Mid-priority — the proposal markdown is still readable by scrolling the page; just not contained.

## C9 — Top-of-page HUD strip still duplicates state

The page chrome above the proposals panel still renders:

```
pending: 39 · transit · alerts · lanes: 1 · pulse #14 · …
```

twice. Same complaint as my operator-panel round-3 §P1 — same root cause (`.operator-hud-telemetry` strip). Not specific to this tab; flagging here for completeness.

**Fix:** see operator-panel round-3 P1.

***

# Round-2 polish notes (cheap)

These are new minor observations from this pass; not regressions:

## R1. Pending border could be more present

Pending row's border-left is sky-blue at 52% opacity. The applied row's same color at 7.5% opacity. The contrast is *enough* to differentiate but barely so on a dark theme. A user scanning the list still has to look closely.

**Fix:** bump pending border to 80% opacity, or use a different hue (amber for pending). Optional; today's contrast is workable but not punchy.

## R2. "Sort · Newest first · next pending · star visible" is dense

Three controls + a label, separated by `·` dots:

* Sort dropdown: *Newest first*
* *Next pending* button (jump-to)
* *Star visible* (filter chip? toggle? unclear without hovering)

Looks like a comma-separated string at a glance.

**Fix:** explicit visual separation. Sort dropdown stays as a chip. *Next pending* becomes a button (with maybe a small `→` glyph). *Star visible* is a filter toggle that visually shows when active vs. inactive.

## R3. The H2 in the detail pane is the proposal markdown's H1

Detail pane shows:

* Eyebrow: *Pending* + title *"Cell merge / unmerge"*
* Then a generated H2: *"Proposed additions (ranked by expected user value)"*
* Then nested H3s: *"Proposal 1: Cell merge / unmerge"*, *"Proposal 2: Paste special — values-only and transpose"*, etc.

Wait — the proposal markdown contains multiple sub-proposals? "Proposal 1 / Proposal 2 / Proposal 3"? If a single "proposal" is actually a generation batch with N sub-proposals, the title *"Cell merge / unmerge"* (the first sub) understates what's in the file.

**Fix:** if proposals contain multiple sub-proposals, surface that on the row: *"Cell merge / unmerge + 2 more"*. Today the row title implies a single proposal but the file is actually a batch.

(May be a data structure issue, not a design one — flagging for the designer to confirm with whoever owns proposal generation.)

## R4. The auto-accept threshold ("auto: low") doesn't show up here

The header sub-line reads *"6 auto-accepted"* — that's accurate. But there's no indication of the *current* threshold setting that determined those 6. If the user wants to know "would the next pending proposal be auto-accepted at my current setting?", they'd have to check the operator panel.

**Fix:** add a small chip near the auto-accepted count: *"Auto-accept: low — Cell merge / unmerge would auto-accept if marked low risk"*. Cross-references the global setting.

(Optional; only worth doing if users ask.)

## R5. Empty-state for Rejected 0

When `Rejected = 0`, clicking the Rejected pill should show a friendly empty state, not a blank list. Couldn't verify the empty state from this capture (no rejected proposals exist on this workspace).

**Fix:** verify empty-state copy across all 4 filter pills. Reuse the *"Decision radar clear"* voice from the architect-inbox empty state.

***

# Top-priority list

If the designer ships **one** more thing:

> **V3.r2 — fix the 6,806px detail-pane height.** It's the only remaining round-1 bug with real impact. Scroll the pane internally instead of letting it extend the document.

If they can ship **two**:

1. V3.r2 (above)
2. **R3 — clarify multi-sub-proposal files.** If a "proposal" is actually a batch of sub-proposals, the row should say so.

The page is in good shape. Most remaining items are polish or cross-cutting (HUD strip, version footer) that belong to the operator-panel cleanup, not this tab.

***

# How I gathered this

* Loaded `http://localhost:3070/harness?ws=default&project=sheets&panel=proposals`.
* Captured proposal items and detail pane via DOM queries.
* Verified filter pill structure: `<span>Label</span><b>count</b>` (no more `<small>`).
* Verified detail pane structure: H2 + H3 sub-headings, computed height 6,806px.
* Verified row visual differentiation: pending bg `rgba(10,17,30,0.98)` + border-left `rgba(125,211,252,0.52)` vs applied border-left `rgba(125,211,252,0.075)`.
* Cross-referenced against round-1 memo to identify what shipped.
* Did not generate, apply, or reject any proposals.
