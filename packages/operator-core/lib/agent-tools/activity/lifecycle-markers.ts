/**
 * lifecycle-markers.ts — the canonical `activity:report { kind:'lifecycle' }`
 * summary literals (EI-12979).
 *
 * Every per-CLI lifecycle hook (Claude/Codex's `hooks/cc/lifecycle-report.sh`,
 * OMP's `coord-hook.ts` `reportLifecycle`) writes EXACTLY one of these two
 * strings as the `summary` of a `kind:'lifecycle'` activity row — never a
 * variant, never with a suffix. Every READER of that summary (report.ts's own
 * `lifecyclePhase`, presence-wakeability.ts's `fetchWakeability` SQL) MUST
 * compare against these EXACT exported values, not re-derive its own
 * pattern.
 *
 * Why this file exists: before EI-12979, two independent readers each
 * hand-rolled an UNANCHORED substring match on the word "end" (a bare
 * `/end/i` regex in report.ts's `lifecyclePhase`, and `summary ILIKE '%end%'`
 * in presence-wakeability.ts's SQL) — so ANY lifecycle summary that merely
 * CONTAINS "end" (e.g. "recommend", "extended", "appended", "suspended",
 * "backend") would misfire as a session-end marker. Blast radius was zero
 * only because no other lifecycle summary happened to contain the substring
 * — a latent trap, not a working design. A shared, exact-match constant is
 * the fix: the writer and every reader can no longer independently drift.
 */
export const SESSION_START_MARKER = '▶ session started';
export const SESSION_END_MARKER = '■ session ended';

/**
 * EI-24791346664119438: written by the turn-start endpoint (UserPromptSubmit,
 * real time) when the submitted prompt opens with a `loop-fire` turn-origin
 * envelope. It is the only per-fire signal that exists while a loop turn is
 * still running: `session_turns` is ingested after the turn (measured 500-600s
 * after the reconciler's grace on long turns), and the Stop-hook journal lands
 * only at turn end. `reconcile-loop-routines` reads it as "this fire became a
 * turn" so a long loop turn is not settled as 'delivered-wake-no-loop-turn'.
 * Not a session phase: lifecycle readers that compare against the two markers
 * above ignore it by construction (exact match).
 */
export const LOOP_TURN_START_MARKER = '▷ loop-fire turn started';
