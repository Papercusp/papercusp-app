# Learning tab first-run UX — design memo (P-009, for owner review)
URL: /internal/docs/design/learning-tab-first-run-ux-plan

Design-shape proposal for the Learning tab's public first-run experience: progressive disclosure over the 17 views, teaching empty states, lexicon glosses, and a first-run orientation banner. Present to the owner before building (P-009).

# Learning tab first-run UX — design memo (P-009)

> **Status: DRAFT for owner review** — P-009's contract is *present the design
> before building*. Nothing here is implemented. Build starts only after the
> owner reviews (and after P-006 re-certification closes).

## The problem, from a first-run public user's seat

Opening the **Learning** tab today (`adv/LearningTab.tsx`) a fresh user gets:

1. **17 sibling views** (`lview`): signals, observations, rubrics, pipeline,
   ideas, gym, improvements, benchmark, orchestration, bakeoff,
   wake-efficiency, ekg, red-queen, experiments, frontier, throughput,
   learnings. At least half are *operator telemetry* (ekg, red-queen, bakeoff,
   wake-efficiency, orchestration, throughput, frontier, pipeline) that mean
   nothing before the system has run for days — and nothing to a non-developer
   ever.
2. **Mute empty states**: `LearningVisualEmpty` renders icon + title only —
   "No bake-offs", "No routed ideas", "No benchmark runs". A first-run user
   cannot tell *whether something is broken*, *what will appear here*, or
   *what action makes it appear*.
3. **Unglossed lexicon**: Blender / Gym / Scout / lanes / rubrics / routed
   ideas are product-internal terms used bare. (The `t("pot")` lexicon seam
   already handles pot-vs-hive naming — the gap is *explaining* terms, not
   swapping them.)
4. **No orientation**: nothing tells a new user the one thing that matters —
   *learning is on, scoped to your Pot, and here is the switchboard* (the
   Blender pane's Arming section).

## Proposal (four pieces, smallest-first)

### 1. Two-tier view menu — core vs. advanced (progressive disclosure)

* **Core** (default visible): **Learnings · Ideas · Gym · Improvements ·
  Rubrics** — the views that answer "what has my Pot learned / what is it
  doing about it".
* **Advanced** (one collapsed group, chevron or "Advanced" overflow):
  everything else, unchanged for power users. State stays in the existing
  `lview` nuqs param — a deep link to an advanced view still lands directly
  (the group renders expanded when the current view is inside it).
* No view is removed; nothing is feature-flagged dark. This is a menu-shape
  change only.

### 2. Teaching empty states

Extend `LearningVisualEmpty` with optional `body` + `action` (deep link):

* Ideas → "The Blender routes ideas here once cycles run. It runs on a cadence
  when armed." + **Open Arming** (Blender pane).
* Gym → "Armed pots A/B-refine their blueprints under a budget; cycles appear
  here." + **Arm the Gym**.
* Learnings/observations → "Agents file observations as they work — the first
  ones usually appear within a session."
* Telemetry views keep terse empties (they are operator surfaces).

Copy principle: *what this view shows → what makes data appear → the one
action*, ≤2 sentences, pot-lexicon via `t()`.

### 3. Lexicon glosses

A single `LEARNING_GLOSSARY` map (term → one-liner) rendered as an info
tooltip on each view's header strapline. One place to edit; no per-view prose
drift. Seed entries: Blender, Gym, rubric, routed idea, lane, arming, budget.

### 4. First-run orientation banner

One dismissible banner atop the Learning tab (shown until dismissed;
dismissal in local UI state, not a flag): the three-engine one-liner (reuse
the approved P-010 public copy, shortened) + two links: **Arming** and the
docs page (`/internal/docs/system/self-learning`). No modal, no tour.

## Deliberately NOT proposed

* No guided multi-step tour (heavy, skipped, high maintenance).
* No removal/renaming of views; no new feature flag (menu shape + copy only).
* No new data fetches on the empty paths (empty states stay resolved-snapshot
  driven — the existing "resolved-empty, never loading-as-empty" discipline in
  LearningTab is kept).

## Open questions — ANSWERED \[owner 2026-07-26 interactive]

1. **Signals is CORE** \[owner 2026-07-26 "signals is core"] — core becomes
   six: Learnings · Ideas · Gym · Improvements · Rubrics · Signals; advanced
   holds the remaining eleven.
2. **Banner once per workspace** \[owner 2026-07-26 "banner once per
   workspace"] — dismissal persists per workspace (localStorage-keyed), not
   per pot.
3. Tone: owner delegated the call \[owner 2026-07-26 "you decide"] — decided:
   instructional for the two arming-linked views (there is a real action to
   take), descriptive elsewhere.

## Implementation sketch (post-approval, \~half-day)

`LearningVisualEmpty` prop extension → glossary map + strapline tooltip →
view-menu grouping (pure render change over `LVIEWS`) → banner. Empty-state
copy through the `t()` lexicon; tests: extend the existing LearningTab
empty-state tests + one menu-grouping render test. Registry/design-phase check
for the tooltip + banner primitives before building (reuse existing Radix
tooltip + dismissible banner components if registered).
