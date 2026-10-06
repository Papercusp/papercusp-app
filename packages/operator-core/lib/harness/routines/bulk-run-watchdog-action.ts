/**
 * `system:bulk-run-watchdog` — the routine-engine registration for the
 * bulk-run watchdog (autonomous-inbox-resolution-2026-08-31 P-002).
 *
 * Decision logic lives in `../../attention/bulk-run-watchdog.ts` (pure,
 * dependency-injected); the DB halves live in `../../attention/bulk-run-store.ts`.
 * This module is the thin adapter that supplies production implementations —
 * the same split `acceptance-grading-sweep-action.ts` and `consult-expiry-action.ts`
 * use, and the same documented deviation: a bespoke `tier:'ephemeral'` routine
 * seeded at the operator HOME level, because one watchdog serves every
 * workspace's runs rather than being a per-blueprint-install concern.
 *
 * WHY IT EXISTS. Every recovery path for a bulk run was pull-triggered — the
 * owner opening the pane and pressing Restart. A resolver that dies mid-run
 * therefore leaves the run in `running` with its remaining items on `pending`
 * indefinitely, because nothing is holding a clock. This routine is that clock.
 *
 * Per the repo scheduling policy this is a declared routine, NOT a bare
 * `setInterval` — it is visible in `schedule:inventory` and pausable from the
 * routines admin like every other recurring job.
 */
import { registerSystemAction } from './system-actions';

/**
 * Cadence hint consumed by the seeder. Five minutes matches the store's
 * `RUN_HEARTBEAT_STALE_MS`, so a stranded run is noticed within roughly one
 * staleness window of becoming stale — soon enough to matter, and never so
 * often that the sweep's own timing decides an outcome (the staleness test is
 * re-evaluated inside the write regardless of when the tick lands).
 */
export const BULK_RUN_WATCHDOG_INTERVAL_SEC = 300;

export const BULK_RUN_WATCHDOG_ACTOR = 'system:bulk-run-watchdog';

registerSystemAction('bulk-run-watchdog', async () => {
  const [
    { classifyRunLiveness, readWatchdogRunRows, reconcileRunCounters, strandStaleRun },
    { runBulkRunWatchdog },
    { fetchWakeability },
  ] = await Promise.all([
    import('../../attention/bulk-run-store'),
    import('../../attention/bulk-run-watchdog'),
    import('../../agent-tools/coordination/presence-wakeability'),
  ]);

  const notes: string[] = [];
  const result = await runBulkRunWatchdog({
    async listRuns() {
      const rows = await readWatchdogRunRows();
      const facts = rows.map((row) => ({
        row,
        // Liveness is DERIVED, never stored (migration 945) — so it is computed
        // here from the same helper the pane and `restartRun` use rather than
        // being re-implemented in the watchdog's own SQL.
        liveness: classifyRunLiveness(row),
      }));
      // WI-10004887: a stale heartbeat is only a candidate. Ask the shared
      // activity clock (the one coord:presence derives from) whether the resolver
      // is still working — one batched read, and only for runs it could rescue.
      const owners = [
        ...new Set(
          facts
            .filter((f) => f.liveness.state === 'stale' && f.row.undecided > 0 && f.row.resolverOwner)
            .map((f) => f.row.resolverOwner as string),
        ),
      ];
      const activity = owners.length > 0
        ? await fetchWakeability(owners).catch((e: unknown) => {
            // Degrade to the heartbeat-only rule rather than skipping the sweep;
            // the strand write re-checks activity itself, so this cannot fail a
            // working resolver on its own.
            notes.push(`resolver activity read failed: ${e instanceof Error ? e.message : String(e)}`);
            return new Map<string, { lastActivityMs?: number | null }>();
          })
        : new Map<string, { lastActivityMs?: number | null }>();
      return facts.map(({ row, liveness }) => ({
        runId: row.runId,
        phase: row.phase,
        liveness,
        undecided: row.undecided,
        stored: row.stored,
        derived: row.derived,
        resolver: row.resolverOwner
          ? { ownerId: row.resolverOwner, lastActivityMs: activity.get(row.resolverOwner)?.lastActivityMs ?? null }
          : null,
      }));
    },
    strandRun: ({ runId, reason }) => strandStaleRun({ runId, reason }),
    reconcileCounters: ({ runId }) => reconcileRunCounters(runId),
    note: (line) => notes.push(line),
  });

  if (result.stranded.length || result.deferred.length || result.countersReconciled.length || result.errors.length) {
    console.log(
      `[bulk-run-watchdog] examined=${result.examined} stranded=${result.stranded.length} ` +
        `deferred=${result.deferred.length} ` +
        `itemsMarked=${result.itemsMarked} reconciled=${result.countersReconciled.length} ` +
        `errors=${result.errors.length}`,
    );
    for (const line of notes) console.log(`[bulk-run-watchdog] ${line}`);
    for (const e of result.errors) {
      console.warn(`[bulk-run-watchdog] ${e.runId}: ${e.error}`);
    }
  }
});
