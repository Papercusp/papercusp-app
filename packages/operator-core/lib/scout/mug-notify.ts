/**
 * mug-notify.ts — the Scout→Mug coord pings of the feedback loop
 * (queen-scout-feedback-loop-2026-06-20, D-003 #1 + D-001 step 3; "Queen" was
 * the Mug role's retired name — the plan slug is historical).
 *
 * Two pings, both Scout→Mug, both DURABLE INBOX (no forced wake — review is
 * idle-gated per D-003 #2; placement always wins, the Mug sees these on its next
 * idle wake):
 *
 *   1. {@link notifyMugDraftRouted} — STARTS the loop: when Scout routes a NEW
 *      draft plan, ping the Mug so it reviews it (closes the "what prompts the
 *      Mug to review?" gap — D-003 #1).
 *
 *   2. {@link notifyMugRevised} — CONTINUES the loop: after a targeted revision
 *      (revise.ts), ping the Mug back per draft so it re-reviews (promote=ready
 *      or another round).
 *
 * WI-963 fix (2026-07-02): BOTH pings address the durable `@role:mug` SLOT
 * (in addition to a best-effort concrete resolved/threaded-back owner id) — never
 * the concrete owner ALONE. The Mug is fresh-per-wake (a brand-new coord owner
 * id every session — the retired mug-brief-launch.ts's `gatherInbox` / WI-682),
 * so a concrete-owner-only address is a session that has almost always already
 * ended by the time anyone reads it; `@role:mug` parks durably (slot-parked-store)
 * and `gatherInbox` already drains it into every future Mug wake regardless of
 * its current owner id. This is what actually closes the loop; the concrete
 * owner is just a best-effort immediate-delivery bonus.
 *
 * Pure over an injected {@link MugNotifyPorts} (the gym:judge / router-deps
 * pattern) so it unit-tests with fakes — no coord, no PG. register-scout-action.ts
 * binds the real send (`sendMessage` in the workspace ALS) + `resolveMugOwner`.
 * Best-effort by contract: a notify failure must NEVER fail the Scout cycle (the
 * caller wraps these so a dead coord layer can't break ideation/revision).
 */

import type { RevisionOutcome } from './revise';

/** A coord message the Scout sends the Mug (the runner maps this onto sendMessage). */
export interface MugNotifyMessage {
  to: string[];
  summary: string;
  body: string;
  planSlug: string;
}

export interface MugNotifyPorts {
  /** Resolve the hive's current Mug coord owner (newest session), or null if none. */
  resolveMugOwner: () => Promise<string | null>;
  /** Deliver one coord message Scout→Mug (sendMessage as `scout:<hive>`). */
  send: (msg: MugNotifyMessage) => Promise<void>;
  /**
   * WI-37625 — resolve the DURABLE co-address that used to be a hardcoded `@role:mug`.
   *
   * Both pings below address a concrete owner PLUS a durable slot, because the Mug is
   * fresh-per-wake and the concrete id is usually already dead (WI-963). That reasoning
   * still holds; what changed is that `@role:mug` is drained by exactly one consumer
   * (`pot/mug-brief-launch.ts`, at Mug spawn), so with the spawn gate closed (D-018) the
   * durable half addressed a slot with no reader — and for `notifyMugDraftRouted` with
   * no resolvable owner it was the ONLY address, so the notice vanished entirely.
   *
   * This is a PORT rather than a direct `deliverScoutNudge` call because this module is
   * deliberately I/O-free DI, and the ladder is workspace-scoped — the runner
   * (`register-scout-action.ts`) is where `workspaceId` actually lives.
   *
   * REQUIRED, not optional-with-a-default: a default would silently fall back to the dead
   * slot the moment a caller forgot to inject it, which is precisely the bug being fixed.
   * Returns the selectors to co-address (possibly empty).
   */
  resolveDurableCoAddress: () => Promise<string[]>;
}

export interface DraftRoutedNotice {
  slug: string;
  title: string;
  /** The Scout's coord owner (`scout:<hive>`) — the address the Mug sends feedback to. */
  scoutOwner: string;
}

export interface DraftRoutedResult {
  notified: boolean;
  /** The resolved concrete Mug owner id, when one was found — best-effort direct
   *  address only; delivery no longer depends on this (see WI-963: the durable
   *  `@role:mug` slot is always addressed too, so `null` here does NOT mean
   *  the Mug won't see it). */
  recipient: string | null;
}

/**
 * Ping the Mug that Scout routed a NEW draft for review (D-003 #1).
 *
 * WI-963 (closing the queen-scout-feedback-loop's broken last link): the Mug
 * is fresh-per-wake — a BRAND-NEW coord owner id every session (see the
 * retired mug-brief-launch.ts's `gatherInbox` comment / WI-682) — so addressing
 * ONLY the resolved `owner` almost always targets a session that has ALREADY
 * ENDED by the time it next wakes under a different owner id: the durable send
 * lands in an inbox no future Mug session ever reads again. Confirmed live:
 * draft `scout-rubric-pot-coordination-health-scorecard-2026-06-26` sat
 * unreviewed 3+ days despite this notify firing on route (WI-963 root cause).
 *
 * The fix: ALWAYS ALSO address the durable `@role:mug` slot selector.
 * `sendMessage` parks a `@role:...` addressee (slot-parked-store) and
 * `gatherInbox` already drains it into EVERY future Mug wake's brief
 * regardless of its current owner id — the exact reliable channel WI-682
 * proved for other senders. The resolved `owner`, when available, still rides
 * along as a best-effort direct address (in case that exact session is
 * somehow still live), but the durable slot is what actually closes the loop.
 * Never throws (resolve/send errors degrade to not-notified) so it can't
 * break the routing path that called it.
 */
