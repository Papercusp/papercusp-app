/**
 * GET /api/backups/healthcheck — UI banner data.
 *
 * Ported from app/api/backups/healthcheck/route.ts. `auth: 'public'`.
 */
import { statfs } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { workspaceBackupFor } from '../../../backup';
import { getKopiaDetection } from '../../../backup/scheduler';
import { activeWorkspaceId, workspacesRoot } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const statfsP = promisify(statfs);
const STALE_THRESHOLD_SEC = 30 * 60;

export type BackupHealthState = 'ok' | 'stale' | 'failing' | 'disabled' | 'never_run';

/**
 * PURE: classify the UI-facing backup health state from the durable rollup.
 *
 * `lastSnapshotAt` is the newest snapshot whose Kopia artifact and database
 * dump are both explicitly known-good. A failed/degraded row must remain
 * visible even when no complete snapshot is known, rather than being
 * misreported as `never_run`.
 */
export function classifyBackupHealth(
  enabled: boolean,
  stats: {
    lastSnapshotAt: string | null;
    lastFailureAt: string | null;
  },
  nowMs: number,
): { state: BackupHealthState; ageSeconds: number | null } {
  if (!enabled) return { state: 'disabled', ageSeconds: null };

  const lastSnapshotMs = stats.lastSnapshotAt ? new Date(stats.lastSnapshotAt).getTime() : null;
  const lastFailureMs = stats.lastFailureAt ? new Date(stats.lastFailureAt).getTime() : null;
  const ageSeconds =
    lastSnapshotMs !== null && Number.isFinite(lastSnapshotMs)
      ? Math.round((nowMs - lastSnapshotMs) / 1000)
      : null;
  if (
    lastFailureMs !== null &&
    Number.isFinite(lastFailureMs) &&
    (lastSnapshotMs === null || !Number.isFinite(lastSnapshotMs) || lastFailureMs > lastSnapshotMs)
  ) {
    return { state: 'failing', ageSeconds };
  }
  if (lastSnapshotMs === null || !Number.isFinite(lastSnapshotMs)) {
    return { state: 'never_run', ageSeconds: null };
  }

  // `ageSeconds` is non-null on every path that reaches here — it is null only when
  // lastSnapshotMs is null/non-finite, which the `never_run` guard above already returned
  // on. TypeScript cannot carry that correlation across the two separate consts, so the
  // null case is spelled out rather than asserted away: an unaged snapshot is not stale.
  return {
    state: ageSeconds !== null && ageSeconds > STALE_THRESHOLD_SEC ? 'stale' : 'ok',
    ageSeconds,
  };
}

export default defineTool({
  method: 'GET',
  path: '/backups/healthcheck',
  auth: 'public',
  async handler() {
    try {
      const ws = activeWorkspaceId();
      const wb = workspaceBackupFor(ws);
      const [settings, stats] = await Promise.all([wb.getSettings(), wb.stats()]);

      const classified = classifyBackupHealth(settings.enabled, stats, Date.now());
      let state = classified.state;
      const { ageSeconds } = classified;

      let freeDiskBytes: number | null = null;
      try {
        const fs = await statfsP(workspacesRoot());
        freeDiskBytes = Number(fs.bavail) * fs.bsize;
      } catch { /* optional */ }

      const kopia = getKopiaDetection();
      if (!kopia.ok) state = 'failing';

      return Response.json({
        state,
        ageSeconds,
        lastOkAt: stats.lastSnapshotAt,
        lastFailureAt: stats.lastFailureAt,
        freeDiskBytes,
        staleThresholdSec: STALE_THRESHOLD_SEC,
        kopia,
      });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});
