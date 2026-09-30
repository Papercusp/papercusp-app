/**
 * code-run-nudge-telemetry — record each inline batch-nudge FIRE
 * (code-run-self-state-adoption-2026-07-03 P-005).
 *
 * The nudge had A/B kill-switch flags but its fires were invisible: you could flip
 * CODE_RUN_FANOUT_NUDGE and compare adoption windows, yet never compute the direct
 * funnel — "of sessions that were nudged, how many then called code:run?". This
 * writes one narrow row per fire (mig 482) so the conversion is a single SQL join
 * against tool_invocations by session key.
 *
 * FIRE-AND-FORGET by contract: called from the MCP tools/call hot path, so it must
 * never throw, never block the result (no await at the call site), and never spam
 * the log (one warn per process on persistent failure). Nudge fires are rare
 * (window + exponential-backoff gated), so per-fire inserts need no batching.
 */
import { getOrgPg } from '@papercusp/db-org';
import { PREFERRED_DOOR_NORMS, sqlNormList } from './code-run-batch-nudge';
import type { BatchNudgeKind } from './code-run-batch-nudge';

export interface BatchNudgeFire {
  /** The nudge module's per-session key (replayOwnerKey = uiClientId ?? spawnId). */
  sessionKey: string;
  role: string;
  kind: BatchNudgeKind;
  /** The tool call the hint was attached to. */
  toolName: string;
  workspaceId: string;
}

let warnedOnce = false;

/** Insert a fire row, best-effort. Returns the in-flight promise for tests; callers on the
 *  hot path deliberately do NOT await it. */
export function recordBatchNudgeFire(fire: BatchNudgeFire): Promise<void> {
  const work = (async (): Promise<void> => {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.code_run_nudge_fires
        (workspace_id, session_key, role, kind, tool_name)
      VALUES
        (${fire.workspaceId}, ${fire.sessionKey}, ${fire.role}, ${fire.kind}, ${fire.toolName})`;
  })().catch((err: unknown) => {
    if (!warnedOnce) {
      warnedOnce = true;
       
      console.warn(
        `[code-run-nudge-telemetry] fire insert failed (further failures silent): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  });
  return work;
}

/** The nudge→conversion read (P-005): of sessions nudged in the window, how many called a
 *  PREFERRED DOOR (code:run / recipes:run / orchestrate:run — the set is interpolated from
 *  PREFERRED_DOOR_NORMS, never restated) AFTER their first nudge? Runnable via dev:pg_query; also consumed
 *  by dev:code_run_adoption. $1 = window days. */
export const NUDGE_CONVERSION_SQL = `
WITH fires AS (
  SELECT session_key, min(fired_at) AS first_fire
  FROM harness_shared.code_run_nudge_fires
  WHERE fired_at >= now() - (($1)::int || ' days')::interval
  GROUP BY session_key
),
converted AS (
  SELECT f.session_key
  FROM fires f
  WHERE EXISTS (
    SELECT 1 FROM harness_shared.tool_invocations ti
    WHERE ti.invoked_at >= f.first_fire
      AND ti.invoked_at >= now() - (($1)::int || ' days')::interval
      AND lower(regexp_replace(ti.tool_name, '[^a-zA-Z0-9]', '', 'g')) IN (${sqlNormList(PREFERRED_DOOR_NORMS)})
      AND (ti.spawn_id = f.session_key OR ti.run_id = f.session_key)
  )
)
SELECT
  (SELECT count(*) FROM fires)::int     AS nudged_sessions,
  (SELECT count(*) FROM converted)::int AS converted_sessions
`;
