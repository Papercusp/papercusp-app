/**
 * spawn-hydration-deps — the PRODUCTION binding of the spawn/wake-hydration
 * sources (directed-wake-honesty-and-spawn-handoff-2026-06-14 P-021 / P-012).
 *
 * The pure assembler (`./spawn-hydration`) is deliberately DB-free so it
 * unit-tests with no PG / flag store. This module is the impure other half: it
 * imports the real source functions and projects them onto the assembler's
 * `SpawnHydrationDeps` seam. BOTH spawn paths — the autonomous operator-spawn and
 * the interactive bootstrap-role launch — bind the seam through THIS one function,
 * so the two paths can never drift in which sources they hydrate from.
 *
 * Each source is fail-soft inside `assembleSpawnHydration` (a throw degrades that
 * section to empty), so these bindings stay thin: resolve, don't guard.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { listHiveRosterSnapshot, renderRosterSnapshot } from './hive-roster';
import { getSpawnHandoffContext } from '../handoff-context';
import { getWorkItemCheckpoint } from '../work-item-checkpoint';
import { computeCupWakeDossier } from '../pot/cup-wake-dossier';
import { activeWorkspaceId } from '../workspace-registry';
import type { SpawnHydrationDeps } from './spawn-hydration';

export function productionSpawnHydrationDeps(): SpawnHydrationDeps {
  return {
    // Predecessor handoff (su-88991): to_feature_id messages + blocked_by
    // completion summaries + the sliced plan Now/decisions, provenance-framed —
    // PLUS B2 slot-drain (P-023): @feature/@role parked messages delivered on
    // spawn. Needs a feature to scope to; without one there is no handoff to gather.
    getHandoff: ({ harness, featureId, planSlug, workspaceId, role, deliverTo, nowMs }) =>
      featureId
        ? getSpawnHandoffContext({ harness, featureId, planSlug, workspaceId, role, deliverTo, nowMs })
        : Promise.resolve(null),
    // Hive-roster snapshot (su-2ab53), rendered to the trusted `### Hive peers` body.
    getRoster: async ({ harness, workspaceId }) =>
      renderRosterSnapshot(await listHiveRosterSnapshot({ potSlug: harness, workspaceId })),
    // The bee's own / predecessor carry-note (su-0de71), so a successor inherits state.
    getCheckpoint: ({ harness, workItemId, workspaceId }) =>
      getWorkItemCheckpoint({ harness, workItemId, workspaceId }),
    // The precomputed work-item DOSSIER (bee-context P-008, D-004/D-008/D-009): item
    // world-state + plan item + blocks + topics + comments + the hive-roster snapshot,
    // so the (re)spawned agent opens already-briefed. Flag-gated on CUP_WAKE_DOSSIER
    // (default on, P-009). FAIL-SOFT: a flag-read fault or a null dossier ⇒ no section
    // (the agent falls back to its read tools). computeCupWakeDossier needs a concrete
    // workspaceId — the spawn paths thread it; activeWorkspaceId() is the safety floor.
    getDossier: async ({ harness, workItemId, workspaceId, role }) => {
      if (!(await getFlag(FLAGS.CUP_WAKE_DOSSIER, 'system'))) return null;
      return computeCupWakeDossier({ workspaceId: workspaceId ?? activeWorkspaceId(), harness, workItemId, role });
    },
  };
}
