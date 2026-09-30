/**
 * Hyperbee → PG projection for `harness_shared.engineer_issues` — the work-queue's
 * issue/task family (work_items[kind ∈ bug|change|task]) federated over the Hive
 * peer-log (fed-reanchor brief B5; closes engineer-issues-2026-06-03 D-009).
 *
 * Mirrors projections/plan-item-assignments.ts + hive-settings.ts (a workspace-owned
 * key riding the peer-log). The federated subset = the work-item document: scope /
 * kind / title / body / severity / source / state / assignee / assigned_by /
 * assigned_at / payload / found_during / linked_feature_id / created_by / created_at.
 * NOT federated (machine-local): workspace_id (the projection binds it), updated_at
 * (locally bumped), _search (generated), AND the per-bee work-list ordering
 * (assignee_rank / rank_writer / rank_updated_at — the bee's CLAIMED-queue order on
 * its OWN Swarm, written by the reorder_work_item SQL fn; not shared backlog state,
 * so it stays local and is preserved across a peer's content update). The standard
 * provenance columns (author_pubkey/origin/fed_ts) carry the echo-guard + LWW.
 *
 * The per-harness guard (`row.harness_slug !== opts.harnessSlug`) demuxes: the
 * capture trigger (mig 197) derives the federation slug from `scope`
 * ('harness:<slug>' → <slug>; 'operator' → the Hive home) and STAMPS it into the
 * wire row as `harness_slug`, so only the owning harness's projection applies the op.
 * engineer_issues has no harness_slug COLUMN — `scope` is the source of truth; the
 * write below persists `scope`, not the demux slug.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  projectionDefer,
  projectionSql,
  projectionStatementFailed,
  type ProjectionGroupWriter,
  type TableProjection,
  type ProvenanceContext,
  type StoredFedOrder,
} from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';
import { composeEngineerIssueKey, parseEngineerIssueKey } from '../feature-issue-op-keys';
import { ANY_FAMILY_TERMINAL_STATES } from '../../../work-item-dispatch-states';
import {
  KEYLESS_TITLE_IDENTITY_INDEX,
  RESOURCE_GOVERNOR_IDENTITY_INDEX,
  WATCHDOG_IDENTITY_INDEX,
} from './work-items-replay-identity-indexes';

/** Wire-shape of an engineer_issues row in Hyperbee — the federated subset plus the
 *  capture-stamped `harness_slug` (the demux key). Defensive on every field. */
export interface EngineerIssueRow {
  /** The federation slug stamped by the capture trigger (the per-harness demux key). */
  harness_slug: string;
  /**
   * Physical work_items.harness_slug.  Added after migration 826 proved that a
   * home log can contain the same issue_id for several authored harnesses.
   * Optional for pre-829 wire ops; their bare keys remain readable.
   */
  storage_harness_slug?: string;
  issue_id: string;
  scope: string;
  kind: string;
  title: string;
  body: string;
  severity: string;
  source: string;
  state: string;
  assignee: string | null;
  assigned_by: string | null;
  assigned_at: string | null; // ISO string (timestamptz under to_jsonb)
  payload: unknown; // jsonb (a task's resume metadata); null for bug/change
  found_during: string | null;
  linked_feature_id: string | null;
  created_by: string | null;
  created_at: string; // ISO string
  /**
   * WI-6327 — the row's creation instant in epoch ms, the SAME unit and value as the
   * `work_items.created_ts` column. This, not `created_at`, is what the EI-13285
   * collision guard compares: `created_at` is derived/defaulted by the mapper and so
   * can be a synthesized stand-in, while `created_ts` is passed through untouched and
   * is null exactly when the op did not carry one.
   *
   * OPTIONAL on the wire, and its ABSENCE is load-bearing: ops appended to the
   * hypercore before mig 688 carry a FABRICATED `created_at` (drain time) that is
   * indistinguishable from a genuine one, so the guard must not judge them. Null here
   * ⇒ legacy op ⇒ fail open. Non-null ⇒ authoritative ⇒ guard applies.
   */
  created_ts?: number | null;
  /**
   * work-item-completion-integrity-2026-07-01 (WI-1403 / EI-5269): the "who did
   * it + what proves it" pair recorded at the terminal-state choke point. OPTIONAL
   * on the wire (pre-432 history lacks them → dropped on write → NULL).
   */
  terminal_owner?: string | null;
  terminal_completion_ref?: string | null;
  /**
   * work-item-status-full-unify-2026-07-19 (P-009, owner hard-req D-001): the
   * pre-collapse terminal nuance (resolved → done, closed → dropped) preserved on
   * the work_items base table (mig 638; the CDC issue wire-shape stamps it in mig
   * 640). MUST federate so an issue keeps its resolution kind across the wire.
   * OPTIONAL on the wire (pre-638 history lacks it → dropped on write → NULL).
   */
  terminal_reason?: string | null;
  /**
   * mig 708 / EI-18785839681430807: the AUTHORITY axis (mig 677,
   * agent-protocol-authority-semantics-2026-07-26 P-003; D-035). Same
   * completion-integrity treatment as the terminal_* pair above — federated as
   * a plain column and joined into the EI-16756 digest below. OPTIONAL on the
   * wire (pre-708 history lacks it → dropped on write → NULL).
   */
  authority?: string | null;
  /**
   * mig 708 PART 2 / EI-18820653360383242: the trigger-maintained close time
   * (mig 698) — same treatment as toFeatureValue's sibling field: a plain
   * carried column, NOT part of the EI-16756 digest below. OPTIONAL on the
   * wire (pre-708 history lacks it → dropped on write → NULL).
   */
  closed_ts?: number | null;
  /**
   * EI-21467654382027859 (mig 965) — nine columns the federated-column-completeness
   * guard caught landing NULL on every peer. Full per-column reasoning is in mig 965's
   * header. The one that is a correctness hole rather than data loss is `admission`:
   * the issue claim gate is `admittedWhereSql` = `(admission IS DISTINCT FROM
   * 'pending')`, so an item federated WITHOUT the column arrives NULL and reads as
   * ADMITTED — a deliberately born-pending item became claimable on every peer.
   *
   * ALL OPTIONAL ON THE WIRE, and that is load-bearing, not stylistic: the other side
   * of the wire is a DIFFERENT BUILD, and `decodeValue` discards a row the validator
   * rejects — wholesale, not field-wise. Making any of these required would make an
   * older peer's every issue op undecodable. (Learned the expensive way on this same
   * item: the `producer` column of EI-21462599108204160 shipped required and had to be
   * amended.)
   */
  admission?: string | null;
  admitted_at?: string | null;
  admitted_by?: string | null;
  state_changed_at?: string | null;
  tags?: unknown; // jsonb — opaque, like `payload`
  parent_id?: string | null;
  source_plan_slug?: string | null;
  source_plan_item_ids?: string[] | null;
  expected_cost_cents?: number | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isEngineerIssueRow(input: unknown): input is EngineerIssueRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (
    r.storage_harness_slug !== undefined &&
    (!isString(r.storage_harness_slug) || r.storage_harness_slug.length === 0)
  )
    return false;
  if (!isString(r.issue_id) || r.issue_id.length === 0) return false;
  if (!isString(r.scope) || r.scope.length === 0) return false;
  if (!isString(r.kind)) return false;
  if (!isString(r.title)) return false;
  if (!isString(r.body)) return false;
  if (!isString(r.severity)) return false;
  if (!isString(r.source)) return false;
  if (!isString(r.state)) return false;
  if (!isStringOrNull(r.assignee)) return false;
  if (!isStringOrNull(r.assigned_by)) return false;
  if (!isStringOrNull(r.assigned_at)) return false;
  if (!isStringOrNull(r.found_during)) return false;
  if (!isStringOrNull(r.linked_feature_id)) return false;
  if (!isStringOrNull(r.created_by)) return false;
  if (!isString(r.created_at)) return false;
  // WI-6327: optional on the wire (absent on every pre-688 op) — but when present it
  // must be a real finite epoch, since the collision guard trusts it.
  if (r.created_ts !== undefined && r.created_ts !== null && !Number.isFinite(r.created_ts)) return false;
  if (r.terminal_owner !== undefined && !isStringOrNull(r.terminal_owner)) return false;
  if (r.terminal_completion_ref !== undefined && !isStringOrNull(r.terminal_completion_ref)) return false;
  if (r.terminal_reason !== undefined && !isStringOrNull(r.terminal_reason)) return false; // P-009/D-001 — optional on the wire
  if (r.authority !== undefined && !isStringOrNull(r.authority)) return false; // mig 708/D-035 — optional on the wire
  if (r.closed_ts !== undefined && r.closed_ts !== null && !Number.isFinite(r.closed_ts)) return false; // mig 708 PART 2 — optional on the wire
  // EI-21467654382027859 (mig 965) — every one of these is OPTIONAL on the wire: an op
  // from a peer running pre-965 code carries none of them, and REJECTING such a row here
  // would discard the WHOLE issue op (decodeValue is all-or-nothing), not just the new
  // fields. Absent ⇒ undefined ⇒ bound as null below ⇒ the ON CONFLICT preserves the
  // local value, which is the fail-safe direction for `admission` in particular.
  if (r.admission !== undefined && !isStringOrNull(r.admission)) return false;
  if (r.admitted_at !== undefined && !isStringOrNull(r.admitted_at)) return false;
  if (r.admitted_by !== undefined && !isStringOrNull(r.admitted_by)) return false;
  if (r.state_changed_at !== undefined && !isStringOrNull(r.state_changed_at)) return false;
  if (r.parent_id !== undefined && !isStringOrNull(r.parent_id)) return false;
  if (r.source_plan_slug !== undefined && !isStringOrNull(r.source_plan_slug)) return false;
  if (
    r.source_plan_item_ids !== undefined &&
    r.source_plan_item_ids !== null &&
    !(Array.isArray(r.source_plan_item_ids) && r.source_plan_item_ids.every((s) => typeof s === 'string'))
  )
    return false;
  if (r.expected_cost_cents !== undefined && r.expected_cost_cents !== null && !Number.isFinite(r.expected_cost_cents))
    return false;
  // payload and tags are jsonb-opaque — accept anything (incl. undefined → null on write).
  return true;
}

