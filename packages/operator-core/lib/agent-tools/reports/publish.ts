/**
 * reports:publish — publish a report into the owner-facing Reports library
 * (plan reports-library-2026-09-15, P-003; satisfies R-1, R-2, R-3).
 *
 * The write path's three load-bearing properties:
 *   * ORIGIN IS NOT AN ARGUMENT. The args schema has no author/pot/session field;
 *     `stampOrigin(ctx)` is the only producer, so a caller payload structurally
 *     cannot forge provenance (R-2).
 *   * AN OVER-CAP BODY IS REFUSED WITH ITS OVERAGE, never stored truncated (R-1) —
 *     a reader cannot tell a truncated audit from one that simply ended.
 *   * A REDONE REPORT PUBLISHES A NEW ROW carrying `supersedes`, inheriting its
 *     predecessor's lineage; nothing is edited in place (R-3).
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { publishReport } from '../../report-library';
import { emitAwaitedEvent } from '../../events/await/engine';
import {
  invalidateReportsSync,
  reportUiPath,
  resolveOwnerId,
  resolveWorkspaceId,
  stampOrigin,
  toRefusal,
  toReportWire,
  zReportKind,
  zReportWire,
  zReportSubject,
  zReportVisibility,
} from './_shared';

export default defineTool({
  name: 'reports:publish',
  description:
    'Publish a report (audit, review, analysis, postmortem, status digest, proposal) into the ' +
    "owner-facing Reports library and get back a stable `report_id` and its UI path. The body is " +
    'markdown (mermaid fences allowed), bounded at 512KB — an over-cap body is REFUSED with its exact ' +
    'overage, never silently truncated. Origin (who wrote it, in which pot, in which session) is ' +
    'stamped by the server from your session and cannot be passed in. Pass `supersedes` to republish a ' +
    'corrected version: it inherits the original lineage, and the old body stays resolvable by id.',
  guidance: {
    when:
      'When you have finished a piece of written work the OWNER should be able to find later — an audit, ' +
      'a review, a postmortem, an analysis. Publishing puts it in the browsable library instead of ' +
      'leaving it in a transcript nobody can search.',
    notWhen:
      'For in-flight state a successor needs (work_items:checkpoint), a standing conclusion peers should ' +
      'inherit (facts:assert), a decision other lanes must follow (plans:add-decision), or a message to ' +
      'a specific agent (coord:send). Do NOT republish to fix a typo in a report you just published ' +
      'unless it is worth a new lineage entry.',
    chaining:
      'reports:publish → the returned `path` is the owner deep link; cite `report_id` anywhere. ' +
      'Correcting one: reports:get { id } → reports:publish { supersedes: id } → reports:list shows only ' +
      'the new one, with the history behind it.',
    returns:
      '{ ok:true, report_id, workspace_id, title, summary, kind, subject, origin, visibility, ' +
      'supersedes_report_id, lineage_id, source, tags, published_at, updated_at, retired_at, path, ' +
      'body_bytes, event_emitted }. Refusals are structured { ok:false, error, message }: ' +
      '`body_too_large` also carries { bytes, limitBytes, overageBytes } so you know how much to cut; ' +
      '`supersedes_not_found` means the id you are replacing does not exist in this workspace (nothing ' +
      'was published — fix the id rather than dropping `supersedes`, which would orphan the history); ' +
      '`subject_ref_required` means every subject.kind except `none` needs a ref; `invalid_field` names ' +
      'the rejected enum value. `event_emitted:false` means the row IS published but the ' +
      '`report:published:<id>` wake did not fire — the publish stands, only the notification was lost.',
    seeAlso: [
      'reports:list (browse the library)',
      'reports:get (read one back, with its lineage)',
      'reports:retire (soft-retire one you authored)',
    ],
  },
  // The success envelope is the wire record spread flat, plus `ok` and the
  // best-effort `event_emitted`. Refusals are returned as a separate structured
  // shape and are described in `returns` prose rather than unioned in here.
  result: zReportWire.extend({ ok: z.literal(true), event_emitted: z.boolean() }),
  capability: 'reports:write',
  requirePrincipal: false,
  // Any agent session may publish — the library is the fleet's shared output surface.
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    title: z.string().min(1).max(500).describe('one line; this is what the library list shows'),
    summary: z.string().max(4000).optional().describe('a short abstract shown under the title'),
    body_md: z.string().optional().describe('the report itself, markdown; mermaid fences allowed; ≤512KB'),
    kind: zReportKind.optional().describe('what kind of report this is (default `audit`)'),
    subject: zReportSubject.optional().describe('what it is ABOUT — use `external` for subjects outside this workspace'),
    visibility: zReportVisibility
      .optional()
      .describe('who may READ it: `owner` (default) | `pot` | `workspace`'),
    supersedes: z
      .string()
      .min(1)
      .optional()
      .describe('the report_id this replaces; its lineage is inherited and its body stays resolvable'),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  }),
  async handler(args, ctx) {
    const sql = getOrgPg().sql;
    const workspaceId = resolveWorkspaceId(ctx);

    let report;
    try {
      report = await publishReport(
        sql,
        {
          workspaceId,
          title: args.title,
          summary: args.summary,
          bodyMd: args.body_md,
          kind: args.kind,
          subject: args.subject,
          visibility: args.visibility,
          supersedes: args.supersedes,
          tags: args.tags,
        },
        // Axis 1, server-side. Never from `args` — see stampOrigin.
        stampOrigin(ctx),
      );
    } catch (err) {
      // A refusal rides the same `{ data }` envelope as a success: the handler
      // contract is `ToolResult | ToolResponse`, and a bare object would not be
      // assignable on either branch.
      return { data: toRefusal(err) };
    }

    // The row is committed from here on. Both side effects are therefore
    // best-effort and REPORTED rather than thrown: failing the call now would tell
    // the caller the publish failed when it did not, and a retry would duplicate it.
    let eventEmitted = true;
    try {
      await emitAwaitedEvent({
        key: `report:published:${report.reportId}`,
        payload: {
          report_id: report.reportId,
          lineage_id: report.lineageId,
          supersedes_report_id: report.supersedesReportId,
          kind: report.kind,
          visibility: report.visibility,
          subject: report.subject,
          origin: report.origin,
          path: reportUiPath(report.reportId),
        },
        summary: `report published: ${report.title}`,
        source: resolveOwnerId(ctx) ?? 'reports:publish',
        workspaceId,
      });
    } catch (e) {
      eventEmitted = false;
      ctx.log(`report:published emit failed for ${report.reportId}: ${e instanceof Error ? e.message : e}`);
    }
    invalidateReportsSync((m) => ctx.log(m));

    // One shared wire projection, so publish and list name every field identically.
    return { data: { ok: true as const, ...toReportWire(report), event_emitted: eventEmitted } };
  },
});
