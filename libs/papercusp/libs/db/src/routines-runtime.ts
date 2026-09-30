/**
 * Routines runtime — the substrate's "routine ticker".
 *
 * Evaluates active cron routines and inserts pending_events when they're due.
 */

import type { Sql } from 'postgres';
import { insertPendingEvent } from './pending-events';

// workspace-data-isolation-leaks-2026-06-17 F-E1: per-workspace routine isolation seam.
// operator-core (configure-per-workspace.ts) pushes the papercusp-routines-per-workspace flag
// into this lib via the setter below (this lib can't read flags — layer boundary), at boot +
// on every flag change.
//
// EI-2019/EI-2082/EI-2123/EI-2000 (routines_pkey duplicate-key cluster): the flag NO LONGER
// switches the upsert's conflict ARBITER. The arbiter is now ALWAYS the `id` PRIMARY KEY (see
// upsertRoutine) — the only collision-free choice while the global UNIQUE(install_slug, name)
// still stands (phase 1; migration 305 is additive). Conflicting on the broken composite
// (workspace_id, install_slug, name) let a cross-workspace re-arm MISS the existing row and
// then collide on routines_pkey, wedging every later hive/overwatch declare-wake + the
// watchdog fallback-arm. The flag is retained for the configure seam and for phase-2 (folding
// workspace_id into the id, after the global unique is dropped — at which point ON CONFLICT (id)
// becomes per-workspace automatically). Full rationale at upsertRoutine's conflict target.
let routinesPerWorkspaceConflict = false;
export function setRoutinesPerWorkspaceConflict(on: boolean): void {
  routinesPerWorkspaceConflict = on;
}

export interface RoutineRow {
  id: string;
  /** Workspace that owns this routine (per-window-workspace-context P-041) —
   *  stamped onto the pending_events it fires so the queue is workspace-scoped. */
  workspaceId: string;
  installSlug: string;
  name: string;
  triggerKind: 'cron' | 'webhook' | 'api';
  // Recurrence dialects: cron (5/6-field) OR the RRULE recurrence SET
  // (scheduled-recurring-plans-2026-06-16 D-004). The engine computes next_fire_at
  // from whichever is present (see operator-core schedule-next.ts) — RRULE is never
  // converted to cron. webhook_token/method are for webhook/api trigger kinds.
  triggerConfig: {
    cron?: string;
    rrule?: string;
    dtstart?: string;
    tzid?: string;
    rdate?: string[];
    exdate?: string[];
    /** Ephemeral-tier cadence in SECONDS (tier:'ephemeral' only; P-010/D-006). */
    interval_sec?: number;
    webhook_token?: string;
    method?: string;
  };
  targetRole: string;
  payloadTemplate: Record<string, unknown> | null;
  concurrency: 'queue' | 'skip' | 'cancel-prev';
  catchup: 'skip-old' | 'run-all-backlog';
  /**
   * Execution tier (schedule-inventory-and-ephemeral-tier-2026-06-26 P-010 / D-006).
   * 'durable' (default) fires via the DBOS `routinesTick`; 'ephemeral' is a frequent,
   * non-DBOS cadence that rides the in-process scheduled-registry (P-012) and is
   * EXCLUDED from `listDueCronRoutines`/`routinesTick` (durable-only).
   *
   * 'in-process' (EI-19294826146331487, migration 1046) is fired by NEITHER — both list
   * queries below filter tier by equality, so a third value matches no executor. It is an
   * ARM-STATE-ONLY row standing for a sweep DECLARED IN CODE (`buildDefaultChecks()`), whose
   * `active` column is that sweep's durable on/off switch. See `listInProcessSweepRoutines`.
   */
  tier: 'durable' | 'ephemeral' | 'in-process';
  active: boolean;
  lastFiredAt: Date | null;
  nextFireAt: Date | null;
  /**
   * The LOOP interval (loop-routines-interval-recurrence-2026-06-20 P-001). A loop is
   * the THIRD recurrence kind: NULL = schedule-only (cron/rrule or one-shot — today's
   * behavior); N = re-fire N sec AFTER the previous turn COMPLETES (claim.ts parks it
   * at next_fire_at='infinity' in-flight, the completion-rebase re-arms it). Dedicated
   * column (D-003), not a trigger_config key.
   */
  rescheduleIntervalSec: number | null;
  /**
   * The coord ownerId of the WARM session a loop wakes (P-004 `coord:send {wake}`
   * recipient). NULL for non-loop routines. The ownerId is the stable coord identity
   * (survives `claude --resume`), so the loop keeps waking the SAME logical agent
   * across iterations; the wake-executor resolves owner→session for inject/resume.
   */
  targetOwnerId: string | null;
}