// EI-13285: the creation instant is part of the federated document (see the module
// header) and — for a genuine edit or re-delivery of the SAME logical issue — is ALWAYS
// identical to what's already stored: it's set once at INSERT and deliberately never
// touched by the `ON CONFLICT ... DO UPDATE SET` list below. So an existing row whose
// `created_ts` disagrees with an incoming remote op's by more than clock-
// skew slop is NOT an edit of that row — it's a DIFFERENT logical issue that happens
// to have been allocated the same issue_id (root cause + the fix to the allocator
// itself: issues-engineer.ts's nextIssueId / newCollisionResistantIssueTail). Refuse
// to apply the write in that case rather than upserting over it: a dropped op is
// bounded, logged, recoverable data loss (the authoring peer's own local copy is
// untouched); silently overwriting was unbounded, silent, PERMANENT local data loss —
// the actual EI-13285 incident (a freshly captured local improvement replaced by an
// unrelated remote issue).
//
// WI-6327: the comparison keys on the wire's `created_ts` (epoch ms, passed through
// untouched), NOT on `created_at` (mapper-derived, and before mig 688 outright
// fabricated as drain-time `now()` because the capture trigger emitted no creation
// timestamp at all). Keying a REFUSE-THE-WRITE decision on a field the mapper was free
// to invent turned this guard into a 100% false positive for the entire issue family:
// on the P-302 rig it refused ops for 10,070 distinct issue_ids, so no issue update
// could ever land on a peer that already held the row. A missing `created_ts` (every
// pre-688 op) now fails OPEN rather than being judged against an invented value.
const COLLISION_CREATED_AT_TOLERANCE_MS = 5_000;
const FEDERATED_TERMINAL_STATES = [...ANY_FAMILY_TERMINAL_STATES];

/**
 * Does an incoming op carrying `incomingCreatedTs` name a DIFFERENT issue than the stored
 * row created at `existingCreatedTs`? The caller reads the stored row
 * ({@link distinctEntityCollisions}) and passes an op only when it carries a creation instant.
 *
 * WI-6327: an op WITHOUT an authoritative creation instant fails OPEN and is never judged.
 * Every op appended before mig 688 has a `created_at` fabricated at drain time (the capture
 * trigger never emitted one) which is indistinguishable from a genuine value — judging
 * those dropped 10,070 distinct ids on the P-302 rig. Only a carried `created_ts` is
 * trustworthy enough to refuse a write over.
 */
function isDistinctEntityCollision(
  incomingCreatedTs: number,
  existingCreatedTs: number,
): { collided: boolean; existingCreatedAtIso?: string } {
  const incomingMs = Number(incomingCreatedTs);
  const existingMs = Number(existingCreatedTs);
  if (!Number.isFinite(incomingMs) || !Number.isFinite(existingMs)) return { collided: false };
  if (Math.abs(incomingMs - existingMs) <= COLLISION_CREATED_AT_TOLERANCE_MS) return { collided: false };
  return { collided: true, existingCreatedAtIso: new Date(existingMs).toISOString() };
}

/**
 * Migration 826 retired a bounded set of same-ID source rows by either merging
 * them into the Papercusp survivor or rekeying the divergent source entity.
 * Pre-829 Hyperbee PUTs carry only the bare issue id, so replaying one after the
 * repair would recreate the retired physical row.  The survivor markers are
 * the persisted identity proof; without one we fail open so unrelated legacy
 * history keeps converging.
 *
 * WI-10002480 — this runs once per legacy issue PUT on the merge hot path, so it
 * MUST be index-served. The previous form was one EXISTS whose OR joined a
 * non-leading `feature_id` match to an unindexed JSON predicate; neither branch
 * had a usable index, so every call was a parallel sequential scan of the whole
 * workspace's work_items. Measured on the P-203 rig: 709.9ms per call over
 * 177,720 rows (656,959 buffer hits), active in 39 of 40 pg_stat_activity
 * samples — it alone bounded the peer-log fold to ~33-107 ops/s.
 *
 * Now each marker branch is its own EXISTS, planned independently onto its own
 * partial index from migration 1197. Each sub-select repeats its index's WHERE
 * clause (`...->>'migration' = '826'`) VERBATIM: the planner uses a partial index
 * only when it can prove the query implies that predicate, so rewording it
 * silently restores the scan. Pinned by the "index-served" test in
 * engineer-issues.integration.test.ts, which EXPLAINs this exact text.
 * Parameters: $1 workspace id, $2 issue id, $3 source harness.
 */
