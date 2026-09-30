/**
 * plans:pause — suspend orchestrator feature-picking for a plan without losing started state.
 *
 * Per plans-central-harness-ux-2026-05-26 Phase 1 P-002.
 *
 * Sets op_status='paused' on the plan's harness_shared.harness_plans row
 * (the operational columns folded in from the retired harness_plan_status
 * table — plans-pg-canonical-migration-2026-06-03).
 * The plan's in-flight features are NOT cancelled — any running worker
 * turn finishes, but no new features are picked until the plan is
 * re-started via plans:start.
 *
 * Pausing a plan that was never started returns { notStarted: true }.
 *
 * ⚠ DELIBERATELY **NOT** GATED by the Mug/Kettle retirement, unlike its sibling
 * `plans:start` (retire-mug-kettle-su-only-2026-08-09 P-047 / D-061). Do not
 * "finish the job" by adding `refuseIfMugKettleRetired` here — that would be the
 * backwards cut, twice over:
 *
 *  1. THIS VERB CANNOT ENTER THE RETIRED AXIS. The
 *     `AND op_status IN ('started','paused')` guard below means it only ever
 *     rewrites a row ALREADY on the axis; it can move a plan from 'started' to
 *     'paused', never from null — or from the 'done' EXIT — to anything. P-047
 *     retires the axis by stopping new ENTRIES (plans:start), and this is an EXIT.
 *
 *     ⚠ That guard used to read `op_status IS NOT NULL`, which was WIDER than the
 *     claim above and made it false: 'done' is the value `clearStartedForTerminalPlan`
 *     writes to take a plan OFF the axis, and it is not null — so pause could move a
 *     retired plan 'done' → 'paused', putting it back on a RESERVING value
 *     (`reservedPlanLaneExclusionSql` reserves 'started' AND 'paused') with no way
 *     back off, because the only re-entry verb, plans:start, is gated by P-047.
 *     Re-entry-by-stopper is not a stopper. WI-38301 / D-055.
 *  2. IT IS A STOPPER, and _mug-kettle-gate.ts's own scope note excludes stoppers
 *     for exactly this reason: "refusing a stop is never the safe direction". The
 *     DBOS orchestrator frontier (dbos/orchestrator-loop.ts) still reads
 *     op_status='started' and is NOT gated by the retirement, so pause remains the
 *     only lever that removes an already-started plan from its dispatch. Gate this
 *     and the plans started before P-047 landed are frozen dispatchable with no
 *     off switch.
 *
 * What pause does NOT do is UN-reserve: 'paused' is still a reserving value in
 * `reservedPlanLaneExclusionSql`. Lifting the reservation on already-started
 * plans is P-048's reader-side change, gated on D-055.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { resolvePlanWriteScope } from './_write-scope';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const argsSchema = z.object({
  slug: z.string().min(1).optional().describe('Plan slug to pause.'),
  slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to pause in one call.'),
  harness: harnessArg,
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
});

export default defineTool({
  name: 'plans:pause',
  description:
    "Suspend orchestrator feature-picking for a plan. In-flight worker turns finish; no new features are picked until plans:start is called again. Returns { notStarted: true } when the plan is not operationally started — either never started (op_status null) or already finished on that axis (op_status 'done'); neither is re-entered.",
  guidance: {
    when: "User pauses work on a plan from the UI, or an agent needs to suspend a plan without marking it done.",
    notWhen:
      'The plan is done — use plans:set-run-status for run lifecycle. To mark the whole plan complete, update the frontmatter status to shipped.',
    chaining: 'plans:list to find the slug, then plans:pause { slug }. Resume with plans:start.',
    seeAlso: [
      'plans:start (resume / start a paused plan)',
      'plans:set-priority (reorder instead of pausing)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    // ⚠ WI-5125 / EI-16183 / WI-5825 class: harness_plans is keyed on
    // (workspace_id, harness_slug, plan_slug), and that key MUST come from the
    // same authority the readers use — see resolvePlanWriteScope's doc comment
    // for the three generations of this bug. Never activeWorkspaceId(), never a
    // DEFAULT_WORKSPACE_ID literal, never the un-collapsed ctx slug.
    //
    // This tool is the one that HID the bug worst: a mis-scoped UPDATE matches
    // 0 rows and falls into the notStarted:true branch below, which reads as
    // ordinary "you never started this plan" rather than a failure. That branch
    // now distinguishes the two cases explicitly (plan_not_found vs notStarted).
    const { workspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const now = new Date().toISOString();
        // op_status is null until a plan has been started, and 'done' once it has
        // LEFT the axis (clearStartedForTerminalPlan) — so a pause that matches
        // neither 'started' nor 'paused' means "not operationally started right
        // now" (the row exists as the plan itself). Matching 'done' here would
        // RE-ENTER the retired axis on a reserving value with no exit; see the
        // header. The set is spelled out rather than written `IS NOT NULL`
        // precisely so 'done' cannot drift back in.
        const rows = await withWorkspace(workspaceId, async (tx) => {
          return tx<{ op_status: string; op_updated_at: string }[]>`
            UPDATE harness_shared.harness_plans
               SET op_status = 'paused', op_updated_at = ${now}
             WHERE workspace_id = ${workspaceId}
               AND harness_slug  = ${harnessSlug}
               AND plan_slug     = ${slug}
               AND op_status IN ('started', 'paused')
            RETURNING op_status, op_updated_at
          `;
        });
        ctxAny.metadata?.({ slug, harnessSlug });
        if (rows.length === 0) {
          // WI-5825: 0 rows has TWO causes and they are not the same news —
          // (a) the plan row exists but was never operationally started (a
          // benign notStarted), or (b) no such plan in this scope at all (a
          // caller/scope error). Reporting (b) as (a) is exactly how a
          // mis-scoped write used to masquerade as normal behavior. Probe the
          // row's existence so the caller is told which one happened.
          const exists = await withWorkspace(workspaceId, async (tx) => {
            const found = await tx<{ plan_slug: string }[]>`
              SELECT plan_slug
                FROM harness_shared.harness_plans
               WHERE workspace_id = ${workspaceId}
                 AND harness_slug  = ${harnessSlug}
                 AND plan_slug     = ${slug}
               LIMIT 1
            `;
            return found.length > 0;
          });
          if (!exists) {
            return {
              ok: false as const,
              slug,
              harnessSlug,
              error: 'plan_not_found',
              message: `no plan '${slug}' in ${workspaceId}/${harnessSlug}`,
            };
          }
          return {
            ok: true as const,
            slug,
            harnessSlug,
            notStarted: true,
            message: 'plan has no started/paused row — call plans:start first',
          };
        }
        return { ok: true as const, slug, harnessSlug, status: 'paused', updatedAt: rows[0].op_updated_at };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
