/**
 * thread.ts — reconstruct a message thread from a flat envelope set by
 * walking the `related_msg_id` chain in both directions. PURE.
 *
 * (Extracted from coordination/messages.ts:readThread — the I/O of
 * loading every outbox lives behind the CoordEventLog seam; this is the
 * graph fold over what was loaded.)
 */

import { type CoordEnvelope, compareByTsThenId } from './envelope';

/**
 * Collect every envelope connected to `rootMsgId` via the
 * `related_msg_id` chain (in either direction), sorted ascending by
 * (ts, msg_id).
 */
export function foldThread(all: CoordEnvelope[], rootMsgId: string): CoordEnvelope[] {
  const inThread = new Set<string>([rootMsgId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of all) {
      const inSelf = inThread.has(l.msg_id);
      const rel = l.related_msg_id;
      const inRel = rel ? inThread.has(rel) : false;
      if (inSelf && rel && !inRel) {
        inThread.add(rel);
        changed = true;
      }
      if (!inSelf && rel && inRel) {
        inThread.add(l.msg_id);
        changed = true;
      }
    }
  }
  return all.filter((l) => inThread.has(l.msg_id)).sort(compareByTsThenId);
}
