/**
 * Flag-gated wiring that re-points a work-item claim onto the per-Hive authority LEASE
 * (decentralized-dispatch-scaling-2026-06-08 P-004 / D-002, on D-007's recommended
 * HYBRID — authority-arbitrated exactly-once, fail-open to reconcile).
 *
 * DEFAULT ON (graduated 2026-06-23, owner-directed verify+flip, WI-597 — the flag registry
 * libs/flags/src/types.ts is the source of truth; this header previously said OFF and lied,
 * cross-machine-coord-parity-and-trust-2026-07-01 P-017). The `WORKITEM_CLAIM_LEASE` FLAG
 * remains the OWNER'S KILL SWITCH: flipping it OFF reverts `work_items:claim_next` / `:claim`
 * to the plain local `SELECT … FOR UPDATE SKIP LOCKED` on one PG. Migrated off the ad-hoc `PAPERCUSP_WORKITEM_CLAIM_LEASE` env gate to a FLAG
 * (work-queue-stuck-item-recovery P-012 / D-008); because the decision is read SYNC deep in
 * the claim path, the flag is held in a SYNC-cached boolean refreshed on the FIRST READ + every
 * flag change (`lazy-flag-refresh.ts` — see the arming note on `armFlagRefresh` below).
 * Listed in KNOWN_DARK_FLAGS.
 *
 * When ON: after the local claim sets `taken_by`, the claim tool acquires the Hive lease
 * through the per-Hive authority (the swarm router installed at boot — see
 * register-claim-authority-ops.ts). On a single box the authority is self → the lease is
 * a local row. Cross-Swarm, the Hive authority (lowest-live-device-pubkey,
 * `lockAuthorityForHive`) serializes: exactly one Swarm wins the lease; the loser
 * RELEASES its local claim so the item returns to the backlog. If the authority is
 * partitioned the acquire fails OPEN to a local advisory lease and
 * `work-item-claim-reconcile.ts` (P-005) resolves any double-claim on reconvergence.
 */
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import { activeWorkspaceId } from './workspace-registry';
import { systemDistinctId } from './flag-distinct-id';
import { potHomeSlugForHarness } from './hive-federation';
import { acquireClaim, releaseClaimForItem, releaseClaimForItemByOwnerLocal, gcOrphanIssueClaimsLocal } from './work-item-claims';
import { getBootedHarness } from './sync/hyperbee/boot-all';
import { resolveMyPubkey } from './orchestrator/distributed-claim';

// P-012 / D-008: the WORKITEM_CLAIM_LEASE flag, SYNC-cached because the claim-path read
// must be synchronous.
//
// ⚠ Unloaded → false, and the flag's registry DEFAULT is ON (graduated 2026-06-23, WI-597).
// An earlier version of this comment claimed "DEFAULT OFF, the safe behavior" — that was
// stale in the same way this file's header once was (see the header's own note). The
// unpopulated state is nonetheless the SAFE one, which is what licenses lazy arming below:
// false means "skip the Hive lease and use the plain local SELECT … FOR UPDATE SKIP LOCKED",
// i.e. exactly the baked pre-feature path the owner's kill switch reverts to. It closes the
// feature rather than opening anything up, so it cannot be a WRONG or unsafe value — only a
// not-yet-applied one. Contrast auth-config-overrides.ts, which stays in the guard BASELINE
// precisely because ITS unpopulated state is the permissive one.
let claimLeaseOn = false;
async function refreshClaimLease(): Promise<void> {
  try {
    claimLeaseOn = await getFlag(FLAGS.WORKITEM_CLAIM_LEASE, systemDistinctId());
  } catch {
    claimLeaseOn = false;
  }
}

