/**
 * work-item REDUNDANCY — BOINC-style redundant execution + judge for HIGH-STAKES items.
 *
 * Plan: decentralized-dispatch-scaling-2026-06-08 (Phase 5, P-014).
 *
 * The default dispatch is exactly-once: one Swarm claims an item and runs it
 * (`work-items.ts` claim_next + the `work_item_claims` lease). For an item the owner
 * deliberately marks HIGH-STAKES, this module INVERTS that — the same item is run
 * INDEPENDENTLY by N Swarms (replicas), each records its result, then a judge (reuse
 * gym:judge — the frozen Opus grader, the only grader of record) scores each replica and
 * the strongest composite is ADOPTED as the item's result; the losers are discarded.
 *
 * Unlike BOINC (which embraces redundancy to validate untrusted volunteers), agentic work
 * is expensive — so redundancy is OPT-IN, off by default, behind TWO gates:
 *   1. `workItemRedundancyEnabled()` (env `PAPERCUSP_WORKITEM_REDUNDANCY=1`) — the master
 *      switch. OFF ⇒ this module is never reached; claim_next is byte-identical.
 *   2. The per-item `redundancy` column (mig 195; default NULL ⇒ 1 ⇒ exactly-once) — which
 *      items are high-stakes. Only items with redundancy > 1 fan out.
 *
 * Storage (mig 195): `harness_shared.work_item_replicas` — one heartbeat-LEASED slot per
 * (item, replica_index), so up to N distinct Swarms hold distinct slots of the SAME item
 * ("claim one item to 2 Swarms"). The slot lease mirrors `work_item_claims` (mig 188): a
 * dead Swarm's slot lapses (expires_ts < now()) and is re-claimable. The judge verdict
 * (composite + rationale) lands on the same row; the winner's row (status='winner') is the
 * durable record of which replica was adopted.
 *
 * The judge LLM call is INJECTED (mirroring gym/judge.ts) so judge → pick-winner → adopt is
 * unit-testable without the network. NOT federated; NO RLS (coord-family); org handle +
 * workspace_id filter.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { getWorkItem, setWorkItemState } from './work-items';
import { isWorkItemAutoPickable } from './work-items-admission';
import { getWorkItemReplicaAuthority } from './work-item-replica-authority';
import { potHomeSlugForHarness } from './hive-federation';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import { systemDistinctId } from './flag-distinct-id';
import {
  judgeGymRun,
  rubricFromBlueprintGym,
  rubricHash,
  type GymJudgeRubric,
  type GymRubricInput,
  type JudgeLlmCall,
} from './gym/primitives';
import { pgTimestampToIso } from './pg-timestamp';

/**
 * Authority-op kinds for the replica store (EI-266) — the redundancy analog of
 * WORK_ITEM_CLAIM_OP_KINDS. A non-authority Swarm's replica op routes to the Hive
 * authority (where the `work_item_replicas` table is homed) under these kinds;
 * `work-item-replica-authority-ops.ts` registers the receiving handlers.
 */
export const WORK_ITEM_REPLICA_OP_KINDS = {
  claimSlot: 'work-item.replica.claim-slot',
  heartbeat: 'work-item.replica.heartbeat',
  release: 'work-item.replica.release',
  recordResult: 'work-item.replica.record-result',
  list: 'work-item.replica.list',
  judge: 'work-item.replica.judge',
} as const;

/** The authority scope key for a replica op: the Hive home if present, else the
 *  harness slug — identical to the claim store's scopeOf (single box → harness). */
function replicaScopeOf(opts: { potSlug?: string | null; harnessSlug?: string; harness?: string }): string {
  if (opts.potSlug && opts.potSlug.length > 0) return opts.potSlug;
  const harness = (opts.harnessSlug ?? opts.harness ?? '').trim();
  if (!harness) {
    // No Hive and no harness → an empty authority scope key collapses every harness's
    // replicas into one consensus bucket (misrouted judging). Fail loud, never `?? ''`
    // (workspace-data-isolation-leaks P-003).
    throw new Error(
      'replicaScopeOf: no potSlug and no harness — the replica authority scope key ' +
        'would be empty, collapsing distinct harnesses into one consensus bucket.',
    );
  }
  return harness;
}

/**
 * Resolve the Hive home slug for a harness so a replica op routes to the per-HIVE
 * authority (EI-266) — the caller (a tool) threads this into the store opts,
 * mirroring how work-item-claim-lease-wiring resolves it for the claim lease. Any
 * resolution failure (not part of a Hive / lookup error) → null = harness-scoped
 * fallback (single-box correct). Best-effort: never throws.
 */
