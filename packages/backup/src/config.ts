import type { Sql } from 'postgres';
import { passthroughStepRunner, type StepRunner } from './types';

/**
 * Host-owned admission decision for an interval snapshot.
 *
 * The backup package deliberately does not know about release qualification or
 * serializer authority. Embedders that do can defer only the recurring path;
 * an absent reader preserves the package's standalone behavior.
 */
export type IntervalSnapshotAdmission =
  | { status: 'admit' }
  | {
      status: 'defer';
      reason: string;
      evidence?: Record<string, unknown>;
    };

/** Options for acquiring the direct-session migration rendezvous. */
export interface BackupMigrationLockWaitInfo {
  /** Stable key used by backup producers and migration appliers. */
  lockKey: string;
  /** Milliseconds since this producer observed the lock as busy. */
  waitedMs: number;
  /** Point-in-time holder metadata; all fields are nullable when the holder raced away. */
  holderPid: number | null;
  holderApplicationName: string | null;
  holderState: string | null;
  holderQueryStartedAt: string | null;
}

export type BackupMigrationLockWaitReporter = (
  info: BackupMigrationLockWaitInfo,
) => void | Promise<void>;

export interface BackupMigrationLockOptions {
  /** Return immediately with `undefined` when another producer holds the lock. */
  tryOnly?: boolean;
  /** Report a blocking wait and repeat while the lock remains held. */
  onWaiting?: BackupMigrationLockWaitReporter;
}

/** A held direct-session migration rendezvous for a backup snapshot. */
export interface BackupMigrationLock {
  /** Release the session lock and close any host-owned session. */
  release: () => Promise<void>;
}

/** Handle returned by the optional host-owned recurring timer seam. */
export interface BackupIntervalHandle {
  stop: () => void;
}

/**
 * Host-owned scheduler for package timers. The package passes a stable name so
 * an embedding host can register the timer in its own inventory without making
 * the host-agnostic backup package depend on that registry at runtime.
 */
export type BackupIntervalScheduler = (
  name: string,
  intervalMs: number,
  callback: () => void | Promise<void>,
) => BackupIntervalHandle;

/**
 * Host seam for `@papercusp/backup`.
 *
 * The package shells out to the kopia CLI and stores snapshot / settings
 * / destination metadata in SQL, but it does NOT know how to resolve the
 * org Postgres handle, the workspaces-root path, the schema bootstrap, or
 * the embedded-pg admin URL — those are the embedding application's
 * concerns, injected here. This keeps the package free of any
 * `@papercusp/*` / `@papercusp/*` runtime dependency.
 */
export interface BackupHost {
  /**
   * The org Postgres handle (postgres-js tagged template). Called per use
   * (not cached) so the host can run its own connection change-detection.
   */
  getSql: () => Sql;
  /** Absolute path to the workspaces root; each workspace is a subdir. */
  workspacesRoot: () => string;
  /** Ensure the backup metadata tables exist before first use. */
  ensureSchema: () => Promise<void>;
  /**
   * Resolve the embedded-pg admin URL (+ provenance) for the pre-snapshot
   * DB dump written into each snapshot.
   */
  getHarnessAdminUrl: () => { url: string; source: string };
  /**
   * Optional direct-session advisory rendezvous shared with migration appliers.
   * The returned handle owns its session and must be released after the whole
   * snapshot (including its metadata row and final status) completes. Absent ⇒
   * standalone backup behavior is unchanged.
   */
  acquireMigrationLock?: (
    options?: BackupMigrationLockOptions,
  ) => Promise<BackupMigrationLock | undefined>;
  /**
   * Optional named interval scheduler for lifecycle heartbeats. When absent,
   * the package uses its dependency-free unref'd timeout fallback.
   */
  scheduleInterval?: BackupIntervalScheduler;
  /**
   * Optional, workspace-scoped rendezvous consulted immediately before a due
   * interval snapshot mutates scheduler state. Throwing, malformed, and
   * explicit defer results all fail closed for that tick and retry later.
   * Manual and event/pre-destructive snapshots never consult this seam.
   */
  readIntervalSnapshotAdmission?: (
    workspaceId: string,
  ) => Promise<IntervalSnapshotAdmission>;
  /**
   * Optional: return true to skip the current orphan-sweep cycle — e.g. a
   * battery-aware pause that defers disk-waking work. Absent ⇒ always run
   * (the sweep is a cheap indexed range scan + UPDATE on ~0 rows in steady
   * state).
   */
  shouldPauseSweep?: () => boolean;
}

let _host: BackupHost | null = null;

/**
 * Wire the host seams. The embedding application calls this once at
 * startup, before any backup API is used.
 */
export function configureBackup(host: BackupHost): void {
  _host = host;
}

/** Internal: read the configured host, throwing if unconfigured. */
export function backupHost(): BackupHost {
  if (!_host) {
    throw new Error(
      '@papercusp/backup: configureBackup() must be called before using the backup API',
    );
  }
  return _host;
}

/**
 * Optional durability seam (D-010 / P-011), kept ORTHOGONAL to the data host
 * above so the heavy DBOS import lives only in the operator module that wires
 * this — not in the always-loaded `configureBackup` call. Unset ⇒ the
 * pass-through runner, so backup behavior is unchanged when no host injects one.
 */
let _stepRunner: StepRunner | null = null;

/**
 * Inject a durability runner. The operator calls this from its DBOS bootstrap
 * (gated behind the backup flag) to map `runStep → DBOS.runStep`; pass `null`
 * to revert to the pass-through. Generic + reusable by any borrowable lib.
 */
export function configureBackupStepRunner(runner: StepRunner | null): void {
  _stepRunner = runner;
}

/** Read the active step runner, defaulting to the no-op pass-through. */
export function backupStepRunner(): StepRunner {
  return _stepRunner ?? passthroughStepRunner;
}
