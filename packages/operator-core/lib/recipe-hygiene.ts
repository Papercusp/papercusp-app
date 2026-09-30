/**
 * recipe-hygiene.ts — the single-run body of the WEEKLY code-recipes hygiene routine
 * (recipes-reuse-activation-2026-06-22 P-003). Kept separate from the DBOS scheduled
 * wrapper in lib/dbos/periodic-workflows.ts so it integration-tests without the
 * scheduler (mirrors runEmbedBackfillOnce / runStorageGrowthAlarmOnce).
 *
 * What it does on its cadence:
 *  - SWEEP the stale long-tail: retire ACTIVE recipes run <= maxRunCount times whose
 *    last run is older than staleDays (sweepRecipes — a reversible status flip that
 *    NEVER touches hot / promoted / merged / NULL-last-run recipes), so the corpus stays
 *    signal-dense instead of accumulating never-reused one-offs (the audit's pollution).
 *  - SURFACE the graduation worklist: compute recipeCandidates (promote candidates +
 *    near-duplicate merge clusters) so a passive heartbeat of "what's graduating" exists
 *    even in a Queen-less window. This does NOT replace the Queen — she still pulls
 *    recipes:candidates live on her cadence (code-recipes-2026-06-21 D-017); the routine
 *    just guarantees hygiene + visibility run on a schedule rather than only when she's idle.
 *  - PROMOTE the persistent tool-sequence graduates: file a work-item for each repeated
 *    cross-agent tool dance that cleared both evidence bars (okf-frontmatter §D). This is
 *    the one step here that is NOT passive, and deliberately so — §D's whole point is that
 *    the existing promotion path ENDS at a human reading a worklist, which means a real
 *    finding waits on someone noticing it. What gets filed is evidence for an AGENT to
 *    claim, not a code change; nothing is edited, promoted or ratified without a claimant.
 *
 * Read-mostly + reversible: the sweep's status flip and the promotion's work-item filings
 * are the only mutations, and the latter coalesce on a stable key so re-running is a no-op.
 * Returns a summary for logging + tests; the scheduled caller wraps it so it never throws out.
 *
 * Server-only.
 */
import type postgres from 'postgres';
import { sweepRecipes, type SweepRecipesInput } from './code-recipes-store';
import { recipeCandidates, type RecipeCandidatesDeps } from './code-recipes-candidates';
import {
  promoteToolSequencesEverywhere,
  type PromoteToolSequencesDeps,
  type PromoteEverywhereResult,
} from './tool-sequence-promote';

export interface RecipeHygieneResult {
  /** ids of the recipes retired by the sweep this run. */
  sweptIds: string[];
  /** count of current promote candidates (the Queen's graduation worklist). */
  promoteCandidates: number;
  /** count of current near-duplicate merge clusters. */
  mergeClusters: number;
  /**
   * Tool-sequence promotion outcome, or null when the leg was skipped (no capture
   * dep wired) — never conflated with "it ran and found nothing", which is the
   * `filed: 0` case and means something quite different.
   */
  sequences: PromoteEverywhereResult | null;
  /** Set when the promotion leg threw; the hygiene result is still returned. */
  sequenceError?: string;
}

export interface RecipeHygieneOpts {
  /** Sweep tuning (default: conservative 30d / run_count<=1, a real — non-dry — run). */
  sweep?: SweepRecipesInput;
  /** Candidate-scorer deps (embedder / co-occurrence) — optional; lexical+structural carry. */
  candidatesDeps?: RecipeCandidatesDeps;
  /**
   * Filing seam for the tool-sequence promotion leg. Injectable so this
   * integration-tests without PG, exactly like the rest of the routine; the
   * scheduled caller passes the real `captureImprovement`.
   */
  sequenceDeps?: PromoteToolSequencesDeps;
  /** Miner/graduation tuning — defaults are the module's (7x24h windows, streak 3). */
  sequenceOpts?: Parameters<typeof promoteToolSequencesEverywhere>[1];
}

/**
 * One hygiene pass: sweep the stale never-reused one-offs, compute the current
 * graduation worklist, then promote the persistent tool-sequence graduates.
 *
 * Promotion runs LAST and is guarded on purpose: the sweep and the worklist are
 * this routine's original job, and a filing failure must not throw their result
 * away. Its error is reported rather than swallowed, so a leg that is failing
 * every week cannot look like a leg that keeps finding nothing.
 */
export async function runRecipeHygieneOnce(
  sql: postgres.Sql,
  opts: RecipeHygieneOpts = {},
): Promise<RecipeHygieneResult> {
  const swept = await sweepRecipes(sql, opts.sweep ?? {});
  const { promoteCandidates, mergeClusters } = await recipeCandidates(sql, {}, opts.candidatesDeps ?? {});

  let sequences: PromoteEverywhereResult | null = null;
  let sequenceError: string | undefined;
  if (opts.sequenceDeps) {
    try {
      sequences = await promoteToolSequencesEverywhere(sql, opts.sequenceOpts ?? {}, opts.sequenceDeps);
    } catch (err) {
      sequenceError = (err as Error)?.message ?? String(err);
    }
  }

  return {
    sweptIds: swept.swept.map((r) => r.id),
    promoteCandidates: promoteCandidates.length,
    mergeClusters: mergeClusters.length,
    sequences,
    ...(sequenceError ? { sequenceError } : {}),
  };
}
