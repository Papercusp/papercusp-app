# Per-phase execution-plan template
URL: /internal/docs/agent-insights/per-phase-execution-plan-template

The pattern proven across 13 dogfood-arc phase plans for splitting a master plan into shippable per-phase execution plans. Sub-acceptances, decision rules, named-fallback rollouts, and for-the-next-agent handoffs.

When a master plan grows past \~1000 lines and covers ≥3 phases with distinct deliverables, splitting into per-phase execution plans pays off. The pattern below was proven across all 13 dogfood-arc phase plans (`papercusp-dogfood-phase{0,1a,1b,2,4,5a,5b,6,7,8,9,10,11}-...-2026-05-24.md` in `apps/operator/docs/plans/`).

## When to split

Split when:

* Master plan exceeds \~1000 lines and phases have natural break-points.
* Multiple agents will work on different phases in parallel or in sequence.
* Some phases are partially done in-tree and others are fully greenfield — the per-phase plan can mark `DONE`/`PARTIAL`/`NOT STARTED` precisely.
* The master plan's phase-section entries are dense enough that a reader implementing one phase has to mentally filter out 90% of the doc.

Don't split when:

* The whole arc fits on one screen.
* All phases will run sequentially with the same agent.
* Phases are tiny (S-sized) and a per-phase plan would be longer than the section it replaces.

## The template

Every per-phase execution plan should contain these sections, in order:

### `## Now`

One sentence: the next concrete action. This is the cold-resume anchor — the most-read field. Anyone landing on the plan after a break sees this first.

### `## Background`

What this phase ships and which v5 section it implements. Two paragraphs max. Include:

* What's already done in-tree (with commit hashes if available).
* What's outstanding.
* The gate (phases this phase blocks-on).
* Whether this phase can run in parallel with siblings.

### `## Phase tasks`

Copy the relevant task rows from the master plan's `## Phases` section verbatim into per-task `### P-NNN` subsections. Each expansion includes:

**Sub-acceptances (P-NNNa/b/c)** — for tasks with platform-matrix or multi-condition dimensions. Example: Phase 0 P-001 (bundle Holepunch primitives) splits into P-001a (Linux), P-001b (macOS arm64), P-001c (macOS x64), P-001d (Windows), P-001e (Tauri bundle). Each sub-acceptance is independently testable and passes/fails on its own.

**Files** — the concrete paths the implementer will touch (existing files to edit, new files to create). Use the real repo layout. Don't say "the harness UI"; say `apps/operator-vite/src/components/adv/LearningTab.tsx`.

**Decision rule** — one sentence stating how to interpret partial-pass. Example: *"PASS when P-001a + P-001d + P-001e all pass. If P-001b fails but P-001c passes (or vice versa), acceptable — pick the side with prebuilds and document the other arch needs Xcode CLT. If both fail, hard fail."* The decision rule prevents "we did 4 of 5 — is that good enough?" debates.

**Status** — for tasks with prior in-tree work, mark ✅ DONE / 🟡 PARTIAL / 🔴 NOT STARTED at the section heading. Cite commit hashes for DONE. The implementer skims and knows immediately what they need to do.

### `## Decisions`

Sub-design decisions made during execution. Don't re-decide what the master plan already decided; reference D-NNN from the master plan instead. New decisions get fresh D-IDs scoped to this execution plan.

### `## Named fallback rollout` (only for phases with substrate-class failure modes)

Concrete numbered steps for how the fallback fires — exactly which master-plan sections get struck or rewritten, which phases get re-merged or removed, which deliverables get deleted from the tree.

**The named fallback being real is itself the gate guarantee.** Aspirational fallbacks ("we'll figure something out if this fails") are gate failures in disguise. Phase 0 of the dogfood arc has an 8-step rollout for "HYPERBEE bucket collapses into GIT bucket"; that specificity is what makes the gate meaningful. Most phases don't need this section (UI work, integration work without substrate dependencies); skip it then.