/**
 * next_fire_at='infinity'::timestamptz is the loop in-flight / parked sentinel
 * (claim.ts P-003): the SQL due-guard `next_fire_at <= now()` is FALSE for it, so a
 * parked loop is never re-claimed mid-turn (skip-if-in-flight, for free). But
 * postgres-js parses an `infinity` timestamptz to an INVALID Date (getTime()===NaN),
 * which would throw on `.toISOString()` and mis-sort. rowToRoutine maps it to this
 * max-valid-Date sentinel so every JS reader stays correct AND consistent with the
 * SQL semantics: `.getTime() <= now()` is false (not due), `Boolean(nextFireAt)` is
 * true (a parked loop IS armed, it will fire after its turn settles), `.toISOString()`
 * works, and it sorts LAST (far future). B-LOOP-2's completion-rebase identifies parked
 * loops in SQL (next_fire_at = 'infinity'), never via this JS field.
 */
export const NEXT_FIRE_PARKED = new Date(8_640_000_000_000_000);

/** True when a routine's nextFireAt is the parked-loop sentinel (NEXT_FIRE_PARKED). */
export function isParkedNextFire(nextFireAt: Date | null): boolean {
  return nextFireAt instanceof Date && nextFireAt.getTime() === NEXT_FIRE_PARKED.getTime();
}

export async function listDueCronRoutines(sql: Sql): Promise<RoutineRow[]> {
  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.routines
     WHERE active = TRUE
       AND trigger_kind = 'cron'
       AND tier = 'durable'
       AND (next_fire_at IS NULL OR next_fire_at <= now())
     ORDER BY next_fire_at ASC NULLS FIRST
  `;
  return rows.map(rowToRoutine);
}

/**
 * Active EPHEMERAL routines (tier='ephemeral', active) — the per-host ephemeral executor's
 * arm-set (schedule-inventory-and-ephemeral-tier-2026-06-26 P-012 / D-006). These ride the
 * in-process scheduled-registry, NOT the DBOS tick (they are excluded from listDueCronRoutines
 * by the `tier='durable'` filter), so there is no next_fire_at due-gate here — the executor
 * arms a managed timer per row at its `trigger_config.interval_sec` cadence.
 */
export async function listActiveEphemeralRoutines(sql: Sql): Promise<RoutineRow[]> {
  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.routines
     WHERE active = TRUE
       AND tier = 'ephemeral'
     ORDER BY id ASC
  `;
  return rows.map(rowToRoutine);
}

/**
 * The ARM-STATE rows for code-declared in-process sweeps (`tier='in-process'`, EI-19294826146331487).
 *
 * Deliberately NOT filtered on `active`: a DISABLED sweep is exactly the row the caller needs to
 * find, because absence of a row means "no operator has ever touched this sweep" and must read as
 * ARMED (fail-open). Filtering on active here would make a disabled sweep indistinguishable from an
 * unmanaged one and silently re-arm it on every reconcile.
 *
 * Nothing fires these rows — `listDueCronRoutines` requires `tier='durable'` and
 * `listActiveEphemeralRoutines` requires `tier='ephemeral'`. The row exists so the Automation pane's
 * existing `routines:set` toggle has something to write, and so the reconciler has something to read.
 */
export async function listInProcessSweepRoutines(sql: Sql): Promise<RoutineRow[]> {
  const rows = await sql<any[]>`
    SELECT * FROM harness_shared.routines
     WHERE tier = 'in-process'
     ORDER BY name ASC, id ASC
  `;
  return rows.map(rowToRoutine);
}