const RETIRED_LEGACY_TWIN_SQL = `
  SELECT EXISTS (
           SELECT 1
             FROM harness_shared.work_items survivor
            WHERE survivor.workspace_id = $1
              AND survivor.feature_id = $2
              AND survivor.payload->'_physicalTwinRepair'->>'migration' = '826'
              AND survivor.payload->'_physicalTwinRepair'->>'sourceHarness' = $3
         )
      OR EXISTS (
           SELECT 1
             FROM harness_shared.work_items survivor
            WHERE survivor.workspace_id = $1
              AND survivor.payload->'_physicalTwinRekey'->>'migration' = '826'
              AND survivor.payload->'_physicalTwinRekey'->>'oldId' = $2
              AND survivor.payload->'_physicalTwinRekey'->>'sourceHarness' = $3
         ) AS retired`;

async function isRetiredLegacyTwinSource(
  sql: postgres.Sql,
  workspaceId: string,
  sourceHarness: string,
  issueId: string,
): Promise<boolean> {
  const rows = await sql.unsafe<{ retired: boolean }[]>(RETIRED_LEGACY_TWIN_SQL, [
    workspaceId,
    issueId,
    sourceHarness,
  ]);
  return rows[0]?.retired === true;
}

interface WatchdogIdentity {
  watchdogKey: string;
  signalOrigin: string;
  lane: string;
}

/**
 * Read the exact identity migration 865 indexes from the incoming wire payload.
 * Fail closed on a malformed explicit component: PostgreSQL's jsonb `->>` would
 * stringify it, but the federation path must not guess that a non-string value
 * denotes the same logical signal as an existing row.
 */
function watchdogIdentityFromPayload(payload: unknown): WatchdogIdentity | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.watchdogKey !== 'string') return null;

  const ei = record._ei;
  const signalOrigin =
    ei && typeof ei === 'object' && !Array.isArray(ei) ? (ei as Record<string, unknown>).signal_origin : undefined;
  if (signalOrigin !== undefined && signalOrigin !== null && typeof signalOrigin !== 'string') return null;
  if (record.lane !== undefined && record.lane !== null && typeof record.lane !== 'string') return null;

  return {
    watchdogKey: record.watchdogKey,
    signalOrigin: typeof signalOrigin === 'string' ? signalOrigin : 'organic',
    lane: typeof record.lane === 'string' ? record.lane : 'improvement',
  };
}

/**
 * Migration 1157's keyless admission-identity arbiter. Its `titleKey` is the
 * server-authored durable identity of a keyless non-observation filing, so a
 * second NON-TERMINAL row with the same titleKey in the same Pot is, by that
 * migration's own definition, the same logical item. A peer that has not yet
 * replicated the first filing (typically because its own merge is stalled) can
 * mint such a duplicate; replaying it here raises a deterministic 23505 that no
 * retry can clear, and the merge path would hold the whole peer log behind it
 * (WI-2142873: tower cursor pinned 2.7 days / 32k attempts on one such op).
 */
/**
 * Migration 986's resource-governor identity arbiter: one durable governor
 * receipt per workspace + namespace + idempotencyKey. The index has no harness
 * or status predicate, and an idempotencyKey can embed a commit sha, so two
 * machines that admit work for the same key mint the same identity. Replaying
 * the peer's receipt then raises a deterministic 23505 (WI-2142873: the Mac
 * VM's cursor for the tower log pinned at position 5868039, 2026-09-23).
 */
interface ResourceGovernorIdentity {
  namespace: string;
  idempotencyKey: string;
}

/**
 * Read the exact identity migration 986 indexes from the incoming wire payload.
 * The governor writes schemaVersion as the number 1, and jsonb `->>` renders
 * both 1 and '1' as '1', so both are inside the predicate. Anything else fails
 * closed.
 */
function resourceGovernorIdentityFromPayload(payload: unknown): ResourceGovernorIdentity | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const marker = (payload as Record<string, unknown>).resource_governor;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const { schemaVersion, namespace, idempotencyKey } = marker as Record<string, unknown>;
  if (schemaVersion !== 1 && schemaVersion !== '1') return null;
  if (typeof namespace !== 'string' || typeof idempotencyKey !== 'string') return null;
  return { namespace, idempotencyKey };
}

/**
 * Exactly one DIFFERENT physical row holding the identity. The index is
 * workspace-wide, so the winner may sit under another harness slug; the
 * physical row identity is (harness_slug, feature_id).
 */
async function findResourceGovernorIdentityWinner(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  incomingIssueId: string,
  identity: ResourceGovernorIdentity,
): Promise<string | null> {
  const rows = await sql<{ harness_slug: string; feature_id: string }[]>`
    SELECT harness_slug, feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND NOT (harness_slug = ${harnessSlug} AND feature_id = ${incomingIssueId})
       AND payload -> 'resource_governor' ->> 'schemaVersion' = '1'
       AND payload -> 'resource_governor' ->> 'namespace' = ${identity.namespace}
       AND payload -> 'resource_governor' ->> 'idempotencyKey' = ${identity.idempotencyKey}
     ORDER BY harness_slug, feature_id
     LIMIT 2`;
  return rows.length === 1 ? `${rows[0]!.harness_slug}/${rows[0]!.feature_id}` : null;
}

/**
 * Only the named logical-identity arbiters are recoverable (see
 * work-items-replay-identity-indexes.ts for the per-index policy); every other
 * 23505 remains fatal and visible to the merge path.
 */
function isNamedIdentityConflict(error: unknown, indexName: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  if (String(candidate.code ?? '') !== '23505') return false;
  if (candidate.constraint === indexName || candidate.constraint_name === indexName) {
    return true;
  }
  return [candidate.message, candidate.detail].some(
    (value) => typeof value === 'string' && value.includes(`"${indexName}"`),
  );
}

/**
 * Read the exact identity migration 1157 indexes from the incoming wire payload,
 * mirroring every component of that partial index's predicate. Fail closed on
 * anything malformed or outside the predicate: such a row cannot have raised
 * this index's 23505 as the same logical item.
 */
function keylessTitleKeyFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const watchdogKey = record.watchdogKey;
  if (watchdogKey !== undefined && watchdogKey !== null) {
    if (typeof watchdogKey !== 'string' || watchdogKey.trim() !== '') return null;
  }
  if (record.lane !== undefined && record.lane !== null && typeof record.lane !== 'string') return null;
  if (record.lane === 'observation') return null;
  const admission = record.admissionIdentity;
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) return null;
  const { schemaVersion, titleKey } = admission as Record<string, unknown>;
  if (schemaVersion !== 'admission-identity-v1') return null;
  if (typeof titleKey !== 'string' || titleKey.trim() === '') return null;
  return titleKey;
}

