/**
 * A durable intent before an external gate effect, followed by a claim-row lock
 * held across the effect. A crash after the external effect leaves the intent in
 * `unknown`, rather than erasing the action from the forensic record.
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

export type GateActionResult<T> =
  | { ok: true; receiptId: string; effect: T; ownership: {
      certainty: 'claim-row-locked-through-effect' | 'no-linked-condition-observed';
      workItem: string | null; holder: string | null; takenAt: string | null;
    } }
  | { ok: false; receiptId: string | null; reason: string; effectMayHaveRun: boolean };

/**
 * `run` must contain only the short effect boundary (for example accepting a
 * detached systemd launch). Long-running suite/deploy work happens afterward.
 */
export async function executeWithGateActionReceipt<T>(input: {
  action: string;
  actor: string;
  ownerId: string;
  conditionKey: string;
  /** A signed queue delegate may act for the locked claim holder. */
  delegate?: { authorized: boolean; callerSpawnId: string | null; queueFixerSpawnId: string | null };
  /** Green actions may have no open incident to claim; retain unknown ownership honestly. */
  allowUnowned?: boolean;
  target: Record<string, unknown>;
  run: () => Promise<T>;
  summarize: (effect: T) => Record<string, unknown>;
}): Promise<GateActionResult<T>> {
  if (!input.conditionKey.trim()) {
    return { ok: false, receiptId: null, reason: 'gate_condition_unmeasured', effectMayHaveRun: false };
  }
  const sql = getOrgPg().sql;
  const workspaceId = activeWorkspaceId();
  const receiptId = `gate-action-${randomUUID()}`;
  const base = { schemaVersion: 2, phase: 'intent', conditionKey: input.conditionKey,
    ownerId: input.ownerId, target: input.target, effect: { status: 'unknown' } };
  try {
    await sql.unsafe(
      `INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [receiptId, Date.now(), input.actor, input.action, input.conditionKey, JSON.stringify(base), workspaceId],
    );
  } catch {
    return { ok: false, receiptId: null, reason: 'gate_action_intent_unavailable', effectMayHaveRun: false };
  }

  let effectStarted = false;
  try {
    return await sql.begin(async (tx): Promise<GateActionResult<T>> => {
      // The work-item row is the claim writer's serialization point. Keep its
      // lock until the external effect is accepted and the receipt is settled.
      const rows = await tx.unsafe<{
        work_item: string; holder: string | null; taken_at: string | null; expires_at: string | null;
      }[]>(
        `SELECT w.feature_id AS work_item, w.taken_by AS holder,
                w.taken_at::text AS taken_at, w.expires_at::text AS expires_at
           FROM harness_shared.coord_links l
           JOIN harness_shared.work_items w
             ON w.feature_id = l.src_ref AND w.workspace_id = l.workspace_id
          WHERE l.workspace_id = $1 AND l.src_kind = 'issue' AND l.dst_kind = 'event'
            AND l.rel = 'about' AND l.dst_ref = $2
            AND (w.status IS NULL OR w.status <> ALL($3::text[]))
          LIMIT 2 FOR UPDATE OF w`,
        [workspaceId, input.conditionKey, ANY_FAMILY_TERMINAL_STATES as string[]],
      );
      const row = rows.length === 1 ? rows[0] : null;
      if (rows.length === 0 && input.allowUnowned) {
        const ownershipObservedAt = new Date().toISOString();
        effectStarted = true;
        const effect = await input.run();
        const effectReturnedAt = new Date().toISOString();
        const ownership = { certainty: 'no-linked-condition-observed' as const,
          workItem: null, holder: null, takenAt: null };
        await tx.unsafe(
          `UPDATE harness_shared.audit_log SET details = $2::jsonb WHERE id = $1 AND workspace_id = $3`,
          [receiptId, JSON.stringify({ ...base, phase: 'settled', ownership,
            ownershipObservedAt, effect: input.summarize(effect), effectReturnedAt,
            settledAt: new Date().toISOString() }), workspaceId],
        );
        return { ok: true, receiptId, effect, ownership };
      }
      const delegateValid = input.delegate?.authorized === true &&
        input.delegate.callerSpawnId !== null &&
        input.delegate.callerSpawnId === input.delegate.queueFixerSpawnId;
      const claimValid = !!row && (row.holder === input.ownerId || delegateValid) &&
        (!row.expires_at || Date.parse(row.expires_at) > Date.now());
      if (!claimValid) {
        const reason = rows.length !== 1 ? 'gate_condition_ownership_ambiguous' : 'gate_condition_not_held_by_caller';
        await tx.unsafe(
          `UPDATE harness_shared.audit_log SET details = $2::jsonb WHERE id = $1 AND workspace_id = $3`,
          [receiptId, JSON.stringify({ ...base, phase: 'refused', reason }), workspaceId],
        );
        return { ok: false, receiptId, reason, effectMayHaveRun: false };
      }
      const ownership = { certainty: 'claim-row-locked-through-effect' as const,
        workItem: row.work_item, holder: row.holder, takenAt: row.taken_at };
      const claimLockedAt = new Date().toISOString();
      effectStarted = true;
      const effect = await input.run();
      const effectReturnedAt = new Date().toISOString();
      await tx.unsafe(
        `UPDATE harness_shared.audit_log SET details = $2::jsonb WHERE id = $1 AND workspace_id = $3`,
        [receiptId, JSON.stringify({ ...base, phase: 'settled', ownership,
          ...(delegateValid ? { delegate: input.delegate } : {}),
          ownershipCertainty: ownership.certainty,
          claimLockedAt, effect: input.summarize(effect), effectReturnedAt,
          settledAt: new Date().toISOString() }), workspaceId],
      );
      return { ok: true, receiptId, effect, ownership };
    });
  } catch {
    // The intent committed before the effect transaction. A transaction failure
    // or process death cannot promote it to a proved settlement.
    return { ok: false, receiptId, reason: 'gate_action_effect_or_settlement_unknown', effectMayHaveRun: effectStarted };
  }
}
