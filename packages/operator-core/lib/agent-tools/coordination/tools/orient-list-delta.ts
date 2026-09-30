/**
 * orient-list-delta.ts — the PURE "unchanged since last read" half of
 * coord:orient's FULL-mode delta folds (fleet-deltas-leader-primitives-2026-07-10
 * P-005; extends P-004's server-side read-cursor infra to full mode).
 *
 * P-004 proved the pattern for the fleet ROSTER fold in monitor mode: fetch the
 * full current state (unavoidable — it's the source of truth), fingerprint it,
 * ack-and-advance against the caller's server-side cursor, and if the fingerprint
 * matches what was already delivered, send a compact "unchanged" marker instead
 * of re-shipping the payload. D-003's audit (tool_invocations, 7d) found the SAME
 * ~96-100% exact-repeat shape on orient's other append-only-log folds
 * (coord:plan-events, coord:catch-up fleet history) — a caller that orients every
 * wake re-receives events it already saw almost every single time.
 *
 * This module generalizes that half of the pattern for ORDERED ID-KEYED lists
 * (plan-events, fleet catch-up rows): the fingerprint is just the ordered list of
 * row ids last delivered. Deliberately NOT a general keyed-collection add/update/
 * remove diff (like fleet-monitor-delta.ts's member diff) — these are read-only
 * informational streams where "nothing new" is a safe, fully-actionable answer,
 * unlike orient's `claimable`/`facts` folds (self-select / binding-context
 * surfaces where omitting "unchanged" content risks an agent acting on stale
 * knowledge — deliberately left OUT of this rollout, see plan D-007).
 *
 * IO-free / pure on purpose — orient.ts injects the cursor ack; tests drive
 * these functions directly.
 */

import type { CursorState } from '../read-cursors';

/** Compact fingerprint of an ordered id-keyed batch — just the ids, in the
 *  order delivered (order-sensitive: a reorder without membership change is
 *  treated as a change, which is the conservative/safe direction). */
export function fingerprintIdList(ids: string[]): CursorState {
  return { ids };
}

/** True iff `committed` (the previously-acked fingerprint) is the SAME ordered
 *  id list as `ids` (this call's current batch) — i.e. nothing new to deliver.
 *  Defensive: any unrecognizable shape returns false (fail-open — a delta must
 *  never make orientation worse than no delta, so "unsure" ⇒ deliver in full). */
export function idListUnchanged(committed: CursorState | null, ids: string[]): boolean {
  const prev = (committed as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(prev) || prev.length !== ids.length) return false;
  for (let i = 0; i < ids.length; i++) {
    if (prev[i] !== ids[i]) return false;
  }
  return true;
}

/** Derive a stable row id for a plan-event / coord-feed-shaped envelope: prefer
 *  its `msg_id` (unique per envelope); fall back to a composite of fields that
 *  are present on every row shape this module sees, so a shape without msg_id
 *  still gets a usable (if coarser) identity rather than losing dedup entirely. */
export function rowKey(row: unknown): string {
  const r = row as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') return JSON.stringify(row);
  if (typeof r.msg_id === 'string' && r.msg_id) return r.msg_id;
  const ts = typeof r.ts === 'string' ? r.ts : '';
  const detail = typeof r.detail === 'string' ? r.detail : typeof r.summary === 'string' ? r.summary : '';
  const plan = typeof r.plan_slug === 'string' ? r.plan_slug : '';
  return `${ts}|${plan}|${detail}`;
}
