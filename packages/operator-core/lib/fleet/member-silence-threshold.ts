/**
 * member-silence-threshold.ts — the one value that decides when a live fleet member
 * stops counting toward productive headcount (plan
 * feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01, P-007 / R-17;
 * value fixed by D-007 item 4).
 *
 * A dependency-free leaf on purpose: `agent-fleets-store` stamps it into the
 * productive-headcount count contract, and `agent-tools/fleet_registry/silent-member`
 * applies it. Many tests replace `agent-fleets-store` with a full `vi.mock` factory, so
 * the constant cannot live there without every such factory having to restate it.
 *
 * It replaces the earlier 60-minute `FLEET_HEADCOUNT_EXECUTION_WINDOW_MS`. That window
 * was widened past the 30-minute wedge window so a member parked on the standard 1800s
 * `events:await` was not read as missing and relaunched. The silence rule keeps that
 * protection precisely instead of by width: a member with a pending, unexpired,
 * non-keepalive await counts however long it has been quiet. That is what lets the
 * call window shrink to 20 minutes without the relaunch churn returning.
 */

/** D-007 item 4: 20 minutes with no calls beyond heartbeats. */
export const FLEET_MEMBER_SILENCE_THRESHOLD_MS = 20 * 60_000;