export async function resolveReplicaPotSlug(workspaceId: string, harnessSlug: string): Promise<string | null> {
  try {
    return await potHomeSlugForHarness(workspaceId, harnessSlug);
  } catch {
    return null;
  }
}

/** The owner's master switch for BOINC redundancy (P-014). **DEFAULT ON** — graduated out of
 *  DARK_FLAGS 2026-06-22; `work-item-redundancy.test.ts` asserts the graduation, and
 *  `FLAG_DEFAULTS[WORKITEM_REDUNDANCY] === true` (measured 2026-08-03). This comment previously
 *  said "Default OFF … ships DARK, owner-ratified" in two places and the flags registry said
 *  "DARK (N× model spend)"; all three were stale, and one of them was load-bearing — it was the
 *  stated justification for the lazy-arm migration below (EI-19448574704459898). Default-ON does
 *  NOT mean N× spend fleet-wide: the master switch only makes the feature available, and a
 *  redundant run additionally requires an explicit per-item `work_items:set_redundancy` (≥
 *  MIN_REDUNDANCY), so an un-opted item still runs single-replica.
 *  Migrated off the `PAPERCUSP_WORKITEM_REDUNDANCY` env gate to the `WORKITEM_REDUNDANCY` FLAG
 *  (live-configurability-audit-2026-06-20 P-007) — SYNC-cached because the claim-path read is
 *  synchronous (the WORKITEM_CLAIM_LEASE pattern). Refreshed on first use + every flag change.
 *  (Single-box redundancy uses the local replica authority; the cross-Swarm
 *  router install at register-replica-authority-ops boot still reads this at module-load, so a
 *  cross-MACHINE redundancy run wants a restart with the flag on — a noted follow-up.) */
let redundancyOn = false;
async function refreshRedundancyFlag(): Promise<void> {
  try {
    redundancyOn = await getFlag(FLAGS.WORKITEM_REDUNDANCY, systemDistinctId());
  } catch {
    redundancyOn = false;
  }
}
/**
 * Armed on FIRST USE, not at import (EI-19416650993725684).
 *
 * ⚠ This module had TWO module-scope flag-binding accesses, not one, and only the second was
 * visible to `scripts/check-no-module-scope-flag-subscribe.mjs`: the eager `void
 * refreshRedundancyFlag()` reached `getFlag` synchronously (an async function body runs up to its
 * first await when called), so migrating the `onFlagChange(...)` alone would have turned that
 * source lint green while leaving the module just as unimportable under a partial
 * `@papercusp/flags/server` mock — merely failing on `getFlag` instead of `onFlagChange`. That is
 * exactly the gap `lib/flags-partial-mock-importable.test.ts` exists to close, and why this file
 * is listed there rather than trusted to the lint.
 *
 * The helper's arm kicks one refresh, so the eager boot read is preserved — it now happens on the
 * first reader call instead of at import.
 *
 * ⚠ CORRECTED 2026-08-03 (EI-19448574704459898). This paragraph used to justify the window with
 * "`false` … is this feature's DEFAULT OFF safe state (it ships DARK, owner-ratified)". The flag is
 * DEFAULT ON and not dark, so that premise was simply false, and "the override has not taken effect
 * yet" was the wrong frame: the window genuinely serves NON-production behaviour. What actually
 * makes it acceptable is the CONSEQUENCE, recorded in the declaration below.
 */
const armFlagRefresh = lazyFlagRefresh(refreshRedundancyFlag, {
  keys: [FLAGS.WORKITEM_REDUNDANCY],
  // Seed SYNCHRONOUSLY from the flag registry, so the reader that arms us sees the flag's DECLARED
  // default instead of the `false` this module initialises to. Without this the first synchronous
  // read in every process answered "redundancy off" for a DEFAULT-ON flag — a real regression from
  // 663fa6dd43, caught by the default-ON test below, which had passed for six weeks only because the
  // pre-migration module-scope refresh started at IMPORT and resolved before anything read it.
  // The deref is LAZY (inside this callback), which is exactly the form
  // check-no-module-scope-flag-subscribe.mjs documents as correct and does not flag.
  seed: () => {
    redundancyOn = FLAG_DEFAULTS[FLAGS.WORKITEM_REDUNDANCY];
  },
  unpopulated: {
    kind: 'seeded-from-flag-default',
    serves:
      "FLAG_DEFAULTS[WORKITEM_REDUNDANCY] — currently true. The window now diverges from production " +
      'only if a runtime OVERRIDE differs from the registry default, and it self-heals within one ' +
      'refresh round-trip. Were it ever to diverge, the degradation is toward a single-replica claim ' +
      '(the pre-feature behaviour, and already the outcome for any item that has not opted in via ' +
      'work_items:set_redundancy) — i.e. toward LESS model spend, never a wrong or dead-data read.',
  },
});