// EI-19416650993725684: the subscription is armed on FIRST READ, never at module scope — a
// module-scope `onFlagChange` binding access makes this file (and every test that
// transitively imports it) unimportable under a PARTIAL vitest mock of
// '@papercusp/flags/server'. See lazy-flag-refresh.ts for the mechanism and for why the
// defensive-looking forms (`onFlagChange?.()`, typeof, try/catch) do NOT work.
//
// ⚠ ARM FROM EVERY READER — there are FOUR here, not just the exported getter:
// workItemClaimLeaseEnabled, releaseWorkItemLease, releaseIssueClaimLease and
// gcOrphanIssueLeases each read `claimLeaseOn` directly. A missed arm point in a process
// whose only reader is, say, the orphan-lease reaper would leave that reaper permanently
// unarmed; this module has NO periodic refresh timer to bound such a miss, unlike the
// config-override callers lazy-flag-refresh's doc describes.
//
// The one behaviour change: the FIRST reader call still sees `false` (the refresh is async,
// the read is sync). For the claim path that means one claim taken without the cross-Swarm
// lease — which is precisely the documented FAIL-OPEN posture (D-007), with
// work-item-claim-reconcile.ts (P-005) resolving any double-claim on reconvergence. On a
// single box the authority is self, so the skipped lease is a local no-op.
const armFlagRefresh = lazyFlagRefresh(refreshClaimLease, {
  keys: [FLAGS.WORKITEM_CLAIM_LEASE],
  // SEEDED 2026-08-03 (WI-8887). Before this, the window served the hardcoded `false` above while
  // the flag is DEFAULT ON, so every process's first claim skipped its lease. The old declaration
  // (kind 'selects-behaviour') justified that as an acceptable degradation and was correct — but
  // justifying a divergence is second-best to not having one. The deref is LAZY (inside this
  // callback), the form check-no-module-scope-flag-subscribe.mjs documents as correct.
  seed: () => {
    claimLeaseOn = FLAG_DEFAULTS[FLAGS.WORKITEM_CLAIM_LEASE];
  },
  unpopulated: {
    kind: 'seeded-from-flag-default',
    serves:
      'FLAG_DEFAULTS[WORKITEM_CLAIM_LEASE] — currently true, i.e. the lease IS taken, which is ' +
      'production. The window now diverges only where a runtime OVERRIDE holds the flag OFF, and ' +
      'self-heals within one refresh round-trip. The prior justification still covers that residual ' +
      'and is kept because it is what makes the residual acceptable: a skipped lease is the ' +
      'documented FAIL-OPEN posture (D-007), work-item-claim-reconcile.ts (P-005) resolves any ' +
      'resulting double-claim on reconvergence, and on a single box the authority is self so the ' +
      'skip is a local no-op — a self-healing degradation of at most one claim per process, never a ' +
      'wrong answer. NOTE the seed does not touch the ERROR path: a getFlag failure still lands on ' +
      "`false` via refreshClaimLease's catch, deliberately.",
  },
});

/** The owner's ratification switch (D-008). **DEFAULT ON** — measured, not assumed:
 *  `FLAG_DEFAULTS[WORKITEM_CLAIM_LEASE] === true` (2026-08-03). Read from the SYNC-cached
 *  WORKITEM_CLAIM_LEASE flag (migrated off the PAPERCUSP_WORKITEM_CLAIM_LEASE env gate). */
export function workItemClaimLeaseEnabled(): boolean {
  armFlagRefresh();
  return claimLeaseOn;
}

/**
 * Acquire the per-Hive authority lease for a work item that was just locally claimed.
 * Returns whether THIS Swarm holds the Hive lease. On `false` the caller must release its
 * local claim (the item is held by another Swarm's Hive lease). Best-effort Hive
 * resolution: a non-Hive harness falls back to harness-scoped arbitration inside the
 * store. `holderPubkey` is left to the store default (null) here — it feeds the
 * cross-machine reconcile (P-005), which is the gated cross-Swarm path, not the
 * single-box claim.
 */
export async function leaseClaimedWorkItem(opts: {
  harness: string;
  workItemId: string;
  owner: string;
  workspaceId?: string;
}): Promise<boolean> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  let potSlug: string | null = null;
  try {
    potSlug = await potHomeSlugForHarness(workspaceId, opts.harness);
  } catch {
    potSlug = null; // not part of a Hive / resolution failed → harness-scoped fallback
  }
  const res = await acquireClaim({
    workspaceId,
    harnessSlug: opts.harness,
    workItemId: opts.workItemId,
    potSlug,
    owner: opts.owner,
    intent: 'work-stealing claim (claim_next)',
  });
  return res.ok;
}

