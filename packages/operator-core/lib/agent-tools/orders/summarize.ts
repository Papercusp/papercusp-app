/**
 * orders:summarize — write the forced summary of an over-cap owner directive
 * (D-004 of owner-directive-delivery-redesign-2026-09-22). A directive longer
 * than OWNER_DIRECTIVE_VERBATIM_CAP chars is rendered to every other agent as
 * this summary instead of a truncated fragment; the owner's verbatim text is
 * never edited and stays one orders:get away.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_REPLY_ROLES } from '../coordination/roles';
import {
  OWNER_DIRECTIVE_SUMMARY_MAX,
  OWNER_DIRECTIVE_VERBATIM_CAP,
  summarizeOwnerDirective,
} from '../../owner-directives';
import { directiveActionVerdict } from '../../owner-directive-agenda';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'orders:summarize',
  profile: 'engineer',
  description: `Write the summary (≤ ${OWNER_DIRECTIVE_SUMMARY_MAX} chars) of an open owner directive longer than ${OWNER_DIRECTIVE_VERBATIM_CAP} chars — what every other agent sees for it. Required before you end the turn that received it.`,
  guidance: {
    when: `An owner directive addressed to you is over ${OWNER_DIRECTIVE_VERBATIM_CAP} chars and shows "summary not written yet". Summarize what the owner is asking for, faithfully, when you first read it.`,
    notWhen: `The directive is ${OWNER_DIRECTIVE_VERBATIM_CAP} chars or shorter (it renders verbatim; refused as summary_not_needed), or it is addressed to another session.`,
    seeAlso: ['orders:get', 'orders:disposition'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  args: z.object({
    id: z.number().int().positive().describe('The directive id.'),
    summary: z
      .string()
      .min(4)
      .max(OWNER_DIRECTIVE_SUMMARY_MAX)
      .describe(`What the owner asked for, in ≤ ${OWNER_DIRECTIVE_SUMMARY_MAX} chars. Rendered labeled with your id, never as owner speech.`),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // The summary replaces the owner's words for EVERY other agent, so only the
    // session the directive is addressed to (or a holder of work linking it)
    // may write it — the same rail orders:disposition carries.
    //
    // directive-ownership-clarity-2026-09-23 D-003: FAIL CLOSED, retryably. An
    // ownership read that errors must refuse with a typed, retryable envelope —
    // not escape the handler as an untyped internal error the caller cannot
    // tell apart from a real defect.
    let verdict: Awaited<ReturnType<typeof directiveActionVerdict>>;
    try {
      verdict = await directiveActionVerdict(
        { directiveId: args.id, ownerId: identity.ownerId, workspaceId: activeWorkspaceId() },
        undefined,
      );
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'verdict_unavailable',
              retryable: true,
              hint: `Could not confirm whose directive #${args.id} is (${String(err).slice(0, 160)}), so no summary was written. Retry shortly.`,
            }),
          },
        ],
        isError: true,
      };
    }
    if ('notFound' in verdict) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'not_found' }) }], isError: true };
    }
    if (!verdict.allowed) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'foreign_directive',
              addressedTo: verdict.addressedTo,
              holders: verdict.holders,
              hint: `Directive #${args.id} is addressed to ${verdict.addressedTo}; its summary is theirs to write.`,
            }),
          },
        ],
        isError: true,
      };
    }
    const result = await summarizeOwnerDirective({ id: args.id, summary: args.summary, summarizedBy: identity.ownerId });
    const body = result.ok
      ? { ok: true, id: args.id, summary: result.row.summaryText }
      : { ok: false, id: args.id, error: result.error };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
});
