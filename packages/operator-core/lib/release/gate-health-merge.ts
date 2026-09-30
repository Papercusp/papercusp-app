/**
 * The ONE write path for the green-checkpoint routine's `gate_health` blob.
 *
 * Extracted so the in-flight markers (`inFlightRetriage`, `inFlightCandidate`) cannot drift apart
 * in either of the two ways that actually matter:
 *
 * 1. SHALLOW MERGE, never a replace. `gate_health` carries the red streak, the failing-test list,
 *    `observedCandidate` and more, written by different code paths at different times. A marker
 *    write that replaced the blob would silently clobber a concurrent reader's field.
 *
 * 2. SCOPED BY BOTH `install_slug` AND `workspace_id`. `harness_shared.routines` is multi-tenant,
 *    one row per harness per workspace. `recordInFlightRetriage` scoped only `install_slug`, so on
 *    a box hosting the same harness slug in two workspaces it wrote BOTH rows — one of them
 *    another tenant's gate. Nothing here needed that breadth: `GateVerdictTarget` has carried
 *    `workspaceId` since WI-4494 and the writer simply never used it. This is the exact
 *    unscoped-slug-filter class the repo guide warns about for READS
 *    (agent-insights/raw-sql-plan-slug-needs-workspace-harness-scope); it applies at least as
 *    sharply to writes, where the damage is to someone else's row rather than to your own answer.
 *
 * BEST-EFFORT BY CONTRACT: swallows its own errors. These markers are diagnostics riding
 * alongside the real checkpoint run — a write failure here must never break, or even slow, the
 * run it describes. A caller that needs to know the write landed must read it back.
 */
import type { GateVerdictTarget } from './gate-verdict-target';
import type { Sql } from 'postgres';

/**
 * Shallow-merge `patch` into `metadata.gate_health` for exactly one routine row.
 *
 * A key set to `null` in `patch` lands as JSON null, which every `parse*` helper in this family
 * already treats as "absent" — that is how a marker is CLEARED without a second code path.
 */
export async function mergeGateHealth(
  target: GateVerdictTarget,
  patch: Record<string, unknown>,
  transaction?: Pick<Sql, 'unsafe'>,
  rethrowOnError = false,
): Promise<void> {
  try {
    const sql = transaction ?? (await import('@papercusp/db-org')).getOrgPg().sql;
    await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{gate_health}',
                COALESCE(metadata->'gate_health', '{}'::jsonb) || $3::jsonb,
                true
              ),
              updated_at = now()
        WHERE install_slug = $1 AND workspace_id = $2 AND target_role = 'system:green-checkpoint'`,
      [target.installSlug, target.workspaceId, JSON.stringify(patch)],
    );
  } catch (error) {
    if (rethrowOnError) throw error;
    /* best-effort diagnostic — never let this break the checkpoint run it rides alongside */
  }
}