/** Same strictness as findWatchdogIdentityWinner: exactly one different live row. */
async function findKeylessTitleIdentityWinner(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  incomingIssueId: string,
  titleKey: string,
): Promise<string | null> {
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND feature_id <> ${incomingIssueId}
       AND item_kind IN ('bug', 'change', 'task')
       AND (status IS NULL OR status <> ALL (
         ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
       ))
       AND NULLIF(btrim(payload ->> 'watchdogKey'), '') IS NULL
       AND COALESCE(payload ->> 'lane', 'improvement') <> 'observation'
       AND payload #>> '{admissionIdentity,schemaVersion}' = 'admission-identity-v1'
       AND payload #>> '{admissionIdentity,titleKey}' = ${titleKey}
     ORDER BY feature_id
     LIMIT 2`;
  return rows.length === 1 ? rows[0]!.feature_id : null;
}

/**
 * Resolve a named logical-identity 23505 to the existing live winner, or null
 * (caller rethrows the ORIGINAL error). Returns the log line describing why the
 * remote PUT is a no-op.
 */
async function resolveIdentityConflict(
  error: unknown,
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  incomingIssueId: string,
  payload: unknown,
): Promise<string | null> {
  if (isNamedIdentityConflict(error, WATCHDOG_IDENTITY_INDEX)) {
    const identity = watchdogIdentityFromPayload(payload);
    if (!identity) return null;
    const winnerId = await findWatchdogIdentityWinner(sql, workspaceId, harnessSlug, incomingIssueId, identity).catch(
      () => null,
    );
    if (!winnerId) return null;
    return (
      `[engineer-issues projection] coalesced stale watchdog replay issue_id=${incomingIssueId} ` +
      `onto existing non-terminal winner=${winnerId} (harness_slug=${harnessSlug}, ` +
      `watchdogKey=${identity.watchdogKey}, signal_origin=${identity.signalOrigin}, lane=${identity.lane}); ` +
      `remote PUT treated as no-op`
    );
  }
  if (isNamedIdentityConflict(error, KEYLESS_TITLE_IDENTITY_INDEX)) {
    const titleKey = keylessTitleKeyFromPayload(payload);
    if (!titleKey) return null;
    const winnerId = await findKeylessTitleIdentityWinner(sql, workspaceId, harnessSlug, incomingIssueId, titleKey).catch(
      () => null,
    );
    if (!winnerId) return null;
    return (
      `[engineer-issues projection] coalesced duplicate keyless filing issue_id=${incomingIssueId} ` +
      `onto existing non-terminal winner=${winnerId} (harness_slug=${harnessSlug}, titleKey=${titleKey}); ` +
      `remote PUT treated as no-op`
    );
  }
  if (isNamedIdentityConflict(error, RESOURCE_GOVERNOR_IDENTITY_INDEX)) {
    const identity = resourceGovernorIdentityFromPayload(payload);
    if (!identity) return null;
    const winnerId = await findResourceGovernorIdentityWinner(
      sql,
      workspaceId,
      harnessSlug,
      incomingIssueId,
      identity,
    ).catch(() => null);
    if (!winnerId) return null;
    return (
      `[engineer-issues projection] coalesced duplicate resource-governor receipt issue_id=${incomingIssueId} ` +
      `onto existing winner=${winnerId} (harness_slug=${harnessSlug}, namespace=${identity.namespace}, ` +
      `idempotencyKey=${identity.idempotencyKey}); remote PUT treated as no-op`
    );
  }
  return null;
}

/** Index names resolveIdentityConflict can coalesce; the replay-policy guard compares this set. */
export const COALESCED_REPLAY_IDENTITY_INDEXES: readonly string[] = [
  WATCHDOG_IDENTITY_INDEX,
  KEYLESS_TITLE_IDENTITY_INDEX,
  RESOURCE_GOVERNOR_IDENTITY_INDEX,
];

/**
 * Re-read the database arbiter after its named 23505. Returning a winner is
 * deliberately stricter than merely finding the same watchdogKey: every
 * component and the partial-index predicate must match, and the winner must be
 * a different physical row. Migration 865 guarantees at most one such row;
 * anything else fails closed and leaves the merge cursor retryable.
 */
async function findWatchdogIdentityWinner(
  sql: postgres.Sql,
  workspaceId: string,
  harnessSlug: string,
  incomingIssueId: string,
  identity: WatchdogIdentity,
): Promise<string | null> {
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND feature_id <> ${incomingIssueId}
       AND item_kind IN ('bug', 'change', 'task')
       AND (status IS NULL OR status <> ALL (
         ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']::text[]
       ))
       AND payload ->> 'watchdogKey' = ${identity.watchdogKey}
       AND COALESCE(payload -> '_ei' ->> 'signal_origin', 'organic') = ${identity.signalOrigin}
       AND COALESCE(payload ->> 'lane', 'improvement') = ${identity.lane}
     ORDER BY feature_id
     LIMIT 2`;
  return rows.length === 1 ? rows[0]!.feature_id : null;
}

export interface EngineerIssuesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** WI-259 parity (shared-hive member-content federation): hive-home slug when this harness is a
   *  hive MEMBER — a cross-member issue op is membership-gated only when set. */
  potHomeSlug?: string;
  /** WI-259 parity: resolve an op's VERIFIED source-log device pubkey from sourceLogKeyHex. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004 parity: content-before-membership defer buffer. */
  pendingMemberContent?: PendingMembershipContent;
}

/** Per-harness Hyperbee key == issue_id (matches the capture trigger's TG_ARGV[0]). */
function composeKey(row: EngineerIssueRow): string {
  return row.storage_harness_slug ? composeEngineerIssueKey(row.storage_harness_slug, row.issue_id) : row.issue_id;
}

function decodeValue(raw: unknown): EngineerIssueRow | null {
  return isEngineerIssueRow(raw) ? raw : null;
}

/**
 * p2p-join-catchup-speed-2026-09-23 P-536: one row of {@link upsertIssues}'s JSON input,
 * named after the work_items columns it fills (plus `created_at`, from which the
 * statement derives `created_ts`).
 */
interface IssueUpsertInput {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string;
  title: string;
  summary: string;
  status: string;
  taken_by: string | null;
  taken_at: string | null;
  payload: Record<string, unknown>;
  author_pubkey: string | null;
  origin: string;
  fed_ts: number | null;
  fed_hlc: string | null;
  created_at: string | null;
  terminal_owner: string | null;
  terminal_completion_ref: string | null;
  terminal_reason: string | null;
  authority: string | null;
  closed_ts: number | null;
  admission: string | null;
  admitted_at: string | null;
  admitted_by: string | null;
  state_changed_at: string | null;
  tags: unknown;
  parent_id: string | null;
  source_plan_slug: string | null;
  source_plan_item_ids: string[] | null;
  expected_cost_cents: number | null;
}

/**
 * P-536: one issue write as `writeToPg` decided it, complete, so a snapshot lane's group
 * write can land it after the op has returned ({@link ProjectionGroupWriter}).
 */
