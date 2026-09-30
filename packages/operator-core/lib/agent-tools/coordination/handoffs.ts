/**
 * handoffs.ts — operator host adapter for agent → agent work handoffs.
 *
 * Record shapes + the open↔acceptance grouping fold live in
 * @papercusp/coordination/core; the per-event-file I/O lives behind the
 * CoordEventLog seam (coordLog). Original function surface preserved.
 *
 * agent-coordination-architecture-v2 §6.4 (#8). A handoff is an
 * immutable event; an acceptance is a sibling event with
 * kind 'handoff_accepted' + related_msg_id. No in-place mutation.
 */

import {
  newMsgId,
  foldHandoffs,
  isHandoffRecord,
  type HandoffRecord,
  type HandoffWithAcceptance,
  type OpenHandoffInput,
} from '@papercusp/coordination/core';
import { coordLog } from './log';
import type { AgentIdentity } from './identity';

export type { OpenHandoffInput, HandoffRecord, HandoffWithAcceptance };

/** Open a new handoff — writes the per-event record. */
export async function openHandoff(
  identity: AgentIdentity,
  // WI-1375: `harness_slug` FEDERATES the handoff. A handoff is peer-agent-directed
  // (`to` = peer ownerIds), so a cross-machine handoff must reach the recipient's
  // machine — PgCoordLog projects env.harness_slug to the coord_event_log.harness_slug
  // column the capture trigger federates on (distributed-coordination-shared-harness
  // Track A). Without it the row lands harness_slug NULL, the capture gate short-circuits,
  // and the handoff stays LOCAL (never reaches a peer-machine recipient). Set by the
  // coord:handoff tool from ctx.harnessSlug (a concrete harness, never '*'/operator-scope).
  // Extended inline here (not on the pure OpenHandoffInput) to keep the generic lib
  // untouched, mirroring openEscalation's `& { meta?: ... }`.
  input: OpenHandoffInput & { harness_slug?: string },
): Promise<HandoffRecord> {
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: input.to,
    kind: 'handoff',
    plan_slug: input.plan_slug,
    summary: input.summary,
  };
  if (input.body !== undefined) env.body = input.body;
  if (input.next_action !== undefined) env.next_action = input.next_action;
  if (input.files_modified !== undefined) env.files_modified = input.files_modified;
  if (input.commit !== undefined) env.commit = input.commit;
  if (input.harness_slug !== undefined) env.harness_slug = input.harness_slug;
  await coordLog.putEvent('handoffs', env.msg_id, env);
  return env;
}

/**
 * Accept a handoff by msg_id — writes a sibling 'handoff_accepted'
 * record. Returns the new acceptance, or null when the target is absent.
 */
export async function acceptHandoff(
  identity: AgentIdentity,
  targetMsgId: string,
  note?: string,
): Promise<HandoffRecord | null> {
  const target = await getHandoff(targetMsgId);
  if (!target) return null;
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: identity.ownerId,
    to: [target.from],
    kind: 'handoff_accepted',
    related_msg_id: targetMsgId,
    plan_slug: target.plan_slug,
    summary: note ?? `accepted handoff from ${target.from}`,
  };
  await coordLog.putEvent('handoffs', env.msg_id, env);
  return env;
}

/**
 * Auto-expire a still-pending handoff by msg_id — writes a sibling
 * 'handoff_expired' record (the SAME immutable pattern as acceptHandoff; the
 * original handoff is never mutated). Used by the stale-handoff reconcile when a
 * handoff has sat pending past the TTL with no acceptance. Returns the new expiry
 * record, or null when the target handoff is absent. `by` is the system reconcile
 * owner; `to` notifies the handoff's opener that their offer lapsed.
 */
export async function expireHandoff(
  targetMsgId: string,
  opts: { by: string; note?: string },
): Promise<HandoffRecord | null> {
  const target = await getHandoff(targetMsgId);
  if (!target) return null;
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: opts.by,
    to: [target.from],
    kind: 'handoff_expired',
    related_msg_id: targetMsgId,
    plan_slug: target.plan_slug,
    summary: opts.note ?? 'auto-expired: handoff pending past the TTL with no acceptance',
  };
  await coordLog.putEvent('handoffs', env.msg_id, env);
  return env;
}

/**
 * Re-ping the OFFERER of a still-open, un-acked handoff — writes a sibling
 * 'handoff_repinged' record (the SAME immutable pattern as acceptHandoff/
 * expireHandoff; the original handoff is never mutated). Used by the reconcile
 * sweep (coord-dispatch-reliability P-003) when an open handoff has sat un-acked
 * past the ~30m re-ping window (but < the 12h expire TTL). The sibling record is
 * itself the idempotency marker — once written, the fold surfaces `repinged_by`
 * and the re-ping selector excludes this handoff, so the offerer is nudged EXACTLY
 * once. `by` is the system reconcile owner; `to` addresses the handoff's offerer
 * (`target.from`), so the re-ping lands in the offerer's coord inbox. Returns the
 * new re-ping record, or null when the target handoff is absent.
 */
