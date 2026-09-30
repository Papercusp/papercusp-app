/**
 * configure-per-workspace.ts — workspace-data-isolation-leaks-2026-06-17 F-E1 (phase 1).
 *
 * The routines lib (@papercusp/db-org / routines-runtime.ts) can't read feature flags
 * (layer boundary), so this operator-core module pushes the papercusp-routines-per-workspace
 * flag into it via `setRoutinesPerWorkspaceConflict` — at module load (boot) and on every
 * flag change. Imported for side effect by the routines workflow (the ticker), so the value
 * is wired before any routine upsert. Until the first async read resolves, the lib's default
 * (false ⇒ today's ON CONFLICT (install_slug, name)) holds — safe.
 *
 * Mirrors the coordScopeWorkspace flag-cache pattern in agent-tools/coordination/log.ts.
 */
import { setRoutinesPerWorkspaceConflict } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { systemDistinctId } from '../../flag-distinct-id';

async function refresh(): Promise<void> {
  try {
    setRoutinesPerWorkspaceConflict(await getFlag(FLAGS.ROUTINES_PER_WORKSPACE, systemDistinctId()));
  } catch {
    setRoutinesPerWorkspaceConflict(false);
  }
}

void refresh();
onFlagChange((key) => {
  if (key === null || key === FLAGS.ROUTINES_PER_WORKSPACE) void refresh();
});
