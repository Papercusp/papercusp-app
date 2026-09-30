/**
 * held-gate-alarm — rising-urgency alerting for a green-checkpoint held RED.
 *
 * The gate held red ~4h on 2026-06-23, blocking 25 commits fleet-wide, and nobody
 * noticed — it opens ONE `release-not-green` escalation on first red, then goes
 * silent (the escalate dep is transition-only). A held release gate is a fleet
 * emergency that should get LOUDER the longer it persists, not quieter. This pure
 * helper maps held-duration → an escalating alert tier; the green-checkpoint
 * re-broadcasts at each tier so a long-held gate keeps surfacing top-of-inbox.
 * (docs-audit 2026-06-23 #2.)
 */

const HOUR = 60 * 60 * 1000;

/** Tier boundaries (ms). Below the first, the single escalation + per-tick broadcast
 *  already cover it; the LOUD alerts start once the gate is genuinely stuck. */
export const HELD_GATE_HELD_MS = 2 * HOUR;
export const HELD_GATE_URGENT_MS = 4 * HOUR;
export const HELD_GATE_CRITICAL_MS = 8 * HOUR;

export interface HeldGateAlert {
  tier: 'held' | 'urgent' | 'critical';
  /** Visual weight for the broadcast headline. */
  emoji: string;
  /** Uppercase urgency word for the headline. */
  urgency: string;
  /** Human duration, e.g. "4h 12m". */
  ageLabel: string;
}

/** Compact "Xh Ym" / "Ym" duration label. */
export function formatHeldDuration(heldMs: number): string {
  const totalMin = Math.max(0, Math.floor(heldMs / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Map how long the gate's been red → an escalating alert, or null while still
 * within the quiet window (< 2h). Pure: `heldMs` is supplied (no clock here), so
 * the tiering is deterministic + unit-testable.
 */
export function heldGateAlert(heldMs: number): HeldGateAlert | null {
  const ageLabel = formatHeldDuration(heldMs);
  if (heldMs >= HELD_GATE_CRITICAL_MS) return { tier: 'critical', emoji: '🟥🟥🟥', urgency: 'CRITICAL', ageLabel };
  if (heldMs >= HELD_GATE_URGENT_MS) return { tier: 'urgent', emoji: '🟥🟥', urgency: 'URGENT', ageLabel };
  if (heldMs >= HELD_GATE_HELD_MS) return { tier: 'held', emoji: '🟥', urgency: 'HELD', ageLabel };
  return null;
}
