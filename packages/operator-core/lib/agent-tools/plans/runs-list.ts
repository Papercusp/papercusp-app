/**
 * plans:runs — the launch history for a plan.
 *
 * plan-agent-launch-2026-05-21, Phase 3 (P-015).
 *
 * One row per agent launched from the plan (the `plan_runs` store),
 * newest-first: run id, title, status, who launched it and when, the
 * launch note, the seeded `plan_content_hash` (P-023's stale-version
 * badge compares it to the plan's current hash), the run's session
 * id, and a transcript turn count. The data behind the Agents tab's
 * past-runs list (P-021).
 *
 * A plan with no runs returns an empty list, not an error (matches
 * `plans:revisions`). A genuine DB failure is reported as
 * `runs_unavailable` rather than a misleading empty list.
 *
 * Each read first runs the poll-based run-status sweep (P-016) —
 * orphaned `running` → `failed`, stale `idle` → `archived` — so this
 * read *is* the v1 lifecycle poll. The sweep is best-effort.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { listPlanRuns, sweepPlanRuns } from './runs';

/** P-006/D-004: what the lifecycle sweep actually did on THIS read. `ran:false`
 *  means orphan reclamation did not happen — never that there was nothing to do. */
type SweepReport =
  | { ran: true; failed: number; archived: number; note?: string }
  | { ran: false; error: string; note: string };

const argsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename stem) whose run history to read.'),
  harness: harnessArg,
});

export default defineTool({
  name: 'plans:runs',
  description:
    'The launch history for a plan, newest-first — one row per agent launched from it: run id, title, status, who launched it and when, the launch note, the seeded content hash, the session id, and a transcript turn count. Empty list when the plan has never been launched. Also returns `sweep { ran, failed, archived }` — this read runs the run-status lifecycle sweep; on `ran:false` orphan reclamation did NOT happen, so a `running` row is not evidence of a live run.',
  guidance: {
    when: 'You want to see the agents launched from a plan — the past-runs list, or to find a runId to resume.',
    notWhen:
      'You want to launch a fresh agent — plans:launch. You want to read the plan body — plans:get. The plan’s edit history — plans:revisions.',
    chaining:
      'plans:runs → plans:resume { runId, message } to continue a run.',
    seeAlso: [
      'plans:run-transcript (read one run\'s transcript)',
      'plans:resume (continue a run)',
      'plans:set-run-status (change a run\'s status)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    try {
      // Poll-based run-status lifecycle (P-016): each runs read first
      // sweeps orphaned `running` → `failed` and stale `idle` →
      // `archived`. Best-effort — a sweep failure must not break the
      // list read.
      //
      // P-006/D-004: the sweep's outcome is REPORTED, not discarded. It used
      // to be `.catch(console.warn)` with the result thrown away, so this read
      // returned an identical-looking ok whether the sweep reclaimed orphans,
      // did nothing, or failed outright — and a console.warn reaches no agent.
      // That mattered because the sweep is self-concealing: reading this list
      // is both the only way to observe an orphan and the thing that repairs
      // it, so a caller who cannot see the sweep's result cannot tell a healthy
      // list from one that is stale because the sweep never ran.
      let sweep: SweepReport;
      try {
        const r = await sweepPlanRuns();
        // A result that is not the declared shape is reported as ran:false, NOT
        // coerced to zeros. `failed:0, archived:0` is a real and common reading
        // ("nothing needed reclaiming"), so defaulting a malformed result into it
        // would forge the one answer a caller is entitled to trust.
        if (!r || typeof r.failed !== 'number' || typeof r.archived !== 'number') {
          throw new Error(`sweep returned an unexpected shape: ${JSON.stringify(r) ?? String(r)}`);
        }
        sweep = {
          ran: true,
          failed: r.failed,
          archived: r.archived,
          ...(r.failed || r.archived
            ? {
                note:
                  `The lifecycle sweep reclaimed ${r.failed} orphaned running run(s) ` +
                  `and archived ${r.archived} stale idle run(s) as part of THIS read — ` +
                  `the list below reflects the post-sweep state.`,
              }
            : {}),
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[plans:runs] run-status sweep failed: ${message}`);
        sweep = {
          ran: false,
          error: message.slice(0, 300),
          note:
            'The run-status lifecycle sweep FAILED, so orphaned `running` runs were NOT ' +
            'reclaimed on this read. The list below is still accurate as stored, but a run ' +
            'showing `running` may be an orphan whose owning process is gone — and while one ' +
            "is unreclaimed, a schedule with concurrency='skip' mints nothing while its " +
            '`last_fired_at` keeps advancing. Do not read `running` here as evidence of a live run.',
        };
      }
      const sctx = harnessScopedCtx(args.harness, ctx);
      const harnessSlug = resolveCtxHarnessSlug(sctx);
      const runs = await listPlanRuns(args.slug, harnessSlug ? { harnessSlug } : {});
      ctxAny.metadata?.({ slug: args.slug, runCount: runs.length, sweepRan: sweep.ran });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ runs, sweep }) }],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'runs_unavailable',
              message: message.slice(0, 400),
              slug: args.slug,
            }),
          },
        ],
        isError: true,
      };
    }
  },
});
