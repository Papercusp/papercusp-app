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
