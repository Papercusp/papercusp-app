/**
 * POST /api/internal/domain-read-canary — deploy-triggered consumer/domain-read
 * probe (EI-856).
 *
 * The pre-existing post-deploy health gate (health-probe.ts) only checked
 * `/api/health` + an MCP `initialize` round-trip — neither exercises a REAL
 * domain read through the production resolver path. During WI-148 (the
 * papercup 'default'→'papercusp-workspace' data move, run in lockstep with a
 * resolver code-flip) a deploy that landed a half-state — the data moved but
 * the code didn't flip, or vice versa — would have passed that gate cleanly
 * while EVERY papercusp plan read silently 404'd/returned empty. This route
 * closes that gap: it does the SAME `resolvePlanScope` + `listPlanRows` call
 * the operator's own `plans:list` tool and the device Plans tab use, against
 * the operator-home (papercusp) harness, right after the freshly-restarted
 * operator's basic health/MCP checks go green — so a lockstep half-state is
 * caught INSIDE the deploy's own verification window, while the automated
 * code+DB-snapshot rollback can still fire.
 *
 * `auth: 'loopback'` — deploy-cli runs on the same box; no external caller
 * needs this. Read-only.
 *
 * GUARD (mirrors memory-canary-probe.ts's PASS-WITH-NOTE contract): this
 * route NEVER 5xxs — a resolver throw / a genuinely empty (but otherwise
 * healthy) plan set are both reported in the 200 body as `reachable`/`empty`.
 * Whether an empty/unreachable domain read BLOCKS the deploy is a policy
 * decision owned by the CALLER (health-probe.ts's `domainReadPolicy`), never
 * this route — a broken probe apparatus must never itself look like "the
 * operator is unhealthy" to a naive caller.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { listPlanRows } from '../../../agent-tools/plans/source';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';

export default defineTool({
  method: 'POST',
  path: '/internal/domain-read-canary',
  auth: 'loopback',
  async handler() {
    const harnessSlug = operatorHomeHarnessSlug();
    try {
      const rows = await listPlanRows({ harnessSlug });
      return Response.json({
        ok: true,
        reachable: true,
        harnessSlug,
        planCount: rows.length,
        empty: rows.length === 0,
      });
    } catch (e) {
      // PASS-WITH-NOTE: a resolver/DB throw here is exactly the failure mode
      // this route exists to catch (the WI-148 half-state class) — report it
      // in the 200 body, never as a 5xx (the caller's policy decides whether
      // it blocks the deploy).
      return Response.json({
        ok: true,
        reachable: false,
        harnessSlug,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
