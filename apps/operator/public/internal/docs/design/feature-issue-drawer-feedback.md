# Feature & issue detail drawers — designer feedback (round 2)
URL: /internal/docs/design/feature-issue-drawer-feedback

After the designer integrated round-1 feedback. Most major issues fixed. A few small new observations + one persistent gap.

:::caution\[Surface superseded — historical feedback]
This memo critiques the **right-docked peek drawer** (the
`.h-feature-peek-drawer` / `.h-issue-sev` / `.h-issue-status` /
`.h-feature-run-row` classes) that opened on the legacy Next
`/harness?ws=…&project=…` page. That surface no longer exists:
`/harness` now **redirects to `/adv`**, and the feature/issue detail
is rendered by the dockview `DetailPanel`
(`apps/operator/app/adv/harnesses/DetailPanel.tsx`) plus the pinnable
`PinnedFeaturePanel` / `PinnedIssuePanel`
(`apps/operator/app/harness/dock/`). The old drawer CSS still lingers
in `apps/operator/app/harness/harness.css` but is no longer rendered
by any live component. Several requests here (Recent agent runs,
attempts) are now present in `DetailPanel`. Class-level and
geometry-level observations below describe the retired drawer; treat
the surviving design intent as still-useful, the cited selectors as
stale.
:::

Captured live by clicking `F-CSV-003` (feature) and `I-0009`
(issue) on
`http://localhost:3070/harness?ws=default&project=sheets` at
1440×900. Screenshots `/tmp/feature-popout-r2.png` +
`/tmp/issue-popout-r2.png`.

The designer integrated almost every round-1 issue. This memo
is mostly *"keep it"* with one persistent gap (issue drawer
parity) and a couple of polish items.

***

# What shipped — don't churn

| Round-1 §    | What was wrong                                                                             | Now                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1**       | Drawer had 160px gap on right of viewport (positioned at `right: 1280` on a 1440 viewport) | **Drawer docks flush right.** Right edge = viewport width, gap = 0. Height = full viewport (900px on a 1440×900 setup). Both drawers, both clean.                                                                            |
| **C2**       | Two H2s per drawer (`Feature F-CSV-003` + the descriptive title both as H2)                | **Single H2** = the descriptive title. ID + status now live in a structured eyebrow strip above.                                                                                                                             |
| **C3**       | Feature ID `F-CSV-003` appeared 3 times in the title area                                  | Now appears once in the eyebrow (`Feature · F-CSV-003 · Passed`).                                                                                                                                                            |
| **C4**       | Issue sub-line crammed `minor I-0009 open` with no separation                              | Eyebrow now has structured chips: `<span class="h-issue-sev sev-minor">minor</span>`, `<span class="h-issue-status st-open">open</span>`. CSS-styled, color-coded (status chip is rose/red, severity has its own treatment). |
| **C5**       | Close button was unicode `✕` on feature, SVG on issue                                      | Both drawers now use SVG with `aria-label="Close feature details"` / `"Close issue details"`. Standardized.                                                                                                                  |
| **C6**       | Run-log entries rendered as concatenated text without separators                           | Now structured rows: `.h-feature-run-row` with cells `[role · time · separator · run-id]`. Properly tabular.                                                                                                                 |
| **C7**       | Lifecycle button row gave no indication of current state                                   | Current state has `aria-pressed="true"`, `is-current` CSS class, `disabled` (no-op-on-self), and `✓` glyph prefix. Clear and accessible.                                                                                     |
| **C8**       | "Steer notes" was internal jargon                                                          | Renamed **"User notes"**.                                                                                                                                                                                                    |
| **C10**      | `role="dialog"` but no `aria-modal="true"`                                                 | Both drawers now have `aria-modal="true"`.                                                                                                                                                                                   |
| **V2**       | Drawer had fixed 720px height regardless of content                                        | Now matches viewport (900px on 1440×900).                                                                                                                                                                                    |
| **Issue P3** | "note" button (lowercase, single word)                                                     | Now **"Add note"**.                                                                                                                                                                                                          |

**Bonus content not asked for:**

* Issue drawer eyebrow now reads `Feature detail` / `Issue detail` overline before the proper name. Nice orientation.
* Issue drawer now shows `0 fix attempts` count — parallel to feature drawer's `Attempts: N`. Partial parity (see C9.r2 below).
* Feature drawer's "User notes" entry is laid out as a structured row (`user · timestamp · message`).

***

# Still open

## C9.r2 — Issue drawer is closer to feature parity but still missing pieces

Round 1 §C9 asked for issues to have the same depth as features:
*Recent runs · View timeline · Attempts*. Issue drawer now has
`0 fix attempts` (good — that's the parallel of feature's
`Attempts: 2`), but still doesn't have:

