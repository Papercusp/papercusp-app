/**
 * Seed the ARM-STATE rows for the code-declared in-process sweeps (EI-19294826146331487).
 *
 * One `tier='in-process'` routines row per `buildDefaultChecks()` entry. The row is fired by
 * nobody — `listDueCronRoutines` filters `tier='durable'`, `listActiveEphemeralRoutines` filters
 * `tier='ephemeral'` — it exists so the sweep's on/off state has somewhere durable to live and the
 * Automation pane's existing `routines:set` toggle has something to write.
 *
 * The background host does this itself on every boot (`startInProcessSweepArmReconciler` seeds
 * before its first reconcile), so this entrypoint is for materializing the rows on a host that is
 * ALREADY UP, without restarting it — the same reason `seed-coverage-census-routine.ts` and the
 * other bespoke seeds in this directory exist.
 *
 * Idempotent, and `active` is never re-applied on conflict: re-running can add missing rows but
 * can never undo an operator's pause.
 *
 *   npx tsx packages/operator-core/lib/harness/routines/seed-in-process-sweep-routines.ts
 */
import { buildDefaultChecks } from '../../dbos/in-process-periodic';
import { seedInProcessSweepRoutines } from '../../dbos/in-process-sweep-arm';

async function main(): Promise<void> {
  const specs = buildDefaultChecks().map((c) => ({ name: c.name, intervalMs: c.intervalMs }));
  const written = await seedInProcessSweepRoutines(specs);
  console.log(
    `[seed-in-process-sweep-routines] upserted ${written} arm-state row(s) across the background ` +
      `workspaces for ${specs.length} declared sweep(s): ${specs.map((s) => s.name).join(', ')}`,
  );
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-in-process-sweep-routines] failed:', err);
    process.exit(1);
  });