interface IssueWrite {
  input: IssueUpsertInput;
  /** WI-6327: the wire's creation instant, the only one the EI-13285 guard trusts. Null fails open. */
  createdTs: number | null;
  /** The wire payload as received, which the identity-conflict coalesce reads. */
  payload: unknown;
}

/**
 * The value postgres-js sends for a string bound to a timestamptz parameter: it parses it
 * with `new Date` and sends `toISOString()` (millisecond precision). The upsert takes its
 * rows as JSON, so it normalises here, and a row lands with the instant a per-parameter
 * bind stored before P-536, on this build and on an older peer alike.
 */
function asTimestamptzParam(value: string | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function issueWrite(
  opts: EngineerIssuesProjectionOpts,
  row: EngineerIssueRow,
  vSlug: string,
  provenance: ProvenanceContext,
): IssueWrite {
  const basePayload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
  return {
    input: {
      workspace_id: opts.workspaceId,
      harness_slug: vSlug,
      feature_id: row.issue_id,
      item_kind: row.kind,
      title: row.title,
      summary: row.body,
      status: row.state,
      taken_by: row.assignee,
      taken_at: asTimestamptzParam(row.assigned_at),
      payload: {
        ...basePayload,
        _ei: {
          scope: row.scope ?? null,
          severity: row.severity ?? null,
          source: row.source ?? null,
          found_during: row.found_during ?? null,
          linked_feature_id: row.linked_feature_id ?? null,
          created_by: row.created_by ?? null,
          assigned_by: row.assigned_by ?? null,
        },
      },
      author_pubkey: provenance?.authorPubkey ?? null,
      origin: provenance.origin,
      fed_ts: provenance?.ts ?? null,
      fed_hlc: provenance?.fedHlc ?? null,
      created_at: asTimestamptzParam(row.created_at),
      terminal_owner: row.terminal_owner ?? null,
      terminal_completion_ref: row.terminal_completion_ref ?? null,
      terminal_reason: row.terminal_reason ?? null,
      authority: row.authority ?? null,
      closed_ts: row.closed_ts ?? null,
      admission: row.admission ?? null,
      admitted_at: asTimestamptzParam(row.admitted_at),
      admitted_by: row.admitted_by ?? null,
      state_changed_at: asTimestamptzParam(row.state_changed_at),
      // EI-21467654382027859 (mig 965): an absent tags value must land SQL NULL, not the
      // jsonb 'null' literal that reads as present. jsonb_to_recordset maps a JSON null
      // to SQL NULL for every column type.
      tags: row.tags ?? null,
      parent_id: row.parent_id ?? null,
      source_plan_slug: row.source_plan_slug ?? null,
      source_plan_item_ids: row.source_plan_item_ids ?? null,
      expected_cost_cents: row.expected_cost_cents ?? null,
    },
    createdTs: row.created_ts ?? null,
    payload: row.payload,
  };
}

async function writeToPg(
  opts: EngineerIssuesProjectionOpts,
  row: EngineerIssueRow,
  provenance: ProvenanceContext,
  groupWriter?: ProjectionGroupWriter<IssueWrite>,
): Promise<void | false> {
  // WI-259/D-027 parity (shared-hive member-content federation): own-slug applies; a CROSS-member
  // issue/task applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. The bare slug
  // early-return previously DROPPED every peer member's issue (members have distinct slugs in a real
  // hive). It lands under its AUTHORED slug (the write persists row.scope = 'harness:<authored>').
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'engineer-issues',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: async () => {
            await writeToPg(opts, row, provenance, groupWriter);
          },
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: 'engineer-issues',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: async () => {
            await writeToPg(opts, row, provenance, groupWriter);
          },
        },
        Date.now(),
      );
    }
    return;
  }
  const target = opts.sql ?? getOrgPg().sql;
  // P-010 unification: apply the issue op to the work_items BASE table (engineer_issues is
  // now a compat view → no ON CONFLICT). Map issue→work_items: issue_id→feature_id,
  // scope→canonical issue harness_slug (migration 382: 'operator:<workspace>' for
  // operator-scope rows; '<harness>' for harness-scoped rows) + issue-only cols into
  // payload->'_ei', body→summary, state→status, assignee→taken_by, kind→item_kind.
  const vSlug =
    typeof row.scope === 'string' && row.scope.startsWith('harness:')
      ? row.scope.slice(8)
      : `operator:${opts.workspaceId || 'default'}`;
  // The storage slug is part of every post-829 op's identity.  Refuse a row
  // whose payload disagrees with its scope-derived destination: accepting it
  // would make the put land under one key while its later tombstone targets a
  // different physical row.
  if (row.storage_harness_slug && row.storage_harness_slug !== vSlug) {
    console.warn(
      `[engineer-issues projection] storage harness mismatch for issue_id=${row.issue_id}: ` +
        `wire=${row.storage_harness_slug}, scope=${vSlug}; refusing op`,
    );
    return false;
  }
  const write = issueWrite(opts, row, vSlug, provenance);
  // P-536: inside a snapshot lane a qualified row joins the lane's group write (one
  // collision read and one upsert per group). A bare legacy row reads the retired-twin
  // markers first, so it always writes alone.
  if (row.storage_harness_slug && groupWriter && (await projectionDefer(target, groupWriter, write))) return;
  // P-002 step 2 (batchable): every statement below, helper reads included, runs
  // on this one handle, so inside the merge's batch it is the batch transaction.
  const sql = await projectionSql(target);
  // WI-40113 / migration 859: a bare pre-829 PUT has no physical identity of
  // its own.  If migration-826 survivor evidence proves that this exact source
  // identity was retired, applying the op would recreate the physical twin.
  // Qualified post-829 PUTs intentionally bypass this guard: their storage key
  // is authoritative and must remain able to represent a current source row.
  if (!row.storage_harness_slug && (await isRetiredLegacyTwinSource(sql, opts.workspaceId, vSlug, row.issue_id))) {
    console.warn(
      `[engineer-issues projection] suppressing legacy replay for retired migration-826 source ` +
        `issue_id=${row.issue_id} (harness_slug=${vSlug}); a qualified post-829 PUT is required`,
    );
    return false;
  }
  return writeIssue(sql, opts, write);
}

/**
 * EI-13285: the writes whose issue_id already names a DISTINCT local issue (see
 * {@link isDistinctEntityCollision}), each logged as the refusal it is. One read for the
 * whole set. It must run BEFORE the upsert, which would otherwise blindly clobber a
 * distinct local record sharing this issue_id.
 */
