/**
 * push-delivery-store.ts — the Postgres layer for the ambient-push DELIVERY RAIL
 * (ambient-semantic-push-2026-07-14 P-003; table: migration 610
 * harness_shared.push_delivery). Pure SQL binding — the SELECTION math (floor +
 * severity gate + novelty + per-class budget) lives in ambient-push.ts (pure
 * core, where its tests are); the journal→push composition + fail-soft injection
 * wiring lives in ambient-push-delivery.ts.
 *
 * One table serves the whole rail (see migration 610):
 *   • a MATCHER enqueues a candidate push (`enqueuePush`, status 'queued');
 *   • the rail reads the receiver's queue (`pendingPushes`), runs selectPushes,
 *     then records the disposition — `recordDelivered` (the TALLY: deliveredCount
 *     is the per-class budget's `alreadyDelivered`, deliveredRefs is the novelty
 *     dedup set, both read back HERE so the rails persist across hops) and
 *     `recordDropped` (kept with a reason for the P-011 utilization ledger);
 *   • `recentDeliveries` is the P-011 read; `pruneDeliveries` is retention.
 *
 * Owner-keyed (target_owner_id) — the delivery axis the wake-executor resolves a
 * recipient on (subscriberId == ownerId), mirroring 609's owner axis + P-002.
 */
import { getOrgPg } from '@papercusp/db-org';
import type {
  MatcherKind,
  PushSeverity,
  QueryHandle,
  DropReason,
} from './ambient-push';

/** The QueryHandle.kind set, persisted as handle_kind. */
export type HandleKind = QueryHandle['kind'];

export interface PushDeliveryRow {
  id: number;
  target_owner_id: string;
  target_session_id: string | null;
  workspace_id: string;
  matcher_kind: MatcherKind;
  severity: PushSeverity;
  handle_kind: HandleKind;
  handle_ref: string;
  handle_query: string[];
  teaser: string;
  score: number;
  source_session_id: string | null;
  status: 'queued' | 'delivered' | 'dropped';
  drop_reason: DropReason | null;
  enqueued_at: string;
  delivered_at: string | null;
  pulled_at: string | null;
  acted_at: string | null;
}

/** postgres-js returns a bigint column as a STRING (precision-safe) — coerce the
 *  `id` back to a number so it survives the object-identity id correlation in the
 *  delivery pipeline and the Number.isFinite guards in recordDelivered/-Dropped. */
function normalizeRow(r: PushDeliveryRow): PushDeliveryRow {
  return { ...r, id: Number(r.id), score: Number(r.score) };
}

export interface EnqueuePushInput {
  targetOwnerId: string;
  targetSessionId?: string | null;
  workspaceId?: string;
  matcherKind: MatcherKind;
  severity: PushSeverity;
  handleKind: HandleKind;
  handleRef: string;
  handleQuery?: string[];
  teaser: string;
  score: number;
  sourceSessionId?: string | null;
}

/**
 * Enqueue a candidate push for a receiver (a matcher's write — status 'queued').
 * `handle_query` goes over as `::text::jsonb` (NOT bare `::jsonb`) — postgres-js
 * JSON-encodes the string param first, so a bare cast would double-encode into a
 * jsonb string scalar instead of the queryable array (session-cursor-store /
 * activity-pg-store gotcha). Returns the new row id.
 */
