/**
 * Per-workspace curation cadence/backoff state (plan curator-operator-2026-06-04,
 * P0). The `autoloop_state` analog for the curation loop: when it last ran /
 * digested + the adaptive interval. Backed by
 * `harness_shared.operator_curation_state` (migration 151).
 */
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { BASE_INTERVAL_SECONDS } from './curation-loop';

export interface CurationState {
  lastRunAtMs: number | null;
  lastDigestAtMs: number | null;
  currentIntervalSeconds: number;
  consecutiveQuiet: number;
  lastSurfacedCount: number;
}

const DEFAULT_STATE: CurationState = {
  lastRunAtMs: null,
  lastDigestAtMs: null,
  currentIntervalSeconds: BASE_INTERVAL_SECONDS,
  consecutiveQuiet: 0,
  lastSurfacedCount: 0,
};

export async function readCurationState(): Promise<CurationState> {
  const ws = activeWorkspaceId();
  const rows = await withWorkspace(ws, async (tx) => {
    return tx<
      {
        last_run_at: string | null;
        last_digest_at: string | null;
        current_interval_seconds: number;
        consecutive_quiet: number;
        last_surfaced_count: number;
      }[]
    >`
      SELECT last_run_at::text, last_digest_at::text, current_interval_seconds,
             consecutive_quiet, last_surfaced_count
        FROM harness_shared.operator_curation_state
       WHERE workspace_id = ${ws}
       LIMIT 1
    `;
  });
  if (!rows.length) return { ...DEFAULT_STATE };
  const r = rows[0];
  return {
    lastRunAtMs: r.last_run_at ? new Date(r.last_run_at).getTime() : null,
    lastDigestAtMs: r.last_digest_at ? new Date(r.last_digest_at).getTime() : null,
    currentIntervalSeconds: Number(r.current_interval_seconds) || BASE_INTERVAL_SECONDS,
    consecutiveQuiet: Number(r.consecutive_quiet) || 0,
    lastSurfacedCount: Number(r.last_surfaced_count) || 0,
  };
}

export interface CurationStatePatch {
  lastRunAtMs?: number;
  lastDigestAtMs?: number;
  currentIntervalSeconds?: number;
  consecutiveQuiet?: number;
  lastSurfacedCount?: number;
}

/** Upsert the workspace's curation state. Only provided fields are written;
 *  omitted fields keep their stored value (COALESCE on update). */
export async function writeCurationState(patch: CurationStatePatch): Promise<void> {
  const ws = activeWorkspaceId();
  const lastRun = patch.lastRunAtMs != null ? new Date(patch.lastRunAtMs).toISOString() : null;
  const lastDigest = patch.lastDigestAtMs != null ? new Date(patch.lastDigestAtMs).toISOString() : null;
  const interval = patch.currentIntervalSeconds ?? null;
  const quiet = patch.consecutiveQuiet ?? null;
  const surfaced = patch.lastSurfacedCount ?? null;
  await withWorkspace(ws, async (tx) => {
    await tx`
      INSERT INTO harness_shared.operator_curation_state
        (workspace_id, last_run_at, last_digest_at, current_interval_seconds,
         consecutive_quiet, last_surfaced_count, updated_at)
      VALUES (
        ${ws},
        ${lastRun},
        ${lastDigest},
        ${interval ?? BASE_INTERVAL_SECONDS},
        ${quiet ?? 0},
        ${surfaced ?? 0},
        now()
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        last_run_at = COALESCE(${lastRun}, harness_shared.operator_curation_state.last_run_at),
        last_digest_at = COALESCE(${lastDigest}, harness_shared.operator_curation_state.last_digest_at),
        current_interval_seconds = COALESCE(${interval}, harness_shared.operator_curation_state.current_interval_seconds),
        consecutive_quiet = COALESCE(${quiet}, harness_shared.operator_curation_state.consecutive_quiet),
        last_surfaced_count = COALESCE(${surfaced}, harness_shared.operator_curation_state.last_surfaced_count),
        updated_at = now()
    `;
  });
}
