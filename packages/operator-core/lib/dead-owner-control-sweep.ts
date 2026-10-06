/** Atomic dead-owner control cleanup (agent-operability P-003). */
import type { Sql } from 'postgres';
import {
  activeSessionHolderFragment,
  parkedHolderFragment,
  STALE_CLAIM_GRACE_MS,
} from './work-items-stale-claims';
import { HELD_AT_EXPR, HOLD_OPEN_GRACE_MS, HOLD_OPEN_PARKED_GRACE_MS } from './work-items-hold-open';
import { POLICY_GATE_REASON_SQL_PATTERNS, recordBulkHoldClearAudit } from './work-items';

export const DEAD_OWNER_CONTROL_GRACE_MS = 2 * 60 * 60 * 1000;

export interface DeadOwnerControlSweepResult {
  owners: string[];
  loopsTerminated: number;
  holdsLifted: number;
}

/**
 * One SQL statement identifies unreachable loop owners past grace, deactivates
 * every active loop they own, and lifts every expired hold they own. CTE update
 * order gives one transaction/snapshot, so an owner cannot be cleaned one loop
 * or one hold per periodic tick.
 */
export async function sweepDeadOwnerControlState(
  sql: Sql,
  opts: { graceMs?: number; parkedGraceMs?: number; ownerGraceMs?: number; holdOpenGraceMs?: number } = {},
): Promise<DeadOwnerControlSweepResult> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const parkedGraceSec = Math.max(graceSec, Math.round((opts.parkedGraceMs ?? HOLD_OPEN_PARKED_GRACE_MS) / 1000));
  const ownerGraceSec = Math.max(1, Math.round((opts.ownerGraceMs ?? DEAD_OWNER_CONTROL_GRACE_MS) / 1000));
  const holdGraceSec = Math.max(1, Math.round((opts.holdOpenGraceMs ?? HOLD_OPEN_GRACE_MS) / 1000));
  const rows = await sql<Array<{ owners: string[] | null; loops_terminated: string | number; holds_lifted: string | number }>>`
    -- WI-42279: use fresh SESSION evidence here, not the broader work-item
    -- holder set that includes armed loops. This sweep owns retiring abandoned
    -- loops; allowing the target loop to prove its own owner live is circular.
    WITH live_holder AS (${activeSessionHolderFragment(sql, graceSec)}),
    parked_holder AS (${parkedHolderFragment(sql, parkedGraceSec)}),
    dead_owner AS (
      SELECT DISTINCT r.target_owner_id AS owner_id
        FROM harness_shared.routines r
       WHERE r.active = TRUE
         AND r.reschedule_interval_sec IS NOT NULL
         AND r.target_owner_id IS NOT NULL AND r.target_owner_id <> ''
         AND r.updated_at < now() - make_interval(secs => ${ownerGraceSec})
         AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = r.target_owner_id)
         AND NOT EXISTS (SELECT 1 FROM parked_holder p WHERE p.alias = r.target_owner_id)
    ),
    ended_loop AS (
      UPDATE harness_shared.routines r
         SET active = FALSE, updated_at = now(),
             metadata = COALESCE(r.metadata, '{}'::jsonb)
               - 'last_error' - 'last_error_at' - 'last_error_source'
               || jsonb_build_object('dead_owner_swept_at', now()::text)
        FROM dead_owner d
       WHERE r.target_owner_id = d.owner_id
         AND r.active = TRUE AND r.reschedule_interval_sec IS NOT NULL
      RETURNING r.target_owner_id
    ),
    lifted_hold AS (
      UPDATE harness_shared.work_items w
         -- Same park-preservation as reclaimStaleHoldOpens: a durable park (claim_hold_by)
         -- is not liveness-bound — lift only the dead lease, keep _claimHold with it.
         SET payload = CASE
               WHEN COALESCE(w.payload, '{}'::jsonb) ? 'claim_hold_by'
               THEN COALESCE(w.payload, '{}'::jsonb)
                      - 'held_open_by' - 'held_open_reason' - 'held_open_at'
               ELSE COALESCE(w.payload, '{}'::jsonb)
                      - '_claimHold' - 'held_open_by' - 'held_open_reason' - 'held_open_at'
             END,
             updated_ts = ${Date.now()}
        FROM dead_owner d
       WHERE w.payload->>'held_open_by' = d.owner_id
         -- WI-10005173: dead_owner is derived from THIS node's presence; a peer-written
         -- row (origin='remote') holds a lease this node cannot judge — same rule as
         -- reclaimStaleHoldOpens.
         AND w.origin IS DISTINCT FROM 'remote'
         AND COALESCE(
               ${sql.unsafe(HELD_AT_EXPR)} < now() - make_interval(secs => ${holdGraceSec}),
               true)
         -- WI-6774: a POLICY-TIER hold (D-NNN / triageDecision:"gate" / literal
         -- "policy-tier" in the reason) survives dead-owner-liveness cleanup — same rule,
         -- same shared pattern constant, as reclaimStaleHoldOpens. Only the audited,
         -- ownerOverride-gated work_items:hold_open clear may lift one of these.
         AND NOT COALESCE(w.payload->>'held_open_reason', '') ~* ANY(${POLICY_GATE_REASON_SQL_PATTERNS})
      RETURNING d.owner_id, w.workspace_id, w.feature_id
    )
    SELECT (SELECT array_agg(owner_id ORDER BY owner_id) FROM dead_owner) AS owners,
           (SELECT count(*) FROM ended_loop) AS loops_terminated,
           (SELECT count(*) FROM lifted_hold) AS holds_lifted,
           (SELECT COALESCE(json_agg(json_build_object(
                     'workspace_id', workspace_id, 'feature_id', feature_id, 'former_holder', owner_id
                   )), '[]'::json)
              FROM lifted_hold) AS lifted_items`;
  const row = rows[0] as
    | {
        owners: string[] | null;
        loops_terminated: string | number;
        holds_lifted: string | number;
        lifted_items: Array<{ workspace_id: string; feature_id: string; former_holder: string }> | null;
      }
    | undefined;

  // WI-6774: this bulk liveness clear previously left NO audit_log row anywhere — structural now.
  void recordBulkHoldClearAudit(
    sql,
    (row?.lifted_items ?? []).map((it) => ({
      id: it.feature_id,
      workspaceId: it.workspace_id,
      formerHolder: it.former_holder,
    })),
    { actor: 'dead-owner-control-sweep', sweepName: 'sweepDeadOwnerControlState' },
  );

  return {
    owners: row?.owners ?? [],
    loopsTerminated: Number(row?.loops_terminated ?? 0),
    holdsLifted: Number(row?.holds_lifted ?? 0),
  };
}
