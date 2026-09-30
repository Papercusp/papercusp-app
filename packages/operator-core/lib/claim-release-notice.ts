/**
 * claim-release-notice.ts — WI-39736: make an INVOLUNTARY work-item claim release
 * impossible to perform SILENTLY.
 *
 * ## The defect this closes
 *
 * A work-item claim held by a LIVE, actively-working agent was being zeroed
 * (`taken_by`/`taken_at` → NULL) by a background sweep. The holder was never told,
 * so it kept working on an item it no longer held while the fleet read the lane as
 * unstaffed — `scheduler:get_next` then handed the same item to a second agent.
 * Observed 2026-08-17: `coord-invariant-monitor` (cron `0 37 * * * *`) fired at
 * 17:37:05.079Z and again at 18:37:39.993Z, and the second fire cleared WI-39264 and
 * WI-39266 in ONE bulk statement — both victims carry the IDENTICAL `updated_ts` to
 * the millisecond, which is the signature of a single `UPDATE` with one `nowMs`.
 *
 * The PREDICATE half of that bug (a sweep that selected working agents
 * preferentially, because `updated_ts` only bumps on a row WRITE) is fixed at each
 * sweep's own `WHERE` clause — see `fleet-monitors.ts` / `work-items-stale-claims.ts`.
 *
 * This module fixes the OTHER half, which no predicate can: **when a release is
 * genuinely correct, it must still be LOUD.** A predicate can only ever be as good as
 * its liveness signal, and several releases here are legitimately performed against a
 * holder that is actually alive — most sharply the never-seen-here remote-holder
 * fallback, which frees a claim after a long horizon precisely BECAUSE this node
 * cannot observe the holder. That agent is alive, on another node, and mid-flight. It
 * must be told. Attribution columns (`last_released_by`) record the actor for a
 * READER who later goes looking; they do not reach the one party who is about to
 * waste hours — the holder.
 *
 * ## The invariant
 *
 * Every code path that clears a claim its holder did not voluntarily give up calls
 * {@link recordInvoluntaryClaimReleases}. It does two things per released claim:
 *
 *   1. an append-only `harness_shared.audit_log` row naming actor + reason + holder,
 *      so a silent divergence is searchable after the fact; and
 *   2. a coord message to the FORMER HOLDER, so the divergence is corrected while it
 *      still matters.
 *
 * Both legs are BEST-EFFORT by construction: a reaper must never fail, or roll back a
 * correct release, because a notification could not be delivered. The function
 * therefore never throws, and returns per-leg counts so a caller (or a test) can
 * assert the notice actually happened rather than assuming it did.
 *
 * ## Why the coord seam is imported lazily
 *
 * `agent-tools/coordination/messages` transitively reaches the presence layer. A
 * STATIC import from a low-level release path into that module is a known cycle
 * hazard in this package, so the seam is resolved with a dynamic `await import()`
 * inside the notify leg — the same defensive shape used elsewhere for this class.
 */

import type postgres from 'postgres';

/** One claim that was taken away from its holder without the holder releasing it. */
export interface InvoluntaryClaimRelease {
  /** The work-item whose claim was cleared (`feature_id`). */
  workItemId: string;
  /** The ownerId that HELD the claim at the moment it was cleared. */
  takenBy: string;
  /** Optional per-row detail, when rows in one batch were freed for different reasons. */
  reason?: string;
}

export interface RecordInvoluntaryClaimReleasesOpts {
  workspaceId: string;
  harness: string;
  /**
   * The sweep that performed the release, as a stable marker — e.g.
   * `reaper:orphan-sweep`, `reaper:dead`. Conventionally the SAME value written to
   * `work_items.last_released_by`, so the audit row and the row attribution agree.
   * A `reaper:`-prefixed marker can never equal a real ownerId.
   */
  actor: string;
  /** Why the batch was released, in words a woken holder can act on. */
  reason: string;
  /** The claims actually cleared. An empty array is a no-op (no rows, no messages). */
  released: readonly InvoluntaryClaimRelease[];
  /** Set false to record the audit trail without waking anybody (tests, backfills). */
  notify?: boolean;
}

export interface InvoluntaryClaimReleaseResult {
  /** audit_log rows successfully written. */
  audited: number;
  /** Distinct former holders successfully notified. */
  notified: number;
  /** Non-fatal failures, for logging/asserting. Never thrown. */
  failures: string[];
}

/** The audit action string. Stable — detectors and `audit:list` filter on it. */
export const INVOLUNTARY_RELEASE_ACTION = 'work_item:claim:released:involuntary';

/**
 * Record + announce a batch of involuntary claim releases.
 *
 * Never throws. A missing `audit_log` table (a hand-rolled test fixture that creates a
 * DDL subset) is expected and non-fatal, exactly as in `work-items.ts`'s sibling audit
 * writes.
 */
