import type { Sql } from 'postgres';
import { readGovernorStateSnapshot } from './state-snapshot';
import {
  buildSpawnGovernorObservation,
  type SpawnDoorOutcome,
  type SpawnGovernorObservation,
} from './spawn-observation';

/**
 * P-003 of plan `spawn-door-governor-migration-2026-08-31` — the BEST-EFFORT
 * persistence half of the observe-only receipt. The counterfactual itself is
 * pure and lives in `./spawn-observation`; this module is the only part that
 * touches the database, and it exists to be impossible to fail a spawn with.
 *
 * WHY IT RUNS AFTER THE TRANSACTION (plan D-009): the observation is EVIDENCE,
 * not a control signal. Writing it inside `admitSpawn`'s transaction would give
 * a defect in this code the power to abort a real spawn — the one property
 * P-003 exists NOT to have. It is therefore called `void`-ed after the
 * admission has already committed, exactly like the `logSpawnReadinessShadow`
 * precedent on the same path (WI-390).
 */

/** Set to `0` to disable observation recording entirely (noisy dev box, incident). */
const KILL_SWITCH_ENV = 'PAPERCUSP_SPAWN_GOVERNOR_OBSERVATION';

/**
 * Deliberately far wider than `GOVERNOR_STATE_MAX_AGE_MS` (120s).
 *
 * `readGovernorStateSnapshot` returns NULL for anything older than the age it is
 * given, which would collapse two states P-004 must tell apart: "the governor
 * publishes nothing" and "the governor publishes, but staleness means a live
 * admit would have been deciding on old data". Reading with a wide window and
 * letting the PURE core mark staleness from the snapshot's own `validUntilMs`
 * keeps `governor-snapshot-stale` a reachable, meaningful caveat instead of a
 * branch that can never fire in production.
 */
const OBSERVATION_SNAPSHOT_MAX_AGE_MS = 15 * 60_000;

export interface SpawnObservationWriteInput {
  readonly sql: Sql;
  readonly workspaceId: string;
  /** The spawn id the door minted for THIS attempt. */
  readonly spawnId: string;
  /**
   * For an `over_cap` refusal: the id of the row `fail()` recorded via
   * `recordFailedAttempt` (a FRESH id, not `spawnId`). Null/absent when the door
   * could not record one, in which case the observation is logged, not persisted.
   */
  readonly failedAttemptSpawnId?: string | null;
  readonly doorOutcome: SpawnDoorOutcome;
  readonly doorCap: number;
  readonly doorRoleCap: number | null;
  readonly parentRole: string;
  readonly childRole: string;
  readonly fleetSlug: string | null;
  readonly planSlug: string | null;
  /** Descriptive callsite label (D-011) — attribution only, binds nothing. */
  readonly caller: string | null;
}

/**
 * WHICH ROW CARRIES THIS RECEIPT (plan D-010) — read this before computing any
 * rate from `governor_observation`.
 *
 * The receipt is a column on `harness_shared.spawned_agents`, so the real question
 * is never "is this outcome persistable" but "which spawn_id holds the row". The
 * three outcomes answer it differently, and they do NOT reduce to admitted-only:
 *
 *   • `admitted`  → our own `spawnId`, inserted in the committed transaction.
 *   • `over_cap`  → a row DOES exist, under the id `fail()` returns: the door's
 *                   `recordFailedAttempt` mints a FRESH id, records the row, and
 *                   flips it to status='failed' with the cap message. Attaching
 *                   here is what makes refusals observable at all — and refusals
 *                   are exactly where P-004's BURST SHAPE lives, since a burst is
 *                   defined by the moments the cap was hit.
 *   • `duplicate` → the id belongs to the ORIGINAL spawn, which already carries its
 *                   own receipt. Nothing to attach; writing there would overwrite a
 *                   different spawn's counterfactual with this replay's.
 *
 * Inventing a row to hold telemetry remains forbidden: `countRunning` derives the
 * live ceiling from this table, so a fabricated 'running' row would let telemetry
 * consume a real spawn slot. Attaching to the terminal row `fail()` ALREADY created
 * is not that — it creates nothing and cannot move the ceiling.
 */
export function resolveObservationTarget(
  outcome: SpawnDoorOutcome,
  ids: { readonly spawnId: string; readonly failedAttemptSpawnId?: string | null },
): string | null {
  if (outcome === 'admitted') return ids.spawnId;
  if (outcome === 'over_cap') return ids.failedAttemptSpawnId ?? null;
  return null;
}

/**
 * Record the observe-only governor receipt for one spawn. NEVER throws, never
 * returns a value a caller is expected to act on, and never blocks admission —
 * call it `void`-ed after the admission transaction has committed.
 */
export async function recordSpawnGovernorObservation(
  input: SpawnObservationWriteInput,
  logFn: (msg: string) => void = (msg) => console.warn(msg),
): Promise<void> {
  if (process.env[KILL_SWITCH_ENV] === '0') return;
  try {
    // A wide window on purpose — see OBSERVATION_SNAPSHOT_MAX_AGE_MS.
    const read = await readGovernorStateSnapshot(input.workspaceId, OBSERVATION_SNAPSHOT_MAX_AGE_MS);

    const observation = buildSpawnGovernorObservation({
      nowMs: Date.now(),
      doorOutcome: input.doorOutcome,
      doorCap: input.doorCap,
      doorRoleCap: input.doorRoleCap,
      parentRole: input.parentRole,
      childRole: input.childRole,
      fleetSlug: input.fleetSlug,
      planSlug: input.planSlug,
      caller: input.caller,
      snapshot: read?.payload ?? null,
    });

    const targetSpawnId = resolveObservationTarget(input.doorOutcome, {
      spawnId: input.spawnId,
      failedAttemptSpawnId: input.failedAttemptSpawnId,
    });
    if (!targetSpawnId) {
      // `duplicate` is EXPECTED to have no row of its own: the retry launched
      // nothing, and the ORIGINAL spawn already carries its own receipt (see
      // resolveObservationTarget). Skipping is the correct outcome, not an
      // anomaly — so it must not warn. A warn here fires on EVERY idempotent
      // retry, which is production log-noise, a false anomaly signal, and (the
      // way this was actually caught) an unexpected-console failure in any test
      // that exercises the dedupe path under vitest-fail-on-console.
      if (input.doorOutcome !== 'duplicate') logUnpersistable(input, observation, logFn);
      return;
    }

    // Guarded by `governor_observation IS NULL` so a retry can never overwrite an
    // existing receipt: the first observation for a spawn is the one taken closest
    // to its admission, and that is the one P-004 wants.
    await input.sql`
      UPDATE harness_shared.spawned_agents
         SET governor_observation = ${input.sql.json(
           observation as unknown as Parameters<typeof input.sql.json>[0],
         )}
       WHERE spawn_id = ${targetSpawnId}
         AND governor_observation IS NULL`;
  } catch {
    /* best-effort evidence only — an observation must never disturb a spawn */
  }
}

function logUnpersistable(
  input: SpawnObservationWriteInput,
  observation: SpawnGovernorObservation,
  logFn: (msg: string) => void,
): void {
  logFn(
    `[spawn-governor-observation] outcome=${input.doorOutcome} has no spawned_agents row to carry a receipt ` +
      `(D-010) — logging instead. spawnId=${input.spawnId} childRole=${input.childRole} ` +
      `wouldAdmit=${observation.governor.wouldAdmit} diverged=${String(observation.divergedFromGovernor)} ` +
      `caveats=${observation.caveats.join(',')}`,
  );
}
