/** Register the named-resource serializer an agent is about to use. */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { hostGlobalLockDomain } from './coordination-domain';
import { inWorkspaceTxn } from './in-workspace-txn';
import { readIdentity } from './identity';
import { registerResource } from './su-lock-store';

export default defineTool({
  name: 'locks:register_resource',
  description:
    'Register a named resource for locks:acquire_resource. Registration is create-if-absent: an existing resource policy is never overwritten, so concurrent agents converge on one serializer.',
  guidance: {
    when: 'Before authoring or executing a locks:acquire_resource protocol for a resource that locks:list does not show.',
    notWhen: 'For an existing resource, use locks:list to discover its exact policy and locks:acquire_resource to hold it. Do not invent a second spelling for an existing resource.',
    chaining: 'locks:register_resource → locks:list → locks:acquire_resource { resource, mode } → use/act → locks:release_resource.',
    seeAlso: [
      'locks:list (discover registered resources and their policy)',
      'locks:acquire_resource (take the shared or exclusive hold)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    resource: z.string().min(1).max(200).describe('Stable named-resource key used by locks:acquire_resource.'),
    description: hardText(LIMITS.ANNOTATION).optional().describe('Why this resource needs serialized access.'),
    rule_text: hardText(LIMITS.ANNOTATION).optional().describe('How callers must acquire and release this resource.'),
    enforcement: z.enum(['advisory', 'checked', 'enforced']).optional(),
    max_holders: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .nullable()
      .optional()
      .describe('Maximum concurrent shared holders; null means unbounded.'),
  }),
  async handler(args, ctx) {
    const { ownerId } = readIdentity(ctx);
    const result = await inWorkspaceTxn(hostGlobalLockDomain(), ownerId, (tx) =>
      registerResource(tx, {
        resource: args.resource,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.rule_text !== undefined ? { rule_text: args.rule_text } : {}),
        ...(args.enforcement !== undefined ? { enforcement: args.enforcement } : {}),
        ...(args.max_holders !== undefined ? { max_holders: args.max_holders } : {}),
      }),
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, created: result.created, resource: result.resource }),
        },
      ],
    };
  },
});
