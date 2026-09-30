/**
 * Coordination liveness / reclaim config (live-configurability-audit-2026-06-20 P-014, expose).
 *
 * One shared operator-state row (operator_coord_liveness_config) holding OVERRIDES for the three
 * P-014 concerns — each an override over the consumer's existing default, threaded into the PERIODIC
 * routine that calls the (already override-accepting) pure fn:
 *   - reclaimGraceMs / reclaimRequeueCap → reclaimStaleWorkItemClaims (dbos/in-process-periodic)
 *   - handoffTtlMs                        → findStaleHandoffs (reconcile-handoffs)        [tool TBD]
 *   - sessionReaperGraceMs                → planIdleSessionReap (idle-session-reaper)      [tool TBD]
 *
 * The consumers are periodic routines (NOT hot paths), so a plain async read at the call site is fine
 * — no sync-cache. An absent field ⇒ the consumer's baked default ⇒ byte-identical. Registers a
 * runtime-config override concern.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { STALE_MS } from './liveness';

export interface CoordLivenessConfig {
  /** Override the stale-handoff auto-expiry TTL (default STALE_HANDOFF_TTL_MS = 12h). */
  handoffTtlMs?: number;
  /** Override the handoff re-ping window — an open, un-acked handoff older than this
   *  (but < handoffTtlMs) re-pings the offerer once (default STALE_HANDOFF_REPING_MS = 30m).
   *  coord-dispatch-reliability P-003. */
  handoffRepingMs?: number;
  /** Override the stale-claim reclaim grace (default STALE_CLAIM_GRACE_MS = STALE_MS = 10m). */
  reclaimGraceMs?: number;
  /** WI-2689: override the LONGER grace given to a briefly-parked/resumable holder (a
   *  loop-dropped member whose coord_presence row still beat recently) before its claim
   *  is reaped — the reclaim-churn fix (default STALE_CLAIM_PARKED_GRACE_MS = 30m; clamped
   *  ≥ reclaimGraceMs). Raise it if members take longer to re-arm; lower it (toward
   *  reclaimGraceMs) to reap parked holders more eagerly. */
  reclaimParkedGraceMs?: number;
  /** Override the requeue cap before a mid-flight claim is dead-lettered (default staleReclaimRequeueCap() = 3). */
  reclaimRequeueCap?: number;
  /** WI-4531: override how long a HOLD-OPEN survives once its holder stops looking alive —
   *  measured from `held_open_at` (default HOLD_OPEN_GRACE_MS = 2h). A hold whose holder is
   *  LIVE is never expired regardless of age, so this only governs holds left behind by dead
   *  sessions. Raise it if a multi-node deployment wants longer protection for a hold placed
   *  by a live agent on ANOTHER hive node (invisible to this node's coord_presence — the one
   *  accepted false-positive; see work-items-hold-open.ts). */
  holdOpenGraceMs?: number;
  /** Override the dead-holder plan-item ASSIGNMENT reclaim grace (default
   *  STALE_PLAN_ASSIGNMENT_GRACE_MS = 60m). Longer than reclaimGraceMs because
   *  assignments are durable across interruption (EI-2535). */
  assignmentReclaimGraceMs?: number;
  /** Override the idle-session reaper grace (default IDLE_SESSION_GRACE_MS = STALE_MS = 10m). */
  sessionReaperGraceMs?: number;
  /** Override the coord_presence retention-reaper TTL (presence-coord-unification-2026-07-01
   *  P-004, WI-1347) — how long a NOT-wakeable ("ended") coord_presence row survives past its
   *  last heartbeat before the scheduled reaper deletes it. A wakeable ("parked") row is never
   *  reaped regardless of this TTL. Default PRESENCE_REAPER_TTL_MS = 4h. */
  presenceReaperTtlMs?: number;
  /** Override the FEDERATED presence reaper TTL (cross-machine-coord-parity-and-trust-2026-07-01
   *  P-057 / M8) — how long a shared_presence / shared_session_presence gossip row survives past
   *  its last_seen_at beat before the scheduled reaper deletes it. Must stay well beyond every
   *  reader's staleness window (PRESENCE_STALE_MS×4 = 40m) so a still-surfaced row is never
   *  removed. Default 4h. */
  sharedPresenceReaperTtlMs?: number;
  /** Override the per-signing-device row cap on the federated presence tables
   *  (cross-machine-coord-parity-and-trust-2026-07-01 P-057 / M8). The reaper keeps only the N
   *  most-recent rows per (workspace, device_pubkey) and deletes the overflow — bounding the total
   *  rows one device can hold regardless of how fast it rotates the sender-controlled machine_label
   *  / owner_id (the TTL alone can't catch a fast rotator whose rows stay fresh). Default 128. */
  sharedPresenceMaxRowsPerDevice?: number;
}

/** The consumers' baked defaults — for the diff/display + the tools' "default" reporting only.
 *  The real fallback lives in each consumer (this layer only carries OVERRIDES). */
export const COORD_LIVENESS_DEFAULTS = {
  handoffTtlMs: 12 * 60 * 60 * 1000,
  handoffRepingMs: 30 * 60 * 1000,
  reclaimGraceMs: STALE_MS,
  reclaimParkedGraceMs: 30 * 60 * 1000,
  reclaimRequeueCap: 3,
  holdOpenGraceMs: 2 * 60 * 60 * 1000,
  assignmentReclaimGraceMs: 60 * 60 * 1000,
  sessionReaperGraceMs: STALE_MS,
  presenceReaperTtlMs: 4 * 60 * 60 * 1000,
  sharedPresenceReaperTtlMs: 4 * 60 * 60 * 1000,
  sharedPresenceMaxRowsPerDevice: 128,
} as const;

export async function readCoordLivenessConfig(): Promise<CoordLivenessConfig> {
  return (await readOperatorState<CoordLivenessConfig>('operator_coord_liveness_config')) ?? {};
}

export async function writeCoordLivenessConfig(patch: CoordLivenessConfig): Promise<CoordLivenessConfig> {
  const next = { ...(await readCoordLivenessConfig()), ...patch };
  await writeOperatorState<CoordLivenessConfig>('operator_coord_liveness_config', next);
  return next;
}

export async function setCoordLivenessConfig(cfg: CoordLivenessConfig): Promise<void> {
  await writeOperatorState<CoordLivenessConfig>('operator_coord_liveness_config', cfg);
}

export async function resetCoordLivenessConfig(): Promise<void> {
  await setCoordLivenessConfig({});
}

registerOverrideConcern({
  name: 'coord-liveness-config',
  description: 'coordination liveness/reclaim overrides (handoff TTL, reclaim grace/cap, session-reaper grace)',
  auditAction: 'work_items:reclaim_config',
  diff: async () => {
    const c = await readCoordLivenessConfig();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(COORD_LIVENESS_DEFAULTS) as (keyof CoordLivenessConfig)[]) {
      if (c[k] !== undefined) entries.push({ key: k, effective: c[k], default: COORD_LIVENESS_DEFAULTS[k], layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readCoordLivenessConfig(),
  reset: () => resetCoordLivenessConfig(),
  restore: (snap) => setCoordLivenessConfig((snap as CoordLivenessConfig) ?? {}),
});