### `## Cross-references`

Link back to:

* The arc's overview doc (5-minute orientation surface).
* The execution-plan index doc.
* The master plan.
* Sibling phase plans (especially prereqs and dependents).
* Relevant D-decisions from the master plan.

A reader landing on this phase plan should never have to back-track to the master plan to find another doc; the cross-refs make the corpus self-navigating.

### `## Open questions`

Anything you hit during planning that needs the user's call. Number them Q-1, Q-2, etc. Each open question states the lean (your recommended answer) so the user can ratify-by-skim if they agree.

### `## For the next agent`

Brief whoever picks up the next phase. What's done that they inherit, what's gated on what, what surprises came up that aren't obvious from the plan body. Hand-off documentation is the discipline that keeps a multi-phase arc shippable.

This section also names the next plan that should be written. Example from Phase 2: *"Skip Phase 3 (substantially done in-tree, v5 entry suffices), write Phase 4 next. Phase 4 should heavily emphasize success criteria + pain capture."*

## Common pitfalls

* **Don't restate the master plan's design.** The execution plan is HOW; the master plan is WHY + WHAT. Restating WHY in every phase plan bloats the corpus.
* **Don't pre-commit detailed design that hasn't been discussed.** If a phase needs design work first, say so in `## Now` ("write three design memos before implementation"). Don't speculate UX patterns in the execution plan; that traps the implementer.
* **Don't size phases optimistically.** L is two-three weeks; M is one week; S is one-three days. If you're writing a phase that looks M but feels L, split it (e.g. Phase 1 → 1a + 1b; Phase 5 → 5a + 5b).
* **Don't omit the for-the-next-agent section.** It's the connective tissue. Every phase plan ships with one even if the content is one paragraph.

## Companion artifacts to write alongside the per-phase plans

After splitting an arc into per-phase plans, also write:

1. **Execution-plan index doc** (one page, in `apps/operator/docs/plans/<arc-slug>-execution-plan-index-<date>.md`). Status legend, per-phase status table with sizing + blockers, navigation hints. The single navigation surface so readers don't get lost in the cohort.

2. **Overview doc** (one page, in `apps/operator/docs/plans/<arc-slug>-overview-<date>.md`). 5-minute read covering why, what, how-rolled-out, what's done, what's deferred, what success looks like. Read before any individual phase plan.

3. **Design memos** (in `apps/operator/docs/plans/<arc-slug>-design-memo-<topic>-<date>.md` initially; convert to MDX under `apps/operator-docs/src/content/docs/design/` when implementation of the relevant phase begins — the operator docs site moved there from the retired `apps/operator/content/internal-docs/`). One memo per design question that gates implementation.

4. **Deferral plans** (separate plan docs for substantial threads carved out of the arc). The master plan's deferral block points at these; each deferral plan is a real plan with its own phases, decisions, and open questions — not a stub.

## When to update the index

After every phase plan write or status change, update the index in the same commit. The index is the single navigation surface; keeping it fresh is the discipline that prevents the cohort from devolving into "we have 12 plans, which one is real?" confusion.

## Why this template works

The template is shaped around three forces:

1. **Cold-resume reality.** Any agent picking up a phase has likely never seen it before. The `## Now` + the for-the-next-agent handoffs make cold-pickup work.
2. **Partial-progress reality.** Most phases have some prior in-tree work. The DONE/PARTIAL/NOT STARTED status + sub-acceptances let the implementer see exactly what's left without guesswork.
3. **Multi-agent parallelism.** Different agents will work different phases. The cross-refs + open-questions + handoffs are the inter-agent protocol.

The result: a multi-phase arc that can be picked up by any agent at any phase boundary without re-reading the entire corpus. Proven across the dogfood arc's 13 phase plans + 3 design memos + 2 deferral plans + 1 index + 1 overview + 1 master plan = 21 documents shipping a single arc.