/**
 * EI-6832: best-effort lease cleanup for a work item RETURNING to the unclaimed pool via
 * `work_items:release` (voluntary release, not `leaseClaimedWorkItem`'s own claimId-checked
 * release). See {@link releaseClaimForItem}'s doc comment for the full mechanism this
 * closes (a stale, not-yet-expired lease silently poisoning the item for every OTHER
 * claimant until its TTL lapses — up to 30m/2h — even though the item is visibly
 * unclaimed). A no-op when the lease flag is off (nothing to clean up) or `owner` is
 * empty (nothing was ever leased under that identity). NEVER throws — callers must not
 * let this cleanup's failure block the actual release; a leftover stale lease degrades
 * to "this one item is temporarily un-self-selectable", never a correctness break.
 */
export async function releaseWorkItemLease(opts: { harness: string; workItemId: string; owner: string | null | undefined }): Promise<void> {
  armFlagRefresh();
  if (!claimLeaseOn || !opts.owner) return;
  try {
    const workspaceId = activeWorkspaceId();
    // Same potSlug resolution as leaseClaimedWorkItem (above), so a release routes to
    // the SAME authority scope the original acquire did — on a single box this is a
    // no-op (authority = self either way); cross-Swarm it matters.
    let potSlug: string | null = null;
    try {
      potSlug = await potHomeSlugForHarness(workspaceId, opts.harness);
    } catch {
      potSlug = null;
    }
    await releaseClaimForItem({ workspaceId, harnessSlug: opts.harness, workItemId: opts.workItemId, potSlug, owner: opts.owner });
  } catch {
    // best-effort — a stale lease that outlives its TTL is a temporary DX papercut,
    // never worth risking the caller's actual release for.
  }
}

/**
 * EI-6480: harness-agnostic lease cleanup for an ISSUE-FAMILY item returning to the pool
 * (reclaimStaleIssueClaims / releaseIssue). Unlike {@link releaseWorkItemLease} — which keys
 * on the item's harness_slug (correct for the feature family, whose slug is bare) — an issue
 * lease is acquired under the CLAIMING AGENT's bare harness, and `engineer_issues` has no
 * harness_slug to reconstruct it (an `operator:<ws>`-scope issue can't recover it at all). So
 * this keys on (workspace_id, work_item_id, owner) — safe because issue ids are globally
 * unique. The workspace is the LEASE's workspace = activeWorkspaceId() (what
 * leaseClaimedWorkItem used at acquire), NOT the issue's scope-workspace. No-op when the
 * lease flag is off or `owner` is empty; NEVER throws (a leftover lease is a temporary DX
 * papercut — never worth failing the caller's release/reap).
 */
export async function releaseIssueClaimLease(opts: {
  workItemId: string;
  owner: string | null | undefined;
  workspaceId?: string;
}): Promise<boolean> {
  armFlagRefresh();
  if (!claimLeaseOn || !opts.owner) return false;
  try {
    const workspaceId = opts.workspaceId ?? activeWorkspaceId();
    return await releaseClaimForItemByOwnerLocal({ workspaceId, workItemId: opts.workItemId, owner: opts.owner });
  } catch {
    // best-effort — see releaseWorkItemLease's doc comment (a stale lease is a DX papercut).
    return false;
  }
}

/**
 * EI-6480 orphan-lease GC (issue-family) — flag-gated wrapper over
 * {@link gcOrphanIssueClaimsLocal}. Self-heals any stale claim_next lease left on an
 * unclaimed, non-terminal issue by ANY taken_by-clearing path (present or future), plus the
 * historical backlog. No-op returning 0 when the lease flag is off; never throws. Returns the
 * number of orphan leases cleared (for the reaper's observability + the integration test).
 */
export async function gcOrphanIssueLeases(): Promise<number> {
  armFlagRefresh();
  if (!claimLeaseOn) return 0;
  try {
    return await gcOrphanIssueClaimsLocal();
  } catch {
    return 0;
  }
}

