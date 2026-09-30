/**
 * Operator barrel for the backup system.
 *
 * The implementation lives in `@papercusp/backup` (extracted per
 * papercusp-systems-abstraction-2026-05-29, P-023/P-024). This file
 * wires the operator host seams (via the `./configure` side-effect) and
 * re-exports the package surface so the `@/lib/backup` consumers resolve
 * unchanged.
 */

import './configure';

export {
  WorkspaceBackup,
  mergeRepoStatsWithKopia,
  workspaceBackupFor,
  deriveRepoPassword,
  startKopiaServer,
  stopKopiaServer,
  kopiaServerStatus,
  stopBackupScheduler,
  triggerSnapshotEvent,
  sweepRestoredClones,
  sweepRestoredClonesTick,
  DEFAULT_RESTORED_CLONE_MAX_AGE_MS,
  type RestoredCloneKeepReason,
  type RestoredCloneProtection,
  type RestoredCloneSweepResult,
  getKopiaDetection,
  RETENTION_PRESETS,
  type BackupSettings,
  type CadenceMode,
  type RepoStats,
  type RestoreResult,
  type RetentionPolicy,
  type RetentionPreset,
  type SnapshotInfo,
  type SnapshotResult,
  type SnapshotTriggerReason,
  type VerifyResult,
  type KopiaServerInfo,
  type DestinationType,
  type DestinationConfig,
} from '@papercusp/backup';
