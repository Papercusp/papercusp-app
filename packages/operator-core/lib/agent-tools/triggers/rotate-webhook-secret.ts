import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { WEBHOOK_DEFAULT_OVERLAP_SEC, WEBHOOK_MAX_OVERLAP_SEC, rotateWebhookSigningKey } from '../../external-triggers/webhook';
import { data, invalidateTriggers, triggerToolContext } from './_shared';
import { WEBHOOK_SIGNING_HOWTO, webhookUrls } from './_webhook';

export default defineTool({
  name: 'triggers:rotate-webhook-secret',
  profile: 'engineer',
  description:
    'Replace a webhook source’s HMAC signing key (P-017). The new key is shown ONCE; the old one keeps verifying for overlapSec (default 24 h, 0 = invalid at once).',
  guidance: {
    when: 'The signing key was lost or may have leaked, or on a scheduled rotation.',
    notWhen: 'To stop a webhook entirely — disarm its bindings (triggers:disarm) or disable the source instead.',
    chaining: 'triggers:rotate-webhook-secret → update the sender → the old key stops at previousValidUntil.',
  },
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sourceId: z.string().uuid(),
    overlapSec: z
      .number()
      .int()
      .min(0)
      .max(WEBHOOK_MAX_OVERLAP_SEC)
      .optional()
      .describe(`how long the previous key still verifies (default ${WEBHOOK_DEFAULT_OVERLAP_SEC})`),
  }),
  async handler(args, ctx) {
    const { sql, workspaceId } = triggerToolContext(ctx);
    const rotated = await rotateWebhookSigningKey(sql, { workspaceId, sourceId: args.sourceId, overlapSec: args.overlapSec });
    await invalidateTriggers(workspaceId);
    return data({
      ok: true,
      sourceId: rotated.sourceId,
      urls: await webhookUrls(rotated.sourceId),
      signingKey: rotated.signingKey,
      signingKeyShownOnce: true,
      previousValidUntil: rotated.previousValidUntil,
      howToSign: WEBHOOK_SIGNING_HOWTO,
    });
  },
});