export function workItemRedundancyEnabled(): boolean {
  armFlagRefresh(); // first use installs the subscription + kicks the initial read
  return redundancyOn;
}

export const DEFAULT_REPLICA_TTL_SEC = 1800; // 30m — generous for an LLM work turn; renewed by heartbeat
export const MAX_REPLICA_TTL_SEC = 7200; // 2h hard cap (a long high-stakes run)
/** A redundancy needs at least 2 independent replicas to compare (judge a winner). */
export const MIN_REDUNDANCY = 2;

export type ReplicaStatus = 'claimed' | 'complete' | 'winner' | 'loser';

/** The recorded output of one replica — what the judge scores + the winner's becomes the item's result. */
export interface ReplicaResult {
  /** The distilled output the judge reads (a summary / diff / answer of this replica's run). */
  text: string;
  /** Arbitrary structured metadata the replica wants to keep alongside the text. */
  meta?: unknown;
}

export interface WorkItemReplica {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  replicaIndex: number;
  redundancy: number;
  claimId: string;
  owner: string;
  ownerLabel: string | null;
  holderPubkey: string | null;
  ttlSec: number;
  acquiredTs: string;
  expiresTs: string;
  lastActivityTs: string;
  status: ReplicaStatus;
  result: ReplicaResult | null;
  judgeComposite: number | null;
  judgeRationale: string | null;
  judgeModel: string | null;
  rubricHash: string | null;
  judgeCostUsd: number | null;
  judgedTs: string | null;
  /** Derived: the lease has lapsed (the slot is re-claimable) as of the read. */
  expired: boolean;
}

// ── Per-item opt-in marker (the `redundancy` column on the feature row) ───────────────

export interface RedundancyResult {
  id: string;
  harness: string | null;
  /** The target replica count now stored (1 = exactly-once, default). */
  redundancy: number;
}

/**
 * Read a feature-family work-item's redundancy factor. Returns null when the item does not
 * exist (or is issue-family — bugs/changes carry no redundancy column). A NULL column reads
 * as 1 (exactly-once).
 */
export async function getItemRedundancy(workItemId: string, opts: { harness?: string } = {}): Promise<number | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ redundancy: number | null }[]>`
    SELECT redundancy FROM harness_shared.harness_features_consolidated
     WHERE feature_id = ${workItemId}
       AND workspace_id = ${activeWorkspaceId()}
       AND ${opts.harness ? sql`harness_slug = ${opts.harness}` : sql`TRUE`}
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT 1`;
  if (rows.length === 0) return null;
  return rows[0].redundancy == null ? 1 : Number(rows[0].redundancy);
}

/**
 * Mark a feature-family work-item high-stakes (redundancy = N ≥ 2), or clear it (N ≤ 1 ⇒
 * NULL column ⇒ exactly-once). The opt-in is inert until `PAPERCUSP_WORKITEM_REDUNDANCY=1`.
 * Returns null when the item does not exist / is issue-family (no redundancy column).
 */
export async function setItemRedundancy(
  workItemId: string,
  n: number,
  opts: { harness?: string } = {},
): Promise<RedundancyResult | null> {
  // The item must exist + be feature-family (issue-family bugs/changes aren't high-stakes
  // pipeline items, and have no redundancy column).
  const wi = await getWorkItem(workItemId, opts.harness);
  if (!wi || wi.family !== 'feature') return null;
  const target = Number.isFinite(n) && n >= MIN_REDUNDANCY ? Math.floor(n) : 1;
  const stored = target <= 1 ? null : target;
  const { sql } = getOrgPg();
  const rows = await sql<{ redundancy: number | null }[]>`
    UPDATE harness_shared.harness_features_consolidated
       SET redundancy = ${stored}, updated_ts = ${Date.now()}
     WHERE harness_slug = ${wi.harness} AND feature_id = ${workItemId}
    RETURNING redundancy`;
  if (rows.length === 0) return null;
  return { id: workItemId, harness: wi.harness, redundancy: rows[0].redundancy == null ? 1 : Number(rows[0].redundancy) };
}

// ── Replica-slot claim (the leased grip on one of the N slots) ────────────────────────

export interface ClaimReplicaOpts {
  workspaceId?: string;
  harnessSlug: string;
  /** Hive home for authority routing (EI-266). Omit → routes by harness (single box). */
  potSlug?: string | null;
  workItemId: string;
  owner: string;
  ownerLabel?: string | null;
  holderPubkey?: string | null;
  ttlSec?: number;
}