export async function enqueuePush(input: EnqueuePushInput): Promise<number> {
  const { sql } = getOrgPg();
  const queryJson = JSON.stringify(input.handleQuery ?? []);
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO harness_shared.push_delivery
      (target_owner_id, target_session_id, workspace_id, matcher_kind, severity,
       handle_kind, handle_ref, handle_query, teaser, score, source_session_id, status)
    VALUES (
      ${input.targetOwnerId}, ${input.targetSessionId ?? null}, ${input.workspaceId ?? 'default'},
      ${input.matcherKind}, ${input.severity}, ${input.handleKind}, ${input.handleRef},
      ${queryJson}::text::jsonb, ${input.teaser}, ${input.score},
      ${input.sourceSessionId ?? null}, 'queued'
    )
    RETURNING id
  `;
  return Number(rows[0]!.id);
}

/** Read a receiver's QUEUED candidate pushes, oldest-first (the rail's inbox). */
export async function pendingPushes(
  targetOwnerId: string,
  limit = 100,
): Promise<PushDeliveryRow[]> {
  const { sql } = getOrgPg();
  const cap = Math.min(Math.max(limit, 1), 500);
  const rows = await sql<PushDeliveryRow[]>`
    SELECT id, target_owner_id, target_session_id, workspace_id, matcher_kind, severity,
           handle_kind, handle_ref, handle_query, teaser, score, source_session_id, status,
           drop_reason, enqueued_at::text AS enqueued_at, delivered_at::text AS delivered_at,
           pulled_at::text AS pulled_at, acted_at::text AS acted_at
    FROM harness_shared.push_delivery
    WHERE target_owner_id = ${targetOwnerId} AND status = 'queued'
    ORDER BY enqueued_at ASC
    LIMIT ${cap}
  `;
  return rows.map(normalizeRow);
}

/**
 * Mark rows delivered (the TALLY): status → 'delivered', delivered_at = now().
 * No-op on an empty id list. Only queued rows transition (a re-delivery of an
 * already-delivered/dropped row is a no-op). Returns the count actually flipped.
 */
export async function recordDelivered(ids: number[]): Promise<number> {
  const list = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (list.length === 0) return 0;
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ id: number }>>`
    UPDATE harness_shared.push_delivery
    SET status = 'delivered', delivered_at = now()
    WHERE id = ANY(${list}) AND status = 'queued'
    RETURNING id
  `;
  return rows.length;
}

/**
 * Mark rows dropped with their reason (kept for the P-011 ledger, not deleted).
 * Only queued rows transition. Returns the count flipped.
 */
export async function recordDropped(
  items: Array<{ id: number; reason: DropReason }>,
): Promise<number> {
  const valid = items.filter((it) => Number.isFinite(it.id));
  if (valid.length === 0) return 0;
  const { sql } = getOrgPg();
  let flipped = 0;
  // Grouped by reason so each UPDATE carries one reason literal (a small fixed
  // set of reasons — at most 4 statements, never per-row).
  const byReason = new Map<DropReason, number[]>();
  for (const it of valid) {
    const arr = byReason.get(it.reason) ?? [];
    arr.push(it.id);
    byReason.set(it.reason, arr);
  }
  for (const [reason, ids] of byReason) {
    const rows = await sql<Array<{ id: number }>>`
      UPDATE harness_shared.push_delivery
      SET status = 'dropped', drop_reason = ${reason}
      WHERE id = ANY(${[...new Set(ids)]}) AND status = 'queued'
      RETURNING id
    `;
    flipped += rows.length;
  }
  return flipped;
}

/**
 * P-011 outcome stamp: the receiver RESOLVED a delivered push's handle (pulled
 * the brief). Keyed by (owner, handle_ref) — the correlation axis
 * push_delivery_ref_idx serves: the outcome probe sees a handle being resolved,
 * never a row id. First observation wins (an already-stamped row is left alone),
 * and only DELIVERED rows take the stamp — a queued/dropped push never reached
 * the receiver, so it cannot have been pulled. Returns the count stamped by THIS
 * call (0 = nothing delivered under that ref, or already stamped).
 */
export async function recordPulled(targetOwnerId: string, handleRef: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ id: number }>>`
    UPDATE harness_shared.push_delivery
    SET pulled_at = now()
    WHERE target_owner_id = ${targetOwnerId}
      AND handle_ref = ${handleRef}
      AND status = 'delivered'
      AND pulled_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/**
 * P-011 outcome stamp: a downstream ACTION followed a delivered push (route
 * change / lock taken / fact read). Independent of {@link recordPulled} — acting
 * on the teaser alone, without resolving the handle, is still genuine engagement
 * (push-utilization's PushOutcome contract), so acted_at never implies pulled_at.
 * Same keying + idempotence as recordPulled.
 */
export async function recordActed(targetOwnerId: string, handleRef: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ id: number }>>`
    UPDATE harness_shared.push_delivery
    SET acted_at = now()
    WHERE target_owner_id = ${targetOwnerId}
      AND handle_ref = ${handleRef}
      AND status = 'delivered'
      AND acted_at IS NULL
    RETURNING id
  `;
  return rows.length;
}

/**
 * The novelty-dedup set: distinct handle refs DELIVERED to this owner since
 * `sinceIso` (the budget/dedup window). ambient-push.isNovelPush drops a push
 * whose ref is already here (already delivered ⇒ not novel).
 */
