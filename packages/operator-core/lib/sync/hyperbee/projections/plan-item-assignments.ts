/**
 * Hyperbee → PG projection for `harness_shared.plan_item_assignments`.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 0 federation, D-002).
 *
 * The ASSIGNMENT half of "who's doing this" is durable, low-churn, shared-knowledge,
 * so it federates as CONTENT over the same peer-log machinery as features/issues/
 * plans (a later assignment legitimately wins under LWW on this small per-item
 * record). The CLAIM half (plan_item_claims) is authority-mediated and NEVER
 * federated — it has no projection.
 *
 * The per-harness Hyperbee key is `<plan_slug>:<item_id>` (the table's generated
 * `fed_key` column, which the capture trigger writes as the outbox key). Federated
 * fields = the assignment document: assignee_name / assigned_by_user / assigned_ts /
 * released_ts / strategy / note. NOT federated (machine-local): workspace_id (the
 * projection binds it), created_at/updated_at, fed_key (regenerated), origin/
 * author_pubkey (stamped on apply). No jsonb columns → no jsonb-binding dance.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';

export interface PlanItemAssignmentRow {
  harness_slug: string;
  plan_slug: string;
  item_id: string;
  assignee_name: string | null;
  assigned_by_user: string | null;
  assigned_ts: string | null; // ISO string (timestamptz under to_jsonb)
  released_ts: string | null; // ISO string; null = active assignment
  strategy: string | null;
  note: string | null;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isPlanItemAssignmentRow(input: unknown): input is PlanItemAssignmentRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.plan_slug !== 'string' || r.plan_slug.length === 0) return false;
  if (typeof r.item_id !== 'string' || r.item_id.length === 0) return false;
  return (
    isStringOrNull(r.assignee_name) &&
    isStringOrNull(r.assigned_by_user) &&
    isStringOrNull(r.assigned_ts) &&
    isStringOrNull(r.released_ts) &&
    isStringOrNull(r.strategy) &&
    isStringOrNull(r.note)
  );
}

export interface PlanItemAssignmentsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** WI-259 parity (shared-hive member-content federation): hive-home slug when this harness is a
   *  hive MEMBER — a cross-member assignment op is membership-gated only when set. */
  potHomeSlug?: string;
  /** WI-259 parity: resolve an op's VERIFIED source-log device pubkey from sourceLogKeyHex. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004 parity: content-before-membership defer buffer. */
  pendingMemberContent?: PendingMembershipContent;
}

/** Per-harness Hyperbee key == `<plan_slug>:<item_id>` (the table's fed_key). */
export function composeAssignmentKey(planSlug: string, itemId: string): string {
  return `${planSlug}:${itemId}`;
}

function composeKey(row: PlanItemAssignmentRow): string {
  return composeAssignmentKey(row.plan_slug, row.item_id);
}

function decodeValue(raw: unknown): PlanItemAssignmentRow | null {
  return isPlanItemAssignmentRow(raw) ? raw : null;
}

async function writeToPg(
  opts: PlanItemAssignmentsProjectionOpts,
  row: PlanItemAssignmentRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259/D-027 parity (shared-hive member-content federation): own-slug applies; a CROSS-member
  // assignment applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. The bare slug
  // early-return previously DROPPED every peer member's assignment (members have distinct slugs in a
  // real hive). It lands under its AUTHORED slug (the INSERT keys on row.harness_slug).
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'item-assignments',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: 'item-assignments',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    return;
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.plan_item_assignments
      (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user,
       assigned_ts, released_ts, strategy, note, author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.plan_slug}, ${row.item_id},
       ${row.assignee_name}, ${row.assigned_by_user}, ${row.assigned_ts}, ${row.released_ts},
       ${row.strategy}, ${row.note}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO UPDATE SET
      assignee_name    = EXCLUDED.assignee_name,
      assigned_by_user = EXCLUDED.assigned_by_user,
      assigned_ts      = EXCLUDED.assigned_ts,
      released_ts      = EXCLUDED.released_ts,
      strategy         = EXCLUDED.strategy,
      note             = EXCLUDED.note,
      author_pubkey    = EXCLUDED.author_pubkey,
      origin           = EXCLUDED.origin,
      fed_ts           = EXCLUDED.fed_ts,
      fed_hlc          = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(plan_item_assignments.fed_hlc, plan_item_assignments.fed_ts)
  `;
}

async function deleteFromPg(
  opts: PlanItemAssignmentsProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  // key == '<plan_slug>:<item_id>'; item_id has no colon, so split on the LAST ':'.
  const cut = key.lastIndexOf(':');
  if (cut <= 0) return;
  const planSlug = key.slice(0, cut);
  const itemId = key.slice(cut + 1);
  if (!planSlug || !itemId) return;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.plan_item_assignments
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND plan_slug = ${planSlug}
      AND item_id = ${itemId}
      -- guard the delete by the SAME fed_order_key() order as the put guard (EI-1698).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildPlanItemAssignmentsProjection(
  opts: PlanItemAssignmentsProjectionOpts,
): TableProjection<PlanItemAssignmentRow> {
  return {
    tableTag: 'item-assignments',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isPlanItemAssignmentRow,
};
