/**
 * Per-harness gym promotion gates (live-configurability-audit-2026-06-20 P-012).
 *
 * The gym optimization loop's accept gates (epsilon / delta margins + costCeiling) were an INLINE
 * placeholder at gym/autoloop-cycle.ts ("placeholders until P-014"). This is the store: the cycle now
 * reads `readGymGates(harness, ws)` and passes it as `thresholds` to runOptimizationLoop. Per-harness
 * (the gym config is per-harness), `operator_gym_gates` keyed by (workspace_id, harness_slug).
 *
 * Empty store ⇒ DEFAULT_GYM_GATES (the inline placeholder) ⇒ byte-identical. The gym loop is
 * human-gated (autoPromote:false), so these only steer the loop's ADVISORY verdict. Registers a
 * (per-harness) override concern.
 *
 * NOTE: judge WEIGHTS live in the blueprint gym rubric (gym/primitives rubricFromBlueprintGym), a
 * separate surface — not covered here; this is the epsilon/delta/costCeiling threshold gate.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface GymGates {
  /** Accept-margin gate (B must beat A by ≥ epsilon on the judge composite). */
  epsilon: number;
  /** Confidence-margin gate (variance-aware accept margin). */
  delta: number;
  /** Max cost multiple of baseline a champion may cost and still promote. */
  costCeiling: number;
}

/** The inline placeholder the gym loop used before this store (autoloop-cycle.ts). */
export const DEFAULT_GYM_GATES: GymGates = { epsilon: 0.1, delta: 0.5, costCeiling: 3 };

/** Effective gates for a harness = stored override merged over DEFAULT_GYM_GATES. */
export async function readGymGates(harnessSlug: string, workspaceId: string = activeWorkspaceId()): Promise<GymGates> {
  const { sql } = getOrgPg();
  const rows = await sql<{ payload: Partial<GymGates> }[]>`
    SELECT payload FROM harness_shared.operator_gym_gates
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} LIMIT 1
  `;
  return { ...DEFAULT_GYM_GATES, ...(rows[0]?.payload ?? {}) };
}

/** Merge a patch over the harness's current gates + persist; returns the new effective gates. */
export async function writeGymGates(harnessSlug: string, patch: Partial<GymGates>, workspaceId: string = activeWorkspaceId()): Promise<GymGates> {
  const next = { ...(await readGymGates(harnessSlug, workspaceId)), ...patch };
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_gym_gates (workspace_id, harness_slug, payload, updated_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${JSON.stringify(next)}::text::jsonb, ${Date.now()})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
  `;
  return next;
}

/** Clear a harness's gate override (back to DEFAULT_GYM_GATES). */
export async function resetGymGates(harnessSlug: string, workspaceId: string = activeWorkspaceId()): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.operator_gym_gates WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}`;
}

/** All per-harness gate overrides for the workspace. */
export async function listGymGates(workspaceId: string = activeWorkspaceId()): Promise<Array<{ harnessSlug: string; gates: Partial<GymGates> }>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ harness_slug: string; payload: Partial<GymGates> }[]>`
    SELECT harness_slug, payload FROM harness_shared.operator_gym_gates
     WHERE workspace_id = ${workspaceId} ORDER BY harness_slug
  `;
  return rows.map((r) => ({ harnessSlug: r.harness_slug, gates: r.payload ?? {} }));
}

async function resetAllGymGates(workspaceId: string = activeWorkspaceId()): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.operator_gym_gates WHERE workspace_id = ${workspaceId}`;
}

registerOverrideConcern({
  name: 'gym-gates',
  description: 'per-harness gym promotion gates (epsilon / delta / costCeiling)',
  auditAction: 'gym:set-gates',
  diff: async () => {
    const all = await listGymGates();
    const entries: OverrideEntry[] = [];
    for (const { harnessSlug, gates } of all) {
      for (const k of Object.keys(DEFAULT_GYM_GATES) as (keyof GymGates)[]) {
        if (gates[k] !== undefined && gates[k] !== DEFAULT_GYM_GATES[k]) {
          entries.push({ key: `${harnessSlug}.${k}`, effective: gates[k], default: DEFAULT_GYM_GATES[k], layer: 'pg-settings' });
        }
      }
    }
    return entries;
  },
  capture: () => listGymGates(),
  reset: () => resetAllGymGates(),
  restore: async (snap) => {
    const rows = (snap as Array<{ harnessSlug: string; gates: Partial<GymGates> }>) ?? [];
    await resetAllGymGates();
    for (const { harnessSlug, gates } of rows) await writeGymGates(harnessSlug, gates);
  },
});
