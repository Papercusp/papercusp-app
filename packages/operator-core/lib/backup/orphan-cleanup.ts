/**
 * Operator deep-path shim for `@/lib/backup/orphan-cleanup`.
 *
 * The orphan sweep now lives in `@papercusp/backup`. This shim re-exports
 * its surface and imports `./configure` for its side-effect so consumers
 * that import this path directly (the admin orphan-cleanup route, the
 * boot worker, and orphan-cleanup.test.ts) get the host seams wired
 * without going through `./index`.
 */

import './configure';

export {
  sweepOrphanSnapshots,
  stopOrphanSweepWorker,
  type SweepResult,
} from '@papercusp/backup';
