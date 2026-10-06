/**
 * documents:subscriptions — which data sources a pot or plan subscribes to for
 * turn-start injection (plan enterprise-data-sources-2026-10-01 P-017; table:
 * migration 1321). A subscription decides relevance only: it never grants access
 * to a document the principal could not already read.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  listSourceSubscriptions,
  subscribeSource,
  unsubscribeSource,
} from '../../data-sources/granted-sources-injection';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'documents:subscriptions',
  needsWorkspaceTx: true,
  capability: 'memory:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  description:
    'Subscribe a pot or plan to a data source (e.g. slack, asana) so its documents inject at turn start; unsubscribe; list. Relevance only — never widens access.',
  guidance: {
    when: 'A pot or plan should see a company source in its turn-start context, or should stop seeing it.',
    notWhen: 'Searching documents — use documents:search. Granting access — that is the vault grant and the source ACL.',
  },
  args: z.object({
    op: z.enum(['subscribe', 'unsubscribe', 'list']),
    subjectKind: z.enum(['pot', 'plan']).optional(),
    subjectRef: z.string().min(1).max(200).optional(),
    source: z.string().min(1).max(80).optional(),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('documents_subscriptions_workspace_required');
    const tx = ctx.tx!;
    if (args.op === 'list') {
      return { data: { subscriptions: await listSourceSubscriptions(tx, workspaceId, args) } };
    }
    if (!args.subjectKind || !args.subjectRef || !args.source) {
      throw new Error('documents_subscriptions_subject_and_source_required');
    }
    const actor = disclosureSubject(ctx) ?? 'unknown-agent';
    const target = { subjectKind: args.subjectKind, subjectRef: args.subjectRef, source: args.source };
    if (args.op === 'subscribe') {
      return { data: await subscribeSource(tx, workspaceId, { ...target, createdBy: actor }) };
    }
    return { data: await unsubscribeSource(tx, workspaceId, { ...target, revokedBy: actor }) };
  },
});
