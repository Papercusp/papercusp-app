/**
 * orders:capture — the UserPromptSubmit hook's owner-turn capture. Every owner
 * turn is a directive (D-001 of owner-directive-delivery-redesign-2026-09-22),
 * so the row lands OPEN: there is no pending triage step. Intentionally tiny
 * and fail-soft at the caller.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { classifyCallOrigin } from '../../telemetry-call-origin';
import {
  countOpenOwnerDirectives,
  directiveNeedsSummary,
  OWNER_DIRECTIVE_VERBATIM_MAX,
  recordOwnerDirective,
} from '../../owner-directives';

export default defineTool({
  name: 'orders:capture',
  profile: 'engineer',
  description:
    'Record an OWNER (interactive) prompt verbatim as an open owner directive. Called by the UserPromptSubmit hook; idempotent per source turn.',
  guidance: {
    when: 'Never by hand — the provenance hook calls it on every OWNER (interactive) turn.',
    notWhen: 'Recording an owner order yourself (e.g. relayed by another channel) — orders:record.',
    seeAlso: ['orders:record', 'orders:summarize', 'orders:disposition'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    verbatim: z.string().min(4).max(OWNER_DIRECTIVE_VERBATIM_MAX),
    sourceTurnRef: z.string().min(1).max(300),
    sessionRef: z.string().max(300).optional(),
    ownerName: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    // captured_by_hook is load-bearing authority: Personal Vault release
    // (personal-data-reader-set-labels-2026-10-01 D-005) trusts it to mean the
    // OWNER typed this. A model client calling this verb would mint that proof
    // for whatever text it chose, so only a declared hook dispatch may.
    const origin = classifyCallOrigin({ requestOrigin: ctx.requestOrigin });
    if (origin.origin !== 'hook' || origin.source !== 'declared') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'hook_origin_required',
              hint: 'orders:capture is the UserPromptSubmit hook\'s verb; record an owner order yourself with orders:record.',
            }),
          },
        ],
      };
    }
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId() ?? 'default';
    const row = await recordOwnerDirective({
      workspaceId,
      ownerId: args.ownerName,
      sessionRef: args.sessionRef ?? null,
      sourceTurnRef: args.sourceTurnRef,
      verbatimText: args.verbatim,
      recordedBy: identity.ownerId,
      capturedByHook: true,
    });
    const openCount = await countOpenOwnerDirectives(workspaceId).catch(() => null);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: row.id,
            // The hook turns this into the forced-summary instruction for the
            // addressed agent (D-004): other agents see only the summary.
            needsSummary: directiveNeedsSummary(row) && !row.summaryText,
            ...(openCount == null ? {} : { openCount }),
          }),
        },
      ],
    };
  },
});
