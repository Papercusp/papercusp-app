/**
 * Operator audit-event writer (Phase 1b of the v5 operator plan).
 *
 * Lifecycle reducer writes two timestamps per card to
 * `harness_shared.audit_log.details` (JSON):
 *
 *   { card_id, dispatched_at, acked_at }
 *
 * Plus a separate `kind: 'undo_cancel'` event when the user cancels
 * within the 5s undo window — distinct from a deliberate dismiss
 * (which goes through the preferences-write path, not this one).
 *
 * Other state-flip timestamps (consumed_at, escalated_at, …) are
 * deferred to v1.5 per the plan; this module only emits the two the
 * Path-a escalation criterion needs.
 */

import { withWorkspace, generated } from '@papercusp/db-org';
import { drizzle } from 'drizzle-orm/postgres-js';
import { activeWorkspaceId } from './workspace-registry';
import { notifySyncInvalidate } from './sync-sse';
import { trackDetached } from './detached-imports';

const al = generated.auditLogInHarnessShared;

export type OperatorAuditKind =
  // New (post-card-lifecycle-collapse, e46ba9c):
  | 'accepted'
  | 'ignored'
  | 'accept_failed'
  | 'undo_cancel'
  // Legacy — still accepted by the writer for back-compat (callers that haven't
  // migrated yet, replayed audit history, etc.). Operator panel itself only
  // emits the four above. Remove once all writers have moved.
  | 'dispatched'
  | 'acked'
  | 'consumed'
  | 'escalated'
  | 'rejected'
  | 'failed'
  | 'dismissed'
  | 'superseded';

/**
 * How the action was initiated (voice-mode-plan-v4 §2m). Stored in
 * audit_log.details.actor_method so retrospective analysis can break
 * down voice vs click vs CLI/API utility.
 *
 *   'voice'  — voice utterance (in-panel command, wake-word, toast cancel)
 *   'click'  — UI click / keyboard activation
 *   'api'    — direct API call (CLI, automated test, external script)
 *   null     — legacy / unspecified (default for back-compat)
 */
export type ActorMethod = 'voice' | 'click' | 'api' | null;

export interface OperatorAuditEvent {
  cardId: string;
  kind: OperatorAuditKind;
  /** ISO timestamp; defaults to now. */
  at?: string;
  /** Optional context (capability + target for dispatched events, etc). */
  context?: Record<string, unknown>;
  /** How this action was initiated. Defaults to null for back-compat. */
  actorMethod?: ActorMethod;
}

function makeId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function writeOperatorAudit(ev: OperatorAuditEvent): Promise<void> {
  const workspaceId = activeWorkspaceId();
  const at = ev.at ?? new Date().toISOString();
  const id = makeId();
  const details = {
    card_id: ev.cardId,
    kind: ev.kind,
    at,
    actor_method: ev.actorMethod ?? null,
    ...(ev.context ?? {}),
  };
  try {
    await withWorkspace(workspaceId, async (tx) => {
      const txDb = drizzle(tx);
      await txDb.insert(al).values({
        id,
        ts: Date.now(),
        actor: 'system:operator',
        action: `operator.${ev.kind}`,
        subject: ev.cardId,
        details: details as any,
        workspaceId: workspaceId,
      });
    });
    // Mobile sync: phone refetches /api/device/actions/recent.
    void notifySyncInvalidate('auditLog.recent').catch(() => {});
  } catch (err) {
    // Best-effort; never block the panel on a missing audit row.
    console.warn(`[operator-audit] failed to write ${ev.kind} for ${ev.cardId}:`, err);
  }

  // After every dispatched event, refresh the standing-approval candidates
  // file so the settings page reflects new patterns. Best-effort, async.
  if (ev.kind === 'dispatched') {
    void trackDetached(import('./operator-standing-candidates'))
      .then((m) => m.refreshCandidates())
      .catch(() => {});
  }
}
