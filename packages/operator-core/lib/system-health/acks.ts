/**
 * system-health/acks — per-panel owner acknowledge/snooze
 * (health-tab-v2-2026-07-12 P-004, decision D-A).
 *
 * An acked panel renders muted-with-badge and is EXCLUDED from the `overall`
 * roll-up while the ack COVERS its current severity (ackCovers, thresholds.ts):
 * an ack taken at 'warn' does not mute a later 'crit' — escalation re-alarms.
 * Acks auto-clear on RECOVERY (the panel returns to 'ok' — NOT 'unknown', a
 * flaky read must never eat an ack) or when the snooze expires.
 *
 * D-A: this deliberately amends the tab's read-only stance (D-002) by exactly
 * one verb — a view-level judgment about *attention*, not an operational
 * control. Storage: harness_shared.system_health_acks (migration 585).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { PanelAck, PanelKey, SystemHealth } from './types';
import { ackCovers, worstStatus } from './thresholds';

const VALID_ACK_STATUS = new Set(['warn', 'crit']);

/** All acks for a workspace, keyed by panel. */
export async function readHealthAcks(workspaceId: string): Promise<Map<string, PanelAck>> {
  const { sql } = getOrgPg();
  // NB: timestamptz round-trips as ISO STRINGS on this client (a Date param
  // throws "Received an instance of Date") — string in, new Date(row) out.
  const rows = await sql<Array<{
    panel: string; status: string; reason: string; acked_by: string;
    acked_at: string; snooze_until: string | null;
  }>>`
    SELECT panel, status, reason, acked_by, acked_at, snooze_until
      FROM harness_shared.system_health_acks
     WHERE workspace_id = ${workspaceId}`;
  const out = new Map<string, PanelAck>();
  for (const r of rows) {
    if (!VALID_ACK_STATUS.has(r.status)) continue;
    out.set(r.panel, {
      status: r.status as PanelAck['status'],
      reason: r.reason,
      ackedBy: r.acked_by,
      ackedAt: new Date(r.acked_at).getTime(),
      snoozeUntil: r.snooze_until ? new Date(r.snooze_until).getTime() : null,
    });
  }
  return out;
}

/** Upsert the (at most one) ack for a panel. */
export async function upsertHealthAck(args: {
  workspaceId: string;
  panel: string;
  status: PanelAck['status'];
  reason: string;
  ackedBy: string;
  snoozeUntil?: number | null;
}): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.system_health_acks
      (workspace_id, panel, status, reason, acked_by, snooze_until)
    VALUES (${args.workspaceId}, ${args.panel}, ${args.status}, ${args.reason},
            ${args.ackedBy}, ${args.snoozeUntil ? new Date(args.snoozeUntil).toISOString() : null})
    ON CONFLICT (workspace_id, panel) DO UPDATE SET
      status = EXCLUDED.status, reason = EXCLUDED.reason,
      acked_by = EXCLUDED.acked_by, acked_at = now(),
      snooze_until = EXCLUDED.snooze_until`;
}

/** Remove a panel's ack (owner un-ack). Returns true when a row was deleted. */
export async function clearHealthAck(workspaceId: string, panel: string): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ panel: string }>>`
    DELETE FROM harness_shared.system_health_acks
     WHERE workspace_id = ${workspaceId} AND panel = ${panel}
     RETURNING panel`;
  return rows.length > 0;
}

/**
 * PURE: stamp covering acks onto the snapshot's panels and recompute `overall`
 * over the UNCOVERED panels only. Mutates `health` in place (the per-tick
 * snapshot is freshly built each time) and returns it. Exported for unit tests.
 */
export function applyHealthAcks(
  health: SystemHealth,
  acks: ReadonlyMap<string, PanelAck>,
  now: number,
): SystemHealth {
  let acked = 0;
  const uncovered: SystemHealth['overall'][] = [];
  for (const [key, panel] of Object.entries(health.panels)) {
    const ack = acks.get(key);
    if (ack && ackCovers(ack, panel.status, now)) {
      panel.ack = ack;
      acked += 1;
    } else {
      delete panel.ack;
      uncovered.push(panel.status);
    }
  }
  health.overall = worstStatus(uncovered);
  health.ackedCount = acked;
  return health;
}

/**
 * Auto-clear acks that no longer apply: the panel RECOVERED (status 'ok' —
 * never 'unknown': a flaky read must not eat an ack) or the snooze expired.
 * Called from the tick, fail-soft at the call site.
 */
export async function sweepHealthAcks(health: SystemHealth, now: number): Promise<void> {
  const acks = await readHealthAcks(health.workspaceId);
  if (acks.size === 0) return;
  const { sql } = getOrgPg();
  for (const [panelKey, ack] of acks) {
    const panel = health.panels[panelKey as PanelKey];
    const recovered = panel !== undefined && panel.status === 'ok';
    const expired = ack.snoozeUntil !== null && now > ack.snoozeUntil;
    const orphaned = panel === undefined; // a panel key that no longer exists
    if (recovered || expired || orphaned) {
      await sql`
        DELETE FROM harness_shared.system_health_acks
         WHERE workspace_id = ${health.workspaceId} AND panel = ${panelKey}`;
      acks.delete(panelKey);
    }
  }
  applyHealthAcks(health, acks, now);
}
