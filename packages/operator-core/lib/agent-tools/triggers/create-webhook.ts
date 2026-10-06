import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { createWebhookSource } from '../../external-triggers/webhook';
import { data, invalidateTriggers, triggerToolContext } from './_shared';
import { WEBHOOK_SIGNING_HOWTO, webhookUrls } from './_webhook';

export default defineTool({
  name: 'triggers:create-webhook',
  profile: 'engineer',
  description:
    'Create a signed webhook trigger source (P-017): returns its URL(s) and an HMAC signing key, shown ONCE. An outside system POSTs signed JSON to start the bound blueprint operation.',
  guidance: {
    when: 'An automated outside system (CI, a SaaS webhook, a script) must start a blueprint operation without holding a user or app token.',
    notWhen: 'An app acting on behalf of a person — issue it an app key instead. A provider with a native adapter (Gmail, Slack) — use triggers:create with that kind.',
    chaining:
      'triggers:create-webhook → give the sender the URL + key → triggers:bind { sourceId, eventPattern: "ext:webhook:<event>", operationHarnessSlug, operationId } → triggers:arm. Lost key → triggers:rotate-webhook-secret.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    label: z.string().min(1).max(120).optional().describe('who sends to it, e.g. "GitHub push events"'),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId, actorId } = triggerToolContext(ctx);
    const created = await createWebhookSource(sql, { workspaceId, label: args.label ?? null, createdBy: actorId });
    await invalidateTriggers(workspaceId);
    return data({
      ok: true,
      sourceId: created.source.id,
      source: created.source,
      path: created.path,
      urls: await webhookUrls(created.source.id),
      signingKey: created.signingKey,
      signingKeyShownOnce: true,
      howToSign: WEBHOOK_SIGNING_HOWTO,
    });
  },
});