* **Recent agent runs** section (e.g., debugger runs that
  attempted to fix this issue). Even if there are 0, an empty
  section makes the parallel explicit.
* **View timeline** affordance.

If the data exists on the backend (the audit log + run tracking
should have it), surface it.

## V3.r2 — Drawer interior may still not scroll

The drawer's `overflow-y: hidden` is set on the outer
`.h-feature-peek-drawer`. I couldn't find an inner scroll
container (`[class*=body], [class*=content], [class*=scroll]`
queries returned nothing). If the feature has many recent runs
or long user notes, the drawer might extend past viewport
without internal scrolling.

This is the same family of bug as my proposals-tab V3.r2
(detail pane was 6,806px tall). Worth verifying with a feature
that has 20+ runs to see if internal scroll kicks in.

**Fix:** ensure the drawer has an inner scroll region — header

* eyebrow stay pinned, body scrolls.

***

# New polish notes (round-2 only)

## R1. Severity / status chips are 9px — same readability concern as proposals

Inspected:

* `.h-issue-sev.sev-minor`: `font-size: 9px`
* `.h-issue-status.st-open`: `font-size: 9.5px`

Same family of issue I called out on the proposals tab in round
1 (8.5px sub-labels). The proposals team fixed it by deleting
the sub-labels. Here the chips ARE meaningful so they should
stay — but bump to **at least 11px**. 9px is below most
browsers' minimum readable threshold; users who zoom or have
visual constraints will struggle.

## R2. The "current state" lifecycle button is `disabled`

Round 1 asked for clear visual indication of which lifecycle
state is current. The fix uses three signals: `aria-pressed`,
`is-current` class, AND `disabled`. The first two are right;
disabling the current button is a half-step too far.

Disabled buttons usually mean "you can't do this" — but the user
*can* meaningfully click on a current-state button (to no-op,
or to confirm the state). More importantly, disabled buttons
are styled as dimmed/unavailable, which makes the *current*
state look LESS prominent than the unselected ones.

**Fix:** drop the `disabled` attribute. Keep `aria-pressed` +
`is-current`. Style the current state as the most prominent
(filled background, white text), not the dimmest.

## R3. Eyebrow chip text concatenates without spaces

textContent on the issue eyebrow comes out as
`Issue·I-0009minoropen`. The DOM has separate `<span>` chips
with their own classes, so visually the chips render with CSS
spacing — but accessibility tools (and copy-paste) get the
run-on string. A separator span (`·`) between sibling chips
would help both.

**Fix:** use `<span aria-hidden="true">·</span>` or `gap` on
the parent flex container with non-zero margins between chips
so screen readers + copy-paste hear/get them as separate items.

## R4. The "Feature detail" / "Issue detail" overline

These overlines appear above the eyebrow strip. Useful
orientation but slightly redundant with the page chrome (the
user clicked a feature row, so they already know they're
seeing a feature detail). Optional to keep — if the overline
goes away, the eyebrow ID + status are still enough.

## R5. The chip color choices

* **Severity `minor`**: white-ish text, transparent background.
  Reads as "this is informational" — good for minor.
* **Status `open`**: rose/red text + rose-tinted background.
  Reads as "attention needed" — fine, though "open" isn't
  necessarily a problem state.

Worth verifying that:

* `severity: critical` gets the loudest treatment (red bg + white text)
* `status: closed` gets a muted gray treatment
* `status: wontfix` reads distinctly from `closed`

Couldn't verify in this state; only one issue type was visible.

***

# Top-priority list

If the designer ships **one** more thing:

> **C9.r2 — issue drawer Recent runs + View timeline.** The only
> remaining round-1 gap. Issues are first-class agent-worked
> items; their drawer should show that.

If they can ship **three**:

1. C9.r2 (above)
2. **R1 — bump 9px chips to 11px+.**
3. **V3.r2 — verify drawer body scrolls internally** with a
   feature that has many runs/notes.

Cheap polish after that:

4. **R2 — drop the `disabled` attribute** on the current
   lifecycle button + make it the visually loudest.
5. **R3 — eyebrow chip separators** for screen readers / copy.

The drawers are in good shape. Most remaining items are polish
or single-data-point verifications.

***

# How I gathered this

* Loaded `http://localhost:3070/harness?ws=default&project=sheets`
  at 1440×900.
* Clicked feature row `F-CSV-003` → captured drawer geometry
  * structure (`right: 1440, gap: 0, full-height 900`).
* Closed, switched to Issues tab, clicked issue row `I-0009`.
* Inspected eyebrow children: `Issue` label + `·` + ID + sev
  chip + status chip with proper classes.
* Verified close buttons are SVG with `aria-label` on both
  drawers.
* Verified run-log rows have structured cells.
* Verified `aria-modal="true"` on both drawers.
* Computed font sizes on chips (9px sev, 9.5px status).
* Did not modify any feature or issue.