export async function notifyMugDraftRouted(
  ports: MugNotifyPorts,
  notice: DraftRoutedNotice,
): Promise<DraftRoutedResult> {
  let owner: string | null = null;
  try {
    owner = await ports.resolveMugOwner();
  } catch {
    owner = null;
  }
  // WI-37625: the durable half is RESOLVED now, not a hardcoded `@role:mug`.
  let durable: string[] = [];
  try {
    durable = await ports.resolveDurableCoAddress();
  } catch {
    durable = [];
  }
  // With no concrete owner AND no resolvable durable address this notice would have no
  // recipient at all — the failure mode that made the old hardcoded slot dangerous. Fall
  // back to the owner rather than sending into the void.
  const to = [...(owner ? [owner] : []), ...durable];
  if (to.length === 0) to.push('human');
  try {
    await ports.send({
      to,
      planSlug: notice.slug,
      summary: `Scout routed a new draft plan for review: ${notice.slug}`,
      body:
        `${notice.title}\n\n` +
        `Scout routed this DRAFT plan (the scout↔reviewer feedback loop). YOU are the reviewer — the Mug/Queen tier is retired, so nothing else will drain it. Review it and either\n` +
        `• promote it (= ready, its items become placeable), or\n` +
        `• coord:send feedback to \`${notice.scoutOwner}\` (set plan_slug=${notice.slug}) to iterate, or\n` +
        `• deprecate it if the premise is wrong (the deprecate emits a learnings observation, so it still feeds Scout).`,
    });
    return { notified: true, recipient: owner };
  } catch {
    return { notified: false, recipient: owner };
  }
}

/**
 * Ping the Mug back after a revision tick (D-001 step 3) — one message per draft,
 * threaded back to the owner that sent the feedback. Skips items with no recipient
 * (a `fromOwnerId` is required to know WHICH draft's feedback this replies to; the
 * `@role:mug` slot is addressed alongside it — WI-963 — never instead of it, since
 * only `fromOwnerId` carries the per-draft thread). Never throws (per-item send
 * errors are swallowed) so it can't fail the revision cycle. Returns the count
 * actually delivered.
 */
export async function notifyMugRevised(
  ports: Pick<MugNotifyPorts, 'send' | 'resolveDurableCoAddress'>,
  outcomes: readonly RevisionOutcome[],
): Promise<{ delivered: number }> {
  let delivered = 0;
  for (const o of outcomes) {
    if (!o.fromOwnerId) continue;
    const { summary, body } = revisedMessage(o);
    try {
      // WI-963: by the time a revision cycle completes, the Mug session that
      // sent the original feedback (`o.fromOwnerId`) has almost always already
      // ended (fresh-per-wake) — also address the durable `@role:mug` slot so
      // the ping-back reliably reaches its next wake even when the concrete
      // owner is already dead.
      // WI-37625: durable half resolved, not a hardcoded `@role:mug`. Unlike the
      // draft-routed ping there is always a concrete `fromOwnerId` here (the loop
      // `continue`s without one), so an empty resolution is safe — it degrades to the
      // threaded owner alone rather than to nobody.
      let durable: string[] = [];
      try {
        durable = await ports.resolveDurableCoAddress();
      } catch {
        durable = [];
      }
      await ports.send({ to: [o.fromOwnerId, ...durable], planSlug: o.planSlug, summary, body });
      delivered += 1;
    } catch {
      /* best-effort per item */
    }
  }
  return { delivered };
}

/** The ping-back wording per revision outcome (status-aware). */
function revisedMessage(o: RevisionOutcome): { summary: string; body: string } {
  switch (o.status) {
    case 'revised':
      return {
        summary: `Scout revised draft ${o.planSlug} addressing your feedback — please re-review`,
        body:
          `I revised the draft to address your feedback. Re-review and either promote it (= ready), send another round of feedback (plan_slug=${o.planSlug}), or deprecate if the premise won't get there.`,
      };
    case 'unchanged':
      return {
        summary: `Scout: no change made to ${o.planSlug} (feedback didn't yield a revision)`,
        body: `Your feedback on ${o.planSlug} didn't produce a concrete revision (${o.note}). If it still needs work, send sharper guidance; otherwise consider promoting or deprecating.`,
      };
    case 'missing':
      return {
        summary: `Scout: draft ${o.planSlug} no longer exists`,
        body: `I couldn't revise ${o.planSlug} — it no longer exists (${o.note}).`,
      };
    case 'rejected':
      return {
        summary: `Scout: revision of ${o.planSlug} didn't produce a usable plan`,
        body: `My revision attempt on ${o.planSlug} didn't produce a usable plan (${o.note}), so the draft is unchanged. Send sharper guidance, or consider promoting / deprecating.`,
      };
    case 'error':
    default:
      return {
        summary: `Scout: couldn't revise ${o.planSlug} (${o.note})`,
        body: `I hit an error revising ${o.planSlug}: ${o.note}. Re-send your feedback if you still want a revision.`,
      };
  }
}