async function distinctEntityCollisions(sql: postgres.Sql, writes: readonly IssueWrite[]): Promise<Set<IssueWrite>> {
  const refused = new Set<IssueWrite>();
  // WI-6327: a write without a carried creation instant fails open, unread.
  const judged = writes.filter((w): w is IssueWrite & { createdTs: number } => w.createdTs !== null);
  if (judged.length === 0) return refused;
  const rows = await sql<{ harness_slug: string; feature_id: string; created_ts: string | number }[]>`
    SELECT w.harness_slug, w.feature_id, w.created_ts
      FROM unnest(${judged.map((w) => w.input.harness_slug)}::text[],
                  ${judged.map((w) => w.input.feature_id)}::text[]) AS k(harness_slug, feature_id)
      JOIN harness_shared.work_items w
        ON w.harness_slug = k.harness_slug AND w.feature_id = k.feature_id`;
  const existingMs = new Map(rows.map((r) => [`${r.harness_slug}\u0000${r.feature_id}`, Number(r.created_ts)]));
  for (const w of judged) {
    const existing = existingMs.get(`${w.input.harness_slug}\u0000${w.input.feature_id}`);
    if (existing === undefined) continue;
    const collision = isDistinctEntityCollision(w.createdTs, existing);
    if (!collision.collided) continue;
    console.warn(
      `[engineer-issues projection] EI-13285 id collision: refusing to apply remote op for ` +
        `issue_id=${w.input.feature_id} (harness_slug=${w.input.harness_slug}) — the existing local row was created at ` +
        `${collision.existingCreatedAtIso}, but the incoming op claims created_at=${w.input.created_at}. ` +
        `These are two distinct issues that were allocated the same id; the incoming op is DROPPED ` +
        `(not applied) to avoid destroying the local record. The authoring peer's own copy is unaffected.`,
    );
    refused.add(w);
  }
  return refused;
}

/** One issue write on its own: the per-op path, and what a failed group write replays. */
async function writeIssue(sql: postgres.Sql, opts: EngineerIssuesProjectionOpts, write: IssueWrite): Promise<void | false> {
  if ((await distinctEntityCollisions(sql, [write])).size > 0) return false;
  try {
    await upsertIssues(sql, [write]);
  } catch (error) {
    // The physical-row ON CONFLICT cannot arbitrate migration 865's
    // separate partial unique index. A historical terminal row can therefore
    // receive a stale remote PUT that tries to reopen it while a newer live row
    // already owns the same watchdog identity. Retrying that deterministic
    // 23505 forever pins every per-harness merge cursor on the same op.
    //
    // Migration 1157's keyless title-identity index has the same shape: a peer
    // that had not yet replicated an open filing mints a duplicate with the same
    // server-authored titleKey, and its replay here is a deterministic 23505.
    // Migration 986's resource-governor identity is the third instance: two
    // machines admit work under the same idempotencyKey.
    //
    // Recover only those named indexes and only after the complete incoming
    // identity resolves to exactly one different row (non-terminal for 865 and
    // 1157, whose predicates exclude terminal rows). That row is
    // the already-coalesced logical item, so the duplicate physical-row PUT is
    // a no-op. Any missing/malformed component, lookup failure, or other 23505
    // rethrows the original error and remains visible to the merge retry path.
    //
    // P-002 step 2: inside the merge's batch transaction the 23505 aborted the
    // transaction, so the lookups below would fail and the coalesce could never
    // resolve. Rolling back to the op's savepoint is exact here: every statement
    // this write issued before the upsert was a read.
    await projectionStatementFailed();
    const coalesced = await resolveIdentityConflict(
      error,
      sql,
      opts.workspaceId,
      write.input.harness_slug,
      write.input.feature_id,
      write.payload,
    );
    if (!coalesced) throw error;
    console.warn(coalesced);
    // The op's own row was not written; another row already holds the logical item.
    return false;
  }
}

/**
 * P-536: a snapshot lane's group of issue writes, as two statements: the collision read
 * and one upsert. The lane never passes two writes for one row, so each write's collision
 * check sees what it would have seen alone. Any failure (an identity-index 23505 among
 * them) rolls the group back and the lane replays each write through {@link writeIssue}.
 */
async function writeIssueGroup(sql: postgres.Sql, writes: readonly IssueWrite[]): Promise<void> {
  const refused = await distinctEntityCollisions(sql, writes);
  const kept = refused.size === 0 ? writes : writes.filter((w) => !refused.has(w));
  if (kept.length > 0) await upsertIssues(sql, kept);
}

function issueGroupWriter(opts: EngineerIssuesProjectionOpts): ProjectionGroupWriter<IssueWrite> {
  return {
    name: 'engineer-issues',
    rowOf: (w) => `${w.input.harness_slug}\u0000${w.input.feature_id}`,
    writeMany: writeIssueGroup,
    writeOne: async (w) => writeIssue(await projectionSql(opts.sql ?? getOrgPg().sql), opts, w),
  };
}

/**
 * The issue upsert. ONE statement text for one row or many (P-536): the rows travel as a
 * JSON array, so the per-op path and a lane's group write cannot drift apart. Rows in one
 * call name distinct physical rows; a conflict between two of them fails the statement.
 */