export type ClaimReplicaResult =
  | { ok: true; replica: WorkItemReplica; reused: boolean }
  | { ok: false; reason: 'item-not-found' | 'not-redundant' | 'not-admitted' | 'all-slots-held'; redundancy?: number };

/**
 * Claim one of the item's N replica slots: assign the caller the lowest free slot (0..N-1),
 * leasing it (ttl + heartbeat). Idempotent — if the caller already holds a slot for this
 * item it is returned (`reused:true`) rather than taking a second. A lapsed slot
 * (`expires_ts < now()` AND still un-recorded, status='claimed') is STOLEN; a slot whose
 * replica already recorded/judged (complete|winner|loser) is never stolen. Refuses
 * (`all-slots-held`) when every slot is live-held by another Swarm — the redundancy ceiling.
 *
 * Concurrency: per-slot `INSERT … ON CONFLICT DO UPDATE WHERE lapsed` is atomic (the
 * work_item_claims pattern) — two racers on slot k can't both win; the loser falls to k+1.
 */
export async function claimReplicaSlot(opts: ClaimReplicaOpts): Promise<ClaimReplicaResult> {
  const resolved = { ...opts, workspaceId: opts.workspaceId ?? activeWorkspaceId() };
  return getWorkItemReplicaAuthority().route(replicaScopeOf(resolved), {
    local: () => claimReplicaSlotLocal(resolved),
    remote: { kind: WORK_ITEM_REPLICA_OP_KINDS.claimSlot, payload: resolved, decode: (raw) => raw as ClaimReplicaResult },
  });
}

/**
 * The LOCAL (un-routed) execution of claim_slot — the raw SQL against THIS peer's
 * PG. Exported so the authority-op registry can run it on the authority's store on
 * a remote peer's behalf; normal callers use `claimReplicaSlot`.
 */
export async function claimReplicaSlotLocal(opts: ClaimReplicaOpts): Promise<ClaimReplicaResult> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const redundancy = await getItemRedundancy(opts.workItemId, { harness: opts.harnessSlug });
  if (redundancy == null) return { ok: false, reason: 'item-not-found' };
  if (redundancy < MIN_REDUNDANCY) return { ok: false, reason: 'not-redundant', redundancy };
  // Admission is two-axis: remote-author trust plus born-pending duplicate screening.
  // isWorkItemAutoPickable owns both, so replica fan-out cannot outrun either promoter.
  if (!(await isWorkItemAutoPickable(opts.workItemId, { harness: opts.harnessSlug, workspaceId }))) {
    return { ok: false, reason: 'not-admitted' };
  }

  const { sql } = getOrgPg();

  // Idempotent: this owner already holds a slot for this item (any status) → return it.
  const mine = await sql<ReplicaDbRow[]>`
    SELECT ${sql.unsafe(REPLICA_COLS)}, (expires_ts <= clock_timestamp()) AS expired
      FROM harness_shared.work_item_replicas
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${opts.harnessSlug}
       AND work_item_id = ${opts.workItemId} AND owner = ${opts.owner}
     ORDER BY replica_index LIMIT 1`;
  if (mine[0]) return { ok: true, replica: replicaFromDb(mine[0]), reused: true };

  const ttlSec = clampTtl(opts.ttlSec ?? DEFAULT_REPLICA_TTL_SEC);
  for (let k = 0; k < redundancy; k++) {
    const rows = await sql<ReplicaDbRow[]>`
      INSERT INTO harness_shared.work_item_replicas
        (workspace_id, harness_slug, work_item_id, replica_index, redundancy, owner, owner_label,
         holder_pubkey, ttl_sec, acquired_ts, expires_ts, last_activity_ts, status)
      VALUES
        (${workspaceId}, ${opts.harnessSlug}, ${opts.workItemId}, ${k}, ${redundancy}, ${opts.owner},
         ${opts.ownerLabel ?? null}, ${opts.holderPubkey ?? null}, ${ttlSec}, clock_timestamp(),
         clock_timestamp() + make_interval(secs => ${ttlSec}), clock_timestamp(), 'claimed')
      ON CONFLICT (workspace_id, harness_slug, work_item_id, replica_index) DO UPDATE SET
        claim_id         = gen_random_uuid(),
        redundancy       = EXCLUDED.redundancy,
        owner            = EXCLUDED.owner,
        owner_label      = EXCLUDED.owner_label,
        holder_pubkey    = EXCLUDED.holder_pubkey,
        ttl_sec          = EXCLUDED.ttl_sec,
        acquired_ts      = clock_timestamp(),
        expires_ts       = clock_timestamp() + make_interval(secs => ${ttlSec}),
        last_activity_ts = clock_timestamp(),
        status           = 'claimed',
        result           = NULL,
        judge_composite  = NULL,
        judge_rationale  = NULL,
        judge_model      = NULL,
        rubric_hash      = NULL,
        judge_cost_usd   = NULL,
        judged_ts        = NULL
      WHERE harness_shared.work_item_replicas.expires_ts <= clock_timestamp()
        AND harness_shared.work_item_replicas.status = 'claimed'
      RETURNING ${sql.unsafe(REPLICA_COLS)}, (expires_ts <= clock_timestamp()) AS expired`;
    if (rows[0]) return { ok: true, replica: replicaFromDb(rows[0]), reused: false };
  }
  return { ok: false, reason: 'all-slots-held', redundancy };
}

