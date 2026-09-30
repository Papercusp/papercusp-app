/**
 * The quiet-cut window — the SINGLE SOURCE OF TRUTH for the rule deciding which commit
 * the release gate judges.
 *
 * ## Why this is its own leaf module (EI-19458822909084210)
 *
 * This rule used to be defined TWICE, independently:
 *
 *   - `apps/operator/lib/release/green-checkpoint.ts` — the AUTHORITY. Its copy drives the
 *     real candidate selection (the `quiet-cut: tip … is Ns old` branch).
 *   - `packages/operator-core/lib/release-checkpoint-launch.ts` — the launch-side PREDICTOR
 *     of what that authority is about to pick (`currentCheckpointCandidate`).
 *
 * The copies had already DRIFTED: only the operator-core one applied `Math.floor`, so the
 * two disagreed for any finite non-integer `PAPERCUSP_QUIET_CUT_SEC` (90.7 → 90.7 vs 90).
 * A predictor that can disagree with the authority it predicts is the entire bug class —
 * it makes `currentCheckpointCandidate` report a candidate the gate would not actually cut,
 * which is exactly the kind of confidently-wrong answer that costs a ~55min suite to
 * discover. So there is now ONE definition and both layers import it.
 *
 * ## Why HERE and not `release-checkpoint-config.ts`
 *
 * That module is the natural-sounding home but pulls in `operator-state-pg` (a PG-backed
 * override store). This function must be importable STATICALLY from `green-checkpoint.ts`
 * — it is called synchronously, including by tests — and the gate's most critical file
 * should not gain a transitive PG dependency to read one env var. Hence a zero-dependency
 * leaf beside `checkpoint-log-tags.ts` / `gate-verdict-target.ts`, matching that pattern.
 *
 * ## Why `Math.floor` is the canonical behavior
 *
 * A tie-break, NOT a correctness fix: the knob is documented in whole seconds and the value
 * is published as the `quiet_cut_sec` API field, so an integer is the sane normalized form.
 * Both former behaviors were functionally equivalent in practice — git accepts a fractional
 * epoch in `--before=@<t>` and resolves the same commit (verified 2026-08-03), so neither
 * copy was producing a wrong candidate on its own. Agreeing is what matters here, not which
 * of the two was picked.
 */

/** Default quiet-cut window: 240s ≈ 1.5 git-sync ticks. */
export const DEFAULT_QUIET_CUT_SEC = 240;

/**
 * Quiet-cut window in seconds; 0 disables the cut entirely (judge the tip).
 *
 * - `PAPERCUSP_QUIET_CUT=0` opts out entirely.
 * - `PAPERCUSP_QUIET_CUT_SEC` tunes the window; a negative, non-finite, or unparseable
 *   value falls back to the default rather than disabling the cut.
 */
export function quietCutSecFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  if (env.PAPERCUSP_QUIET_CUT === '0') return 0;
  const v = Number(env.PAPERCUSP_QUIET_CUT_SEC);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_QUIET_CUT_SEC;
}
