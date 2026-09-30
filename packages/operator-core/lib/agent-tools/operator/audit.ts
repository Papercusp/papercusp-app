/**
 * operator:audit — log a single operator-card lifecycle event.
 *
 * Wraps `writeOperatorAudit()`. Same kind allowlist as the legacy
 * route. Useful for agents that act on operator suggestions and need
 * to record the outcome (accepted / ignored / accept_failed / undo) so
 * the dashboard's reconstruction sees the same lifecycle.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  writeOperatorAudit,
  type ActorMethod,
  type OperatorAuditKind,
} from '../../operator-audit';

const ALLOWED_KINDS = [
  'accepted',
  'ignored',
  'accept_failed',
  'undo_cancel',
  'dispatched',
  'acked',
  'consumed',
  'escalated',
  'rejected',
  'failed',
  'dismissed',
  'superseded',
] as const;

const ALLOWED_METHODS = ['voice', 'click', 'api'] as const;

export default defineTool({
  name: 'operator:audit',
  profile: 'engineer',
  description: 'Log a single operator-card lifecycle event (accepted / ignored / dispatched / dismissed / …) so the dashboard reconstruction sees it.',
  capability: 'operator:write',
  guidance: {
    when: `Operator-scoped audit feed — every operator action (scans fired, cards dispatched, mode flips).`,
    notWhen: `For workspace-wide audit including non-operator actors, use \`audit:list\`. operator:audit is the narrower operator-only stream.`,
    seeAlso: [
      'actions:recent (recent user-facing actions)',
      'audit:list (workspace-wide audit incl non-operator actors)',
      'operator:decisions (operator-policy decision log)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'scoper', 'worker', 'debugger', 'curator'],
  rolesQuota: {
    worker: { perChunk: 20 },
    architect: { perRun: 100 },
    operator: { perRun: 500 },
  },
  args: z.object({
    cardId: z.string().min(1),
    kind: z.enum(ALLOWED_KINDS),
    actorMethod: z.enum(ALLOWED_METHODS).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  }),
  async handler(args) {
    await writeOperatorAudit({
      cardId: args.cardId,
      kind: args.kind as OperatorAuditKind,
      context: args.context,
      actorMethod: (args.actorMethod ?? null) as ActorMethod,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, cardId: args.cardId, kind: args.kind }) }],
    };
  },
});