export interface ReplicaLeaseParams {
  workspaceId?: string;
  harnessSlug: string;
  /** Hive home for authority routing (EI-266). Omit → routes by harness. */
  potSlug?: string | null;
  workItemId: string;
  replicaIndex: number;
  claimId: string;
  owner: string;
  ttlSecOverride?: number;
}

export interface ReplicaHeartbeatResult {
  renewed: boolean;
  held: boolean;
  expiresTs: string | null;
}

/** Renew a replica slot's lease (proving the replica run is still in flight).
 *  Routed through the per-Hive replica authority (EI-266). */
export async function heartbeatReplica(p: ReplicaLeaseParams): Promise<ReplicaHeartbeatResult> {
  const resolved = { ...p, workspaceId: p.workspaceId ?? activeWorkspaceId() };
  return getWorkItemReplicaAuthority().route(replicaScopeOf(resolved), {
    local: () => heartbeatReplicaLocal(resolved),
    remote: { kind: WORK_ITEM_REPLICA_OP_KINDS.heartbeat, payload: resolved, decode: (raw) => raw as ReplicaHeartbeatResult },
  });
}

/** LOCAL (un-routed) heartbeat — the authority-side execution. */
export async function heartbeatReplicaLocal(p: ReplicaLeaseParams): Promise<ReplicaHeartbeatResult> {
  const workspaceId = p.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const ttl = p.ttlSecOverride != null ? clampTtl(p.ttlSecOverride) : null;
  const rows = await sql<{ expires_ts: string }[]>`
    UPDATE harness_shared.work_item_replicas
       SET ttl_sec = ${ttl ?? sql`ttl_sec`},
           expires_ts = clock_timestamp() + make_interval(secs => ${ttl ?? sql`ttl_sec`}),
           last_activity_ts = clock_timestamp(), updated_ts = clock_timestamp()
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${p.harnessSlug}
       AND work_item_id = ${p.workItemId} AND replica_index = ${p.replicaIndex}
       AND claim_id = ${p.claimId}::uuid AND owner = ${p.owner}
       AND expires_ts > clock_timestamp() AND status = 'claimed'
    RETURNING expires_ts`;
  if (rows[0]) return { renewed: true, held: true, expiresTs: rows[0].expires_ts };
  return { renewed: false, held: false, expiresTs: null };
}

/** Release (delete) a replica slot the caller holds — its slot returns to the pool.
 *  Routed through the per-Hive replica authority (EI-266). */
export async function releaseReplica(p: ReplicaLeaseParams): Promise<boolean> {
  const resolved = { ...p, workspaceId: p.workspaceId ?? activeWorkspaceId() };
  return getWorkItemReplicaAuthority().route(replicaScopeOf(resolved), {
    local: () => releaseReplicaLocal(resolved),
    remote: { kind: WORK_ITEM_REPLICA_OP_KINDS.release, payload: resolved, decode: (raw) => raw as boolean },
  });
}

/** LOCAL (un-routed) release — the authority-side execution. */
export async function releaseReplicaLocal(p: ReplicaLeaseParams): Promise<boolean> {
  const workspaceId = p.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<{ replica_index: number }[]>`
    DELETE FROM harness_shared.work_item_replicas
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${p.harnessSlug}
       AND work_item_id = ${p.workItemId} AND replica_index = ${p.replicaIndex}
       AND claim_id = ${p.claimId}::uuid AND owner = ${p.owner}
    RETURNING replica_index`;
  return rows.length > 0;
}

export interface RecordReplicaResultOpts {
  workspaceId?: string;
  harnessSlug: string;
  /** Hive home for authority routing (EI-266). Omit → routes by harness. */
  potSlug?: string | null;
  workItemId: string;
  replicaIndex: number;
  owner: string;
  result: ReplicaResult;
}

/**
 * Record this replica's result and mark the slot `complete` (ready for judging). Owner-checked;
 * only a still-running (`claimed`) slot can record (no double-record, no recording a stolen slot).
 * Returns the updated replica, or null when the caller does not hold a claimed slot.
 */
