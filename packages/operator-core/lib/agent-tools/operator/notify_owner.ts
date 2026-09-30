/**
 * notifications:send_owner — one replay-safe owner-delivery seam for plans.
 *
 * A successful call leaves two independently inspectable receipts:
 *   - a durable coord inbox message addressed to `human`;
 *   - the existing attention_notifications row plus audited mobile/desktop
 *     channel outcomes produced by notifyAttention.
 *
 * The caller supplies a stable delivery key (normally plan-run + trigger
 * delivery). The coord message gets a deterministic full-shape msg_id and the
 * attention path claims each channel once, so a work-item retry cannot page the
 * owner twice.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { notifyAttentionOnce } from '../../attention-notify';
import { getMessageById, sendMessage } from '../coordination/messages';
import { resolveAgentIdentity } from '../coordination/identity';

const OWNER_NOTIFY_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep'] as const;

/** Full coord msg-id shape: <no-hyphen-prefix>-<digits>-<32 hex>. */
export function ownerNotificationMessageId(workspaceId: string, dedupeKey: string): string {
  const digest = createHash('sha256')
    .update(`${workspaceId}\0${dedupeKey}`)
    .digest('hex')
    .slice(0, 32);
  return `ntfy-0-${digest}`;
}

function isUniqueViolation(error: unknown): boolean {
  let cursor: unknown = error;
  for (let i = 0; i < 4 && cursor && typeof cursor === 'object'; i += 1) {
    if ((cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

export default defineTool({
  name: 'notifications:send_owner',
  profile: 'engineer',
  description:
    'Deliver one replay-safe owner notification through BOTH the durable human inbox and audited mobile/desktop attention channels. A stable dedupeKey is required; retries with the same key do not notify twice.',
  capability: 'coord:write',
  guidance: {
    when:
      'A plan/event consumer has a result the owner should see now and needs both durable inbox history and a desktop/mobile attention attempt. Use a stable plan-run/delivery key.',
    notWhen:
      'Agent coordination uses coord:send. Conversational replies should be spoken normally. Never generate a fresh dedupeKey when retrying the same delivery.',
    chaining:
      'Build the result first, then call once with dedupeKey = <plan-run-ref>:<delivery-purpose>. The returned inbox.msgId and attention.recordId are the receipts.',
    seeAlso: [
      'coord:send (agent coordination)',
      'notifications:recent (transient UI toast history)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...OWNER_NOTIFY_ROLES],
  rolesQuota: { worker: { perChunk: 20 }, operator: { perRun: 100 } },
  args: z.object({
    dedupeKey: z.string().trim().min(1).max(500),
    harness: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(240),
    body: z.string().trim().min(1).max(8_000),
    importance: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
    planRunRef: z.string().trim().min(1).max(300).optional(),
    sourceRef: z.string().trim().min(1).max(500).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId?.trim();
    if (!workspaceId || workspaceId === 'default' || workspaceId === '*') {
      throw new Error('owner_notification_workspace_required');
    }

    const msgId = ownerNotificationMessageId(workspaceId, args.dedupeKey);
    let inboxSent = false;
    let inboxDeduped = false;
    let inboxError: unknown = null;
    try {
      const existing = await getMessageById(msgId);
      if (existing) {
        inboxDeduped = true;
      } else {
        await sendMessage(identity, {
          to: ['human'],
          msgId,
          summary: args.title,
          body: args.body,
          expectsReply: false,
          harnessSlug: args.harness,
          extra: {
            ownerNotification: true,
            deliveryKey: args.dedupeKey,
            ...(args.planRunRef ? { planRunRef: args.planRunRef } : {}),
            ...(args.sourceRef ? { sourceRef: args.sourceRef } : {}),
          },
        });
        inboxSent = true;
      }
    } catch (error) {
      if (isUniqueViolation(error)) inboxDeduped = true;
      else inboxError = error;
    }

    const attention = await notifyAttentionOnce({
      workspaceId,
      harnessSlug: args.harness,
      kind: 'intervention',
      title: args.title,
      body: args.body,
      importance: args.importance ?? 'high',
      dedupeKey: args.dedupeKey,
      data: {
        ownerNotification: true,
        ...(args.planRunRef ? { planRunRef: args.planRunRef } : {}),
        ...(args.sourceRef ? { sourceRef: args.sourceRef } : {}),
      },
    });

    if (inboxError) {
      const message = inboxError instanceof Error ? inboxError.message : String(inboxError);
      throw new Error(`owner_notification_inbox_failed:${message}`, { cause: inboxError });
    }

    return {
      data: {
        ok: true,
        deliveryKey: args.dedupeKey,
        inbox: { msgId, sent: inboxSent, deduped: inboxDeduped },
        attention,
      },
    };
  },
});
