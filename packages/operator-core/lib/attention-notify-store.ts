/**
 * Durable audit trail for notifyAttention() (WI-36644).
 *
 * notifyAttention is the single "ping the human now" rail — ~35 call sites — and until this
 * landed it wrote nothing anywhere: two fire-and-forget, independently-swallowed pushes (mobile
 * APNs/FCM, desktop SSE), both silently no-op-safe (no paired device / no open webview). After a
 * silent halt, "was the human ever told?" was unanswerable, even to the agent that raised it.
 *
 * One row per call, written UNCONDITIONALLY before either channel is attempted, then updated
 * with each channel's outcome — turns the epistemic gap into a query. Best-effort: a failure to
 * write/update this audit trail is logged and swallowed, exactly like the two delivery channels
 * themselves — the audit log must never become a new way for notifyAttention to throw.
 */
import { withWorkspace } from '@papercusp/db-org';

export interface AttentionNotificationRecordInput {
  workspaceId: string;
  harnessSlug?: string;
  kind: string;
  title: string;
  body: string;
  importance?: string;
  data?: Record<string, unknown>;
}

export interface AttentionNotificationChannelOutcome {
  attempted: boolean;
  succeeded?: boolean;
  error?: string;
}

export interface AttentionNotificationIntentClaim {
  id: number;
  created: boolean;
}

/** Insert the intent row BEFORE either channel is attempted. Returns the row id, or null on a
 *  (logged, swallowed) write failure — callers must still attempt delivery either way. */
export async function recordAttentionNotifyIntent(
  input: AttentionNotificationRecordInput,
): Promise<number | null> {
  try {
    return await withWorkspace(input.workspaceId, async (tx) => {
      const rows = await tx<{ id: number }[]>`
        INSERT INTO harness_shared.attention_notifications
          (workspace_id, harness_slug, kind, title, body, importance, data)
        VALUES (
          ${input.workspaceId}, ${input.harnessSlug ?? null}, ${input.kind},
          ${input.title}, ${input.body}, ${input.importance ?? null},
          ${input.data ? JSON.stringify(input.data) : null}
        )
        RETURNING id
      `;
      return rows[0]?.id ?? null;
    });
  } catch (e) {
    console.warn('[attention-notify-store] failed to record intent:', (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * Reserve (or recover) one stable notification intent.
 *
 * The JSON delivery key extends the existing attention ledger instead of
 * creating a parallel outbox. A transaction-scoped advisory lock makes the
 * lookup+insert atomic for concurrent replays. Channel delivery is claimed
 * separately below, so a process that resumes a partially completed intent can
 * deliver only the still-unclaimed channel.
 */
export async function ensureAttentionNotifyIntent(
  input: AttentionNotificationRecordInput,
  dedupeKey: string,
): Promise<AttentionNotificationIntentClaim | null> {
  const key = dedupeKey.trim();
  if (!key) throw new Error('attention_notify_dedupe_key_required');
  try {
    return await withWorkspace(input.workspaceId, async (tx) => {
      const lockKey = `attention-notify:${input.workspaceId}:${key}`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const existing = await tx<Array<{ id: number }>>`
        SELECT id
          FROM harness_shared.attention_notifications
         WHERE workspace_id = ${input.workspaceId}
           AND data ->> 'dedupeKey' = ${key}
         ORDER BY id
         LIMIT 1`;
      if (existing[0]) return { id: existing[0].id, created: false };

      const data = JSON.stringify({ ...(input.data ?? {}), dedupeKey: key });
      const rows = await tx<Array<{ id: number }>>`
        INSERT INTO harness_shared.attention_notifications
          (workspace_id, harness_slug, kind, title, body, importance, data)
        VALUES (
          ${input.workspaceId}, ${input.harnessSlug ?? null}, ${input.kind},
          ${input.title}, ${input.body}, ${input.importance ?? null},
          ${data}::text::jsonb
        )
        RETURNING id`;
      return rows[0] ? { id: rows[0].id, created: true } : null;
    });
  } catch (e) {
    console.warn('[attention-notify-store] failed to ensure intent:', (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * Atomically take the at-most-once send right for one channel. Marking the
 * attempt before the external side effect is deliberate: retries may reveal an
 * interrupted attempt in the audit row, but they never double-page the owner.
 */
export async function claimAttentionNotifyChannel(
  id: number,
  workspaceId: string,
  channel: 'mobile' | 'desktop',
): Promise<boolean> {
  try {
    return await withWorkspace(workspaceId, async (tx) => {
      const rows = channel === 'mobile'
        ? await tx<Array<{ id: number }>>`
            UPDATE harness_shared.attention_notifications
               SET mobile_attempted = TRUE
             WHERE id = ${id} AND workspace_id = ${workspaceId}
               AND mobile_attempted = FALSE
            RETURNING id`
        : await tx<Array<{ id: number }>>`
            UPDATE harness_shared.attention_notifications
               SET desktop_attempted = TRUE
             WHERE id = ${id} AND workspace_id = ${workspaceId}
               AND desktop_attempted = FALSE
            RETURNING id`;
      return rows.length > 0;
    });
  } catch (e) {
    // Audit/claim storage remains fail-soft. The caller treats an unavailable
    // claim as permission to deliver, preserving notifyAttention's historical
    // "never lose the page because the audit DB is down" contract.
    console.warn(
      `[attention-notify-store] failed to claim ${channel} for id=${id}:`,
      (e as Error)?.message ?? e,
    );
    return true;
  }
}

/** Stamp one channel's outcome onto an already-recorded row. No-op (logged) if `id` is null —
 *  the intent insert itself failed, so there is nothing to update. */
export async function recordAttentionNotifyOutcome(
  id: number | null,
  workspaceId: string,
  channel: 'mobile' | 'desktop',
  outcome: AttentionNotificationChannelOutcome,
): Promise<void> {
  if (id == null) return;
  try {
    await withWorkspace(workspaceId, async (tx) => {
      if (channel === 'mobile') {
        await tx`
          UPDATE harness_shared.attention_notifications
          SET mobile_attempted = ${outcome.attempted},
              mobile_succeeded = ${outcome.succeeded ?? null},
              mobile_error = ${outcome.error ?? null},
              mobile_completed_at = now()
          WHERE id = ${id}
        `;
      } else {
        await tx`
          UPDATE harness_shared.attention_notifications
          SET desktop_attempted = ${outcome.attempted},
              desktop_succeeded = ${outcome.succeeded ?? null},
              desktop_error = ${outcome.error ?? null},
              desktop_completed_at = now()
          WHERE id = ${id}
        `;
      }
    });
  } catch (e) {
    console.warn(
      `[attention-notify-store] failed to record ${channel} outcome for id=${id}:`,
      (e as Error)?.message ?? e,
    );
  }
}