export async function recordInvoluntaryClaimReleases(
  sql: postgres.Sql,
  opts: RecordInvoluntaryClaimReleasesOpts,
): Promise<InvoluntaryClaimReleaseResult> {
  const result: InvoluntaryClaimReleaseResult = { audited: 0, notified: 0, failures: [] };
  // Defensive: a sweep that freed nothing must not write rows or wake anyone.
  const released = (opts.released ?? []).filter((r) => r && r.workItemId && r.takenBy);
  if (released.length === 0) return result;

  // ── Leg 1: the append-only audit trail ────────────────────────────────────
  for (const row of released) {
    try {
      await sql.unsafe(
        `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          `claim-release-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          Date.now(),
          opts.actor,
          INVOLUNTARY_RELEASE_ACTION,
          row.workItemId,
          JSON.stringify({
            takenBy: row.takenBy,
            actor: opts.actor,
            reason: row.reason ?? opts.reason,
            harness: opts.harness,
            involuntary: true,
          }),
          opts.workspaceId,
        ],
      );
      result.audited += 1;
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      // No audit_log table in this fixture — expected, non-fatal (mirrors work-items.ts).
      if (code === '42P01') return result;
      const msg = (err as Error)?.message ?? String(err);
      result.failures.push(`audit ${row.workItemId}: ${msg}`);
      console.warn(`[claim-release-notice] audit write failed for ${row.workItemId}: ${msg}`);
    }
  }

  if (opts.notify === false) return result;

  // ── Leg 2: tell the holder, so it stops working on something it no longer holds ──
  // Grouped per holder: one agent that lost five claims in one sweep gets ONE message
  // naming all five, not five wakes.
  const byHolder = new Map<string, InvoluntaryClaimRelease[]>();
  for (const row of released) {
    const list = byHolder.get(row.takenBy);
    if (list) list.push(row);
    else byHolder.set(row.takenBy, [row]);
  }

  let sendMessageFn: typeof import('./agent-tools/coordination/messages').sendMessage;
  let identity: import('./agent-tools/coordination/identity').AgentIdentity;
  try {
    ({ sendMessage: sendMessageFn } = await import('./agent-tools/coordination/messages'));
    identity = {
      ownerId: opts.actor,
      ownerLabel: `system · ${opts.actor}`,
      source: 'principal',
      workspaceId: opts.workspaceId,
      userId: null,
    };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    result.failures.push(`notify seam unavailable: ${msg}`);
    return result;
  }

  for (const [holder, rows] of byHolder) {
    const ids = rows.map((r) => r.workItemId);
    const idList = ids.join(', ');
    // D-011 (agent-state-plane-verification-2026-07-27): `CoordEnvelope.body` is a STRING on the
    // wire — a `Section[]` body is not representable there at all, and
    // `message-sender-completeness.test.ts` pins that as a refutation so widening the type reds
    // instead of silently shipping an unreadable envelope. Structure rides BESIDE the text as
    // `sections`, which `tools/send.ts` derives via `toSections` + `sectionsToText`. That
    // conversion belongs to the TOOL layer; this module writes the RAW `sendMessage` seam
    // (deliberately, so a reaper never depends on the tool stack), so it does the flattening
    // itself: `body` carries the text, `extra.sections` carries the `forYouBecause` routing.
    // With one section, `sectionsToText` is the section's own text — no projection to drift.
    const text =
      `${opts.actor} released ${ids.length === 1 ? 'a work-item claim' : `${ids.length} work-item claims`} you were holding: ${idList}.\n\n` +
      `Reason: ${opts.reason}\n\n` +
      'This was an INVOLUNTARY release — you did not give it up. If you are still ' +
      'working on it, RE-CLAIM IT NOW (work_items:claim): until you do, the item ' +
      'reads as unstaffed and the scheduler can hand it to another agent while you ' +
      'are still mid-flight on it. If you have genuinely stopped, no action is needed.';
    try {
      await sendMessageFn(identity, {
        to: [holder],
        summary:
          `YOUR CLAIM WAS RELEASED by ${opts.actor}: ${idList}` +
          ` — re-claim if you are still working ${ids.length === 1 ? 'it' : 'them'}.`,
        body: text,
        // `expects` is an ENVELOPE-ONLY field (`ENVELOPE_ONLY_FIELDS`), not a `SendOptions` one —
        // on the raw seam it rides in `extra`, the same way the coord tests write it. `expectsReply`
        // is DERIVED from `expects` (D-048: "anything but 'none'") inside tools/send.ts, so this
        // seam — which bypasses that layer — must set it explicitly or the message would read as
        // fire-and-forget and never surface as unanswered-directed to the holder we need to reach.
        expectsReply: true,
        extra: {
          expects: 'action',
          sections: [{ text, forYouBecause: { relation: 'owns', ref: ids[0] } }],
        },
      });
      result.notified += 1;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      result.failures.push(`notify ${holder}: ${msg}`);
      console.warn(`[claim-release-notice] notify ${holder} failed: ${msg}`);
    }
  }

  return result;
}