async function upsertIssues(sql: postgres.Sql, writes: readonly IssueWrite[]): Promise<void> {
  const rowsJson = JSON.stringify(writes.map((w) => w.input));
  await sql`
      INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, summary, status,
       taken_by, taken_at, payload, author_pubkey, origin, fed_ts, fed_hlc,
       created_ts, updated_ts, ts, terminal_owner, terminal_completion_ref, terminal_reason,
       authority, closed_ts,
       admission, admitted_at, admitted_by, state_changed_at, tags, parent_id,
       source_plan_slug, source_plan_item_ids, expected_cost_cents)
    SELECT
       r.workspace_id, r.harness_slug, r.feature_id, r.item_kind, r.title,
       r.summary, r.status, r.taken_by, r.taken_at,
       r.payload, r.author_pubkey, r.origin, r.fed_ts, r.fed_hlc,
       COALESCE((extract(epoch FROM r.created_at) * 1000)::bigint,
                (extract(epoch FROM now()) * 1000)::bigint),
       (extract(epoch FROM now()) * 1000)::bigint,
       (extract(epoch FROM now()) * 1000)::bigint,
       r.terminal_owner, r.terminal_completion_ref, r.terminal_reason,
       r.authority, r.closed_ts,
       r.admission, r.admitted_at, r.admitted_by, r.state_changed_at, r.tags,
       r.parent_id, r.source_plan_slug, r.source_plan_item_ids, r.expected_cost_cents
      -- The rows bind as ONE text parameter cast to jsonb (the postgres-js jsonb binding
      -- gotcha). jsonb_to_recordset turns a JSON null into SQL NULL for every column.
      FROM jsonb_to_recordset(${rowsJson}::text::jsonb) AS r(
       workspace_id text, harness_slug text, feature_id text, item_kind text, title text,
       summary text, status text, taken_by text, taken_at timestamptz,
       payload jsonb, author_pubkey text, origin text, fed_ts bigint, fed_hlc text,
       created_at timestamptz,
       terminal_owner text, terminal_completion_ref text, terminal_reason text,
       authority text, closed_ts bigint,
       admission text, admitted_at timestamptz, admitted_by text, state_changed_at timestamptz, tags jsonb,
       parent_id text, source_plan_slug text, source_plan_item_ids text[], expected_cost_cents bigint)
    ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
      item_kind     = EXCLUDED.item_kind,
      title         = EXCLUDED.title,
      summary       = EXCLUDED.summary,
      status        = EXCLUDED.status,
      taken_by      = EXCLUDED.taken_by,
      taken_at      = EXCLUDED.taken_at,
      payload       = EXCLUDED.payload,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc,
      updated_ts    = EXCLUDED.updated_ts,
      terminal_owner = EXCLUDED.terminal_owner,
      terminal_completion_ref = EXCLUDED.terminal_completion_ref,
      -- P-009/D-001 (work-item-status-full-unify): the terminal nuance
      -- (resolved→done / closed→dropped) must converge like status itself.
      terminal_reason = EXCLUDED.terminal_reason,
      -- mig 708/D-035: same rationale as terminal_reason — the authority axis
      -- must converge like status itself.
      authority = EXCLUDED.authority,
      -- mig 708 PART 2: honour a federated close time; the BEFORE trigger's own
      -- COALESCE/freeze logic (mig 698) then decides whether it actually wins.
      closed_ts = EXCLUDED.closed_ts,
      -- EI-21467654382027859 (mig 965). These plain content columns converge like
      -- status does: last writer in fed_order_key space wins.
      tags = EXCLUDED.tags,
      parent_id = EXCLUDED.parent_id,
      source_plan_slug = EXCLUDED.source_plan_slug,
      source_plan_item_ids = EXCLUDED.source_plan_item_ids,
      expected_cost_cents = EXCLUDED.expected_cost_cents,
      -- state_changed_at COALESCEs rather than taking EXCLUDED outright, and the
      -- difference is not cosmetic. An op from a pre-965 peer carries NULL here, and
      -- the mig 896 BEFORE trigger treats a NULL that DIFFERS from the stored value as
      -- "an explicit origin timestamp" and preserves it -- so a bare EXCLUDED would let
      -- one older peer's update ERASE the state age this column exists to protect.
      -- COALESCE means: a 965 peer supplies the true origin time, an older peer
      -- supplies nothing and the local value stands.
      state_changed_at = COALESCE(EXCLUDED.state_changed_at, work_items.state_changed_at),
      -- admission is MONOTONIC (pending -> admitted/auto/unreviewed; no writer anywhere
      -- moves it back), so it is upserted with a floor rather than blindly:
      --
      --   * EXCLUDED NULL  => the op predates mig 965 (or the column really is NULL).
      --     Keep the local value. Taking NULL would read as ADMITTED at the claim gate
      --     and un-hide a born-pending item -- the exact bypass this column federates
      --     to close.
      --   * EXCLUDED 'pending' over a locally PROMOTED row => a peer that has not yet
      --     seen the promotion. Keep the promotion. The LWW guard below does not cover
      --     this: a LOCAL promotion does not restamp fed_ts/fed_hlc, so a later remote
      --     op legitimately outranks it in fed_order_key space and would re-hide work
      --     that was already judged.
      --   * otherwise => take the incoming value, including 'pending' over a NULL
      --     legacy row (hiding is the fail-safe direction, and it is what the origin
      --     asserts about the item).
      --
      -- admitted_at/admitted_by follow the SAME branch so the trio can never disagree
      -- about who promoted the row and when.
      admission = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admission
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admission
        ELSE EXCLUDED.admission
      END,
      admitted_at = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admitted_at
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admitted_at
        ELSE EXCLUDED.admitted_at
      END,
      admitted_by = CASE
        WHEN EXCLUDED.admission IS NULL THEN work_items.admitted_by
        WHEN EXCLUDED.admission = 'pending'
             AND work_items.admission IS NOT NULL
             AND work_items.admission IS DISTINCT FROM 'pending' THEN work_items.admitted_by
        ELSE EXCLUDED.admitted_by
      END
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    -- WI-2923 (mig 504): at an EQUAL order key the WRITER tie-break decides —
    -- the bare ">=" applied unconditionally on ties, so two cells that each
    -- completed the same item in the same clock tick SWAPPED values on heal
    -- (each applied the other's write, echo suppression froze the swap, and
    -- convergence reported a fixed point over divergent replicas —
    -- composition-chaos P-002). fed_apply_wins breaks the tie by writer-pair
    -- when both are known, else by the SYMMETRIC content digest (local rows are
    -- author_pubkey-NULL by design, mig 214), so every replica settles on the
    -- same value in one exchange. The digest covers CONTENT columns only.
    --
    -- EI-16756: terminal_owner/terminal_completion_ref MUST be in this digest.
    -- They were originally omitted as "bookkeeping", but they are not — they are
    -- the completion-integrity attribution pair, and two DIFFERENT completions of
    -- the same item routinely converge to an IDENTICAL status/taken_by (terminal
    -- status, taken_by NULL) while carrying DIFFERENT terminal_owner/ref. With
    -- those two columns excluded, such ops hash to the SAME digest, so the tie
    -- branch's "equal digest ⇒ identical content ⇒ applying is a no-op" invariant
    -- is FALSE for them: a stale/racing peer completion can silently overwrite the
    -- correct completer's terminal_owner while every other field looks converged
    -- (observed live: a completion's terminalCompletionRef matched the caller's own
    -- text exactly, but terminalOwner was stamped as an unrelated peer who had
    -- earlier briefly held the same item).
    -- P-009/D-001: terminal_reason joins the digest for the SAME reason as the
    -- terminal_owner pair above — two completions can converge to an identical
    -- status (e.g. both 'done') while carrying a different terminal_reason
    -- (resolved vs plain-done), so excluding it would let a racing peer silently
    -- overwrite the correct terminal nuance under the "equal digest ⇒ no-op" tie.
    --
    -- mig 708 / EI-18785839681430807 (D-035): authority joins the digest for the
    -- SAME reason — two racing completions can converge to an identical
    -- status/taken_by/terminal_owner while carrying a DIFFERENT authority (an
    -- evidence-backed 'committed' vs a racing under-evidenced 'proposed').
    -- WARNING: SINGLE quotes, never backticks. This comment lives INSIDE a
    -- tagged sql template literal, so a backtick here CLOSES the template and
    -- the whole module stops PARSING (TS1005/TS1443) -- a hard compile failure
    -- for every consumer and a red green-gate for the whole fleet, not a style
    -- nit. It landed here AND in the sibling projections/harness-features.ts in
    -- the same edit; run: npm run lint:no-sql-comment-backtick
    WHERE harness_shared.fed_apply_wins(
            EXCLUDED.fed_hlc, EXCLUDED.fed_ts, EXCLUDED.author_pubkey,
            md5(concat_ws('|', EXCLUDED.item_kind, EXCLUDED.title, EXCLUDED.summary,
                          EXCLUDED.status, EXCLUDED.taken_by, EXCLUDED.payload::text,
                          EXCLUDED.terminal_owner, EXCLUDED.terminal_completion_ref,
                          EXCLUDED.terminal_reason, EXCLUDED.authority)),
            work_items.fed_hlc, work_items.fed_ts, work_items.author_pubkey,
            md5(concat_ws('|', work_items.item_kind, work_items.title, work_items.summary,
                          work_items.status, work_items.taken_by, work_items.payload::text,
                          work_items.terminal_owner, work_items.terminal_completion_ref,
                          work_items.terminal_reason, work_items.authority)))
      -- EI-22581437944679741: a later remote OPEN snapshot is not proof that a
      -- terminal row was deliberately reopened. The local lifecycle writer records
      -- an explicit reopen by appending the exact displaced completion to the newest
      -- payload.reopenHistory entry. Require that proof atomically here; a peer that
      -- never observed the close otherwise erases the terminal result merely because
      -- its unrelated edit has a later federation clock.
      AND (
        EXCLUDED.origin IS DISTINCT FROM 'remote'
        OR NOT (
          work_items.status = ANY(${FEDERATED_TERMINAL_STATES}::text[])
          AND NOT (EXCLUDED.status = ANY(${FEDERATED_TERMINAL_STATES}::text[]))
        )
        OR (
          jsonb_typeof(EXCLUDED.payload -> 'reopenHistory' -> -1) = 'object'
          AND NULLIF(btrim(EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'at'), '') IS NOT NULL
          AND NULLIF(btrim(EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'by'), '') IS NOT NULL
          AND jsonb_typeof(EXCLUDED.payload -> 'reopenHistory' -> -1 -> 'force') = 'boolean'
          AND EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'prevState' = work_items.status
          AND (EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'terminalOwner')
                IS NOT DISTINCT FROM work_items.terminal_owner
          AND (EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'terminalCompletionRef')
                IS NOT DISTINCT FROM work_items.terminal_completion_ref
          AND (EXCLUDED.payload -> 'reopenHistory' -> -1 ->> 'completionAuthority')
                IS NOT DISTINCT FROM work_items.authority
          AND NULLIF(
                EXCLUDED.payload -> 'reopenHistory' -> -1 -> 'terminalCompletionEvidence',
                'null'::jsonb
              ) IS NOT DISTINCT FROM (work_items.payload -> '_completionEvidence')
          AND NULLIF(
                EXCLUDED.payload -> 'reopenHistory' -> -1 -> 'assumptions',
                'null'::jsonb
              ) IS NOT DISTINCT FROM (work_items.payload -> '_assumptions')
          -- A prior reopen retained on a re-closed row is not authority to reopen
          -- it again. The lifecycle writer always appends a fresh newest entry.
          AND (EXCLUDED.payload -> 'reopenHistory' -> -1) IS DISTINCT FROM
              (work_items.payload -> 'reopenHistory' -> -1)
        )
      )
    `;
}