/**
 * Per-schedule durable liveness for an ephemeral fire (D-004: UPDATE ONE row per schedule,
 * never INSERT per fire — this is exactly how the EI-1622 workflow_status bloat is avoided by
 * construction). Stamps last_fired_at; on error records metadata.last_error/last_error_at, on
 * success clears last_error.
 */
export async function recordEphemeralFire(sql: Sql, routineId: string, error: string | null): Promise<void> {
  const metaPatch = JSON.stringify(
    error == null
      ? { last_error: null, last_error_at: null }
      : { last_error: error, last_error_at: new Date().toISOString(), last_error_source: 'ephemeral-executor' },
  );
  await sql`
    UPDATE harness_shared.routines
       SET last_fired_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || ${metaPatch}::text::jsonb,
           updated_at = now()
     WHERE id = ${routineId}
  `;
}

/**
 * Fire a routine: insert pending_event + advance routine's next_fire_at.
 *
 * Returns the event ID + computed next_fire_at, or null if skipped due to
 * concurrency policy.
 */
export async function fireRoutine(
  sql: Sql,
  routine: RoutineRow,
  computeNextFireAt: (cronExpr: string, from: Date) => Date | null
): Promise<{ eventId: string; nextFireAt: Date | null } | null> {
  const fire = async (db: Sql): Promise<{ eventId: string; nextFireAt: Date | null } | null> => {
    // The concurrency check and the insert must share a transaction-scoped lock.
    // A plain SELECT followed by INSERT lets two hosts both observe no prior event
    // and create duplicate `skip` fires (EI-20711970611053452). The lock is scoped
    // to this routine only and is released automatically when the transaction ends.
    if (routine.concurrency === 'skip' || routine.concurrency === 'cancel-prev') {
      await db`
        SELECT pg_advisory_xact_lock(hashtextextended(${routine.id}, 0))
      `;
      const prior = await db<{ id: string }[]>`
        SELECT id FROM harness_shared.pending_events
         WHERE source_id = ${routine.id} AND consumed_at IS NULL
      `;
      if (prior.length > 0) {
        if (routine.concurrency === 'skip') {
          const next = routine.triggerConfig.cron
            ? computeNextFireAt(routine.triggerConfig.cron, new Date())
            : null;
          await db`
            UPDATE harness_shared.routines
               SET last_fired_at = now(), next_fire_at = ${next ? next.toISOString() : null}::timestamptz, updated_at = now()
             WHERE id = ${routine.id}
          `;
          return null;
        }
        // cancel-prev: consume all prior unconsumed events from this routine
        await db`
          UPDATE harness_shared.pending_events
             SET consumed_at = now(), consumed_by = 'routine-ticker:cancel-prev'
           WHERE source_id = ${routine.id} AND consumed_at IS NULL
        `;
      }
    }

    // Insert the pending event.
    const event = await insertPendingEvent(db, {
      workspaceId: routine.workspaceId,
      installSlug: routine.installSlug,
      kind: 'routine',
      targetRole: routine.targetRole,
      payload: {
        routine_name: routine.name,
        ...(routine.payloadTemplate ?? {}),
      },
      sourceId: routine.id,
    });

    // Advance next_fire_at.
    const next = routine.triggerConfig.cron
      ? computeNextFireAt(routine.triggerConfig.cron, new Date())
      : null;
    await db`
      UPDATE harness_shared.routines
         SET last_fired_at = now(), next_fire_at = ${next ? next.toISOString() : null}::timestamptz, updated_at = now()
       WHERE id = ${routine.id}
    `;

    return { eventId: event.id, nextFireAt: next };
  };

  // Only policies whose decision depends on pending-event state need a transaction.
  // Queue retains its existing behavior and avoids an unnecessary transaction.
  if (routine.concurrency === 'skip' || routine.concurrency === 'cancel-prev') {
    return sql.begin(async (tx) => fire(tx as unknown as Sql));
  }
  return fire(sql);
}

