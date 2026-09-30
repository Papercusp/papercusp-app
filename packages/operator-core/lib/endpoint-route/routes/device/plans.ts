/**
 * Device plans routes — mobile-apps-revival-redesign-2026-06-05 (D-002).
 *
 *   GET  /device/plans                              device JWT
 *   GET  /device/plans/:slug                        device JWT
 *   POST /device/plans/:slug/items/:itemId/status   device JWT
 *
 * The phone's Plans tab browses the PG-canonical plans
 * (harness_shared.harness_plans) and acts on items (approve = a status
 * flip to `done`; nudge = a flip to `wip`; gate = `needs-human`). All
 * over the SAME source the desktop + TUI read, scoped to the device's
 * workspace, with an optional pot (harness) filter for the header's
 * "All Pots" switcher (D-003).
 *
 * Reads call the plans source layer directly; the item write dispatches
 * the `plans:set-status` tool in-process so it reuses the proven path
 * (PG advisory lock → surgical flip → plan-revision capture → plan-event
 * emit → needs-human push), rather than re-implementing the RMW.
 */
import { z } from 'zod';
import {
  defineTool,
  dispatchProjectedTool,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { listPlanRows, readPlanBySlug, type PlanRow } from '../../../agent-tools/plans/source';
import { listHarnessesFor } from '../../../device-harnesses';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';

/** Compact per-status item tally for a plan card. */
function itemCounts(row: PlanRow): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of row.items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return counts;
}

function planSummary(row: PlanRow) {
  return {
    slug: row.planSlug,
    harness: row.harnessSlug,
    title: row.title ?? row.planSlug,
    status: row.status,
    updated: row.updated ?? row.updatedAt,
    owner: row.owner,
    archived: row.archived,
    itemCounts: itemCounts(row),
    nowState: row.nowState,
    nowNext: row.nowNext,
  };
}

/**
 * GET /device/plans?harness=<slug>&includeArchived= — plan summaries.
 * Omitted harness (or `all`) fans out across every harness (pot) in the
 * workspace for the "All Pots" view; a concrete slug narrows to one pot.
 */
const plansList = defineTool({
  method: 'GET',
  path: '/device/plans',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness');
    const includeArchived = url.searchParams.get('includeArchived') === 'true';

    let slugs: string[];
    if (harness && harness !== 'all' && harness !== '*') {
      slugs = [harness];
    } else {
      // Fan out across the workspace's pots ("All Pots"). Always include the
      // operator-home primary (papercusp post-migration) — its plans live under
      // the home workspace (resolvePlanScope), which the device's paired
      // workspace may not be. Baking 'papercup' here returned nothing once the
      // papercup→papercusp migration moved the home's plans, so resolve the
      // home pointer instead of a dead literal.
      const harnesses = await listHarnessesFor(principal.workspaceId).catch(() => []);
      slugs = [...new Set([operatorHomeHarnessSlug(), ...harnesses.map((h) => h.slug)])];
    }

    const all: PlanRow[] = [];
    for (const slug of slugs) {
      try {
        // No workspaceId override — let resolvePlanScope resolve each pot to
        // the workspace its plans actually live in (the home → its workspace),
        // the SAME resolution the operator's plans:list uses.
        const rows = await listPlanRows({ harnessSlug: slug, includeArchived });
        all.push(...rows);
      } catch {
        /* best-effort per pot — a missing/empty harness shouldn't fail the list */
      }
    }
    // Most-recently-updated first.
    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return Response.json({ plans: all.map(planSummary) });
  },
});

/**
 * GET /device/plans/:slug?harness=<slug> — one plan's full parsed
 * structure (frontmatter + Now + items + decisions) for the detail view.
 */
const planGet = defineTool({
  method: 'GET',
  path: '/device/plans/:slug',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const harness = new URL(req.url).searchParams.get('harness') ?? undefined;
    // No workspaceId override — resolvePlanScope resolves the harness to the
    // workspace its plans live in (papercup → default), matching plans:get.
    // (Auth is the DEVICE_AUTH gate; no principal field is needed here.)
    const found = await readPlanBySlug(ctx.params.slug, { harnessSlug: harness });
    if (!found) return Response.json({ error: 'plan_not_found' }, { status: 404 });
    const { parsed, archived, row } = found;
    return Response.json({
      slug: row.planSlug,
      harness: row.harnessSlug,
      archived,
      title: row.title ?? row.planSlug,
      status: row.status,
      owner: row.owner,
      frontmatter: parsed.frontmatter,
      now: parsed.now,
      items: parsed.items,
      decisions: parsed.decisions,
    });
  },
});

/**
 * POST /device/plans/:slug/items/:itemId/status — flip a plan item's
 * status from the phone (approve→done, nudge→wip, gate→needs-human, …).
 * Dispatches plans:set-status in-process for the full locked RMW path.
 */
const planItemSetStatus = defineTool({
  method: 'POST',
  path: '/device/plans/:slug/items/:itemId/status',
  auth: DEVICE_AUTH,
  cors: true,
  input: z.object({
    status: z.string().min(1),
    note: z.string().max(400).optional(),
    harness: z.string().min(1).optional(),
  }),
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    const tool = lookupByMcpName('plans:set-status');
    if (!tool) return Response.json({ error: 'plans:set-status not registered' }, { status: 500 });

    const toolCtx: UnifiedToolContext = {
      log: () => {},
      signal: ctx.signal,
      progress: () => {},
      emit: () => {},
      workspaceId: principal.workspaceId,
      role: 'operator',
      runId: globalThis.crypto.randomUUID(),
      spawnId: globalThis.crypto.randomUUID(),
      transport: 'in_process',
      uiClientId: null,
    };

    const dispatched = await dispatchProjectedTool(
      tool,
      'plans:set-status',
      {
        slug: ctx.params.slug,
        item: ctx.params.itemId,
        status: ctx.input.status,
        ...(ctx.input.note ? { note: ctx.input.note } : {}),
        ...(ctx.input.harness ? { harness: ctx.input.harness } : {}),
      },
      toolCtx,
      {},
    );

    if (!dispatched.ok) {
      return Response.json(
        { error: dispatched.error?.code ?? 'dispatch_failed', message: dispatched.error?.message },
        { status: 400 },
      );
    }
    let parsed: unknown = {};
    try {
      parsed = JSON.parse((dispatched.result?.content[0] as { text?: string })?.text ?? '{}');
    } catch {
      /* leave as {} */
    }
    return Response.json(parsed, { status: dispatched.result?.isError ? 400 : 200 });
  },
});

export default [plansList, planGet, planItemSetStatus];
