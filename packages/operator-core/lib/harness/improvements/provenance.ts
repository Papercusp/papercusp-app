/**
 * provenance.ts — signal-origin provenance for learning-signal rows
 * (self-learning-frontier-2026-06-12 P-002 / D-002, brief FB-03).
 *
 * Every learning-signal row (improvements captures — agent-filed and
 * watchdog-filed alike — and everything the loop derives from them) carries an
 * origin so synthetic signals from the frontier loops can coexist with the live
 * loop without polluting organic learners:
 *
 *   - organic — a real signal from live operation (the default, and the only
 *     origin any consumer sees unless it explicitly opts in);
 *   - drill   — a vaccination-planted synthetic friction (Red Queen, P-031);
 *   - replay  — output of a counterfactual replay run (P-020/P-021);
 *   - shadow  — output of a shadow ablation (P-023).
 *
 * Storage: `engineer_issues.signal_origin` (migration 241 — NOT `origin`, which
 * is the federation local/remote column from migration 108). The read-side
 * default is enforced at the ONE repointable read seam (read-items.ts), so
 * every loop consumer — digest, triage, decay, hygiene, recurrence escalation,
 * gym routed ideas, scout corpus/cadence, the implement loop, the Learning tab
 * resolver — inherits organic-only without per-consumer code.
 *
 * Filtering is EXACT-match allowlisting: a row reaches a consumer only when its
 * stored origin is in the allowed set, so a junk/unknown value fails CLOSED
 * (excluded everywhere) rather than leaking into organic learners. The one
 * deliberate exception: a row with NO stored origin (pre-migration legacy rows,
 * unit-test fakes that predate the column) reads as organic — that is exactly
 * what the migration's DEFAULT backfills, not a guess.
 */

/** Provenance of a learning-signal row (D-002). */
export type SignalOrigin = 'organic' | 'drill' | 'replay' | 'shadow';

export const SIGNAL_ORIGINS: readonly SignalOrigin[] = ['organic', 'drill', 'replay', 'shadow'];

/** The write-path default: every capture that does not say otherwise is organic. */
export const DEFAULT_SIGNAL_ORIGIN: SignalOrigin = 'organic';

/** The read-path default allowlist (D-002): organic only. */
export const ORGANIC_ONLY: readonly SignalOrigin[] = ['organic'];

export function isSignalOrigin(v: unknown): v is SignalOrigin {
  return typeof v === 'string' && (SIGNAL_ORIGINS as readonly string[]).includes(v);
}

/**
 * Resolve a row's effective origin: a missing value (legacy row / pre-column
 * fake) is organic by the migration-DEFAULT argument above; anything else is
 * the raw stored value, NOT normalized — junk stays junk so it matches no
 * allowlist.
 */
export function effectiveOrigin(stored: unknown): string {
  return stored == null ? DEFAULT_SIGNAL_ORIGIN : String(stored);
}

/** Exact-match allowlist check over the EFFECTIVE origin (fail-closed on junk). */
export function originAllowed(stored: unknown, allowed: readonly SignalOrigin[] = ORGANIC_ONLY): boolean {
  return (allowed as readonly string[]).includes(effectiveOrigin(stored));
}