async function deleteFromPg(
  opts: EngineerIssuesProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (!key) return;
  const sql = await projectionSql(opts.sql ?? getOrgPg().sql);
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  const parsed = parseEngineerIssueKey(key);
  const storageHarnessSlug = parsed?.storageHarnessSlug ?? opts.harnessSlug;
  const issueId = parsed?.issueId ?? key;
  // Author-scoped tombstones must never widen into an unscoped delete when a
  // legacy/direct caller omits the provenance context. The canonical apply
  // path always supplies it; refusing here protects direct callers and keeps
  // the authorization boundary fail-closed.
  if (!provenance) return;
  const authorPubkey = provenance.authorPubkey;
  await sql`
    DELETE FROM harness_shared.work_items
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${storageHarnessSlug}
      AND feature_id = ${issueId}
      AND item_kind IN ('bug', 'change', 'task')
      -- Remote tombstones may delete only the row materialised from that same
      -- source log.  This makes every pre-829 bare-key replay fail closed instead
      -- of erasing a same-id local/sibling row (the migration-826 incident).
      AND author_pubkey = ${authorPubkey}
      -- ts-guard the delete (a stale del must not erase a newer row).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

/**
 * p2p-join-catchup-speed-2026-09-23 P-002 (WI-10002479): the stored federation
 * order for the physical rows these keys address, in ONE query.
 *
 * Only QUALIFIED keys (`<storage_harness_slug>/<issue_id>`) are resolved: the put
 * refuses a row whose storage slug disagrees with its scope, and the delete parses
 * the same key, so a qualified key names exactly the `(harness_slug, feature_id)`
 * primary key both guards compare against. A bare legacy key's physical row
 * depends on the op VALUE (its scope), so it is omitted and simply applied.
 *
 * `fed_hlc`/`fed_ts` are exactly what `fed_apply_wins` (put) and the delete's
 * `fed_order_key >=` guard read, and both reject an op whose order key is
 * strictly lower, so a caller may skip such an op without changing PG state.
 */
async function storedOrderForKeys(
  opts: EngineerIssuesProjectionOpts,
  keys: readonly string[],
): Promise<Map<string, StoredFedOrder>> {
  const out = new Map<string, StoredFedOrder>();
  const slugs: string[] = [];
  const ids: string[] = [];
  const keyByPk = new Map<string, string>();
  for (const key of keys) {
    const parsed = parseEngineerIssueKey(key);
    if (!parsed) continue;
    const pk = `${parsed.storageHarnessSlug}\u0000${parsed.issueId}`;
    if (keyByPk.has(pk)) continue;
    keyByPk.set(pk, key);
    slugs.push(parsed.storageHarnessSlug);
    ids.push(parsed.issueId);
  }
  if (ids.length === 0) return out;
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<{ harness_slug: string; feature_id: string; fed_hlc: string | null; fed_ts: string | number | null }[]>`
    SELECT w.harness_slug, w.feature_id, w.fed_hlc, w.fed_ts
      FROM unnest(${slugs}::text[], ${ids}::text[]) AS k(harness_slug, feature_id)
      JOIN harness_shared.work_items w
        ON w.harness_slug = k.harness_slug AND w.feature_id = k.feature_id`;
  for (const r of rows) {
    const key = keyByPk.get(`${r.harness_slug}\u0000${r.feature_id}`);
    if (!key) continue;
    out.set(key, { hlc: r.fed_hlc ?? null, ts: r.fed_ts == null ? null : Number(r.fed_ts) });
  }
  return out;
}

export function buildEngineerIssuesProjection(opts: EngineerIssuesProjectionOpts): TableProjection<EngineerIssueRow> {
  // P-536: one writer per projection, so a lane batch keeps one group for it.
  const groupWriter = issueGroupWriter(opts);
  return {
    tableTag: 'engineer-issues',
    // EI-117: CDC-captured table (mig 197 custom capture) — own-log ops are replays.
    skipOwnOps: true,
    // P-002 step 2: every apply statement goes through projectionSql and no
    // transaction-local state is set, so ops may fold inside the batch transaction.
    batchable: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance, groupWriter),
    deleteFromPg: (key, delTs, delHlc, provenance) => deleteFromPg(opts, key, delTs, delHlc, provenance),
    storedOrderForKeys: (keys) => storedOrderForKeys(opts, keys),
    // P-528: a QUALIFIED key names one physical row (the put refuses a row whose storage
    // slug disagrees with it, resolving false), and every put carries the author's whole
    // wire row. A bare legacy key's row depends on the op value, so it never qualifies.
    supersedableKey: (key) => parseEngineerIssueKey(key) !== null,
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isEngineerIssueRow,
  RETIRED_LEGACY_TWIN_SQL,
  asTimestamptzParam,
};
