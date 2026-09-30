/**
 * @papercusp/backup — per-workspace kopia backup system.
 *
 * Each workspace gets its own kopia repository under
 * `<workspaceRoot>/backups/kopia-repo`. The package shells out to the
 * kopia CLI for snapshot/restore/verify/maintenance, stores snapshot +
 * settings + destination metadata in SQL, runs a pre-snapshot DB-dump
 * hook, schedules interval + event-triggered snapshots, and sweeps
 * orphaned snapshot rows.
 *
 * It is host-agnostic: the org Postgres handle, the workspaces-root
 * path, the schema bootstrap, and the embedded-pg admin URL are all
 * injected via `configureBackup(host)` (see ./config). The package
 * carries no `@papercusp/*` / `@papercusp/*` runtime dependency.
 *
 * The self-exclusion guard (`IGNORE_PATTERNS` must contain `backups`)
 * is load-bearing — without it the kopia repo recursively snapshots its
 * own pack files and balloons toward 1TB. See ./policy.
 */

export {
  configureBackup,
  configureBackupStepRunner,
  type BackupHost,
  type BackupIntervalHandle,
  type BackupIntervalScheduler,
  type BackupMigrationLock,
  type BackupMigrationLockOptions,
  type BackupMigrationLockWaitInfo,
  type BackupMigrationLockWaitReporter,
  type IntervalSnapshotAdmission,
} from './config';
export {
  WorkspaceBackup,
  mergeRepoStatsWithKopia,
  type WorkspaceBackupOpts,
} from './workspace-backup';
export {
  RETENTION_PRESETS,
  passthroughStepRunner,
  type BackupSettings,
  type CadenceMode,
  type LiveBackupSession,
  type RepoStats,
  type RestoreResult,
  type RetentionPolicy,
  type RetentionPreset,
  type SnapshotInfo,
  type SnapshotResult,
  type SnapshotTriggerReason,
  type StepRunner,
  type VerifyResult,
} from './types';
export {
  PRE_DESTRUCTIVE_SNAPSHOT_SCHEMA_MIGRATION,
  PRE_DESTRUCTIVE_SNAPSHOT_TRIGGER,
  completedPreDestructiveSnapshotQuerySql,
  evaluateLatestPreDestructiveSnapshot,
  isCompletedPreDestructiveSnapshotReceipt,
  preDestructiveSnapshotAdmissionGuardSql,
  requiresPreDestructiveSnapshotAdmission,
  type PreDestructiveSnapshotAdmission,
  type PreDestructiveSnapshotAdmissionReason,
  type PreDestructiveSnapshotReceiptLike,
} from './snapshot-admission';
export { deriveRepoPassword } from './password';
export {
  BACKUP_APPLICATION_NAMES,
  HOST_BACKUP_APPLICATION_NAME,
  WORKSPACE_BACKUP_APPLICATION_NAME,
} from './application-names';
export { workspaceBackupFor } from './singleton';
export {
  startKopiaServer,
  stopKopiaServer,
  kopiaServerStatus,
  type KopiaServerInfo,
} from './server';
export {
  runBackupSchedulerTick,
  stopBackupScheduler,
  triggerSnapshotEvent,
  getKopiaDetection,
} from './scheduler';
export {
  sweepOrphanSnapshots,
  stopOrphanSweepWorker,
  type SweepResult,
} from './orphan-cleanup';
export {
  sweepRecoveryDebris,
  sweepRecoveryDebrisTick,
  DEFAULT_DEBRIS_MAX_AGE_MS,
  type DebrisSweepResult,
} from './recovery-debris-cleanup';
export {
  sweepRestoredClones,
  sweepRestoredClonesTick,
  DEFAULT_RESTORED_CLONE_MAX_AGE_MS,
  type RestoredCloneKeepReason,
  type RestoredCloneProtection,
  type RestoredCloneSweepResult,
} from './restored-clone-cleanup';
export type { DestinationType, DestinationConfig } from './destinations';
export { IGNORE_PATTERNS, SELF_EXCLUSION_RULES, diffPolicyIgnores } from './policy';
