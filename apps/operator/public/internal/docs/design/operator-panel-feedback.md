# Operator panel — designer feedback (round 3)
URL: /internal/docs/design/operator-panel-feedback

Captured live after the round-2 design pass shipped. Acknowledges what landed, isolates what's still broken, flags new issues from the live state.

:::caution\[Surface superseded — the card-feed operator panel became a chat thread]
This memo critiques the `OperatorPanel.tsx` card-feed surface — the
Pending/Accepted/Ignored/Scans tabs, the HUD telemetry strip, the
reactor orb, the "Operator MCP v0.1.0" footer. **`OperatorPanel.tsx` is
orphaned dead code** — the file still exists and is git-tracked, but
nothing imports or renders it anymore, and it is no longer importable in
any case (it still `import`s sibling modules that have since been removed:
`DelegatesSection`, `ScanHistorySection`, `hud/OperatorReactorCore`,
`hud/OperatorScanOverlay`). The operator surface is now `OperatorChat`
(`apps/operator/app/_components/OperatorChat.tsx`, a thin wrapper around
the shared `ChatConversation`): a single chat thread where suggestions
render inline and pending `ctx.askUser` cards surface in a
`PendingCardsBar`, not the old tabbed card queue. The
`operator-reactor` / `operator-hud-*` / `operator-entry__*` CSS still
lingers in `globals.css` but is no longer rendered. The legacy
`/harness?ws=…&project=…` URL now redirects to `/adv`. Several items
here (HUD strip, version footer) are moot on the new surface; the
remaining notes are historical design intent.
:::

Captured live by loading
`http://localhost:3070/harness?ws=default&project=sheets`,
opening the operator panel, and inspecting the rendered DOM.
This is the **third pass** — round 1 was the original feedback;
round 2 was a partial check after the first round of changes
shipped; this pass is after the larger redesign + the
card-lifecycle collapse landed.

Screenshots in `/tmp/op-panel-r3.png` (panel idle) and
`/tmp/op-panel-r3-loaded.png` (panel scanning).

The card-lifecycle work (collapse to `pending / accepted /
ignored`, uniform Accept/Ignore buttons, failure chip pattern,
auto-accept threshold) shipped via my own commits this session
(`e46ba9c`, `fec47ca`, `170eafb`) and is reflected here. The
designer's UX redesign work shipped on top of that.

***

# What's shipped well — don't churn these

Real progress vs. round 2:

* **Lifecycle vocabulary is clean.** Tabs now read **Pending /
  Accepted / Ignored / Scans** with counts (`Pending 0 /
  Accepted 0 / Ignored 0 / Scans`). The 9-state taxonomy is
  collapsed; user-facing labels match what the user thinks of as
  the card's outcome.

* **Filter pills with counts as tabs.** Round 2 §1.3 + §2.2
  asked for collapsed status buckets + visible filter counts.
  Done.

* **Search input has a real placeholder.** *"Filter pending
  actions by title or action"* — descriptive, scopes the search
  to the active view. Better than the generic round-2
  placeholder.

* **Per-harness filter is now an explicit dropdown.** Round 2
  §2.1 called out the per-harness sidebar as a hidden filter
  affordance — the user couldn't tell clicking a row would
  filter the timeline. Now there's a clear *"Filter actions by
  harness"* combobox with `All harnesses` default + each slug as
  an option. Discoverable.

* **Delegates section structure is good.** Tabs:
  `Open / Archived / All` plus a helpful empty-state copy:
  *"No open delegates. Ask the operator to delegate something
  complex (file reads, planning) to spawn one."* Voice +
  intent come through. Reuse this pattern across the app.

* **Auto-accept toggle.** *"auto: low"* with a long descriptive
  tooltip explaining what each level means. (My own commit.)
  It works.

* **Scan-state messaging.** When the operator is scanning, the
  feed shows *"◐ Scanning workspace… Operator is checking
  workspace state, recent decisions, and pending harness
  work."* — a real progress message, not a blank list.

* **Cmd/Ctrl+K + O hint** still in the footer. Power-user shortcut
  is documented; round-2 §1.7 asked for the version number to
  be dropped — that's still pending (see below) but the
  shortcut text is unchanged. Good.

* **Card-action buttons** (when cards are visible) are uniform:
  `Accept → / Ignore` on every pending card, plus `Cancel auto`
  * `Ignore` for auto-fire pending. Tier-high directives still
    go through a preview-confirm strip. (My own commit.)

***

# Persistent issues from round 2 (still not addressed)

## P1. The HUD telemetry strip still duplicates everything  *(round-2 §1.8)*

Above the panel chrome the rendered DOM still contains:

```
operator mesh   0 pending   0 transit   0 alerts
state:synthesis pulse  pending:00  transit:00  alerts:00  hud:cinematic branch
state:synthesis pulse  pending:00  transit:00  alerts:00  hud:cinematic branch
synthesis  O-27  Operator  thinking
```

That's the same data printed **three times** in different
formats. None of it is unique — `pending: 0` matches the
`Pending 0` tab below; `transit / alerts` are stale labels (see
P2 below). `hud: cinematic branch` is pure mood, not state.
Round 2 asked for this to collapse into one source of truth.
Still not done.

**Fix:** delete the HUD telemetry strip OR collapse to a single
small status line *"idle · 0 pending"*. Pick one place to show
state and own it.

## P2. HUD vocabulary doesn't match the tabs  *(new this round)*

The HUD strip uses `pending / transit / alerts` (legacy
4-bucket model). The tabs below use `Pending / Accepted /
Ignored / Scans` (the new 3-state model). These are *the same
data described two different ways* in the same panel.

`transit` was the legacy "in flight / dispatched" bucket — that
state no longer exists in the new model. `alerts` was the
"attention" bucket (failed/escalated/rejected) — also collapsed.

