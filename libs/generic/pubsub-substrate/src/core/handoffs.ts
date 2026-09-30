/**
 * handoffs.ts — handoff record shapes + the open↔acceptance grouping
 * fold. PURE.
 *
 * agent-coordination-architecture-v2 §6.4 (#8). A handoff is an
 * immutable event; an acceptance is a SIBLING event with
 * kind 'handoff_accepted' + related_msg_id pointing at the original.
 * `foldHandoffs` pairs each handoff with its acceptance (if any). The
 * per-event-file I/O lives behind the CoordEventLog seam.
 */

import {
  type CoordEnvelope,
  type CoordExecutableKind,
  compareByTsThenId,
  isExecutableCoordKind,
} from './envelope';

/**
 * The handoff-family kinds, declared ONCE. Both `HandoffRecord['kind']` and the
 * `isHandoffRecord` guard derive from this, so the type and the runtime check can
 * no longer drift apart — the D-014 failure mode ("a re-listed set is how the two
 * taxonomies drifted"), which this file previously reproduced by listing the four
 * literals twice.
 */
export const HANDOFF_KINDS = [
  'handoff',
  'handoff_accepted',
  'handoff_expired',
  'handoff_repinged',
] as const;

export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/** Compile-time proof that every handoff kind is an EXECUTABLE coord kind — so a
 *  handoff can drive a transition (P-009) and stays inside the closed set. If a
 *  handoff kind is ever dropped from COORD_EXECUTABLE_KINDS this stops compiling. */
// NB the tuple wrappers: a bare `HandoffKind extends CoordExecutableKind` is a
// DISTRIBUTIVE conditional over the union, so a single non-executable member would
// still yield `true | never` === `true` and compile. `[A] extends [B]` checks the
// union as a whole, which is the assertion actually intended.
type _HandoffKindsAreExecutable = [HandoffKind] extends [CoordExecutableKind] ? true : never;
const _handoffKindsAreExecutable: _HandoffKindsAreExecutable = true;
void _handoffKindsAreExecutable;

const HANDOFF_KIND_SET: ReadonlySet<string> = new Set(HANDOFF_KINDS);

export interface OpenHandoffInput {
  to: string[];
  /** Optional for ad-hoc handoffs; plan-scoped handoffs may provide it. */
  plan_slug?: string;
  summary: string;
  body?: string;
  next_action?: string;
  files_modified?: string[];
  commit?: string;
}

export interface HandoffRecord extends CoordEnvelope {
  kind: HandoffKind;
  next_action?: string;
  files_modified?: string[];
}

export interface HandoffWithAcceptance {
  record: HandoffRecord;
  accepted_by?: HandoffRecord;
  /**
   * The sibling 'handoff_expired' record, if a reconcile auto-expired this
   * handoff after it sat pending past the TTL (no acceptance). Acceptance
   * dominates expiry: a handoff that is both accepted and expired counts as
   * accepted, never open/expired.
   */
  expired_by?: HandoffRecord;
  /**
   * The sibling 'handoff_repinged' record, if the reconcile re-pinged the OFFERER
   * after the handoff sat un-acked past the re-ping window (~30m, < expire TTL).
   * coord-dispatch-reliability P-003. A re-ping is NOT a terminal status — a
   * re-pinged handoff is STILL `open` (the re-ping only nudges the offerer); this
   * marker exists so the re-ping selector can exclude already-re-pinged handoffs
   * (one re-ping per handoff, idempotent without a mutable column).
   */
  repinged_by?: HandoffRecord;
}

/**
 * True if an arbitrary envelope is a handoff, acceptance, expiry, or re-ping
 * record. Decided by the DECLARED `kind` alone (P-009) — never by body/summary
 * prose, so a `message` claiming "handoff accepted" is not one.
 */
export function isHandoffRecord(rec: CoordEnvelope): rec is HandoffRecord {
  return (
    typeof rec?.kind === 'string' &&
    HANDOFF_KIND_SET.has(rec.kind) &&
    isExecutableCoordKind(rec.kind)
  );
}

/**
 * Group handoff records: each `handoff` paired with its matching
 * `handoff_accepted`, `handoff_expired`, and/or `handoff_repinged` sibling (by
 * related_msg_id). A `handoff_expired` is written by the stale-handoff reconcile
 * when a handoff sat pending past the TTL (no acceptance); a `handoff_repinged`
 * is written when an open handoff sat un-acked past the ~30m re-ping window (it
 * nudges the offerer, but is NOT a terminal status). Optionally filter to:
 *   - open     — neither accepted NOR expired (still genuinely pending; a re-ping
 *                does NOT change this — a re-pinged-but-unaccepted handoff is open)
 *   - accepted — has an acceptance
 *   - expired  — auto-expired and not accepted
 * Acceptance DOMINATES expiry: an accepted handoff is never open/expired, even
 * if a reconcile also wrote an expiry for it (a benign race). Sorted ascending
 * by (ts, msg_id).
 */
export function foldHandoffs(
  records: HandoffRecord[],
  opts: { status?: 'open' | 'accepted' | 'expired' } = {},
): HandoffWithAcceptance[] {
  const handoffs = records.filter((r) => r.kind === 'handoff');
  const acceptsByTarget = new Map<string, HandoffRecord>();
  const expiresByTarget = new Map<string, HandoffRecord>();
  const repingsByTarget = new Map<string, HandoffRecord>();
  for (const r of records) {
    if (!r.related_msg_id) continue;
    if (r.kind === 'handoff_accepted') acceptsByTarget.set(r.related_msg_id, r);
    else if (r.kind === 'handoff_expired') expiresByTarget.set(r.related_msg_id, r);
    else if (r.kind === 'handoff_repinged') repingsByTarget.set(r.related_msg_id, r);
  }
  const out: HandoffWithAcceptance[] = handoffs
    .sort(compareByTsThenId)
    .map((h) => {
      const item: HandoffWithAcceptance = { record: h };
      const acc = acceptsByTarget.get(h.msg_id);
      if (acc) item.accepted_by = acc;
      const exp = expiresByTarget.get(h.msg_id);
      if (exp) item.expired_by = exp;
      const rep = repingsByTarget.get(h.msg_id);
      if (rep) item.repinged_by = rep;
      return item;
    });
  // A re-ping is intentionally NOT a status filter: it only marks that the offerer
  // was nudged — the handoff is still open/accepted/expired by the same rules.
  if (opts.status === 'open') return out.filter((x) => !x.accepted_by && !x.expired_by);
  if (opts.status === 'accepted') return out.filter((x) => !!x.accepted_by);
  if (opts.status === 'expired') return out.filter((x) => !!x.expired_by && !x.accepted_by);
  return out;
}