export async function upsertRoutine(
  sql: Sql,
  input: {
    /** Owning workspace — `harness_shared.routines.workspace_id` is NOT NULL with no
     *  column default and no fill trigger, so the caller MUST supply it (resolve via
     *  the active-workspace registry / the project's workspace_id). */
    workspaceId: string;
    installSlug: string;
    name: string;
    triggerKind: 'cron' | 'webhook' | 'api';
    triggerConfig: Record<string, unknown>;
    targetRole: string;
    payloadTemplate?: Record<string, unknown> | null;
    concurrency?: 'queue' | 'skip' | 'cancel-prev';
    catchup?: 'skip-old' | 'run-all-backlog';
    active?: boolean;
    /** Explicit next fire time — a ONE-SHOT routine (cron-kind, no cron expr,
     *  fires once at this instant and is deactivated on claim). Overrides the
     *  cron-derived computation when present. */
    nextFireAt?: Date | null | 'infinity';
    /** LOOP interval in seconds (P-001) — re-fire N sec after the turn completes.
     *  Omit/NULL for a non-loop (cron/rrule/one-shot) routine. */
    rescheduleIntervalSec?: number | null;
    /** The coord ownerId a loop's warm wake is delivered to (P-004). Omit/NULL for
     *  a non-loop routine. */
    targetOwnerId?: string | null;
  },
  computeNextFireAt: (cronExpr: string, from: Date) => Date | null
): Promise<RoutineRow> {
  const id = `rt_${input.installSlug}_${input.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const nextFireAt =
    'nextFireAt' in input && input.nextFireAt !== undefined
      ? input.nextFireAt
      : input.triggerKind === 'cron' && input.triggerConfig.cron
        ? computeNextFireAt(String(input.triggerConfig.cron), new Date())
        : null;

  const triggerConfigStr = JSON.stringify(input.triggerConfig);
  const payloadTemplateStr = input.payloadTemplate ? JSON.stringify(input.payloadTemplate) : null;
  // PURE loops use the timestamptz infinity sentinel while an in-flight turn is
  // settling. The initial cold-loop arm uses the same sentinel before its first
  // carry-note exists, so the routine ticker cannot claim it during a long arm.
  const nextFireAtStr = nextFireAt === 'infinity' ? 'infinity' : nextFireAt ? nextFireAt.toISOString() : null;
  // EI-2019 / EI-2082 / EI-2123 / EI-2000 — the routines_pkey duplicate-key cluster.
  // `id` (the PRIMARY KEY) is derived deterministically from (install_slug, name) above, so it
  // IS the routine's canonical identity. The upsert must arbitrate on the id PK — NOT the
  // composite (workspace_id, install_slug, name) — even when per-workspace routines are on:
  // in phase 1 the global UNIQUE(install_slug, name) is still present (migration 305 is
  // ADDITIVE), so a re-arm under a workspace_id that differs from the existing row's (how the
  // live hive/overwatch declare-wake + watchdog fallback-arm drift) MISSES the composite target
  // and the fallthrough INSERT then collides on routines_pkey — wedging every later time wake.
  // Conflicting on the id PK is idempotent in BOTH flag states (a re-arm always matches-and-
  // UPDATEs in place — incl. after a dropped-response partial commit), and since the SET below
  // never touches workspace_id the existing row's workspace is PRESERVED (the anti-clobber
  // intent F-E1 wanted) — no flip, no throw, no wedge. The legacy OFF path conflicts on
  // (install_slug, name), which is equivalent to (id) since id↔(install_slug, name); kept
  // byte-identical. Phase-2 per-workspace coexistence = drop the global unique + fold
  // workspace_id into the id, after which ON CONFLICT (id) is per-workspace automatically.
  const conflictTarget = routinesPerWorkspaceConflict
    ? sql`(id)`
    : sql`(install_slug, name)`;
  const rescheduleIntervalSec =
    input.rescheduleIntervalSec === undefined ? null : input.rescheduleIntervalSec;
  const targetOwnerId = input.targetOwnerId === undefined ? null : input.targetOwnerId;
  const rows = await sql<any[]>`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at, workspace_id,
       reschedule_interval_sec, target_owner_id)
    VALUES (
      ${id},
      ${input.installSlug},
      ${input.name},
      ${input.triggerKind},
      ${triggerConfigStr}::text::jsonb,
      ${input.targetRole},
      ${payloadTemplateStr}::text::jsonb,
      ${input.concurrency ?? 'queue'},
      ${input.catchup ?? 'skip-old'},
      ${input.active ?? true},
      ${nextFireAtStr}::timestamptz,
      ${input.workspaceId},
      ${rescheduleIntervalSec},
      ${targetOwnerId}
    )
    ON CONFLICT ${conflictTarget} DO UPDATE SET
      trigger_kind            = EXCLUDED.trigger_kind,
      trigger_config          = EXCLUDED.trigger_config,
      target_role             = EXCLUDED.target_role,
      payload_template        = EXCLUDED.payload_template,
      concurrency             = EXCLUDED.concurrency,
      catchup                 = EXCLUDED.catchup,
      active                  = EXCLUDED.active,
      -- EI-6786: a loop row PARKED at the 'infinity' in-flight sentinel (NEXT_FIRE_PARKED)
      -- must stay parked across a re-arm (e.g. loop:arm widening/narrowing intervalSec on
      -- an already-active loop, called from WITHIN the very turn its own fire is running).
      -- Unconditionally overwriting next_fire_at with EXCLUDED's freshly-computed timestamp
      -- would UN-PARK a currently in-flight loop: it defeats the skip-if-in-flight due-guard
      -- AND, once the turn later settles, the completion-rebase (reconcile-loop-routines.ts)
      -- can no longer find it — its query keys specifically on next_fire_at='infinity' — so
      -- the loop is never re-armed off the fresh reschedule_interval_sec at all. 'infinity'
      -- is EXCLUSIVELY the loop-parked sentinel (never used by cron/webhook/one-shot rows),
      -- so preserving it here is safe for every OTHER upsertRoutine caller too.
      next_fire_at            = CASE WHEN harness_shared.routines.next_fire_at = 'infinity'::timestamptz
                                      THEN harness_shared.routines.next_fire_at
                                      ELSE EXCLUDED.next_fire_at END,
      reschedule_interval_sec = EXCLUDED.reschedule_interval_sec,
      target_owner_id         = EXCLUDED.target_owner_id,
      updated_at              = now()
    RETURNING *
  `;
  return rowToRoutine(rows[0]);
}

export async function setRoutineActive(
  sql: Sql,
  installSlug: string,
  name: string,
  active: boolean
): Promise<boolean> {
  const result = await sql`
    UPDATE harness_shared.routines
       SET active = ${active}, updated_at = now()
     WHERE install_slug = ${installSlug} AND name = ${name}
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}

