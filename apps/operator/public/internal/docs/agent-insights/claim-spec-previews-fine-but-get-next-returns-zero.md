# Claim spec previews fine but get_next returns zero: suspect the tier-3 id-leaf, not the floors
URL: /internal/docs/agent-insights/claim-spec-previews-fine-but-get-next-returns-zero

A drain fleet silently starves while scheduler:set_claim_spec's admissibilityPreview reports a healthy match count. The trap is a mis-classified id leaf skipping tier 3 (the only issue-family claim path) — not floors, kind, or state. Where to look, what NOT to re-check.

## Symptom

A backlog-drain fleet reports scoped-miss / windDown on **every** `scheduler:get_next`
call — "no claimable work-item matched your spec within the floors" — while hundreds of
genuinely open `bug`/`change`/`task` items sit unclaimed. Crucially:

* `scheduler:set_claim_spec`'s `admissibilityPreview.poolEffect.matched` looks **normal**
  (e.g. 299/313) — so the spec looks fine.
* A direct `work_items:claim { id: <a specific matching id> }` succeeds **instantly** — so
  the items really ARE claimable.
* Only the spec-driven `get_next` pull returns empty.

This has starved the fleet for hours more than once (backlog-drain-clean, 2026-07-17, 7+h;
EI-14231 / WI-5275). It fails **silent**: the spec validates (`ok:true`), and the miss reads
like a floors/eligibility problem, so the natural instinct — re-check kind/state filters,
re-check the readiness/blocking floors — leads nowhere.

## What is actually wrong (usually)

The pull is a **three-tier ladder** (`get-next.ts` `getNextWorkItem`): tier 1/2 query the
feature-family table (`harness_features_consolidated`); **tier 3 is the ONLY path that serves
issue-family work** (`bug`/`change`/`task`, via `claimNextIssueWorkItem`). Tier 3 is gated on
how it classifies any `id` leaf in the spec:

* A **positive closed-world allowlist** (`id in [...]` bare or ANDed in a top-level `all`) →
  tier 3 narrows to exactly those ids. This is `positiveIdCohortIds` (`claim-spec.ts`).
* Anything else — an `id` leaf wrapped in `not` (`not:{id in [...]}`, an *exclusion*), or
  reached through an `any` (OR) branch (a *widening*) — is **NOT** an allowlist.
  `positiveIdCohortIds` correctly returns `null`, and tier 3 must run **unrestricted by id**,
  honoring the exclusion via `negativeIdExclusions` → tier-3 SQL `excludeIds`.

The historical bug (the removed `filterHasIdConstraint`) mis-classified *any* id leaf found
anywhere — including a `not`-wrapped exclusion — as "the spec names an id allowlist", couldn't
safely extract a set, and fell into "can't extract ⇒ **skip tier 3 entirely**". Result: the
whole issue lane went invisible while the preview (which counts via `compileFilter` over the
NOT-NULL `feature_id` PK, a *different* code path) stayed accurate. That preview-HIGH /
pull-ZERO split is the signature.

So the natural way to exclude a couple of known-handled items —
`{ not: { field:"id", op:"in", value:[...] } }` — was the exact clause that zeroed the pool.

## The runbook

1. **Do NOT re-check floors/kind/state first.** The miss message points there; the bug is
   almost never there when a direct `work_items:claim` of a matching id succeeds.
2. **Read the spec's filter for an `id` leaf** — especially one inside a `not` or an `any`.
   That is the prime suspect.
3. **Confirm the classification.** `positiveIdCohortIds(spec.view.filter)` should be `null`
   for a `not`-wrapped / `any`-nested id leaf (so tier 3 runs). A non-null result there for
   an exclusion-shaped spec is the regression.
4. **Mitigate immediately**: drop the `id` clause (bump the revision). If the excluded items
   are already terminal, the clause is pure liability — remove it. `get_next` recovers
   fleet-wide at once. Also clear any per-bee spec that baked in the same clause.
5. **Then find the durable cause** if the pull still zeroes without an id leaf: the same
   class also bites a `not:`/`!=` fence over a **NULLABLE** field (`plan`/`assignee`/
   `risk_tier`) that isn't null-safe — see EI-13306; the SQL `not` must be
   `NOT COALESCE((...), false)`.

## Current state

All three legs are fixed and regression-tested: `positiveIdCohortIds` null-for-exclusion
(`claim-spec.test.ts`), the tier-3 `excludeIds` SQL leg end-to-end
(`get-next.integration.test.ts`, the "NOT-wrapped id EXCLUSION" case), and the full-incident
composition against the post-claim JS re-check (`claim-spec-match.test.ts`, EI-14231 block).

Known residual gap: `set_claim_spec`'s `admissibilityPreview` (`spec-pool-preview.ts`) still
computes matches via `compileFilter` directly, a **different** path than the tier-1/2/3 pull —
so a *future* tier-3 regression would again not be caught at write time. Unifying those paths
is tracked as EI-14231's deferred second ask.
