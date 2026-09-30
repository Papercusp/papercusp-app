/**
 * POST /api/internal/memory-canary — deploy-triggered live memory recall
 * canary probe (EI-10361).
 *
 * Wraps the existing scheduled canary orchestration (`runRecallCanary`,
 * recall-canary.ts / EI-10047) for an ON-DEMAND, in-process call from the
 * freshly-restarted operator: the post-deploy health probe
 * (health-probe.ts's `probeMemoryCanary`) POSTs here right after
 * `/api/health` + the MCP probe go green, so a deploy-induced silent recall
 * outage (the 2026-07-12 PG-42703 class — schema drift makes the store
 * swallow errors and return zero hits) is caught INSIDE the deploy's own
 * verification window, while the automated code+DB-snapshot rollback can
 * still fire — instead of up to 24h later at the next scheduled 05:45 tick,
 * after that rollback window has closed. Complements, never replaces, the
 * daily scheduled canary (memory-live-recall-canary blueprint).
 *
 * `auth: 'loopback'` — deploy-cli runs on the same box; no external caller
 * needs this. Read-only (~25 live searches via `runRecallCanary`'s own
 * contract, no store writes beyond its own bookkeeping row — migration 580).
 *
 * GUARD (the design's PASS-WITH-NOTE contract): this route NEVER 5xxs on a
 * degraded/decayed/seeded/flag-off/error outcome — it always 200s with the
 * verdict in the body. Whether a `degraded` verdict blocks the DEPLOY is a
 * policy decision owned by the CALLER (health-probe.ts's
 * `memoryCanaryPolicy`), not this route — an unarmed/broken canary apparatus
 * must never itself throw a 5xx that a naive caller could confuse for "the
 * operator is unhealthy".
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runRecallCanary } from '../../../memory/bench/recall-canary';
import { activeWorkspaceId } from '../../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';

const bodySchema = z.object({
  workspaceId: z.string().min(1).max(200).optional(),
});

export default defineTool({
  method: 'POST',
  path: '/internal/memory-canary',
  auth: 'loopback',
  async handler(req) {
    let workspaceId: string | undefined;
    try {
      const raw: unknown = await req.json();
      const parsed = bodySchema.safeParse(raw);
      if (parsed.success) workspaceId = parsed.data.workspaceId;
    } catch {
      /* no/invalid body — fine, this route's body is entirely optional */
    }
    if (!workspaceId) {
      try {
        workspaceId = activeWorkspaceId();
      } catch (e) {
        // PASS-WITH-NOTE: no resolvable workspace is a config gap, not an
        // operator-health failure — never 5xx here (see file header).
        return Response.json(
          { ok: true, ran: false, skipReason: 'failed', error: `no workspace resolvable: ${e instanceof Error ? e.message : String(e)}` },
          { status: 200 },
        );
      }
    }
    const installSlug = operatorHomeHarnessSlug();
    try {
      const outcome = await runRecallCanary({ workspaceId, installSlug });
      if (!outcome.ran) {
        return Response.json({
          ok: true,
          ran: false,
          skipReason: outcome.skipReason,
          error: 'error' in outcome ? outcome.error : undefined,
        });
      }
      return Response.json({
        ok: true,
        ran: true,
        status: outcome.status,
        rAt10: outcome.metrics.rAt10,
        delta: outcome.metrics.delta,
        zeroHitRate: outcome.metrics.zeroHitRate,
        rowId: outcome.rowId,
      });
    } catch (e) {
      // runRecallCanary already catches internally and returns a `failed`
      // outcome — this is a last-resort backstop (e.g. an unexpected throw
      // in the workspace/slug resolution above). Same PASS-WITH-NOTE 200.
      return Response.json(
        { ok: true, ran: false, skipReason: 'failed', error: e instanceof Error ? e.message : String(e) },
        { status: 200 },
      );
    }
  },
});