/**
 * The serializable subset of a held work-item lease that the DBOS pipeline carries so it
 * can RENEW the lease + SELF-ABORT if it is stolen mid-run (shared-hive-loop-e2e-testing
 * D-007). Plain data — threaded through `PipelineInput` (DBOS-serializable). `workItemId`,
 * `harnessSlug`, `workspaceId` are already on `PipelineInput`, so only the lease identity
 * lives here. The heartbeat re-keys on (workItemId, claimId, owner) routed by `potSlug`.
 */
export interface WorkItemClaimLeaseHandle {
  claimId: string;
  /** THIS Swarm's lease owner (its device pubkey, or the swarm-local fallback). */
  owner: string;
  potSlug: string | null;
  holderPubkey: string | null;
}

/** The outcome of an executor lease attempt: whether this Swarm may run the feature, plus
 *  the lease HANDLE to thread into the pipeline when it took one (D-007). */
export interface FeatureLeaseResult {
  /** This Swarm may run the feature (it holds the lease, or fail-open). */
  ok: boolean;
  /** The acquired lease, present only when `ok` AND a real claim was taken. ABSENT on
   *  refusal (another Swarm holds it) AND on the fail-open path (no handle to heartbeat →
   *  the pipeline runs WITHOUT the D-007 zombie-guard, exactly as before the lease landed). */
  claim?: WorkItemClaimLeaseHandle;
}

/**
 * The orchestrator-side (per-Swarm executor) lease gate — decentralized-dispatch-scaling
 * P-007/P-008. Before the DBOS executor dispatches a READY feature (eligibility still
 * decided by computeFrontier), acquire the per-Hive lease so that cross-Swarm exactly ONE
 * Swarm runs it: the lease is the cross-machine exactly-once gate, with DBOS workflow-id
 * dedup remaining the LOCAL guard (D-006 — the orchestrator is demoted from sole global
 * dispatcher to one Swarm's executor that work-steals).
 *
 * Owner = THIS Swarm's device pubkey so two Swarms are DISTINCT holders (a shared owner
 * would both "win" the acquire's own-extend clause). Returns whether this Swarm may run
 * the feature AND (on success) the lease handle to thread into the pipeline — the running
 * pipeline then renews the lease + self-aborts on a steal (D-007), which retires the old
 * dispatch-loop keep-alive re-acquire (a long pipeline keeps its OWN lease alive now).
 *
 * FAIL-OPEN (D-007): any resolution / authority / PG error → returns `{ ok: true }` (no
 * handle) so dispatch proceeds. The lease gate must NEVER wedge the live dispatcher; a
 * rare cross-Swarm double-run (e.g. a lease that lapses mid-pipeline) is the
 * tolerate-and-reconcile case (work-item-claim-reconcile, P-005). A generous TTL (2h)
 * covers a long pipeline and an enqueue-wait before the pipeline starts heartbeating.
 */
export async function leaseFeatureForExecutor(opts: {
  workspaceId: string;
  harness: string;
  featureId: string;
}): Promise<FeatureLeaseResult> {
  try {
    const booted = getBootedHarness(opts.workspaceId, opts.harness);
    const owner = (booted ? resolveMyPubkey(booted) : null) ?? `swarm-local:${opts.harness}`;
    let potSlug: string | null = null;
    try {
      potSlug = await potHomeSlugForHarness(opts.workspaceId, opts.harness);
    } catch {
      potSlug = null;
    }
    const res = await acquireClaim({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harness,
      workItemId: opts.featureId,
      potSlug,
      owner,
      holderPubkey: owner,
      intent: 'executor dispatch (orchestrator)',
      ttlSec: 7200,
    });
    if (!res.ok) return { ok: false };
    return {
      ok: true,
      claim: {
        claimId: res.claim.claimId,
        owner: res.claim.owner,
        potSlug: res.claim.potSlug,
        holderPubkey: res.claim.holderPubkey,
      },
    };
  } catch {
    return { ok: true }; // fail-open — never let the lease gate wedge the live dispatcher
  }
}
