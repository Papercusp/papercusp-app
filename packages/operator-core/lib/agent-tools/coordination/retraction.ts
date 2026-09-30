/**
 * retraction.ts — coord:retract v1's PURE core (coord-authority-hardening-
 * 2026-07-11 P-011 / WI-4176, H5c).
 *
 * A sent coord message cannot be unsent — coord_event_log is append-only (no
 * update-in-place, same constraint reply-deadline-sweep.ts documents) — but it
 * CAN be withdrawn: a RETRACTION NOTICE row addressed to the ORIGINALLY-
 * DELIVERED audience carries the retracted msg_id on the RETRACTS_FIELD, and
 * every read surface suppresses a message some in-window row retracts. The
 * notice does triple duty (house sibling-row pattern — reply-deadline /
 * delivery-ladder / allhive sweeps): it IS the durable "marked retracted"
 * state, the visible "disregard that" delivery to the audience, and the
 * idempotency marker a second retract call detects.
 *
 * This module is the IMPORT-LIGHT half (the P-001/P-008 house split): the
 * field constant, the defensive reader, the suppression fold every renderer
 * applies, and the pure invoker guard. The IO (message lookup, presence/
 * leader reads, the notice send) lives in tools/retract.ts.
 *
 * WHY SUPPRESSION IS IN-WINDOW: a bounded read that contains the original
 * also contains the (strictly newer) notice in every practical shape — the
 * notice is addressed to the SAME audience, inbox reads are since→now, and
 * feed/catch-up reads are newest-first — so collecting markers from the raw
 * window is correct without a second query on the hot paths. A deep
 * `before_ts` history page older than the notice can still show the original
 * (documented v1 caveat; the forensic coord:thread deliberately shows both).
 *
 * NO who-acted tracking in v1 (per the plan item): the notice is sent from a
 * system principal and records no invoker — the guard gates the ACT, the
 * ledger stays lean.
 */

import type { CoordEnvelope } from '@papercusp/coordination/core';
import type { AgentPaneKind } from '@papercusp/agent-mcp';

/** Envelope field on a retraction notice naming the retracted msg_id. Not
 *  settable through any agent-facing tool arg (coord:send exposes no `extra`),
 *  so a marker can only be written by the guarded coord:retract path or
 *  in-process code. */
export const RETRACTS_FIELD = 'retracts';

/** The retracted msg_id a notice row carries, or null. Defensive: any
 *  non-string / blank value reads as "not a retraction notice". */
export function readRetractionTarget(env: unknown): string | null {
  if (!env || typeof env !== 'object') return null;
  const v = (env as Record<string, unknown>)[RETRACTS_FIELD];
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Collect every msg_id retracted by some row in `lines`. Pass the RAW
 *  (pre-filter) window so a marker a later filter would drop still counts. */
export function collectRetractedIds(lines: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    const target = readRetractionTarget(l);
    if (target) out.add(target);
  }
  return out;
}

/**
 * Drop every envelope whose msg_id is retracted. The notice itself always
 * survives (it never shares the retracted msg_id) — the audience keeps the
 * "disregard that" line while the withdrawn content disappears. `retracted`
 * defaults to the ids collected from `entries` themselves; pass a set
 * collected from a WIDER raw window when one is available.
 */
export function suppressRetracted<T extends Pick<CoordEnvelope, 'msg_id'>>(
  entries: readonly T[],
  retracted: ReadonlySet<string> = collectRetractedIds(entries),
): T[] {
  if (retracted.size === 0) return [...entries];
  return entries.filter((e) => !retracted.has(e.msg_id));
}

/** How a permitted coord:retract invoker qualified. */
export type RetractInvoker = 'sender' | 'leader' | 'queen' | 'owner';

/**
 * The v1 invoker guard: original sender / THEIR fleet leader / queen / owner.
 * Pure — the caller resolves the IO inputs (the original's `from`, the
 * SENDER's fleet leaders from the registry, the CALLER's pane kind from
 * presence). Precedence mirrors classifyFleetControlInvoker (P-009):
 * identity match first, then the specific (leader-of-the-sender) authority,
 * then the pane-derived hive authorities. Everything else → null (refuse).
 */
export function classifyRetractInvoker(opts: {
  callerOwnerId: string;
  senderOwnerId: string;
  /** Current leaders of the SENDER's fleet (registry-resolved; [] when the
   *  sender is fleetless or its fleet/leader is unresolvable). */
  senderFleetLeaders: readonly string[];
  /** The CALLER's pane kind (classifyAgentPane over its presence role). */
  paneKind: AgentPaneKind | null;
}): RetractInvoker | null {
  const { callerOwnerId, senderOwnerId, senderFleetLeaders, paneKind } = opts;
  if (callerOwnerId && callerOwnerId === senderOwnerId) return 'sender';
  if (senderFleetLeaders.includes(callerOwnerId)) return 'leader';
  if (paneKind === 'mug' || paneKind === 'kettle') return 'queen';
  // The su pane is the owner's proxy (the established su-as-owner rule,
  // P-009 / fleet control-core).
  if (paneKind === 'su') return 'owner';
  return null;
}
