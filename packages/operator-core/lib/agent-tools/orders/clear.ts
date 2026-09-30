/**
 * orders:clear — take an owner directive off YOUR OWN banner, changing nothing
 * for its addressee or any other session (D-008 of
 * directive-visibility-and-ownership-2026-09-22). This is the agenda half of the
 * former orders:resolve-pending; its promote/dismiss half was removed when every
 * owner turn became a directive (owner-directive-delivery-redesign-2026-09-22,
 * D-001) — a directive now ends only through orders:disposition.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { clearDirectiveFromAgenda } from '../../owner-directive-agenda';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'orders:clear',
  profile: 'engineer',
  description:
    "Remove one owner directive from YOUR OWN banner only, with a reason. It stays open for its addressee and every other session; orders:list keeps showing it.",
  guidance: {
    when: 'A directive addressed to ANOTHER session keeps rendering to you and is unrelated to your work.',
    notWhen: 'The directive is yours — carry it out and close it with orders:disposition.',
    seeAlso: ['orders:disposition', 'orders:list'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.number().int().positive().describe('Directive id from the Orientation block or orders:list.'),
    reason: z.string().min(4).max(2000).describe('Why it is not yours to act on (e.g. "addressed to su-…, unrelated to my plan").'),
  }),
  async handler(args, ctx) {
    // The schema's min(4) accepts four spaces; a cleared row without a real
    // reason cannot be told apart from an unexplained disappearance.
    if (!args.reason.trim()) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'reason_required' }) }], isError: true };
    }
    const identity = resolveAgentIdentity(ctx);
    // Deliberately UNGUARDED: clearing a foreign directive from your own banner
    // is the correct operation, and refusing it would strand every foreign row
    // in every agent's Orientation forever. It must never acquire an ownership check.
    const cleared = await clearDirectiveFromAgenda(
      { directiveId: args.id, ownerId: identity.ownerId, workspaceId: activeWorkspaceId(), reason: args.reason.trim() },
      undefined,
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...cleared, scope: 'this-session-only' }) }] };
  },
});
