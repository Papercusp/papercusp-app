export type CadenceMode = 'event' | 'interval' | 'both';

export type RetentionPreset = 'aggressive' | 'default' | 'conservative' | 'custom';

export interface RetentionPolicy {
  keepLatest: number;
  keepHourly: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export const RETENTION_PRESETS: Record<Exclude<RetentionPreset, 'custom'>, RetentionPolicy> = {
  aggressive:   { keepLatest: 10,  keepHourly: 24, keepDaily: 7,  keepWeekly: 4,  keepMonthly: 3  },
  default:      { keepLatest: 24,  keepHourly: 48, keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
  conservative: { keepLatest: 100, keepHourly: 96, keepDaily: 90, keepWeekly: 26, keepMonthly: 36 },
};

/**
 * A workspace snapshot includes a database hook and repository maintenance;
 * minute-scale interval schedules multiply that work across every workspace.
 * Event-triggered snapshots remain immediate, while recurring sweeps keep a
 * one-hour floor.
 */
export const MIN_INTERVAL_CADENCE_MINUTES = 60;

export function assertSafeBackupCadence(mode: CadenceMode, minutes: number): void {
  if (mode !== 'event' && minutes < MIN_INTERVAL_CADENCE_MINUTES) {
    throw new Error(
      `interval backup cadence must be at least ${MIN_INTERVAL_CADENCE_MINUTES} minutes; use event mode for immediate lifecycle snapshots`,
    );
  }
}

/**
 * Why a snapshot was taken.
 *
 * `manual` and `interval` are intrinsic to this package — the scheduler
 * produces them, and they're excluded from the event-trigger surface
 * (see `scheduler.ts`). Every other reason is an EVENT trigger owned by
 * the embedding application's lifecycle, so the type is left open
 * (`string & {}`) rather than enumerating harness-specific reasons here
 * (P-024). The operator's current event vocabulary: `pre_destructive`,
 * `post_run`, `plugin_install`, `secret_change`, `startup`.
 */
export type SnapshotTriggerReason = 'manual' | 'interval' | (string & {});

export interface SnapshotInfo {
  id: number;
  kopiaSnapshotId: string | null;
  workspaceId: string;
  startedAt: string;
  finishedAt: string | null;
  /**
   * Whether the pre-snapshot database dump landed. `null` is deliberate:
   * rows written before this field existed (or by a resumed workflow whose
   * cached hook result is unavailable) are unknown, never inferred as good.
   */
  dbDumpOk?: boolean | null;
  /**
   * `degraded` = the kopia snapshot succeeded but the pre-snapshot DB dump did
   * not land, so the captured tree carries a stale database. Distinct from
   * `failed` (no usable snapshot at all) because the file tree IS restorable —
   * and distinct from `ok` because a health surface must not read it as a
   * complete backup (EI-20109034777197353).
   */
  status: 'running' | 'ok' | 'degraded' | 'failed' | 'aborted';
  triggerReason: SnapshotTriggerReason;
  triggerContext: Record<string, unknown> | null;
  bytesAdded: number | null;
  bytesTotal: number | null;
  sources: string[];
  error: string | null;
}

/**
 * A currently-active PostgreSQL session belonging to EITHER backup producer
 * (`packages/backup/src/application-names.ts`) — the per-workspace kopia
 * hook or the independent host-level cron `pg_dump` — regardless of whether
 * it has any receipt row in `harness_shared.backup_snapshots`.
 *
 * This is deliberately session-shaped, not snapshot-shaped: it exists to
 * answer "is a backup holding relation locks on this database RIGHT NOW",
 * which `SnapshotInfo`'s receipt rows cannot answer for the host producer at
 * all (EI-22064935119941678 — `backup:snapshot_list` reported an all-clear
 * while host-cron `pcbackup` sessions still held `AccessShareLock`).
 */
export interface LiveBackupSession {
  pid: number;
  applicationName: string;
  state: string;
  xactStartedAt: string | null;
  queryStartedAt: string | null;
  /** Seconds since the session's transaction (or query, if none) started; null if neither is set. */
  ageSec: number | null;
}

export type DestinationType = 'local' | 'local+s3' | 'local+b2' | 'local+rclone';

export interface BackupSettings {
  workspaceId: string;
  enabled: boolean;
  cadenceMode: CadenceMode;
  cadenceMinutes: number;
  retentionPreset: RetentionPreset;
  retentionCustom: RetentionPolicy | null;
  eventTriggers: SnapshotTriggerReason[];
  excludedPaths: string[];
  destinationType: DestinationType;
  /** Truthy iff a destination config is stored (UI doesn't get the secrets). */
  destinationConfigured: boolean;
}

export interface RepoStats {
  totalSnapshots: number;
  bytesOnDisk: number;
  bytesRaw: number;
  dedupRatio: number;
  lastSnapshotAt: string | null;
  lastFailureAt: string | null;
}

export interface SnapshotResult {
  snapshotId: number;
  kopiaSnapshotId: string;
  bytesAdded: number;
  durationMs: number;
  /** Tri-state pre-snapshot database dump outcome; null/absent is unknown. */
  dbDumpOk?: boolean | null;
}

export interface RestoreResult {
  targetPath: string;
  bytesRestored: number;
  fileCount: number;
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

/**
 * Generic, zero-dependency durability seam (dbos-durable-flows-adoption
 * D-010 / P-011). A host can inject an implementation that wraps each named
 * sub-operation as a durable, checkpointed step — e.g. the operator maps
 * `runStep → DBOS.runStep` so a crash mid-op RESUMES from the last completed
 * step instead of re-running the whole flow. Without a host wired the default
 * `passthroughStepRunner` simply runs `fn()`, so the package's behavior is
 * IDENTICAL when nothing is injected.
 *
 * The seam is deliberately generic — it names nothing about backups or DBOS —
 * so any other borrowable lib wanting optional durability can adopt the same
 * one-method contract. This is what lets `@papercusp/backup` keep its "zero
 * @papercusp/@restart runtime deps" borrowable contract while still gaining
 * crash-resume when hosted: DBOS lives entirely host-side, injected here.
 *
 * IMPORTANT — necessary but not sufficient: a StepRunner only buys crash-RESUME
 * when each `fn` is idempotent (replaying a completed step must be a no-op).
 * `snapshot()` (content-addressed kopia create) is ~idempotent and gains
 * durability from the seam alone; the destructive restore/promote/rollback ops
 * are non-idempotent FS renames and need idempotent decomposition first (P-012)
 * before routing them through here pays off.
 */
export interface StepRunner {
  /**
   * Run `fn` as a single durable step labelled `name`. The default
   * implementation just awaits `fn()`; a host implementation checkpoints the
   * result so a resume returns the recorded value without re-running `fn`.
   */
  runStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Default seam: identical behavior to calling `fn()` directly (no host wired). */
export const passthroughStepRunner: StepRunner = {
  runStep: (_name, fn) => fn(),
};