export async function deleteRoutine(sql: Sql, installSlug: string, name: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${name}
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}

/**
 * Normalize a raw next_fire_at into the RoutineRow JS shape. postgres-js parses
 * `infinity`::timestamptz (the loop parked sentinel) to an INVALID Date
 * (getTime()===NaN); map that to NEXT_FIRE_PARKED (a valid far-future Date) so JS
 * readers stay correct (.toISOString(), .getTime() <= now() === false, sorts last)
 * and consistent with the SQL not-due semantics. A real finite Date passes through;
 * NULL stays NULL.
 */
export function normalizeNextFireAt(raw: unknown): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? NEXT_FIRE_PARKED : raw;
  // postgres-js gives a Date for timestamptz; a non-Date here is unexpected, but be
  // robust — try to parse, and treat an unparseable value as the parked sentinel.
  const d = new Date(raw as any);
  return Number.isNaN(d.getTime()) ? NEXT_FIRE_PARKED : d;
}

function rowToRoutine(row: any): RoutineRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    installSlug: row.install_slug,
    name: row.name,
    triggerKind: row.trigger_kind,
    triggerConfig: row.trigger_config,
    targetRole: row.target_role,
    payloadTemplate: row.payload_template,
    concurrency: row.concurrency,
    catchup: row.catchup,
    // Defensive default: a row from a DB where migration 408 hasn't applied yet
    // (or a hand-built test row) has no `tier` → treat as durable (the column default).
    tier: row.tier ?? 'durable',
    active: row.active,
    lastFiredAt: row.last_fired_at,
    nextFireAt: normalizeNextFireAt(row.next_fire_at),
    rescheduleIntervalSec:
      row.reschedule_interval_sec == null ? null : Number(row.reschedule_interval_sec),
    targetOwnerId: row.target_owner_id ?? null,
  };
}
