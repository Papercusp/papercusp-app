# Plan format
URL: /internal/docs/spec/plan-format

Markdown-canonical format for SU-agent plans — frontmatter, ## Now anchor, items with computed status, decisions log. Consumed by the plans:* tool surface.

import { Aside } from '@astrojs/starlight/components';

The **plan format** is a small markdown convention that lets SU agents
browse, status-track, and cold-resume work-in-flight plans without a
human re-briefing them.

**Storage: PG-canonical** (plans-pg-canonical-migration-2026-06-03).
Plans live in `harness_shared.harness_plans` — one row per plan, keyed by
`(workspace_id, harness_slug, plan_slug)`; the canonical markdown is the
`content` TEXT column. Reads parse that blob; the frontmatter + op\_\* status +
the structured `items`/`decisions`/`now_*` columns are a **derived index**
maintained on write (D-006: the prose body stays canonical in `content`). The
markdown is rendered on demand by `plans:get` / `plans:export` / the admin UI —
the `apps/operator/docs/plans/<slug>.md` files were **removed from git** once PG
became the source of truth. Plans federate cross-machine over the peer-log
(`plans-by-slug` projection) as `papercup`-harness content (D-004). This format
spec is the shape of the markdown the `plans:*` tools read and write.

This is the format spec. For the rationale, design tradeoffs, and
roll-out plan, see
[`agent-plan-tracking-2026-05-20.md`](/internal/docs/plans/agent-plan-tracking-2026-05-20).

Plans not in this format are **legacy** — the parser flags them
`isLegacy` and `plans:list` surfaces them as `status: 'draft'`
(the missing projected status maps to `'draft'`; the parser never
synthesizes a status). `plans:lint` exempts them entirely.
Conversion is opt-in, per plan, when you're actively working on it.

## File layout

One file per plan, named `<slug>-<YYYY-MM-DD>.md`. The filename stem
is the **plan id** — referenced from other plans, tools, and the
CLAUDE.md project-history workflow.

A plan has four parser-keyed structural parts:

```
---             ← YAML frontmatter
title: ...
slug: ...
status: ...
---

# Title         ← optional H1

## Now          ← cold-resume anchor (required)

**State:** ...
**Next:** ...
**Next:** ...

## Phase N — Name   ← optional, multiple

- **P-NNN** `status` text · blocked-by: P-MMM

## Decisions    ← optional (recommended)

### D-NNN — Title
Date: YYYY-MM-DD
body
```

