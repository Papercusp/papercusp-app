/** Register the named-resource serializer an agent is about to use. */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { HOST_GLOBAL_RESOURCES, hostGlobalLockDomain } from './coordination-domain';
import { findCrossDomainResourceConflicts } from './cross-domain-conflict';
import { inWorkspaceTxn } from './in-workspace-txn';
import { readIdentity } from './identity';
import { registerResource, stampResourceCoordinationDomainKind } from './su-lock-store';

export default defineTool({
  name: 'locks:register_resource',
  description:
    'Register a named resource for locks:acquire_resource. Registration preserves an existing policy and publishes the maintained host-global domain declaration for known host resources. Refuses publication while a legacy-domain lease remains held.',
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
    const maintainedHostResource = HOST_GLOBAL_RESOURCES.has(args.resource);
    if (maintainedHostResource) {
      const holders = await findCrossDomainResourceConflicts({
        resource: args.resource, targetDomain: hostGlobalLockDomain(), requestedMode: 'exclusive',
        // Declaration affects every reader: an own legacy lease must finish
        // before publication too. No valid owner identity is empty.
        owner: '',
      });
      if (holders.length) return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: false, reason: 'held_in_other_domain', holders,
          hint: 'Release the legacy-domain lease before registering its host-global declaration.',
        }) }],
      };
    }
    const result = await inWorkspaceTxn(hostGlobalLockDomain(), ownerId, async (tx) => {
      const registered = await registerResource(tx, {
        resource: args.resource,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.rule_text !== undefined ? { rule_text: args.rule_text } : {}),
        ...(args.enforcement !== undefined ? { enforcement: args.enforcement } : {}),
        ...(args.max_holders !== undefined ? { max_holders: args.max_holders } : {}),
      });
      if (maintainedHostResource &&
          !await stampResourceCoordinationDomainKind(tx, args.resource, 'host-global')) {
        throw new Error('Registered resource missing during domain declaration');
      }
      return registered;
    });
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
