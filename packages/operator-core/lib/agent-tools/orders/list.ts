/**
 * orders:list — the owner-directives ledger for this workspace (EI-11484):
 * open (still owed) by default, or the full record with { open: false } /
 * omitted-open history. Nothing is truncated (D-004 of
 * owner-directive-delivery-redesign-2026-09-22): a directive within the verbatim
 * cap is returned whole; a longer one carries its agent summary and the
 * orders:get pointer to the full verbatim.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_READ_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  alsoSentToNote,
  directiveNeedsSummary,
  listOwnerDirectives,
  OWNER_DIRECTIVE_STATES,
  OWNER_DIRECTIVE_VERBATIM_CAP,
  ownerDirectiveState,
} from '../../owner-directives';
import { listClearedDirectiveIds } from '../../owner-directive-agenda';
import { resolveAgentIdentity } from '../coordination/identity';

export default defineTool({
  name: 'orders:list',
  profile: 'engineer',
  description: `List recorded owner directives for this workspace — open (the ones still owed) with { open: true }, closed with { open: false }, all when omitted. Directives ≤ ${OWNER_DIRECTIVE_VERBATIM_CAP} chars come back verbatim; longer ones as their agent summary + an orders:get pointer.`,
  guidance: {
    when:
      'Orienting on what the workspace still OWES the owner, before loop:end / wind-down, or auditing how past directives were closed. Use { state } to separate done from declined.',
    notWhen:
      'Finding YOUR directive: use the id your turn gave you, or `mine`/`yours` — never a text match (the same text is often open in other sessions). Full verbatim by id: orders:get. Filter state with { state }, not client-side (`limit` cuts first).',
    seeAlso: ['orders:get', 'orders:record', 'orders:disposition'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_READ_ROLES],
  args: z.object({
    open: z.boolean().optional().describe('true = only open; false = only dispositioned; omit = all.'),
    state: z
      .union([
        z.enum(OWNER_DIRECTIVE_STATES as unknown as [string, ...string[]]),
        z.array(z.enum(OWNER_DIRECTIVE_STATES as unknown as [string, ...string[]])).min(1).max(3),
      ])
      .optional()
      .describe('Exact lifecycle state(s): open | done | declined. Applied in SQL before `limit`.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId() ?? 'default';
    const rows = await listOwnerDirectives({
      workspaceId,
      open: args.open,
      state: args.state as Parameters<typeof listOwnerDirectives>[0]['state'],
      limit: args.limit,
    });
    // This is the LEDGER, so it deliberately does NOT apply `viewerOwnerId`:
    // the rows you cleared off your own banner must stay findable here, or
    // `clear` becomes an untraceable disappearance rather than a per-session
    // agenda action. They are ANNOTATED instead — that annotation is also what
    // explains why a row visible here is absent from your Orientation banner.
    let clearedByMe = new Set<number>();
    let me: string | null = null;
    try {
      me = resolveAgentIdentity(ctx).ownerId;
      clearedByMe = await listClearedDirectiveIds({ ownerId: me, workspaceId });
    } catch {
      /* unattributable caller — no agenda to annotate against */
    }
    // directive-ownership-clarity-2026-09-23 P-003 / D-001: every row says whose it
    // is, your own rows come first, and `byAddressee` groups the rest under their
    // session. On 2026-09-23 an agent regex-filtered this list by text and closed
    // five other sessions' copies of the same pasted report; `mine` is the field
    // to filter on, and your own directive's id arrived with the turn itself.
    const ordered = [...rows.filter((r) => r.recordedBy === me), ...rows.filter((r) => r.recordedBy !== me)];
    const byAddressee: Record<string, number[]> = {};
    for (const r of ordered) if (r.recordedBy !== me) (byAddressee[r.recordedBy] ??= []).push(r.id);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            count: rows.length,
            yours: ordered.filter((r) => r.recordedBy === me).map((r) => r.id),
            byAddressee,
            directives: ordered.map((r) => ({
              id: r.id,
              mine: r.recordedBy === me,
              addressedTo: r.recordedBy,
              open: r.dispositionedAtMs == null,
              state: ownerDirectiveState(r),
              // D-004(1): the same text open for other sessions is THEIR directive,
              // counted over the whole open set (not this page) by the store read.
              ...((r.otherSessionCopies ?? 0) > 0
                ? { alsoSentTo: r.otherSessionCopies, alsoSentNote: alsoSentToNote(r.otherSessionCopies).trim() }
                : {}),
              ...(clearedByMe.has(r.id)
                ? { clearedFromYourAgenda: true, clearedNote: 'Cleared from YOUR banner only (orders:clear) — still open for its addressee.' }
                : {}),
              ...(directiveNeedsSummary(r)
                ? {
                    summary: r.summaryText ?? null,
                    summaryBy: r.summaryBy ?? null,
                    verbatimChars: r.verbatimText.trim().length,
                    fullText: `orders:get #${r.id}`,
                  }
                : { verbatim: r.verbatimText.trim() }),
              recordedBy: r.recordedBy,
              createdAt: new Date(r.createdAtMs).toISOString(),
              ...(r.dispositionedAtMs != null
                ? {
                    dispositionStatus: r.dispositionStatus,
                    dispositionNote: r.dispositionNote,
                    dispositionedBy: r.dispositionedBy,
                    dispositionedAt: new Date(r.dispositionedAtMs).toISOString(),
                  }
                : {}),
            })),
          }),
        },
      ],
    };
  },
});
