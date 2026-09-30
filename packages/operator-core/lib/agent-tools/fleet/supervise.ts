/**
 * fleet:supervise — report one OR many crashed spawns to the supervisor (P1, D-002).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The control supervisor (the
 * curator-operator) calls this when a supervised child crashes. The engine decides:
 * restart per the spawn's strategy (one_for_one | one_for_all | rest_for_one) if within
 * the restart-intensity budget, or — if crash-looping — tear the subtree down (freeing
 * its locks/claims) and escalate to a human.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `spawn_id` for one or
 * `spawn_ids` for several → { ok, results:[{ ok, spawn_id, action, … | error }],
 * counts }. Each result self-describes its spawn_id; one bad report never poisons
 * the rest. `reason` / `max_restarts` / `window_sec` / `workspace` are batch-level.
 *
 * WI-5541: a 'restart' action REALLY relaunches now (superviseCrash re-invokes the
 * one spawn chokepoint for every id it marks 'restarting', then retires the
 * superseded row) — it used to only flip status='restarting' and stop there, a
 * phantom the caller had to notice and manually re-run. `relaunches[]` on each
 * result reports the real outcome per id.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { superviseCrash } from '../../fleet/supervision';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText, LIMITS } from '../limits';

export default defineTool({
  name: 'fleet:supervise',
  profile: 'engineer',
  description:
    'Report one OR many crashed spawns. The supervisor ACTUALLY RESTARTS the strategy\'s set (one_for_one/one_for_all/rest_for_one) within the restart-intensity budget — re-launching each as a fresh spawn, no caller action needed — or tears the subtree down + escalates to a human when it is crash-looping. Pass `spawn_id` for one or `spawn_ids` for several. Returns { ok, results:[{ ok, spawn_id, action, relaunches, … | error }], counts } — correlate by spawn_id, not position; one failure never fails the rest.',
  guidance: {
    when: 'A supervised child exited abnormally and you (the control supervisor / curator) must decide restart-vs-escalate. On a restart it is ALREADY DONE by the time this returns — check each `relaunches[]` entry (ok/new_spawn_id/error) rather than re-launching yourself. Several crashed at once? Pass them all via `spawn_ids`.',
    notWhen: 'For a clean human abort — that is fleet:cancel, not a crash.',
    chaining: 'detect crash → fleet:supervise { spawn_id } | { spawn_ids:[…] } → inspect `relaunches[]` (a false `ok` means the row is still \'restarting\' and needs a manual look) | handle the escalation. Bulk: correlate by spawn_id, not position; one failure never fails the rest.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      spawn_id: z.string().min(1).optional().describe('a single crashed spawn id (n=1 shorthand for spawn_ids:[id])'),
      spawn_ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('crashed spawn ids to report (1–100)'),
      reason: softText(LIMITS.ANNOTATION).optional().describe('What the crash was (exit code, error) — batch-level. Auto-truncated to 2000 chars if longer.'),
      max_restarts: z.number().int().min(1).max(50).optional(),
      window_sec: z.number().int().min(1).max(86_400).optional(),
      workspace: z.string().max(120).optional(),
    })
    .refine((a) => Boolean(a.spawn_id) || (a.spawn_ids?.length ?? 0) > 0, {
      message: 'pass `spawn_id` (one) or `spawn_ids` (many)',
    }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const ids = mergeIds(args.spawn_id, args.spawn_ids);
    const env = await runBulk(
      ids,
      async (spawn_id) => {
        const res = await superviseCrash(sql, {
          workspaceId,
          spawnId: spawn_id,
          actor,
          reason: clampText(args.reason, LIMITS.ANNOTATION),
          maxRestarts: args.max_restarts,
          windowSec: args.window_sec,
        });
        return {
          ok: true as const,
          spawn_id: res.spawnId,
          action: res.action,
          strategy: res.strategy,
          restart_count: res.intensity?.count ?? null,
          to_restart: res.toRestart,
          // WI-5541: `to_restart` is no longer just an intent — these are the REAL
          // relaunch outcomes (one per to_restart id), so the caller can tell an
          // actual replacement agent from a relaunch that was rejected (over ceiling,
          // unknown role, missing project dir, …) and the old row was left 'restarting'.
          relaunches: (res.relaunches ?? []).map((r) => ({
            spawn_id: r.spawnId,
            ok: r.ok,
            new_spawn_id: r.newSpawnId,
            error: r.error ?? null,
          })),
          escalation_id: res.escalationId ?? null,
          reason: res.reason,
        };
      },
      { keyOf: (spawn_id) => ({ spawn_id }) },
    );
    return bulkContent(env);
  },
});
