/**
 * GET /api/harness/:slug/assertion/:valId
 *
 * Resolve a VAL-* assertion by id. Reads from harness_plan_assertions (PG).
 * Returns 404 if not found — no fallback to validation-contract.md.
 *
 * Per plans-central-harness-ux-2026-05-26 Phase 6 P-020.
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';

interface AssertionRow {
  val_id: string;
  plan_slug: string;
  item_id: string;
  verify_text: string;
  evidence_text: string;
  status: string;
  requires_test: boolean;
}

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/assertion/:valId',
  auth: 'public',
  // For validator agents resolving a VAL-* assertion text by id before writing
  // a report. NOT a fallback for validation-contract.md — a 404 here means the
  // feature was not promoted from a plan with inline VAL-* assertions.
  // (HTTP-route defineTools carry no `guidance` block — that's MCP-tool only.)
  async handler(_req, ctx) {
    const slug = ctx.params.slug as string;
    const valId = ctx.params.valId as string;

    if (!slug || !valId) {
      return Response.json({ error: 'missing slug or valId' }, { status: 400 });
    }

    try {
      const { sql } = getOrgPg();
      const workspaceId = activeWorkspaceId();

      const rows = await sql<AssertionRow[]>`
        SELECT val_id, plan_slug, item_id, verify_text, evidence_text, status, requires_test
          FROM harness_shared.harness_plan_assertions
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${slug}
           AND val_id       = ${valId}
         LIMIT 1
      `;

      if (rows.length === 0) {
        return Response.json(
          {
            error: 'assertion_not_found',
            detail: 'assertion not found — feature must be promoted from a plan with inline VAL-* assertions',
          },
          { status: 404 },
        );
      }

      const row = rows[0];
      return Response.json({
        val_id: row.val_id,
        verify_text: row.verify_text,
        evidence_text: row.evidence_text,
        status: row.status,
        requires_test: row.requires_test,
        plan_slug: row.plan_slug,
        item_id: row.item_id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: 'internal_error', detail: msg }, { status: 500 });
    }
  },
});