export async function recordReplicaResult(opts: RecordReplicaResultOpts): Promise<WorkItemReplica | null> {
  const resolved = { ...opts, workspaceId: opts.workspaceId ?? activeWorkspaceId() };
  return getWorkItemReplicaAuthority().route(replicaScopeOf(resolved), {
    local: () => recordReplicaResultLocal(resolved),
    remote: { kind: WORK_ITEM_REPLICA_OP_KINDS.recordResult, payload: resolved, decode: (raw) => raw as WorkItemReplica | null },
  });
}

/** LOCAL (un-routed) record-result — the authority-side execution. */
export async function recordReplicaResultLocal(opts: RecordReplicaResultOpts): Promise<WorkItemReplica | null> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const resultJson = JSON.stringify(opts.result);
  const rows = await sql<ReplicaDbRow[]>`
    UPDATE harness_shared.work_item_replicas
       SET status = 'complete', result = ${resultJson}::text::jsonb,
           last_activity_ts = clock_timestamp(), updated_ts = clock_timestamp()
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${opts.harnessSlug}
       AND work_item_id = ${opts.workItemId} AND replica_index = ${opts.replicaIndex}
       AND owner = ${opts.owner} AND status = 'claimed'
    RETURNING ${sql.unsafe(REPLICA_COLS)}, (expires_ts <= clock_timestamp()) AS expired`;
  return rows[0] ? replicaFromDb(rows[0]) : null;
}

/** All replica rows for a redundancy group, ordered by slot. Routed through the
 *  per-Hive replica authority (EI-266) so the judge reads the FULL group. */
export async function listReplicas(
  workItemId: string,
  opts: { harness: string; workspaceId?: string; potSlug?: string | null },
): Promise<WorkItemReplica[]> {
  const resolved = { ...opts, workspaceId: opts.workspaceId ?? activeWorkspaceId() };
  return getWorkItemReplicaAuthority().route(replicaScopeOf({ harness: resolved.harness, potSlug: resolved.potSlug }), {
    local: () => listReplicasLocal(workItemId, resolved),
    remote: {
      kind: WORK_ITEM_REPLICA_OP_KINDS.list,
      payload: { workItemId, ...resolved },
      decode: (raw) => raw as WorkItemReplica[],
    },
  });
}

/** LOCAL (un-routed) list — the authority-side execution. */
export async function listReplicasLocal(
  workItemId: string,
  opts: { harness: string; workspaceId?: string; potSlug?: string | null },
): Promise<WorkItemReplica[]> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<ReplicaDbRow[]>`
    SELECT ${sql.unsafe(REPLICA_COLS)}, (expires_ts <= clock_timestamp()) AS expired
      FROM harness_shared.work_item_replicas
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${opts.harness} AND work_item_id = ${workItemId}
     ORDER BY replica_index`;
  return rows.map(replicaFromDb);
}

// ── Winner selection (pure, deterministic) ────────────────────────────────────────────

/** One replica's judge verdict — the input to deterministic winner selection. */
export interface ReplicaVerdict {
  replicaIndex: number;
  composite: number;
  acquiredTs: string;
  owner: string;
}

/**
 * Total order over judged replicas (mirrors work-item-claim-reconcile's deterministic
 * tie-break so every peer agrees on the winner without further coordination):
 *   (1) HIGHEST composite (the judge's reward — the whole point);
 *   (2) earliest acquired_ts (started first → did the most work, like reconcile);
 *   (3) lowest owner (lexical — matches the authority-election tiebreak);
 *   (4) lowest replica_index (final disambiguator).
 * Returns < 0 when `a` wins.
 */
export function compareReplicaVerdicts(a: ReplicaVerdict, b: ReplicaVerdict): number {
  if (a.composite !== b.composite) return b.composite - a.composite; // higher first
  if (a.acquiredTs !== b.acquiredTs) return a.acquiredTs < b.acquiredTs ? -1 : 1; // earlier first
  if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1; // lower first
  return a.replicaIndex - b.replicaIndex; // lower first
}

/** The winning replica_index for a set of judged verdicts, or null when empty. Pure + total. */
export function pickRedundancyWinner(verdicts: readonly ReplicaVerdict[]): number | null {
  if (verdicts.length === 0) return null;
  return [...verdicts].sort(compareReplicaVerdicts)[0].replicaIndex;
}

// ── The judge (reuse gym:judge) + adopt the winner ────────────────────────────────────

