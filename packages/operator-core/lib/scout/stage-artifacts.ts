/**
 * stage-artifacts.ts — the persisted per-cycle pipeline stage artifacts store
 * (learning-tab-visibility-2026-07-18 P-009 / D-001, migration 623).
 *
 * THE PROBLEM: ScoutCycleResult (cycle.ts) carries EVERY intermediate stage in
 * memory — per-ideator raw ideas (with the creative lens each rode),
 * adversarial-critique verdicts (keep/moonshot/reject + critic notes), and
 * debate/recombine fusions (sourceIdeaIds chains) — but only the FINAL routed
 * rows, tick economics, and the input digest persist. The owner asked to SEE
 * the advanced pipeline, not just its routed tail ("I want the user to be able
 * to see the advanced things happening as part of idea generation").
 *
 * THE MECHANISM: at fire time the tick seam (runScoutTick's success path, via
 * the persistStageArtifacts dep buildScoutTickDeps wires) lands the full stage
 * arrays on `harness_shared.scout_cycle_stage_artifacts` — ONE ROW PER FIRED
 * CYCLE, one jsonb column per stage, joined to scout_ticks /
 * scout_digest_snapshots / scout_routed_ideas by cycle_id. The
 * `learning.analyze` resolver reads it for the Learning tab's Analyze stage.
 *
 * BEST-EFFORT by contract (same as digest-snapshots): an artifact-persist
 * outage must never disturb the cycle. Retention: inline prune to the newest
 * {@link ARTIFACT_KEEP} rows per workspace bounds jsonb growth; the stage
 * text is persisted RAW (the ask is transparency, not summaries) — the prune
 * is the size bound.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

/** Rows kept per workspace — one row lands per FIRED cycle (≤ hourly under the
 *  legacy cadence; ~15min burst-coalesced under volume firing), so 30 rows is
 *  days of history while bounding jsonb growth (same keep as digest-snapshots). */
export const ARTIFACT_KEEP = 30;

/**
 * Persist one fired cycle's intermediate stage artifacts. Serializes via JSON
 * (the org-pg client rejects rich objects as params — the house `::jsonb`
 * idiom), then prunes to the newest {@link ARTIFACT_KEEP} rows for the
 * workspace. A repeat persist for the same cycle keeps the first row
 * (ON CONFLICT DO NOTHING — cycle ids are mint-once).
 */
export async function persistStageArtifacts(opts: {
  cycleId: string;
  /** ScoutCycleResult.ideas — per-ideator raw ideas incl. their lens. */
  ideas?: readonly unknown[];
  /** ScoutCycleResult.scored — critique verdicts (keep/moonshot/reject + notes). */
  scored?: readonly unknown[];
  /** ScoutCycleResult.proposals — debate/recombine fusions (sourceIdeaIds). */
  proposals?: readonly unknown[];
  /**
   * ScoutCycleResult.routed — every routing decision, including failures and
   * skips that have no routedRef. WI-20860583842231472: the successful-artifact
   * ledger cannot represent those outcomes, so this cycle-owned artifact is the
   * durable reconciliation surface for proposals → success | failed | skipped.
   */
  routingDecisions?: readonly unknown[];
  /** ScoutCycleLike.ideators — per-slot ideator outcomes (EI-13119). */
  ideatorSlots?: readonly unknown[];
  workspaceId?: string;
  installSlug?: string | null;
}): Promise<void> {
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const asJson = (v: readonly unknown[] | undefined): string | null => (v == null ? null : JSON.stringify(v));
  await sql`
    INSERT INTO harness_shared.scout_cycle_stage_artifacts
      (workspace_id, install_slug, cycle_id, ideas, scored, proposals, routing_decisions, ideator_slots)
    VALUES (${ws}, ${opts.installSlug ?? null}, ${opts.cycleId},
            ${asJson(opts.ideas)}::text::jsonb, ${asJson(opts.scored)}::text::jsonb,
            ${asJson(opts.proposals)}::text::jsonb, ${asJson(opts.routingDecisions)}::text::jsonb,
            ${asJson(opts.ideatorSlots)}::text::jsonb)
    ON CONFLICT (workspace_id, cycle_id) DO NOTHING`;
  await sql`
    DELETE FROM harness_shared.scout_cycle_stage_artifacts
     WHERE workspace_id = ${ws}
       AND id NOT IN (
         SELECT id FROM harness_shared.scout_cycle_stage_artifacts
          WHERE workspace_id = ${ws}
          ORDER BY created_at DESC
          LIMIT ${ARTIFACT_KEEP})`;
}
