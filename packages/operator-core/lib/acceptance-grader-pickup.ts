/**
 * Pickup confirmation for a recruited acceptance grader — P-003 R-3 of plan
 * `generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20`.
 *
 * WHAT THIS IS FOR
 * A grading cascade WAKES its head grader. The wake fan returns a DELIVERY
 * receipt — `{ woke: n }` — which `acceptance-grader.ts` records on the lifecycle
 * as `notified`. Delivery is not pickup: `wakeRecipients` returns once the wake is
 * ENQUEUED on the await-event pump, before the target has been scheduled a turn,
 * let alone taken one. R-3 requires that pickup be established "from that grader's
 * own later activity rather than from the queued delivery count alone" — this
 * module is that later observation.
 *
 * WHY A SEPARATE SEAM RATHER THAN A RICHER WAKE RESULT (plan D-011)
 * The obvious implementation — widen `inbox-wake.ts`'s `pickupConfirmed` from the
 * literal `false` to `boolean` and set it when delivery succeeds — is FORBIDDEN,
 * and would ship a regression. That literal type IS a guard
 * (EI-22733985246154315): the field was `boolean` once, which let `checkpoint-run`
 * gate a gate-ownership stand-down on `pickupConfirmed === true` — a branch
 * production could never enter, kept green by a unit test that MOCKED the value
 * `true`. Narrowing it to `false` turned every such comparison into a compile
 * error instead of silently-dead code. A truthful pickup confirmation is
 * unavailable AT THAT SEAM BY CONSTRUCTION, not merely unimplemented. So pickup is
 * confirmed HERE, afterwards, by re-reading the grader — exactly as that file's
 * own header prescribes ("a fresh lastActiveAt that post-dates the wake").
 *
 * THE STRUCTURAL GUARANTEE
 * `GraderActivityReading` carries NO delivery-count field. The classifier cannot
 * consult `woke` because `woke` is not in its input type — so R-3's falsifier
 * ("the provider reports a grader as woken on the strength of a queued delivery
 * count while that grader takes no turn afterwards") is not merely false here, it
 * is UNTYPEABLE. A comment saying "do not use the delivery count" is advice; an
 * absent field is a compile error.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  deriveLastActive,
  fetchPresenceTier1,
  type LastActiveSource,
} from './agent-tools/coordination/presence-tier1';

/**
 * Three-valued on purpose (plan D-011 ruling 4).
 *
 *  - `confirmed`  — the grader produced activity of its own STRICTLY AFTER the
 *                   wake instant. Positive evidence of pickup.
 *  - `not-yet`    — no such activity is visible YET. This is the ABSENCE of
 *                   evidence, NOT evidence the grader is dead — see the failure
 *                   direction below.
 *  - `unreadable` — the grader's activity could not be read at all. A failed
 *                   MEASUREMENT, never a verdict about the grader.
 *
 * Collapsing `unreadable` into a boolean false would recreate the false-negative
 * that `recipient_absent` already causes elsewhere: a live-but-mid-turn grader
 * read as absent, triggering a needless re-recruit.
 */
export type GraderPickupVerdict = 'confirmed' | 'not-yet' | 'unreadable';

/**
 * The ONLY evidence a pickup verdict may be computed from: the grader's own
 * activity timestamps. Both legs UNDER-report and neither over-reports (see
 * `deriveLastActive`), which is what makes a POSITIVE reading trustworthy and a
 * negative one merely inconclusive.
 *
 * ⛔ Do not add a delivery-count / `woke` / `queued` field here. Its absence is
 * the enforcement mechanism for R-3's falsifier, not an oversight.
 */
export interface GraderActivityReading {
  /** `coord_presence.last_active_at` for the grader (bumps only on real activity). */
  recordLastActiveAt: string | null;
  /** Freshest assistant-authored transcript part for the grader, when ingested. */
  turnPartLastAt?: string | null;
}

export interface GraderPickupObservation {
  verdict: GraderPickupVerdict;
  /** The wake instant this verdict is measured against (ms since epoch). */
  wakeInstantMs: number;
  /** The grader's own latest activity instant, or null when unreadable. */
  graderLastActiveMs: number | null;
  /** Which under-reporting source supplied the reading, or null when unreadable. */
  source: LastActiveSource | null;
  /** ms between the wake and the grader's activity; negative = activity predates
   *  the wake. Null when unreadable. Observability only — never a verdict. */
  sinceWakeMs: number | null;
  /** Human-readable justification, safe to surface in a lifecycle record. */
  reason: string;
}

/**
 * Pure: classify whether a woken grader has demonstrably taken a turn SINCE the
 * wake. No I/O, no clock of its own, no delivery count — fully unit-testable.
 *
 * The comparison is STRICT (`>`): activity at exactly the wake instant is not
 * evidence of activity CAUSED BY the wake, so it fails closed to `not-yet`.
 *
 * FAILURE DIRECTION (deliberate, and the part most likely to be misused):
 * `not-yet` is the cheap, recoverable answer and `confirmed` is the expensive
 * one, so the rule is biased toward `not-yet`. Because both activity sources
 * under-report, a grader that HAS picked the work up can still read `not-yet`
 * for a while. Therefore:
 *   ⛔ `not-yet` is NOT a licence to re-recruit, re-wake, or replace the grader.
 * Treating it as one would make WI-10002369 strictly worse — the recruiter
 * already opens a fresh cascade too eagerly, re-selecting an agent who just
 * declined. A caller that wants to give up on a grader needs a TIMEOUT policy of
 * its own; this function only reports what the evidence shows right now.
 */