export interface JudgeRedundancyOpts {
  workspaceId?: string;
  harness: string;
  /** Hive home for authority routing (EI-266). Omit → routes by harness. */
  potSlug?: string | null;
  workItemId: string;
  /** Default: the work-item's title + summary. */
  intent?: string;
  /** Default: the harness slug + the item summary. */
  projectContext?: string;
  /** A partial gym rubric (mirrors a target blueprint's gym.rubric); omit → GYM_JUDGE_RUBRIC_V1. */
  rubric?: GymRubricInput;
}

export interface JudgedReplica {
  replicaIndex: number;
  owner: string;
  composite: number;
  rationale: string;
}

export type JudgeRedundancyResult =
  | {
      ok: true;
      winner: { replicaIndex: number; owner: string; composite: number };
      scores: JudgedReplica[];
      judgeModel: string;
      rubricHash: string;
      totalCostUsd: number;
    }
  | { ok: false; reason: 'item-not-found' | 'insufficient-replicas'; completeCount?: number };

/**
 * Judge a redundancy group: distill each COMPLETE replica's result, score it with the frozen
 * Opus judge (reuse gym:judge via the injected `llmCall`), persist each verdict, pick the
 * deterministic winner (highest composite), mark winner/losers, and ADOPT the winner — settle
 * the work item to `passed` (fires `work-item:done`). Needs ≥2 complete replicas to compare.
 */
export async function judgeRedundancyGroup(
  opts: JudgeRedundancyOpts,
  deps: { llmCall: JudgeLlmCall },
): Promise<JudgeRedundancyResult> {
  const resolved = { ...opts, workspaceId: opts.workspaceId ?? activeWorkspaceId() };
  // The judge needs the WHOLE group + adopts the winner — it MUST run where the
  // replicas live (the authority). Route it; on a remote authority the caller's
  // injected `llmCall` cannot serialize, so the authority judges with its OWN
  // grader (the only grader of record) — the op handler supplies it.
  return getWorkItemReplicaAuthority().route(replicaScopeOf({ harness: resolved.harness, potSlug: resolved.potSlug }), {
    local: () => judgeRedundancyGroupLocal(resolved, deps),
    remote: { kind: WORK_ITEM_REPLICA_OP_KINDS.judge, payload: resolved, decode: (raw) => raw as JudgeRedundancyResult },
  });
}

/** LOCAL (un-routed) judge — the authority-side execution (reads the full group,
 *  scores, adopts the winner, settles the item). */
export async function judgeRedundancyGroupLocal(
  opts: JudgeRedundancyOpts,
  deps: { llmCall: JudgeLlmCall },
): Promise<JudgeRedundancyResult> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const wi = await getWorkItem(opts.workItemId, opts.harness);
  if (!wi) return { ok: false, reason: 'item-not-found' };

  const replicas = await listReplicasLocal(opts.workItemId, { harness: opts.harness, workspaceId });
  const complete = replicas.filter((r) => r.status === 'complete');
  if (complete.length < MIN_REDUNDANCY) {
    return { ok: false, reason: 'insufficient-replicas', completeCount: complete.length };
  }

  const intent = opts.intent ?? `${wi.title}${wi.summary ? `\n\n${wi.summary}` : ''}`;
  const projectContext = opts.projectContext ?? `Harness: ${opts.harness}. ${wi.summary ?? ''}`.trim();
  const rubric: GymJudgeRubric = rubricFromBlueprintGym(opts.rubric ? { rubric: opts.rubric } : undefined);
  const rubricHashValue = rubricHash(rubric);

  const { sql } = getOrgPg();
  const verdicts: ReplicaVerdict[] = [];
  const scores: JudgedReplica[] = [];
  let totalCostUsd = 0;

  for (const r of complete) {
    const distilledTrace = r.result?.text ?? JSON.stringify(r.result ?? {});
    const score = await judgeGymRun({ intent, projectContext, distilledTrace, rubric }, { llmCall: deps.llmCall });
    totalCostUsd += score.costUsd;
    await sql`
      UPDATE harness_shared.work_item_replicas
         SET judge_composite = ${score.composite}, judge_rationale = ${score.rationale},
             judge_model = ${score.judgeModel}, rubric_hash = ${score.rubricHash},
             judge_cost_usd = ${score.costUsd}, judged_ts = clock_timestamp(), updated_ts = clock_timestamp()
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${opts.harness}
         AND work_item_id = ${opts.workItemId} AND replica_index = ${r.replicaIndex}`;
    verdicts.push({ replicaIndex: r.replicaIndex, composite: score.composite, acquiredTs: r.acquiredTs, owner: r.owner });
    scores.push({ replicaIndex: r.replicaIndex, owner: r.owner, composite: score.composite, rationale: score.rationale });
  }

  const winnerIndex = pickRedundancyWinner(verdicts)!;
  const winnerVerdict = verdicts.find((v) => v.replicaIndex === winnerIndex)!;

  // Mark winner + losers (only the replicas we just judged; any still-claimed slot is untouched).
  const judgedIndices = complete.map((r) => r.replicaIndex);
  await sql`
    UPDATE harness_shared.work_item_replicas
       SET status = CASE WHEN replica_index = ${winnerIndex} THEN 'winner' ELSE 'loser' END,
           updated_ts = clock_timestamp()
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${opts.harness}
       AND work_item_id = ${opts.workItemId} AND replica_index = ANY(${judgedIndices}::int[])`;

  // Adopt the winner: settle the item to `done` (fires work-item:done). The winner's row
  // (status='winner', result=…) is the durable record of which replica was adopted.
  // Completion-integrity gate (WI-1403, contract C-1): a genuine, evidence-backed
  // completion — the judge scored N replicas and picked one — so it carries a real
  // owner (the winning replica's producer) + a completionRef naming the judged winner.
  await setWorkItemState(opts.workItemId, 'done', {
    harness: opts.harness,
    by: winnerVerdict.owner,
    completionRef: `Redundancy judge picked replica #${winnerIndex} (composite ${winnerVerdict.composite.toFixed(3)}, ${judgedIndices.length} replicas judged)`,
  });

  return {
    ok: true,
    winner: { replicaIndex: winnerIndex, owner: winnerVerdict.owner, composite: winnerVerdict.composite },
    scores,
    judgeModel: rubric.model,
    rubricHash: rubricHashValue,
    totalCostUsd,
  };
}

