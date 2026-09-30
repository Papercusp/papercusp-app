# Adding a derived plan frontmatter scalar (mirror `owner`)
URL: /internal/docs/agent-insights/adding-a-derived-plan-frontmatter-scalar

The full edit-site set for a new harness_plans frontmatter column (e.g. `initiative`) — incl. the 3 federation re-derive sites and the integration-test STUBS that unit tests won't catch.

## What

Adding a new plan-frontmatter scalar that must reach the client (a filter facet,
a badge) means adding a **derived index column** on `harness_plans`, mirroring
`owner` — NOT parsing the content blob in the resolver. `plans:list` is
deliberately parse-free (audit P-042): it reads `listPlanIndexRows` (index
columns only, content never leaves PG). Parsing for your field reintroduces the
exact per-request-parse regression P-042 removed.

Worked example: `initiative` (shared-pot-collaboration P-015 / D-015). The same
edit-site set was reused verbatim for `template`/`promote_policy`/`template_data`
(mig 329/331, plan-template provenance + auto-promote policy) — `template` is a
plain frontmatter-derived TEXT scalar (mirrors `initiative`, see the comments in
`with-plan-lock.ts` and `source.ts`), confirming the pattern below holds across
more than one addition.

## Why it's a trap

Two things bite you AFTER unit tests are green:

1. **The federation hand-written stubs.** Three integration tests build a
   *column-faithful* `harness_plans` via raw `CREATE TABLE` (not the migration
   set): `sync/hyperbee/__tests__/plan-part-federation-cutover.integration.test.ts`
   and `ei117-replay-revert-guard.integration.test.ts` mirror the real columns —
   you MUST add your column to their stub or they red with
   `column "<x>" of relation "harness_plans" does not exist` (the projection
   INSERT now binds it).
   (`backfill-local-state.integration.test.ts` uses a *subset* stub that omits
   `owner`/`supersedes` too — leave it; it never runs the full INSERT.) Unit
   tests + tsc are all green; only the integration tier catches this, so it lands
   as a green-checkpoint red unless you run the federation integration tests
   locally.

2. **Federation needs NO wire redesign** — and reasoning otherwise wastes time.
   The scalar is derived from `content`, and `content` always federates. The
   per-part recompose re-derives scalars from the recomposed frontmatter; the
   whole-blob projection carries them on the wire. So this is NOT the heavy
   "federated-schema migration" category — keep the wire validator *tolerant*
   (optional field) and you're done.

## The edit-site set (all mirror an existing `owner` line)

* **Parser** `libs/generic/plan-parser/src/parser.ts`: add to `PlanFrontmatter`
  * `if (typeof raw.<x> === 'string') out.<x> = raw.<x>;`
* **Migration**: reserve the number via `db:next-migration` (NOT a hand-picked
  one — they collide), then a single `ALTER TABLE … ADD COLUMN IF NOT EXISTS …
  text;`. Files ≥215 carry **no** top-level `BEGIN;/COMMIT;` (the runner wraps
  each file — `lint:migrations` enforces it).
* **source.ts**: `PlanRow`, `PlanDbRow`, `PlanIndex`, `rowFromDb`,
  `deriveIndexFromContent`, and **all five SELECT lists** (getPlanRow /
  listPlanRows / listPlanIndexRows / listPlanRowsMatchingAnyToken /
  `listPlanIndexRowsForWorkspace` — added 2026-06-30 for the scheduled-recurring-plans
  work; it carries its own column-not-exist fallback query, so both its SELECTs
  need the new column too).
* **with-plan-lock.ts**: the INSERT column list + VALUES + the `DO UPDATE SET`.
* **Federation (3 sites)**: `projections/harness-plans.ts` (wire type — make it
  optional/tolerant in `isHarnessPlanRow` — plus both INSERT paths),
  `projections/harness-plan-parts.ts` `defaultRecomposeSink`,
  `feature-issue-op-keys.ts` `toPlanValue`.
* **list.ts** (`plans:list`): `ListRow` + the pushed row.
* **Client**: `plans-api.ts` `PlanListRow`; `plan-filtering.ts` (state +
  predicate); `PlanFilters.tsx` (nuqs key + facet + active-token + clearAll) and
  the readers `PlanRail.tsx` / `PlanBucketTabs.tsx` that construct
  `PlanFilterState` (+ their test fixtures).
* **A write verb** (optional): mirror `plans:transfer-owner` — reuse its exported
  `setFrontmatterScalar`; register in `agent-tools/index.ts`; run `tools-md-sync`.

## generated.ts

The drizzle `generated.ts` models `harness_plans`. `pull-schema` regenerates it
from a *migrated* DB — which the dev box's live PG won't be until boot-apply
runs. Add the one convergent column line by hand (`<x>: text(),` after `owner`);
the drizzle-drift CI check is **informational/non-gating**, and a post-deploy
`pull-schema` yields the identical line.

## Verify

`vitest run` the federation integration tests above + the
`baseline-schema-globalsetup` test (proves your migration applies via the real
runner), plus the parser, `plan-buckets` (filter predicate), and `tools-md-sync`.
