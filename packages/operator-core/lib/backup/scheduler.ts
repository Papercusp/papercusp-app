/**
 * Operator deep-path shim for `@/lib/backup/scheduler`.
 *
 * The scheduler now lives in `@papercusp/backup`. This shim re-exports
 * the scheduler surface and imports `./configure` for its side-effect so
 * consumers that import this path directly (e.g. the backups healthcheck
 * route) get the host seams wired without going through `./index`.
 */

import './configure';

export {
  getKopiaDetection,
  stopBackupScheduler,
  triggerSnapshotEvent,
} from '@papercusp/backup';
