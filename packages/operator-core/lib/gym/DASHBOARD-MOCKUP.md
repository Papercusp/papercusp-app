# Harness Gym — operator dashboard mockup (P-024)

> **Status:** mockup + designer brief. The **data layer is done** (`read-api.ts`); this
> spec is the structure + data-binding + URL-state contract. Visual craft (spacing,
> color, motion, empty/loading states) is for a designer — match the operator design
> system (`/internal/docs/design` + `design-phase:*` tokens), don't hand-roll.
> **Gated behind P-014:** build only after the milestone go/no-go confirms the signal is
> sound (if the gym's premise doesn't hold, the contents change).

## What it visualizes

The gym controller's read surface (`apps/operator/lib/gym/read-api.ts`) over the gym PG:

| View | Source (`read-api.ts` / gym tables) | Answers |
| --- | --- | --- |
| **Variants** | `gym_variants` (+ `variantLineage`) | what variants exist, their lineage (parent→child) |
| **Scores / A-vs-B** | `compareVariants(sql, a, b, rubricHash)` | per-task composite diff between two variants |
| **Frontier** | `frontierView(sql, rubricHash)` → `buildVariantVectors`→`frontierFromVectors` | which variants are Pareto-optimal over the train set |
| **Cycles** | `readCycleHistory(sql)` (`gym_cycles`) | the optimize loop: parent→candidate, accept/reject, deltas |

## URL state (nuqs — non-negotiable per CLAUDE.md)

Everything user-meaningful lives in the URL so agents (`ui:get_state`/`ui:dispatch`) and
deep-links work. **No `useState` for any of these.**

```
?gymTab=frontier|variants|compare|cycles      parseAsStringEnum, default 'frontier'
&rubric=<rubricHash>                            parseAsString  (the scored rubric; scores are rubric-scoped)
&a=<variantId>&b=<variantId>                    parseAsString  (compare view A/B selection)
&variant=<variantId>                            parseAsString  (variants view: selected row → lineage panel)
&pool=train|dev-anchor|monitor|real-anchor      parseAsStringEnum, default 'train'
&sort=composite|delta|cycle                     parseAsStringEnum
```

`useState` only for: fetch loading/error, hover, the live cost-meter tween.

## Layout mockup (ASCII — structure, not final visuals)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Harness Gym                          rubric: v1·a1b2c3 ▾    pool: train ▾      │
│  [ Frontier ]  Variants   Compare   Cycles                  champion: cand-7 ★  │
├──────────────────────────────────────────────────────────────────────────────┤
│  FRONTIER (Pareto over train composites)                                       │
│                                                                                │
│   trainAgg                                                                     │
│    8.5 ┤                          ● cand-7 (champion)                          │
│    8.0 ┤                ● cand-4                                               │
│    7.5 ┤        ● cand-2          ○ cand-5 (dominated)                          │
│    7.0 ┤  ● baseline                                                           │
│        └────────────────────────────────────────────  cost $/run →            │
│                                                                                │
│   ● on-frontier   ○ dominated      (click a point → Compare vs champion)       │
├──────────────────────────────────────────────────────────────────────────────┤
│  per-variant (frontier members)                                                │
│  variant      trainAgg   dev-anchor   $/run   probes   on-frontier             │
│  baseline       7.0        6.8        0.42     3/3        ✓                     │
│  cand-2         7.5        7.1        0.45     3/3        ✓                     │
│  cand-7 ★       8.5        8.2        0.51     3/3        ✓                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

```
COMPARE  (?gymTab=compare&a=baseline&b=cand-7)
┌── A: baseline ─────────────┬── B: cand-7 ──────────────┬── Δ (B−A) ────────────┐
│ task          composite    │ composite                 │ delta      win        │
│ add-health      6.0        │   8.0                     │  +2.0      ▲ B         │
│ fix-race        7.0        │   7.5                     │  +0.5      ▲ B         │
│ refactor-x      8.0        │   7.0                     │  −1.0      ▼ A         │
│ ─────────────────────────────────────────────────────────────────────────────│
│ mean            7.0        │   7.5                     │  +0.5      ▲ B         │
└────────────────────────────┴───────────────────────────┴───────────────────────┘
  per-row expand → the two distilled traces + judge rationales side-by-side.
```

```
CYCLES  (?gymTab=cycles)   — readCycleHistory()
  #  parent     candidate   decision   devΔ    costΔ   probes   narrative
  1  baseline   cand-1      reject     −0.3    +0.01   3/3      "tried terser worker prompt…"
  2  baseline   cand-2      accept ✓   +0.5    +0.03   3/3      "added explicit acceptance re-read…"
  7  cand-4     cand-7      accept ✓★  +1.0    +0.06   3/3      "promote: dev-anchor best so far"
```

```
VARIANTS  (?gymTab=variants&variant=cand-7)  — gym_variants + variantLineage
  list ────────────┐   ┌── lineage: cand-7 ──────────────────────────────┐
  baseline          │   │  baseline → cand-2 → cand-4 → cand-7 (selected)  │
  cand-2            │   │  overlay diff vs parent: promptOverrides.worker  │
  cand-7  ★ ◄───────┘   │  (+ "Re-read acceptance criteria before…")        │
                        └──────────────────────────────────────────────────┘
```

## Designer brief

- **Tone:** an internal *instrument panel*, not a marketing page — dense, scannable,
  monospace-friendly for numbers; the operator design tokens for color/spacing.
- **The frontier is the hero.** A scatter (trainAgg vs $/run) with on-frontier points
  emphasized and dominated points de-emphasized; the champion marked (★). Clicking a
  point deep-links to Compare-vs-champion.
- **Deltas are the story in Compare:** signed, color-coded (▲ improve / ▼ regress), with
  the mean row emphasized. Row-expand reveals the two distilled traces + judge rationales
  (the optimizer's reasoning material).
- **Cycles read as a ledger:** accept/reject + the hard numbers (devΔ, costΔ, probes)
  anchor each row; the narrative is secondary text. Champion-promotions marked ★.
- **States to design:** empty (no runs yet), loading (skeleton rows), and the
  circuit-breaker-tripped banner (champion auto-reverted — surface loudly).
- **Falsifiability cue:** show the `real-anchor` pool's trend next to the train trend — if
  train climbs while real-anchor is flat, flag it (the gym is optimizing a proxy, D-014).

## Build notes (when P-024 is scheduled, post-P-014)

- New route under the operator Vite SPA; a `gym` MCP tool already-exists path feeds it via
  `read-api.ts` (wrap those readers in a `defineTool` per the tool-adding discipline if a
  tool surface is wanted, else a thin API route).
- All four readers are pure + unit-tested; the UI is presentation only.
- Respect the performance page (no serial per-row PG opens; one query per view).
