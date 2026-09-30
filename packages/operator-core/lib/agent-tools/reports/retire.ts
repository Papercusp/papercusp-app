/**
 * reports:retire — soft-retire one OR many reports (P-003; satisfies R-3).
 *
 * Retirement is SOFT and that is the whole design: the row keeps its body and still
 * resolves by id, it just leaves the default library list. Nothing here can hard-
 * delete a report, because a citation to a report id must never stop resolving.
 *
 * ## Write authority (distinct from the R-7 READ matrix)
 * R-7 governs who may READ a report; it says nothing about who may retire one, and
 * borrowing it would let any agent in a pot retire a peer's `pot`-visible report.
 * This verb therefore applies its own narrower rule: you may retire a report you
 * AUTHORED. The check runs in two stages so it cannot leak existence — an invisible
 * report is `not_found` (same answer reports:get gives), and only a report you can
 * already see can come back `not_author`.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getReport, retireReport } from '../../report-library';
import { mergeIds, runBulk, bulkContent, bulkEnvelopeSchema } from '../_bulk';
import { invalidateReportsSync, resolveViewer, resolveWorkspaceId, toReportSummary } from './_shared';

export default defineTool({
  name: 'reports:retire',
  description:
    'Soft-retire one OR many reports you authored: they leave the default library list but KEEP their ' +
    'body and still resolve by id, so citations never break. Pass `id` for one or `ids` for several. ' +
    'Idempotent — re-retiring preserves the original `retired_at`. You may retire only reports you ' +
    'authored. There is no hard delete. To correct a report rather than withdraw it, publish a new ' +
    'version with `supersedes` instead: that keeps the correction visible as history.',
  guidance: {
    when:
      'When a report you published should no longer appear in the library — it was published in error, is ' +
      'obsolete with no replacement, or was superseded by work that lives elsewhere.',
    notWhen:
      'To correct or update a report — reports:publish { supersedes: id } supersedes it and keeps the ' +
      'history readable, which is almost always what you want. Retiring is withdrawal, not revision.',
    chaining:
      'reports:list → reports:retire { ids:[…] }. A retired report still resolves via reports:get, so you ' +
      'can un-publish safely without breaking a citation someone already made.',
    returns:
      '{ ok, results:[{ ok, id, report? | error }], counts } — correlate by id, NOT position. `report` is ' +
      'the updated record with `retiredAt` set. error is `not_found` when the id does not exist OR is not ' +
      'visible to you (existence is withheld by the same rule that hides the report); `not_author` when ' +
      'you can see it but did not write it — ask its author, or supersede it instead.',
    seeAlso: ['reports:publish (supersede — the usual alternative)', 'reports:get (a retired report still resolves)'],
  },
  // Envelope described by `_bulk`; per-item stays OPEN (`report` on success, `error`
  // — not_found or not_author — on failure).
  result: bulkEnvelopeSchema(),
  capability: 'reports:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single report id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).min(1).max(50).optional().describe('report ids to retire (1–50)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args, ctx) {
    const sql = getOrgPg().sql;
    const workspaceId = resolveWorkspaceId(ctx);
    const viewer = resolveViewer(ctx);
    const ids = mergeIds(args.id, args.ids);
    let anyRetired = false;

    const env = await runBulk(
      ids,
      async (id) => {
        // Stage 1 — visibility, via the store's gate. Not visible ⇒ not_found, so
        // this verb cannot be used to probe which report ids exist.
        const existing = await getReport(sql, workspaceId, id, viewer);
        if (!existing) return { ok: false as const, id, error: 'not_found' };

        // Stage 2 — authorship. Narrower than the read matrix on purpose.
        if (!viewer.ownerId || existing.origin.authorOwnerId !== viewer.ownerId) {
          return { ok: false as const, id, error: 'not_author' };
        }

        const report = await retireReport(sql, workspaceId, id);
        if (!report) return { ok: false as const, id, error: 'not_found' };
        anyRetired = true;
        return { ok: true as const, id, report: toReportSummary(report) };
      },
      { keyOf: (id) => ({ id }) },
    );

    if (anyRetired) invalidateReportsSync((m) => ctx.log(m));
    return bulkContent(env);
  },
});
