/**
 * Backup scheduler — interval timer + event trigger entry point.
 *
 * Single in-process timer that wakes every minute, checks each enabled
 * workspace's settings, and fires `snapshot('interval')` if its
 * cadence is due. Per-workspace state (lastFiredAt, in-flight bool)
 * lives in this module's Map; nothing crash-survives, so on operator
 * restart the next due cycle fires immediately.
 *
 * `triggerEvent(workspaceId, reason, context)` is the public hook for
 * event-driven snapshots — call it from pre-destructive code paths,
 * post-run completion, plugin install, secret change. The function
 * checks the workspace's event_triggers_json setting before firing so
 * users can opt individual triggers off without touching the call
 * sites.
 *
 * Idempotency: at most one snapshot per workspace in-flight at any
 * moment. Calls during a running snapshot are dropped silently (logged
 * to backup_events for the UI).
 */

import { spawnSync } from 'node:child_process';
import type { Sql } from 'postgres';
import {
  backupHost,
  type BackupMigrationLock,
  type IntervalSnapshotAdmission,
} from './config';
import { workspaceBackupFor } from './singleton';
import type { SnapshotTriggerReason } from './types';

const TICK_MS = 60_000;
const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';

/** Detect whether kopia is on $PATH at scheduler start. Surface a clear log */
/** so the operator's startup messages explain "no snapshots yet" cleanly. */
function detectKopia(): { ok: boolean; version?: string; reason?: string } {
  try {
    const r = spawnSync(KOPIA_BIN, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) {
      return { ok: true, version: r.stdout.split(/\s+/)[0] };
    }
    return { ok: false, reason: r.stderr?.trim() || `exit ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

let kopiaDetection: { ok: boolean; version?: string; reason?: string } | null = null;
export function getKopiaDetection(): { ok: boolean; version?: string; reason?: string } {
  return kopiaDetection ?? detectKopia();
}

interface WorkspaceTickState {
  lastFiredAt: number;
  inFlight: boolean;
}
const STATE = new Map<string, WorkspaceTickState>();
// Avoid writing the same durable deferral event every minute while a single
// hold remains active. A reason/evidence transition is recorded immediately;
// admission clears the fingerprint so a later recurrence is visible again.
const LAST_INTERVAL_DEFERRAL = new Map<string, string>();

let timer: NodeJS.Timeout | null = null;

/**
 * One backup cadence tick: ensure kopia is detected, then fire snapshots for
 * any workspace whose interval cadence is due. Exposed for the DBOS
 * scheduled-workflow migration (dbos-durable-jobs-2026-05-31 Phase 2, P-011) —
 * the per-workspace dueness + in-flight dedup + PG cadence floor live in tick(),
 * so a DBOS schedule just needs to call this each minute.
 */
export async function runBackupSchedulerTick(): Promise<void> {
  if (!kopiaDetection) kopiaDetection = detectKopia();
  if (!kopiaDetection.ok) return;
  await tick();
}

// Legacy startBackupScheduler removed (dbos-scheduler-consolidation P-005): DBOS
// owns the cadence (periodic-workflows.ts `backupCadence` → runBackupSchedulerTick).
// `runBackupSchedulerTick` above is the single-run tick that workflow calls.

export function stopBackupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  try {
    const sql = backupHost().getSql();
    // Join settings with most-recent snapshot start time so we use a
    // persistent floor for cadence — restarting the operator doesn't
    // re-fire snapshots that just ran in the previous process.
    // postgres.js usually returns timestamptz as Date instances, but
    // under some runtime configs (Turbopack prod build observed in
    // operator's :3070 server) the column comes back as an ISO string.
    // Type widened + `new Date()` coercion below mirrors the pattern
    // used across operator/lib (omp-sessions, operator-scan-lock,
    // spawn-signing, autoloop, cross-harness-data, etc.).
    const rows = await sql<{
      workspace_id: string; cadence_minutes: number; last_started_at: Date | string | null;
    }[]>`
      SELECT s.workspace_id,
             s.cadence_minutes,
             MAX(snap.started_at) AS last_started_at
      FROM harness_shared.workspace_backup_settings s
      LEFT JOIN harness_shared.backup_snapshots snap
             ON snap.workspace_id = s.workspace_id
      WHERE s.enabled = TRUE AND s.cadence_mode IN ('interval', 'both')
      GROUP BY s.workspace_id, s.cadence_minutes
    `;
    const now = Date.now();
    const pendingSnapshots: Promise<void>[] = [];
    for (const r of rows) {
      const mem = STATE.get(r.workspace_id) ?? { lastFiredAt: 0, inFlight: false };
      // Use the larger of in-memory and PG — in-memory wins after a
      // local fire (avoids extra PG round-trip), PG wins after a process
      // restart.
      const pgFloor = r.last_started_at ? new Date(r.last_started_at).getTime() : 0;
      const lastFiredAt = Math.max(mem.lastFiredAt, pgFloor);
      const dueAt = lastFiredAt + r.cadence_minutes * 60_000;
      if (mem.inFlight) continue;
      if (now < dueAt) continue;

      // The rendezvous MUST precede both scheduler mutations below. A defer
      // therefore remains due and is retried on the next cadence tick rather
      // than consuming the interval or masquerading as an in-flight snapshot.
      const admission = await readIntervalAdmission(r.workspace_id);
      if (admission.status === 'defer') {
        await recordIntervalDeferral(sql, r.workspace_id, admission);
        continue;
      }
      LAST_INTERVAL_DEFERRAL.delete(r.workspace_id);

      // The scheduler runs in more than one operator process. Probe the same
      // dedicated-session rendezvous used by WorkspaceBackup before consuming
      // cadence/in-flight state; a blocking acquire here would recreate the
      // cross-process convoy that caused repeated 900s dump watchdog failures.
      // The returned session is transferred into snapshot() and held until its
      // final receipt write, so there is no try-then-release race.
      const lockResult = await tryAcquireIntervalMigrationLock();
      if (lockResult.defer) {
        await recordIntervalDeferral(sql, r.workspace_id, lockResult.defer);
        continue;
      }

      const next: WorkspaceTickState = { lastFiredAt: now, inFlight: true };
      STATE.set(r.workspace_id, next);
      pendingSnapshots.push(
        runSnapshot(r.workspace_id, 'interval', undefined, lockResult.lock).finally(() => {
          const cur = STATE.get(r.workspace_id);
          if (cur) cur.inFlight = false;
        }),
      );
    }
    await Promise.all(pendingSnapshots);
  } catch (err) {
    console.warn('[backup-scheduler] tick failed:', err);
  }
}

interface IntervalMigrationLockResult {
  lock?: BackupMigrationLock;
  defer?: Extract<IntervalSnapshotAdmission, { status: 'defer' }>;
}

async function tryAcquireIntervalMigrationLock(): Promise<IntervalMigrationLockResult> {
  const acquire = backupHost().acquireMigrationLock;
  // Standalone package consumers may not provide a migration applier. Keep
  // their historical behavior: WorkspaceBackup will acquire a blocking lock
  // after it has created the durable snapshot intent row.
  if (!acquire) return {};
  try {
    const lock = await acquire({ tryOnly: true });
    if (lock) return { lock };
    return {
      defer: {
        status: 'defer',
        reason: 'migration-rendezvous-busy',
        evidence: { tryOnly: true },
      },
    };
  } catch (error) {
    return {
      defer: {
        status: 'defer',
        reason: 'migration-rendezvous-unreadable',
        evidence: {
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      },
    };
  }
}

async function readIntervalAdmission(workspaceId: string): Promise<IntervalSnapshotAdmission> {
  const reader = backupHost().readIntervalSnapshotAdmission;
  if (!reader) return { status: 'admit' };
  try {
    const decision = await reader(workspaceId);
    if (decision?.status === 'admit') return decision;
    if (
      decision?.status === 'defer' &&
      typeof decision.reason === 'string' &&
      decision.reason.trim() !== ''
    ) {
      return decision;
    }
    return {
      status: 'defer',
      reason: 'interval-admission-unreadable',
      evidence: { error: 'host returned a malformed interval admission decision' },
    };
  } catch (error) {
    return {
      status: 'defer',
      reason: 'interval-admission-unreadable',
      evidence: {
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      },
    };
  }
}

async function recordIntervalDeferral(
  sql: Sql,
  workspaceId: string,
  decision: Extract<IntervalSnapshotAdmission, { status: 'defer' }>,
): Promise<void> {
  const fingerprint = JSON.stringify({ reason: decision.reason, evidence: decision.evidence });
  if (LAST_INTERVAL_DEFERRAL.get(workspaceId) === fingerprint) return;
  try {
    await sql`
      INSERT INTO harness_shared.backup_events
        (workspace_id, snapshot_id, kind, payload_json)
      VALUES (
        ${workspaceId},
        NULL,
        'interval_deferred',
        ${JSON.stringify({ reason: decision.reason, evidence: decision.evidence ?? null })}::jsonb
      )
    `;
    LAST_INTERVAL_DEFERRAL.set(workspaceId, fingerprint);
  } catch (error) {
    // Admission is still fail-closed even when its best-effort audit row cannot
    // be written; leaving the fingerprint unset retries the record next tick.
    console.warn(
      `[backup-scheduler] failed to record interval deferral for ${workspaceId}:`,
      error,
    );
  }
}

async function runSnapshot(
  workspaceId: string,
  reason: SnapshotTriggerReason,
  context: Record<string, unknown> | undefined,
  migrationLock?: BackupMigrationLock,
): Promise<void> {
  let lockTransferred = false;
  try {
    const wb = workspaceBackupFor(workspaceId);
    const settings = await wb.getSettings();
    if (!settings.enabled) return;
    // Manual snapshots are always explicit and interval snapshots are admitted
    // by tick() above. Every other reason (including startup) is an event: an
    // interval-only schedule must never fire it, and event/both schedules must
    // opt into the individual trigger. Previously cadenceMode was ignored on
    // this path, so selecting "interval" in settings still produced event
    // snapshots whenever a lifecycle hook called triggerSnapshotEvent().
    if (reason !== 'interval' && reason !== 'manual') {
      if (settings.cadenceMode !== 'event' && settings.cadenceMode !== 'both') return;
      if (!settings.eventTriggers.includes(reason)) return;
    }
    if (migrationLock) {
      const snapshotPromise = wb.snapshot(reason, context, { migrationLock });
      lockTransferred = true;
      await snapshotPromise;
    } else {
      await wb.snapshot(reason, context);
    }
  } catch (err) {
    console.warn(`[backup-scheduler] snapshot ${reason} for ${workspaceId} failed:`, err);
  } finally {
    // A settings change can disable a workspace between the scheduler query
    // and this call. In that case no WorkspaceBackup operation receives the
    // probe lock, so release it here rather than leaking the dedicated session.
    if (migrationLock && !lockTransferred) {
      try {
        await migrationLock.release();
      } catch (error) {
        console.warn(
          `[backup-scheduler] migration rendezvous release for ${workspaceId} failed:`,
          error,
        );
      }
    }
  }
}

/**
 * Event-driven snapshot trigger. Safe to call from anywhere; dedupes
 * to at most one in-flight per workspace, respects per-workspace
 * event_triggers setting.
 */
export async function triggerSnapshotEvent(
  workspaceId: string,
  reason: Exclude<SnapshotTriggerReason, 'interval' | 'manual'>,
  context?: Record<string, unknown>,
): Promise<void> {
  const s = STATE.get(workspaceId) ?? { lastFiredAt: 0, inFlight: false };
  if (s.inFlight) return;
  s.inFlight = true;
  STATE.set(workspaceId, s);
  try {
    await runSnapshot(workspaceId, reason, context);
  } finally {
    const cur = STATE.get(workspaceId);
    if (cur) cur.inFlight = false;
  }
}
