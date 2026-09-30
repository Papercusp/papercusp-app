/**
 * operator-sentinel-handoff-watch — the P-016 outcome-feedback leg of the Sentinel
 * handoff (sentinel-herald Phase 4).
 *
 * After the Sentinel files a handoff work_item (operator-sentinel-handoff.ts), it
 * subscribes the operator-owner to that item's thread so the Queen's placement +
 * the work landing fan back (subscribe→inject). This module is the LANDING hook:
 * when a tracked handoff item SETTLES (done/resolved/closed/passed/dropped), it
 * reports the outcome back through the existing hindsight "[While you were away]"
 * channel (notifyOperatorHindsight) — the same push the delegate-complete path
 * uses, so the Sentinel's voice surface drains it on the next connect.
 *
 * Reuse, don't rebuild (the plan's directive): the LANDING signal is the
 * work_item lifecycle (setWorkItemState fires the settled-events emit; we ride the
 * same fire-and-forget seam), and the DELIVERY is operator-hindsight. This module
 * only owns the "is this a tracked handoff?" gate + the headline shaping.
 *
 * The gate is the durable `user-requested` LABEL the handoff stamps on the item
 * (operator-sentinel-handoff.USER_REQUESTED_LABEL) — no new table, no migration: a
 * settling item that carries it is a Sentinel-filed user request, so its landing is
 * exactly the outcome the user is owed a "[While you were away]" line about.
 */

import { notifyOperatorHindsight } from './operator-hindsight';
import { USER_REQUESTED_LABEL } from './operator-sentinel-handoff';

/** The hindsight sub-kind for a Sentinel handoff landing. The voice surface renders
 *  it the same as a delegate-complete line; the kind lets telemetry tell them apart. */
export const HANDOFF_LANDED_KIND = 'handoff-landed';

/**
 * Report a settled Sentinel-handoff work_item back to the operator via hindsight,
 * but ONLY when the item is actually a Sentinel handoff — i.e. it carries the
 * `user-requested` topic the handoff stamps (operator-sentinel-handoff). The
 * caller may pass the topics directly (cheap, when it already has them) or omit
 * them, in which case they are read lazily via getTopics. Fire-and-forget by
 * contract (the caller is the setWorkItemState settled-events seam): never throws,
 * swallows its own errors.
 *
 * @param item     the settled work_item (id/title/state, optional harness)
 * @param getTopics lazy topic reader — only invoked when `item.topics` is absent.
 *                  Injectable so the watch unit-tests without PG.
 */
export async function reportHandoffLandingIfTracked(
  item: {
    id: string;
    title: string;
    state: string;
    harness?: string | null;
    topics?: readonly string[];
  },
  getTopics?: (id: string, harness: string | null) => Promise<readonly string[]>,
): Promise<void> {
  try {
    let topics = item.topics;
    if (topics == null) {
      if (!getTopics) return; // no way to tell — skip rather than guess
      topics = await getTopics(item.id, item.harness ?? null);
    }
    if (!topics.includes(USER_REQUESTED_LABEL)) return;
    const verb =
      item.state === 'dropped' || item.state === 'deprecated' ? 'was dropped' : 'landed';
    const headline = `Your request "${item.title}" ${verb} (${item.id}).`;
    await notifyOperatorHindsight(headline, HANDOFF_LANDED_KIND);
  } catch {
    /* fire-and-forget: a hindsight-push failure must never break the lifecycle write */
  }
}