**Fix:** retire the HUD vocabulary. Either delete the strip
(see P1) or update its labels to match the tabs.

## P3. "Activity · waiting · 0" rail is still undocumented  *(round-2 §1.6)*

Right rail still shows *"Activity · waiting · 0"*. Round 2
called this out as ambiguous: the user can't tell what
*Activity* is, why it's *waiting*, or what changes the count.

**Fix:** rename to its actual meaning (queue depth?
background-task count?) or remove. *"Activity"* with no anchor
is just a number that mocks meaning.

## P4. Footer still leaks `Operator MCP v0.1.0`  *(round-2 §1.7)*

Footer reads:

> Cmd/Ctrl+K then O to toggle • Click outside to close • Operator MCP v0.1.0

Version number still visible to end users.

**Fix:** drop, or move to a tooltip on a small `?` icon.

## P5. State vocabulary is inconsistent  *(amplified this round)*

In a single rendered panel I see at least 4 different state
terms:

| Where        | Word                             |
| ------------ | -------------------------------- |
| Header pill  | *idle* / *thinking* / *scanning* |
| HUD strip    | *synthesis pulse*                |
| Card tabs    | *Pending / Accepted / Ignored*   |
| HUD counters | *pending / transit / alerts*     |

A user reading the panel can't tell which vocabulary is "the
real one."

**Fix:** pick one vocabulary per concept. Operator state
(idle/scanning/thinking/acting) is the runtime state of the
agent; card state (pending/accepted/ignored) is the lifecycle
of items in the queue. They're different concepts and should
NOT share words. Drop *synthesis pulse* + *transit* + *alerts*.

***

# New observations from this round

## N1. "Live" appears in multiple unrelated places

The Scan button shows `↻ Scan · Live`, the Stream sidebar shows
`Stream · live scan`, and other places probably use *Live*
too. Without context the word doesn't clarify what's live —
the scan? the stream? the operator itself?

**Fix:** specific context. *"Scan in progress"* on the Scan
button while running. *"Streaming output"* in the stream
panel. Reserve *"Live"* for one concept.

## N2. `O-27` is mystery internal state

The HUD shows `synthesis O-27` — what's O-27? Probably an
operator session/instance counter. Users don't know that. If
it's diagnostic, it shouldn't be in the always-visible chrome.

**Fix:** remove from the visible HUD or label it (`Session #27`
if it's actually useful).

## N3. The empty state when nothing is pending says nothing

When all four tabs are at 0 (`Pending 0 / Accepted 0 /
Ignored 0 / Scans`), the user has no idea why. Possible
reasons:

* Operator hasn't run a scan yet
* Operator scanned and found nothing
* All cards have been resolved
* Background scanner is paused / blocked

The right reason is critical UX information. Today it's
silence.

**Fix:** explicit empty state in the feed area:

* *"No suggestions. Last scan completed 4m ago — try Re-scan
  to surface new ones."*
* Or *"Operator hasn't run yet. Click Scan to start."*
* Or *"Operator paused. No scans will run until you resume."*

Pick the right copy based on actual state. Round-2 §1.5
called for a unified empty-state voice — easy place to apply
it.

## N4. Filter affordance hierarchy

Three filters now coexist: search box, harness combobox, view
tabs (Pending / Accepted / Ignored). They compose silently —
filtering by harness on the Accepted tab shows a different
list than filtering by harness on the Pending tab. Round 2
§2.2 asked for a "filters active" indicator. Still not present.

**Fix:** when a non-default filter is active (harness ≠ "All",
search has text), surface a chip strip *"Filtered: sheets ·
'csv' · clear all"*. The user always knows the result is
filtered.

## N5. Delegates badge counter mismatch potential

Header reads *"Delegates 0 open"*. The Open tab shows the same
0\. Two displays of the same fact. If they're populated from
different queries (live vs. cached), they could disagree.
Worth confirming the source is identical.

## N6. The dialog has `role="dialog"` but no `aria-modal="true"`

Same as my drawer feedback. The operator panel is a modal-style
overlay (Esc-to-close, click-outside-to-close — per the footer
hint). Should set `aria-modal="true"`.

***

# Things explicitly still good

* **Pending / Accepted / Ignored tabs** with counts.
* **Search placeholder** is descriptive.
* **Harness filter** as combobox is discoverable.
* **Delegates section** structure + empty state is exemplary.
* **Auto-accept threshold tooltip** is verbose but informative.
* **Card-action buttons** are uniform (when cards are visible).

***

# Top-priority list

If the designer ships **one** thing next:

> **P1 — Kill the HUD telemetry strip.** Three duplicated
> renderings of the same state, with vocabulary that doesn't
> match the tabs below. Highest signal-to-noise ratio fix.

If they can ship **three**:

1. **P1 — HUD strip cleanup.**
2. **N3 — Empty-state messaging in the feed area** that
   explains *why* the list is empty.
3. **P3 — Rename or remove the "Activity · waiting · 0" rail.**

Cheap wins after that:

4. **P4 — Drop the version number from the footer.**
5. **N1 — Specific contexts for "Live"** (scan / stream / etc).
6. **N4 — Filter-active strip.**
7. **N6 — `aria-modal="true"` on the dialog.**

***

# How I gathered this

* Loaded `http://localhost:3070/harness?ws=default&project=sheets`.
* Opened the operator panel via the header button.
* Captured rendered text + accessibility tree + screenshots
  (`/tmp/op-panel-r3.png`, `/tmp/op-panel-r3-loaded.png`).
* Cross-referenced against the round-2 memo to identify what
  shipped vs. what's still pending.
* Did not click into the cards (panel was empty during the
  capture window).