Everything else (background, scope, verification, prose) is free. One
optional operator-parsed section — **`## Promote`** — carries the
promote/waves policy (how the plan becomes harness features); see
[The `## Promote` policy (waves)](#the-promote-policy-waves) below.

## Frontmatter

```yaml
---
title: <Title Case sentence>
slug: <kebab-case-slug>-<YYYY-MM-DD>   # MUST match filename stem
status: draft | ready | active | shipped | superseded
created: YYYY-MM-DD
updated: YYYY-MM-DD                     # bumped on every assisted write
owner: <email>                          # human owner; agents don't own plans
supersedes: [<other-slug>, ...]         # optional
superseded-by: <other-slug>             # optional, set when status=superseded
---
```

`status` is the **plan's** lifecycle. It's distinct from per-item
status (see [Status vocabulary](#status-vocabulary)).

A plan with missing or malformed frontmatter is **legacy** — the
parser sets only the `isLegacy` flag (it never synthesizes a
`status`), and `plans:list` reports it as `status: 'draft'` (a
missing projected status maps to `'draft'`) with no item counts.
Conversion happens via `plans:set-now` + frontmatter edit when the
plan is being actively worked on.

## The `## Now` block

Exactly one section near the top, fixed heading:

```markdown
## Now

**State:** one paragraph describing where the plan currently stands.

**Next:** one sentence — the single next concrete action and who
should do it ("an agent should …" / "human decision needed on …").
```

This is the **single most-read field**. An agent dropped into a
fresh session loads `plans:get \{ slug \}` and reads this first.
Updating it via `plans:set-now` is the canonical way to keep the
plan "alive" between sessions.

## Items

Items live under `## Phase N — <name>` sections. One item per line,
flat permanent ID, free text after.

Canonical ASCII form:

```markdown
- **P-007** `todo` Migrate stray plan files into docs/plans/.
- **P-008** `wip` Wire plans:list to filesystem.
- **P-009** `todo` Implement plans:lint. blocked-by: P-008
- **P-010** `needs-human` Decide archive listing default. → D-003
- **P-011** `done` Verify parser handles legacy files.
- **P-012** `needs-human` Human sign-off before production ship. importance: urgent
```

### Rules

* **Permanent flat IDs** — `P-NNN`, never reused, never renumbered.
  Reordering the list never invalidates a reference. The
  `plans:add-item` verb allocates the next id inside a lock so
  parallel callers don't collide.
* **Status token** — one of six, lowercase, backticked. See
  [Status vocabulary](#status-vocabulary).
* **`blocked-by:`** — keyword. Parser reads it independent of any
  separator glyph. Comma-separated IDs: `blocked-by: P-003, P-005`.
  *Not* a status — see "Computed-blocked" below.
* **Decision refs** — explicit markers only: `→ D-NNN`, `-> D-NNN`,
  `- see D-NNN`, `decision: D-NNN`, or `ref: D-NNN` (labels are
  case-insensitive). A bare or qualified prose citation such as
  `source D-NNN` or `other-plan#D-NNN` is not an in-plan reference;
  this prevents citations to another record from becoming dangling local
  decision refs. The visible item text is preserved unchanged.
* **`importance:`** — keyword, glyph-agnostic like `blocked-by:`.
  Values `urgent | high | normal | low`; omit it for the `normal`
  default. A 4th axis orthogonal to status — see
  [Importance](#importance).
* **`risk:`** — keyword, glyph-agnostic and stripped from the visible
  text like `importance:`. Values `trivial | low | moderate | high |
  critical`; an unrecognised value degrades silently to *no tier*
  (no parse warning). Feeds the autonomy-risk / needs-human
  derivation (`mug-autonomy-policy`), not the ranker.
* **`authority:`** — keyword, glyph-agnostic and stripped from the
  visible text the same way. Values `system | owner`, default
  `system`; an unknown value degrades silently to the default.
  `owner` always gates the call to a human; it feeds the same
  autonomy derivation, not the ranker.
* **Separators are display-only.** Examples may use `·` or `→` for
  human readability; the parser never depends on them. If you type
  `,` / `-` / `->` instead, it still parses.

Items not under a `## Phase N` heading are still parsed but flagged
by lint as "unphased".

### Importance

Every item carries an **importance** — a fourth axis, orthogonal to
[status](#status-vocabulary). Status says *where the item is in its
lifecycle*; importance says *how much it matters*. It is written as an
`importance:` keyword on the item line and parsed glyph-agnostically,
exactly like `blocked-by:`:

```markdown
- **P-030** `needs-human` Sign off before the production ship. importance: urgent
- **P-031** `todo` Tidy the dead feature flag. importance: low
- **P-032** `todo` Wire the new endpoint.
```

| Level    | Meaning                                                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `urgent` | Progress is fully blocked, **or** acting without a human risks harm (repeated failures, an irreversible / production-affecting approval, a security or data-loss risk, a release gate). Interrupt the human now. |
| `high`   | A real decision is needed and this thread is paused until it's answered, but other work proceeds and nothing is at risk. Should be seen today.                                                                   |
| `normal` | **Default.** A decision/approval or task is needed; nothing is stuck and it fits the normal cadence.                                                                                                             |
| `low`    | Informational, or there is a safe default and the agent will proceed with it if unanswered.                                                                                                                      |

Rules:

* **Default is `normal`** — omit the keyword for a normal item. The
  parser degrades any unrecognised value to `normal`; `plans:lint`
  emits a soft `unknown_importance` *warning* (never an error, so a
  typo can't fail CI).
* **One read, two uses.** For a `todo` it answers *which to pick up
  next*; for a `needs-human` item it answers *how urgently a human
  should act*. `plans:items` sorts by importance (urgent → low).
* **Distinct from the operator capability `tier`** (low/med/high),
  which measures *risk of the action*, not importance.
* **Always set deliberately.** When you create a `needs-human` or
  `todo` item, choose the level from the importance rubric rather than
  defaulting by reflex — see the agent prompts (and the rubric in
  `planning-attention-importance-2026-05-31`).

## Status vocabulary

Six tokens. One is *computed*.

| Token         | Meaning                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `todo`        | Not started. Default for new items.                                                                                                                                                                 |
| `wip`         | In progress. The active item. Use `locks:acquire` on the plan file before flipping to `wip`.                                                                                                        |
| `blocked`     | **External** blocker only — upstream PR, vendor response, awaiting a release, etc. *Not* used for items waiting on other plan items.                                                                |
| `needs-human` | A human decision/approval/clarification is required. Surfaces in `plans:items \{ needsHuman: true \}`. **The orchestrator cannot emit DONE while any started plan has an open `needs-human` item.** |
| `done`        | Completed and verified.                                                                                                                                                                             |
| `dropped`     | Decided not to do. Keep the line; record the reason in a `D-NNN` decision.                                                                                                                          |

### Computed-blocked

An item with `blocked-by: P-NNN` has *effective* status `blocked`
iff any `P-NNN` referenced is not yet *resolved*. A blocker is
resolved when its stored status is `done` (completed) or `dropped`
(abandoned — it will never complete, so the dependent un-gates;
`plans:lint` emits `blocker_dropped` so the dependency still gets
re-evaluated). As soon as all blockers resolve, the effective
status reverts to whatever the item is stored as (typically
`todo`) — automatically, no manual flip.

This is the load-bearing reason for the parser/effectiveStatus
split:

* `storedStatus` is the literal token written in the file.
* `effectiveStatus` is what callers (such as `plans:items` with `actionable: true`) actually want.

Why: a stored `blocked` would go stale the moment a blocker
finishes, and the only way to find the staleness is to remember.
Computing it eliminates the bug. The literal `blocked` token stays
useful for the case markdown genuinely can't compute — an
external blocker — where a human/agent has to explicitly declare
it.

## Milestone gates

Use `needs-human` items to insert mandatory approval gates between
phases. The orchestrator cannot emit `DONE` while any started plan
has an open `needs-human` item, so these gates block autonomous
progress until the user acts.

**Recommended pattern — pre-ship sign-off:**

```markdown
## Phase 3 — Ship

- **P-030** `needs-human` Human sign-off before shipping to production — review the Phase 2 results, confirm validation-contract.md is final, and mark this done to unblock the release. importance: urgent
- **P-031** `todo` Tag v1.0.0 release commit. blocked-by: P-030
```

When the user is satisfied with Phase 2 output they flip P-030 to
`done` (via the plan editor or `plans:set-status`). The orchestrator
picks up P-031 on its next tick.

**Agent-created gates** (architect judgment calls, spec ambiguities):
The architect and orchestrator create `needs-human` items dynamically
when they hit decisions that require human input. These appear in the
Decisions panel (`plans:items { needsHuman: true }`) with the feature
id, attempt count, and the agent's diagnosis. The user resolves by
editing the item note and marking it `done`.

## The `## Decisions` log

Append-only. Stable IDs. Tolerant heading match (same as `## Now`).

```markdown
## Decisions

### D-001 — Don't share code with harness `features`
Date: 2026-05-20
SU plans are standalone. The harness feature system is a workflow
engine for the autonomous side; we share neither schema nor code.
```

### Rules

* IDs are `D-NNN`, never reused. `plans:add-decision` allocates the
  next id inside a lock.
* New decisions append; existing ones are never edited (except a
  small `Superseded by D-NNN` line if reversed).
* Items reference decisions by ID; parser surfaces both directions.
* The `Date:` line is parsed if present; falls back to "no date" if
  absent.

## Tolerant heading match

The parser strips leading `N. ` / `N.M ` numbering from headings
before matching, so all of these are recognized:

* `## Now`
* `## 3. Now`
* `## 11.2 Now`

This lets you number your sections (`## 1. Background`, `## 2.
Goals`, `## 3. Now`, …) without breaking the parser. The format
spec uses the unnumbered form; conversions can do either.

## Fenced code blocks

The parser tracks fenced code blocks (` ``` ` or `~~~`) and skips
their contents. This means:

* `### D-NNN` inside an example block doesn't fool the decisions
  parser into thinking there's a real decision.
* `- **P-001** \`todo\` example\` inside a code fence isn't picked
  up as a real item.

ID allocators (`plans:add-decision`, `plans:add-item`) consult the
parsed structure — not raw bytes — so example IDs in prose don't
poison the allocator.

## Optional sections

* `## Background`, `## Scope`, `## Verification` — free prose,
  parser-agnostic.
* `## Open questions` — list of items waiting on a human decision.
  Each question, once ratified, becomes a `D-NNN` decision.
* `## Deferred follow-ups` — items intentionally not in scope;
  can later be promoted to real items.

## Umbrella plans and per-phase split-outs

A long-running plan often gets split into per-phase execution
plans (e.g. `myproject-v5-2026-05-23.md` spawns
`myproject-phase0-2026-05-23.md`, `myproject-phase1a-…`, etc).
When that happens, write activity divides:

* **The per-phase plan owns its item-level `## Now`.** Every
  `plans:set-now` / `plans:set-status` / `plans:add-item` /
  `plans:add-decision` for work *inside* the phase lands on the
  per-phase plan, not the umbrella.
* **The umbrella plan owns phase-level rollup.** Its `## Now`
  only updates on a *phase status transition* — a per-phase plan
  flips from `draft` → `active` → `shipped` (or `superseded`).
* **Per-phase plan's frontmatter `status:` is the source of truth
  for that phase's state.** The umbrella does *not* duplicate
  the value; it links + reads.

### Why

Two `## Now` blocks updated in parallel drift within a day. A
1000+-line umbrella's `## Now` cannot be a per-task journal
without rotting. Each doc gets one job: the per-phase plan is
the working surface; the umbrella is the index.

### When to update the umbrella

Trigger an umbrella `plans:set-now` only on these events:

1. A per-phase plan moves to `status: shipped` — record it in
   the rollup line, advance any blocked phases.
2. A per-phase plan moves to `status: active` — record "Phase
   X started."
3. A per-phase plan moves to `status: superseded` — note the
   reason and the successor slug.
4. A phase that was implicit in the umbrella's prose acquires
   a per-phase plan — record the slug + carve-out date.

Routine progress inside an active phase never touches the
umbrella. If you find yourself updating both per-phase and
umbrella in the same commit for the same item, you're doing
it wrong: ask "did a *phase* just change status?" If no, the
umbrella stays untouched.

### Umbrella's relationship to its per-phase plans

Recommended pattern: the umbrella's `## Now` carries a short
"Phase status" line per phase, sourced from each per-phase
plan's frontmatter — manually mirrored at status-transition
time. For programs spawning many phases, a `## Phase index`
section listing each per-phase slug + its frontmatter status
keeps the rollup readable without one-block-per-phase
duplication.

Per-phase plans should include a `supersedes:` or `parent:`
hint in frontmatter pointing back at the umbrella's slug —
this is informational; the parser ignores it.

## Worked example

Filename: `example-feature-2026-05-20.md` (slug = stem).

```markdown
---
title: Example feature
slug: example-feature-2026-05-20
status: active
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
---

# Example feature

## Now

**State:** Phase 1 in flight. Parser shipped; tools wired.
**Next:** an agent picks up P-007 (consolidation).

## Phase 1 — Tooling

- **P-001** `done` Spec the format. → D-002
- **P-002** `done` Implement parser.
- **P-003** `wip` Implement plans:list/get/items.
- **P-004** `todo` Implement plans:lint. blocked-by: P-003

## Phase 2 — Migration

- **P-007** `todo` Consolidate stray plan files.
- **P-008** `needs-human` Triage active vs stale across legacy plans.

## Decisions

### D-001 — Standalone, not shared with harness features
Date: 2026-05-20
SU plans are standalone…

### D-002 — PG-canonical
Date: 2026-06-03
Plans are PG-canonical (harness_shared.harness_plans); the markdown
`content` blob is the source of truth, rendered on demand. (Superseded
the original filesystem-canonical model — plans-pg-canonical-migration.)
```

## Validation assertions (VAL-\*)

Plan items can carry inline behavioral assertions that the validator
agent checks when certifying a feature. See
[Validation assertion format](/internal/docs/spec/validation-assertion-format)
for the full format, ID scheme, and tooling contract.

Short form: each assertion is a nested sub-bullet block under a plan item:

```markdown
- **P-007** `todo` Implement CSV export.
  - **[VAL-my-plan-2026-05-26-001]**
    - **Verify:** `GET /api/reports/:id/csv` returns `Content-Type: text/csv`.
    - **Evidence:** `tests/api/reports.csv.test.ts`
    - **Status:** `todo`
```

The plan parser ignores these sub-bullets; `plans:promote` extracts them
into `harness_plan_assertions` and populates `feature.claims`.

## The `## Promote` policy (waves)

A plan can carry a **`## Promote` policy** — plan-resident, fine-grained
control over *how* it is promoted into a harness as features, in ordered
**waves**. The human/architect authors it; the promote step and the
wave-advance sweep honor it. Optional — without it, promote takes an
explicit `features[]` list. (Source of truth:
`promote-policy-and-waves-2026-05-30`.)

A fenced `yaml` block under a `## Promote` heading (numbered headings like
`## 9a. Promote` are also recognized):

```yaml
target_harness: restart          # default harness (a promote call may override)
waves:
  - id: tier1                     # static wave — features listed verbatim
    features:
      - title: "Fix marketplace schema fetchers"
        from_items: [P-001]       # plan items this feature covers (marked done on promote)
        assigned_role: worker     # per-feature hint → feature metadata
  - id: tier2
    blocked_by: tier1             # documents ordering (tier2 follows tier1)
    generate:                     # generative wave — one feature per runtime item
      for_each: universal_type    # a named set the promoter resolves at promote time
      feature_template:
        title: "Universal schema: {item}"          # {item} substituted per item
        acceptance: ["validates vs asinDetails for {item}"]
        agent_hint: "row-grain; union all marketplaces"
  # ⚠ spawn_child is the EXCEPTION, not a default (anti-over-spawn, D-001):
  # declare it ONLY when this wave's work crosses a repo/worktree boundary or
  # needs its own lifecycle/done-definition. Same-repo sub-work stays as plain
  # features in THIS harness — the dispatcher already runs feature pipelines
  # concurrently, so a child buys no extra parallelism, only overhead.
  - id: extract-cli
    spawn_child:
      slug: my-tool-cli           # NEW child harness slug (≠ target_harness, unique)
      template: node-cli          # spawnable template — the child's own repo (required, v1)
      goal: "Extract the CLI into its own repo + release lifecycle"   # ≤280 chars
    features:                     # these features populate the CHILD, not target_harness
      - title: "Port the CLI entrypoints"
        from_items: [P-009]       # parent items — marked done once the child is seeded
        acceptance: ["CLI builds + smoke-runs in the child repo"]
```

**Waves** run in order. A wave is **static** (`features[]` listed verbatim)
and/or **generative** (`generate` — the `feature_template` expanded once per
item in the `for_each` runtime set, with `{item}` substituted in
title/acceptance/body). A generative wave's set is **resolved at promote
time**, not hand-listed — so a plan whose later features depend on what
earlier waves *discover* (e.g. "one feature per universal product type the
Tier-1 pass found") is expressible.

**Static feature fields:** `title` (required), `from_items?` (P-NNN ids
covered), `acceptance?`, `body?`, and the hints `assigned_role?` /
`blocked_by?` / `order?` (carried into the feature's `metadata` for the
orchestrator).

### Spawning a child harness (`spawn_child`)

A wave may declare `spawn_child` to route its features into a **newly
created child harness** instead of `target_harness` (source of truth:
`promote-spawn-child-harness-2026-05-31`). On `apply:true`, promote
**scaffolds** the child from the spawnable `template` (its own repo —
the parent harness is sealed server-side from the promote caller, never
from the YAML), **auto-synthesizes a seed plan**
(`<child-slug>-seed-<date>`, the wave's features as items with their
`acceptance` as inline VAL-\* assertions), **imports** the wave's
features into the child against that seed plan, and **starts** it — so
the dispatcher picks the child up with a real acceptance contract. On
`apply:false` the preview reports the would-be child (slug, seed plan,
feature count) with no side effects. Failures land in `warnings[]` and
a re-promote resumes idempotently.

**Anti-over-spawn rule (D-001): `spawn_child` only for cross-repo or
own-lifecycle work; same-repo sub-work stays as features in the current
harness.** The dispatcher already runs feature pipelines concurrently —
a child harness buys no extra parallelism, only overhead (own schema,
worktree, crew, recursion budget). `plans:lint` warns on every
spawn\_child wave to prompt that justification; when in doubt, don't
spawn.

### Promoting waves

`plans:promote \{ slug, all_waves: true \}` (policy-mode, the default path
since P-044) reads the policy and promotes **every wave up front in one
pass** — building each wave's features (static defs, and/or the generative
template × `generate_items`) and stamping each feature's `wave`.
`harness_slug` falls back to `target_harness`. The legacy explicit form —
`plans:promote \{ slug, harness_slug, features:[...] \}` — still works for
plans without a policy, and the single-wave form `plans:promote \{ slug, wave \}`
remains for promoting one named wave at a time.

### Cross-wave ordering (all-waves-up-front, P-044)

Because all waves are promoted up front, wave ordering is **not** a runtime
poll. A wave's `blocked_by: <prior-wave-id>` is compiled into **feature-level
`blocked_by` edges** (`applyInterWaveEdges`): every feature in a wave is
blocked by every feature title of the wave it depends on, so the dispatch
frontier (P-042) alone sequences the waves — there is **no `current_wave`
cursor and no 30s wave-advance sweep** (the per-wave advance role/poll was
retired in P-044). A failing/stuck upstream feature simply leaves its
downstream `blocked_by` edges unsatisfied, so dependent waves don't start
until it's fixed or `deprecate`d. Completion-time `for_each: { from_feature }`
generative waves stay deferred and expand on publish rather than up front.

## Tool surface

Plans are read and written through the `plans:*` MCP tools.

### Reads

* `plans:list` — directory summary with item counts by
  `effectiveStatus`.
* `plans:get \{ slug \}` — full parsed structure.
* `plans:items \{ actionable, needsHuman, status, slug \}` — item-
  level query across plans.
* `plans:search \{ query, scope \}` — keyword search scoped to
  title/now/items/decisions/prose.
* `plans:lint` — validate; legacy files exempt.

### Writes

* `plans:new \{ slug, title \}` — create from template, slug
  uniqueness checked inside a lock.
* `plans:set-status \{ slug, itemId, status, note? \}` — flip one
  **item's** stored token.
* `plans:set-plan-status \{ slug, status \}` — flip the **plan's**
  lifecycle status (`draft`/`ready`/`active`/`shipped`/`superseded`)
  — distinct from the per-item verb above.
* `plans:set-now \{ slug, state, next \}` — replace the Now block
  atomically.
* `plans:add-decision \{ slug, title, body, refs? \}` — append; D-NNN
  allocated inside the lock.
* `plans:add-item \{ slug, phase, text, importance, blockedBy? \}` —
  append; P-NNN allocated inside the lock; creates phase section if
  missing. `importance` is **required by the tool** (no silent
  default), even though the markdown form defaults to `normal` when
  the keyword is absent.
* `plans:set-importance \{ slug, itemId, importance \}` — set one
  item's importance.
* `plans:set-item-blocked-by \{ slug, itemId, blockedBy \}` — rewrite
  an item's `blocked-by:` set.
* `plans:set-item-phase \{ slug, itemId, phase \}` — move an item to a
  different phase section.
* `plans:set-frontmatter \{ slug, … \}` — edit frontmatter fields.
* `plans:set-title \{ slug, title, rationale? \}` — rename the reserved display title
  without rewriting the rest of the frontmatter or plan body.
* `plans:transfer-owner \{ slug, owner \}` — change the plan's human
  owner.
* `plans:set-content { slug, content, expectedHash }` — replace the
  whole plan body after CAS/lint checks; use only when the full body
  comfortably fits in one tool call.
* `plans:set-content-chunk { op, slug, draftId?, chunk?, expectedHash? }`
  — staged whole-body rewrite for large plans. Flow: `begin` with the
  `plans:get` `contentHash` as `expectedHash`, `append` chunks under
  24k characters, then `commit`. Only `commit` writes the real plan
  file, with the same CAS/lint/revision behavior as `set-content`.

All write verbs acquire a `locks:*` lock on the plan file before
the read-modify-write, surface `busy` with holder info if the lock
is held, and auto-bump frontmatter `updated:` to today's date.

## Lint rules

`plans:lint` returns `errors` + `warnings`. CI must fail on errors;
warnings are informational. Legacy files (no/malformed
frontmatter) are exempt entirely.

### Errors

* `slug_mismatch` — frontmatter `slug:` doesn't match filename
  stem.
* `missing_now_section` — required `## Now` is absent.
* `parse_warning` — parser surfaced a structural issue (duplicate
  IDs, malformed line).
* `unknown_blocked_by` — item references a `P-NNN` that doesn't
  exist in this plan.
* `missing_blocker` — same, from the resolver's perspective.
* `cycle` — item is part of a `blocked-by` cycle.
* `malformed_item_id` — item id isn't in `P-NNN` form.
* `missing_promoted_block` — the plan promoted ≥1 feature but its
  body has no `## Promoted` block. **Date-gated:** an *error* for
  plans created on/after `2026-05-24`, a *warning* for older plans
  (regenerate the block with `plans:promote apply=true`).

### Warnings

* `missing_decisions_section` — items exist but no `## Decisions`
  section.
* `unknown_decision_ref` — item references `D-NNN` that doesn't
  exist (allowed; the decision may live in a different plan).
* `stored_blocked_with_blocked_by` — an item is stored `blocked`
  *and* carries `blocked-by`. The `blocked` token is for external
  blockers only; internal dependencies are computed, so the stored
  token should be `todo`.
* `blocker_dropped` — an item's `blocked-by` points at a `dropped`
  item. The dependent un-gates (a dropped blocker never completes),
  but the dependency should be re-evaluated.
* `unphased_item` — an item is not under a `## Phase` heading.
* `superseded_status_mismatch` — the plan records that it's
  superseded (frontmatter `superseded-by:` or a `## Now` "superseded
  by" line) but its `status` isn't `superseded`. Flip it with
  `plans:set-plan-status`.
* `completion_status_mismatch` — a non-terminal plan
  (`draft`/`ready`/`active`) looks finished — all its items are
  closed, or its `## Now` state uses strong whole-plan completion
  language — but its status wasn't flipped to `shipped`.
* `owner_ask_not_needs_human` — the `## Now` block phrases an
  owner/human action-gate but the plan has no `needs-human` item, so
  the ask never reaches the owner inbox. Encode it as a
  `needs-human` item.
* `checkbox_item_syntax` — checkbox-style item lines
  (`- [ ] P-NNN — text`) parse as **zero** items (invisible to
  `plans:items` and `plans:set-status`). Rewrite as the canonical
  `- **P-NNN** \`status\` text\` form.
* `decision_done_items_todo` — a `done` decision still has open
  (`todo`) items referencing it.
* `unknown_importance` — an item's `importance:` value isn't one of
  `urgent | high | normal | low` (degrades to `normal`; a typo can't
  fail CI).
* `spawn_child_wave` — a `## Promote` wave declares `spawn_child`,
  which creates a new child harness — confirm the cross-repo /
  own-lifecycle justification (D-001).
* `spawn_child_ambiguous_target` — a `spawn_child` wave gives
  neither `repo` nor `template`, so the child's target tree is
  ambiguous.

## Concurrency

Same-plan concurrent writes serialize through a **PG advisory xact lock** on
`(workspace_id, harness_slug, plan_slug)` held across the read-modify-write
(plans-pg-canonical-migration-2026-06-03 D-005), replacing the old filesystem
`O_EXCL` lock. ID allocation (D-NNN, P-NNN) happens *inside* the advisory lock,
so concurrent `plans:add-decision` calls produce sequential non-colliding IDs.
Editor concurrency is additionally guarded by an optimistic `version`-column
compare-and-swap: a write based on a stale `version` is rejected rather than
clobbering a concurrent change.