export function classifyGraderPickup(input: {
  wakeInstantMs: number;
  reading: GraderActivityReading;
  nowMs: number;
}): GraderPickupObservation {
  const { wakeInstantMs, reading, nowMs } = input;
  const recorded = reading.recordLastActiveAt ?? null;
  const turnPart = reading.turnPartLastAt ?? null;

  // Reuse the shared max()-of-both-sources selection rather than re-deriving it,
  // so this seam cannot drift from how the rest of the system reads "activity".
  const derived = deriveLastActive(recorded, turnPart, nowMs);

  if (derived.lastActiveSource === null) {
    return {
      verdict: 'unreadable',
      wakeInstantMs,
      graderLastActiveMs: null,
      source: null,
      sinceWakeMs: null,
      reason:
        'grader activity is unreadable (no parseable presence row and no ingested transcript part) — measurement failed, which is NOT evidence the grader is absent',
    };
  }

  // Take the absolute instant from whichever leg `deriveLastActive` selected.
  // Deliberately NOT reconstructed from `lastActiveSecAgo`: that value is rounded
  // to whole seconds, which would let activity up to ~500ms BEFORE the wake read
  // as after it.
  const rawSelected = derived.lastActiveSource === 'turn-parts' ? turnPart : recorded;
  const graderLastActiveMs = rawSelected == null ? NaN : Date.parse(rawSelected);

  if (Number.isNaN(graderLastActiveMs)) {
    return {
      verdict: 'unreadable',
      wakeInstantMs,
      graderLastActiveMs: null,
      source: null,
      sinceWakeMs: null,
      reason: 'grader activity timestamp could not be parsed — measurement failed',
    };
  }

  const sinceWakeMs = graderLastActiveMs - wakeInstantMs;
  if (sinceWakeMs > 0) {
    return {
      verdict: 'confirmed',
      wakeInstantMs,
      graderLastActiveMs,
      source: derived.lastActiveSource,
      sinceWakeMs,
      reason: `grader produced activity ${sinceWakeMs}ms after the wake (source: ${derived.lastActiveSource})`,
    };
  }

  return {
    verdict: 'not-yet',
    wakeInstantMs,
    graderLastActiveMs,
    source: derived.lastActiveSource,
    sinceWakeMs,
    reason: `grader's latest activity predates the wake by ${Math.abs(sinceWakeMs)}ms (source: ${derived.lastActiveSource}) — no turn taken since; NOT a basis for re-recruiting`,
  };
}

/** Injectable reader so the seam is testable without PG. */
export type GraderActivityReader = (graderId: string) => Promise<GraderActivityReading>;

/**
 * Production reader: the grader's recorded presence activity plus its ingested
 * transcript activity.
 *
 * The transcript leg comes from `fetchPresenceTier1` rather than a local copy of
 * its query — that query carries non-obvious semantics (the `workspace_id`
 * CORPUS-namespace literal, an assistant-role filter, and an `ingested_at` bound
 * distinct from the `ts` it reads), and a second copy here would be free to drift
 * from the one every other activity reading uses.
 */
export const prodReadGraderActivity: GraderActivityReader = async (graderId) => {
  const { sql } = getOrgPg();
  const [presenceRows, joins] = await Promise.all([
    sql<{ last_active_at: string | Date | null }[]>`
      SELECT last_active_at
        FROM harness_shared.coord_presence
       WHERE owner_id = ${graderId}
       LIMIT 1`,
    fetchPresenceTier1([graderId]),
  ]);
  const raw = presenceRows[0]?.last_active_at ?? null;
  return {
    recordLastActiveAt: raw == null ? null : raw instanceof Date ? raw.toISOString() : String(raw),
    turnPartLastAt: joins.get(graderId)?.turnPartLastAt ?? null,
  };
};

/**
 * Observe whether a recruited grader has picked the grading up, by re-reading
 * that grader AFTER the wake. This is the callable R-3 seam.
 *
 * It takes the wake INSTANT (not a wake RESULT) on purpose: the caller supplies
 * when delivery happened, and this function supplies the independent later
 * evidence. Nothing about the delivery's success or recipient count reaches the
 * verdict.
 */
export async function observeGraderPickup(
  args: { graderId: string; wakeInstantMs: number; nowMs?: number },
  deps: { read?: GraderActivityReader } = {},
): Promise<GraderPickupObservation> {
  const read = deps.read ?? prodReadGraderActivity;
  const nowMs = args.nowMs ?? Date.now();
  let reading: GraderActivityReading;
  try {
    reading = await read(args.graderId);
  } catch {
    // A failed read is `unreadable`, never `not-yet`: an infrastructure fault must
    // not be reported as a statement about the grader's behaviour.
    return {
      verdict: 'unreadable',
      wakeInstantMs: args.wakeInstantMs,
      graderLastActiveMs: null,
      source: null,
      sinceWakeMs: null,
      reason: 'grader activity read failed — measurement failed, not a verdict about the grader',
    };
  }
  return classifyGraderPickup({ wakeInstantMs: args.wakeInstantMs, reading, nowMs });
}