/** Delete lapsed (un-recorded) replica slots — a GC convenience (claim steals them lazily anyway). */
export async function sweepLapsedReplicas(workspaceId: string, harnessSlug?: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ work_item_id: string }[]>`
    DELETE FROM harness_shared.work_item_replicas
     WHERE workspace_id = ${workspaceId}
       AND ${harnessSlug ? sql`harness_slug = ${harnessSlug}` : sql`TRUE`}
       AND status = 'claimed' AND expires_ts <= clock_timestamp()
    RETURNING work_item_id`;
  return rows.length;
}

// ── DB mapping ────────────────────────────────────────────────────────────────────────

const REPLICA_COLS = `workspace_id, harness_slug, work_item_id, replica_index, redundancy, claim_id,
  owner, owner_label, holder_pubkey, ttl_sec, acquired_ts, expires_ts, last_activity_ts, status,
  result, judge_composite, judge_rationale, judge_model, rubric_hash, judge_cost_usd, judged_ts`;

interface ReplicaDbRow {
  workspace_id: string;
  harness_slug: string;
  work_item_id: string;
  replica_index: number;
  redundancy: number;
  claim_id: string;
  owner: string;
  owner_label: string | null;
  holder_pubkey: string | null;
  ttl_sec: number;
  acquired_ts: string;
  expires_ts: string;
  last_activity_ts: string;
  status: ReplicaStatus;
  result: ReplicaResult | null;
  judge_composite: number | null;
  judge_rationale: string | null;
  judge_model: string | null;
  rubric_hash: string | null;
  judge_cost_usd: number | null;
  judged_ts: string | null;
  expired: boolean;
}

function replicaFromDb(r: ReplicaDbRow): WorkItemReplica {
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    workItemId: r.work_item_id,
    replicaIndex: Number(r.replica_index),
    redundancy: Number(r.redundancy),
    claimId: r.claim_id,
    owner: r.owner,
    ownerLabel: r.owner_label,
    holderPubkey: r.holder_pubkey,
    ttlSec: Number(r.ttl_sec),
    acquiredTs: tsIso(r.acquired_ts),
    expiresTs: tsIso(r.expires_ts),
    lastActivityTs: tsIso(r.last_activity_ts),
    status: r.status,
    result: r.result ?? null,
    judgeComposite: r.judge_composite == null ? null : Number(r.judge_composite),
    judgeRationale: r.judge_rationale,
    judgeModel: r.judge_model,
    rubricHash: r.rubric_hash,
    judgeCostUsd: r.judge_cost_usd == null ? null : Number(r.judge_cost_usd),
    judgedTs: r.judged_ts == null ? null : tsIso(r.judged_ts),
    expired: Boolean(r.expired),
  };
}

// EI-18691099450966094: delegates to the shared pg-timestamp helper — see
// pg-timestamp.ts for why a bare `String(v)` fallback is a staleness-trap bug.
const tsIso = pgTimestampToIso;

function clampTtl(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REPLICA_TTL_SEC;
  return Math.min(Math.floor(n), MAX_REPLICA_TTL_SEC);
}
