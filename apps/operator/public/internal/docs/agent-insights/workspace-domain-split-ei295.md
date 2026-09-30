# The workspace-domain split (EI-295)
URL: /internal/docs/agent-insights/workspace-domain-split-ei295

Presence/activity rows stamp AGENT workspace; plan-store rows stamp DEFAULT. Readers joining both must accept all three workspace IDs (agent, default, global) until axes unify.

## What

The Papercusp workspace scoping model uses two distinct domains for row identity:

* **Presence rows** (`harness_shared.coord_presence`, read into `harness_shared.fleet_assignment` as `source='presence'`): stamp the **AGENT workspace** — the workspace where the agent is spawned (e.g., `papercusp-workspace`).
* **Plan-store rows** (e.g., `plans`, `plan_item_claims`, `plan_items`): stamp the **DEFAULT\_WORKSPACE\_ID** (`'default'`) — the workspace resolved by `resolvePlanScope`.

This split exists because agents span workspaces but claims + plans are anchored to a single default scope. It is intentional but sharp: readers that JOIN presence-domain rows with plan-store rows see double the workspace scope until the axes unify.

> **Current behavior (2026-07-10).** The `owner_activity` table named below (Bugs 1–3, as of 2026-06-11) no longer exists — presence now lives in `harness_shared.coord_presence`, and the canonical reader is the `harness_shared.fleet_assignment` VIEW (migration 165+, `state-not-chat-fleet-state-2026-06-05`), which UNIONs `plan_item_claims` + `plan_item_assignments` + work-item `taken_by` claims with `coord_presence`, each LEFT-joined to its holder's liveness. **The rule itself is unchanged and still enforced**: `listFleetAssignments` (`packages/operator-core/lib/fleet/assignments.ts`) still explicitly accepts all three workspace IDs — the caller's workspace, `DEFAULT_WORKSPACE_ID`, and `GLOBAL_WORKSPACE` (`'*'`) — with an inline comment citing EI-295 verbatim. Bug 3 (below) is now moot: `defaultSharedResolver` (`packages/operator-core/lib/plan-items/liveness.ts`) was rewritten to decide a harness's liveness mode from `harness_shared.contributors` (a distinct-GitHub-user count), not from presence/claim rows at all — it no longer touches either domain, so the "wrong domain" failure mode described in Bug 3 cannot recur there. See "The rule for future agents" below — it still applies verbatim to any NEW reader that joins presence with plan-store rows.

## The bugs (2026-06-11)

Three bugs surfaced from this split on 2026-06-11:

### Bug 1: fleet\_assignment reader dropped all claims

**What**: The `fleet_assignments` reader (`lib/fleet/assignments.ts`) was filtering for only one workspace ID. It would join `owner_activity` (agent workspace) with `plan_item_claims` (default workspace) but accept only one side, dropping claims in the other domain.

**Fixed in**: `packages/operator-core/lib/fleet/assignments.ts` — the WHERE clause now accepts rows from all three workspace IDs: the caller's agent workspace, `DEFAULT_WORKSPACE_ID` (`'default'`), and `GLOBAL_WORKSPACE` (`'*'`) — and unifies them in the result.

### Bug 2: claim renewal missed default-domain rows

**What**: The auto-renewal routine (`renewOwnerActivityClaims` in `lib/plan-items/claims.ts`) refreshed the `owner_activity` side (agent workspace) but did not refresh `plan_item_claims` rows in the default workspace. Claims would show stale in one domain while live in the other.

**Fixed in**: `packages/operator-core/lib/plan-items/claims.ts` — the renewal now touches both domains.

> *Update (2026-07-10):* `renewOwnerActivityClaims` (the function name is historical) now renews only `plan_item_claims`, filtered by `(workspace_id = <caller's> OR workspace_id = DEFAULT_WORKSPACE_ID)` — there is no separate `owner_activity` row left to renew, since that table was retired in favor of `coord_presence` (a live heartbeat, not a claim-renewal target).

### Bug 3: shared-resolver counted contributors in the wrong domain

**What**: The `defaultSharedResolver` (`lib/plan-items/liveness.ts`) counted work contributors by querying `owner_activity`, but some contributors' claims were only live in the default-workspace `plan_item_claims` rows. The count was incomplete.

**Status**: Still unfixed, but harmless after fix #2. Once claims renew correctly in both domains, the domain mismatch no longer loses data — it just means the counter runs over only one domain instead of unifying both. A full fix would be to join both domains in the counter query.

> *Update (2026-07-10):* `defaultSharedResolver` (`packages/operator-core/lib/plan-items/liveness.ts`) has since been rewritten and no longer counts contributors via `owner_activity`/presence at all — it now counts `COUNT(DISTINCT github_user_id)` from `harness_shared.contributors` to decide whether a harness is SHARED (>1 contributor ⇒ `'activity'` liveness mode). This bug's specific failure mode (undercounting by querying the wrong workspace domain) no longer applies to this function; it is superseded by a different data source entirely.

## The rule for future agents

**Any reader JOINing presence-domain rows (`harness_shared.coord_presence`, `harness_shared.fleet_assignment`) with plan-store rows (like `plan_item_claims`, `plans`, `plan_items`) must accept and return rows from ALL THREE workspace IDs (agent workspace, `DEFAULT_WORKSPACE_ID`, and `GLOBAL_WORKSPACE='*'`) until the axes are unified.**

This is not a bug in your code; it is a property of the schema. If you write a reader that touches both domains:

1. Do not filter by a single workspace ID mid-query.
2. Do not assume one domain "is the right one" — both are valid.
3. If you need a single answer, unify the results on the client side or add a migration to stamp both domains the same way.

The workspace split is tracked under [EI-295](/) and the unification plan is in [local-pot-orchestration D-013](/).

## Related

* `lib/fleet/assignments.ts` — reader that correctly handles both domains (still cites EI-295 inline)
* `lib/plan-items/claims.ts` — renewal routine for `plan_item_claims` (the plan-store domain)
* `lib/plan-items/liveness.ts` — `defaultSharedResolver` no longer touches either domain (see the 2026-07-10 update above)
* EI-295 — the issue tracking full unification
* local-pot-orchestration D-013 — the unification roadmap
