/**
 * orders:get — one owner directive, FULL VERBATIM (EI-11484). The render
 * points excerpt long rows with substr + a pointer to this tool; this is the
 * pointer's target.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_READ_ROLES } from '../coordination/roles';
import { directiveNeedsSummary, getOwnerDirective } from '../../owner-directives';
import { activeWorkspaceId } from '../../workspace-registry';
import { assessDirectiveStatus, deriveDirectiveStatus } from '../../owner-directive-status';
import { listWorkItemsByDirective } from '../../work-items';

export default defineTool({
  name: 'orders:get',
  profile: 'engineer',
  description:
    'Fetch one recorded owner directive by id — the FULL verbatim text plus provenance, summary and disposition. The target of the "[full text: orders:get #id]" pointer every surface leaves on a long directive.',
  guidance: {
    when: 'A render or orders:list showed a long directive as its summary and you need the owner\'s full words before acting.',
    notWhen: 'Browsing the set — orders:list.',
    seeAlso: ['orders:list', 'orders:disposition'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_READ_ROLES],
  args: z.object({
    // COERCED, not merely numeric: this tool backs the `owner.directive.status`
    // state cell, and `cell-read.ts` passes a caller-relative subject through as
    // a STRING (`argsForRelativity`). A bare z.number() rejects "125" and the
    // cell would report `resolver-failed` for a directive that exists.
    id: z.coerce.number().int().positive().describe('The directive id.'),
  }),
  async handler(args, ctx) {
    const row = await getOwnerDirective(args.id);
    if (!row) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'not_found',
              id: args.id,
              // RESULT-level unknown channel for the `owner.directive.status` cell
              // (D-038 axis 2). A per-row qualifier is missable; this is not. It
              // says WHY the headline path is absent, so a null is never read as
              // "this directive has no status".
              directiveUnknown:
                'no directive with this id is recorded in this workspace — it was never captured here, or the id belongs to another workspace. This is an ABSENT subject, not an unclaimed directive.',
            }),
          },
        ],
        isError: true,
      };
    }
    // P-007: the cell and the banner derive from ONE function. The turn-start
    // renderer calls `deriveDirectiveStatus(row, linked)` (turn-start-orientation.ts
    // ~:3507); this is the same call over the same two inputs, so a mid-turn
    // ACTION-time re-read ("has this been claimed since turn start?") can never
    // disagree with the banner the caller is acting on.
    //
    // Fail-soft on the linked-items read ONLY: a directive whose work-item query
    // fails still derives from its own row, where `unclaimed` is the correct and
    // safe reading. Swallowing the whole status instead would make the cell
    // silently unreadable exactly when the caller most needs it.
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId() ?? 'default';
    const linked = await listWorkItemsByDirective(workspaceId, [row.id]).catch(() => []);
    const status = deriveDirectiveStatus(row, linked);
    // The ASSESSMENT, distinct from the headline `status.kind` on purpose (D-038):
    // an assessment must say what a measurement MEANS, and re-projecting the kind
    // would add a field and no information. These codes are exactly the
    // distinctions the bare kind CANNOT make — each one changes what the reader
    // should do next; 'worked-awaiting-disposition' is the measured D-007 shape
    // that must not render as an imperative.
    const assessments = { directiveStatus: assessDirectiveStatus(status) };
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            assessments,
            directive: {
              id: row.id,
              open: row.dispositionedAtMs == null,
              status,
              verbatim: row.verbatimText,
              owner: row.ownerId,
              recordedBy: row.recordedBy,
              sessionRef: row.sessionRef,
              sourceTurnRef: row.sourceTurnRef,
              createdAt: new Date(row.createdAtMs).toISOString(),
              // D-004: an over-cap directive renders to other agents as its summary.
              ...(directiveNeedsSummary(row)
                ? {
                    summary: row.summaryText ?? null,
                    summaryBy: row.summaryBy ?? null,
                    ...(row.summaryAtMs != null ? { summaryAt: new Date(row.summaryAtMs).toISOString() } : {}),
                  }
                : {}),
              ...(row.dispositionedAtMs != null
                ? {
                    dispositionStatus: row.dispositionStatus,
                    dispositionNote: row.dispositionNote,
                    dispositionedBy: row.dispositionedBy,
                    dispositionedAt: new Date(row.dispositionedAtMs).toISOString(),
                  }
                : {}),
            },
          }),
        },
      ],
    };
  },
});