export async function repingHandoff(
  targetMsgId: string,
  opts: { by: string; note?: string },
): Promise<HandoffRecord | null> {
  const target = await getHandoff(targetMsgId);
  if (!target) return null;
  const env: HandoffRecord = {
    ts: new Date().toISOString(),
    msg_id: newMsgId(),
    from: opts.by,
    to: [target.from],
    kind: 'handoff_repinged',
    related_msg_id: targetMsgId,
    plan_slug: target.plan_slug,
    summary:
      opts.note ?? 'auto re-ping: handoff still un-acked after the re-ping window — nudging the offerer',
  };
  await coordLog.putEvent('handoffs', env.msg_id, env);
  return env;
}

/** Read one handoff record by msg_id. */
export async function getHandoff(msgId: string): Promise<HandoffRecord | null> {
  const rec = await coordLog.getEvent('handoffs', msgId);
  return rec && isHandoffRecord(rec) ? rec : null;
}

/**
 * List handoffs (with acceptance/expiry status), optionally filtered to
 * open / accepted / expired.
 *
 * UNBOUNDED — reads the ENTIRE handoffs surface (`coordLog.readEvents`, no
 * LIMIT) every call. Fine for the surface's own small volume, but a caller
 * that just wants a recent, bounded page (e.g. a history/feed view) should
 * use `listHandoffsPaginated` instead — see EI-18138089781782660.
 */
export async function listHandoffs(
  opts: { status?: 'open' | 'accepted' | 'expired' } = {},
): Promise<HandoffWithAcceptance[]> {
  const records = (await coordLog.readEvents('handoffs')).filter(isHandoffRecord);
  return foldHandoffs(records, opts);
}

/** WI-4181-style slack subtracted from the oldest open's ts when deciding
 *  whether the accept/expire window covers the opens window — absorbs writer
 *  clock skew between a handoff and its acceptance/expiry. Mirrors
 *  escalations.ts's RESOLVE_COVERAGE_SLACK_MS for the same failure class
 *  (a zombie "open" handoff re-appearing once its acceptance ages out of a
 *  count-bounded window). */
const HANDOFF_COVERAGE_SLACK_MS = 60_000;
/** Hard cap on EXTRA accept/expire pages fetched for coverage (beyond the
 *  first window) — bounds the read to (1 + cap) × maxRecords rows even on a
 *  pathologically accept-heavy surface. */
const MAX_HANDOFF_COVERAGE_PAGES = 8;

/**
 * List handoffs with pagination — bounds the READ at the storage layer
 * instead of loading the entire handoffs surface into memory (EI-18138089781782660,
 * mirroring listEscalationsPaginated's EI-1548/EI-6624/WI-4181 pattern).
 *
 * Reads `handoff` (opens) and `handoff_accepted`/`handoff_expired`/
 * `handoff_repinged` (status events) on SEPARATE bounded windows, then pages
 * the status-events window deeper (up to MAX_HANDOFF_COVERAGE_PAGES rounds)
 * until it covers the oldest open in this page — otherwise a handoff whose
 * acceptance/expiry got evicted from a shallower window would re-appear as a
 * zombie "open" (the exact bug WI-4181 fixed for escalations).
 */
export async function listHandoffsPaginated(
  opts: { status?: 'open' | 'accepted' | 'expired'; maxRecords?: number } = {},
): Promise<{ handoffs: HandoffWithAcceptance[]; truncated: boolean; total: number }> {
  const maxRecords = Math.max(1, Math.min(opts.maxRecords ?? 50, 500));
  const STATUS_KINDS = ['handoff_accepted', 'handoff_expired', 'handoff_repinged'] as const;

  const [opensRaw, firstStatusPage] = await Promise.all([
    coordLog.readEventsBounded('handoffs', { limit: maxRecords, kinds: ['handoff'] }),
    coordLog.readEventsBoundedCursor('handoffs', { limit: maxRecords, kinds: [...STATUS_KINDS] }),
  ]);
  const opens = (opensRaw as HandoffRecord[]).filter(isHandoffRecord);

  let statusRows = firstStatusPage.rows;
  let statusExhausted = firstStatusPage.exhausted;
  const oldestOpenMs = opens.length
    ? Date.parse(opens.reduce((min, o) => (o.ts < min ? o.ts : min), opens[0].ts))
    : null;
  const coverageTs =
    oldestOpenMs !== null && Number.isFinite(oldestOpenMs)
      ? new Date(oldestOpenMs - HANDOFF_COVERAGE_SLACK_MS).toISOString()
      : null;
  let extraPages = 0;
  while (
    coverageTs !== null &&
    !statusExhausted &&
    extraPages < MAX_HANDOFF_COVERAGE_PAGES &&
    statusRows.length > 0 &&
    statusRows[statusRows.length - 1].envelope.ts > coverageTs
  ) {
    const page = await coordLog.readEventsBoundedCursor('handoffs', {
      limit: maxRecords,
      kinds: [...STATUS_KINDS],
      beforeId: statusRows[statusRows.length - 1].id,
    });
    statusRows = statusRows.concat(page.rows);
    statusExhausted = page.exhausted;
    extraPages += 1;
    if (page.rows.length === 0) break;
  }
  const statusEvents = statusRows.map((r) => r.envelope).filter(isHandoffRecord);

  const handoffs = foldHandoffs([...opens, ...statusEvents], opts);
  const truncated = opens.length >= maxRecords || statusRows.length >= maxRecords;
  return { handoffs, truncated, total: handoffs.length };
}