export async function deliveredRefs(
  targetOwnerId: string,
  sinceIso: string,
): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ handle_ref: string }>>`
    SELECT DISTINCT handle_ref
    FROM harness_shared.push_delivery
    WHERE target_owner_id = ${targetOwnerId}
      AND status = 'delivered'
      AND delivered_at > ${sinceIso}::timestamptz
  `;
  return new Set(rows.map((r) => r.handle_ref));
}

/**
 * The stateless-matcher ENQUEUE dedup: the set of handle_refs a given matcher
 * kind already has QUEUED (undelivered) for this owner. A stateless matcher
 * (dead-end / insight-docs) re-proposes the same ref every tick its cursor still
 * overlaps the source; {@link deliveredRefs} suppresses re-warning AFTER delivery
 * (novelty), but nothing stops a fresh QUEUED row piling up every turn BEFORE the
 * rail next drains — the "Clippy" spam the design forbids. A matcher live leg
 * skips a ref already in this set so at most one queued row per (owner, matcher,
 * ref) is ever outstanding. (The collision matcher needs no equivalent: its
 * hysteresis only enqueues on the enter EDGE, not every tick.)
 */
export async function queuedRefs(
  targetOwnerId: string,
  matcherKind: MatcherKind,
): Promise<Set<string>> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ handle_ref: string }>>`
    SELECT DISTINCT handle_ref
    FROM harness_shared.push_delivery
    WHERE target_owner_id = ${targetOwnerId}
      AND matcher_kind = ${matcherKind}
      AND status = 'queued'
  `;
  return new Set(rows.map((r) => r.handle_ref));
}

/**
 * The per-class budget's `alreadyDelivered`: how many pushes were delivered to
 * this owner since `sinceIso` (the rolling window). selectPushes subtracts this
 * from the class budget so the window's budget persists across hops.
 */
export async function deliveredCount(
  targetOwnerId: string,
  sinceIso: string,
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM harness_shared.push_delivery
    WHERE target_owner_id = ${targetOwnerId}
      AND status = 'delivered'
      AND delivered_at > ${sinceIso}::timestamptz
  `;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Recent delivery rows for the P-011 utilization ledger / dashboard — a receiver's
 * delivered (and optionally dropped) pushes, freshest first. The pulled/acted
 * columns P-011 fills in ride along.
 */
export async function recentDeliveries(filter: {
  targetOwnerId?: string;
  status?: 'delivered' | 'dropped' | 'queued';
  since?: Date | string;
  limit?: number;
} = {}): Promise<PushDeliveryRow[]> {
  const { sql } = getOrgPg();
  const cap = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const sinceIso =
    filter.since == null
      ? null
      : typeof filter.since === 'string'
        ? filter.since
        : filter.since.toISOString();
  const rows = await sql<PushDeliveryRow[]>`
    SELECT id, target_owner_id, target_session_id, workspace_id, matcher_kind, severity,
           handle_kind, handle_ref, handle_query, teaser, score, source_session_id, status,
           drop_reason, enqueued_at::text AS enqueued_at, delivered_at::text AS delivered_at,
           pulled_at::text AS pulled_at, acted_at::text AS acted_at
    FROM harness_shared.push_delivery
    WHERE TRUE
      ${filter.targetOwnerId ? sql`AND target_owner_id = ${filter.targetOwnerId}` : sql``}
      ${filter.status ? sql`AND status = ${filter.status}` : sql``}
      ${sinceIso ? sql`AND enqueued_at > ${sinceIso}::timestamptz` : sql``}
    ORDER BY enqueued_at DESC
    LIMIT ${cap}
  `;
  return rows.map(normalizeRow);
}

/**
 * Retention prune: drop delivery rows older than `olderThan` (enqueued). Returns
 * the count removed. The journal / coord feed remain the archive; this table is a
 * bounded working set for the budget/novelty rails + a recent utilization window.
 */
export async function pruneDeliveries(olderThan: Date | string): Promise<number> {
  const { sql } = getOrgPg();
  const iso = typeof olderThan === 'string' ? olderThan : olderThan.toISOString();
  const rows = await sql<Array<{ id: number }>>`
    DELETE FROM harness_shared.push_delivery
    WHERE enqueued_at < ${iso}::timestamptz
    RETURNING id
  `;
  return rows.length;
}
