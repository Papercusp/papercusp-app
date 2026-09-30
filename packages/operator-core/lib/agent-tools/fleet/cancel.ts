/**
 * fleet:cancel — transitive cancellation of one OR many spawn subtrees (P0, D-003).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The human/operator-cancel entry
 * point for the structured-concurrency nursery: cancelling a node fans cancellation
 * DOWN the entire spawn subtree and releases each descendant's work-item/plan-item
 * claims + file/resource locks immediately — instead of burning tokens for minutes
 * while N leases independently expire.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `spawn_id` for one or
 * `spawn_ids` for several → { ok, results:[{ ok, spawn_id, cancelled, … | error }],
 * counts }. Each result self-describes its spawn_id, so one bad root never poisons
 * the rest and the caller correlates by spawn_id (not array position). `reason` /
 * `workspace` are batch-level.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { cancelSubtree } from '../../fleet/nursery';
import { killTask } from '../../task-manager/control';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText } from '../limits';

export default defineTool({
  name: 'fleet:cancel',
  profile: 'engineer',
  description:
    'Cancel one OR many spawn subtrees: mark every active descendant cancelled and release its claims + locks NOW. Pass `spawn_id` for one or `spawn_ids` for several. The structured-concurrency abort — use it instead of waiting for leases to expire. Returns { ok, results:[{ ok, spawn_id, cancelled, … | error }], counts } — correlate by spawn_id, not position; one failure never fails the rest.',
  guidance: {
    when: 'A human/operator aborts a unit of work, or a supervisor tears down a doomed subtree. Cancels the named spawn(s) AND all descendants transitively, freeing their locks + work-item/plan-item claims immediately. Tearing down several at once? Pass them all via `spawn_ids`.',
    notWhen: 'To cancel a single leaf with no children — that is the same call with a leaf spawn_id, but prefer it when you specifically mean the whole subtree.',
    chaining: 'fleet:tree (inspect the subtree) → fleet:cancel { spawn_id } | { spawn_ids:[…] }. Bulk: correlate each result by spawn_id, not position; one failure never fails the rest.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      spawn_id: z.string().min(1).optional().describe('Root of one subtree to cancel (this node + all descendants; n=1 shorthand for spawn_ids:[id]).'),
      spawn_ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('Roots of the subtrees to cancel (1–100).'),
      reason: softText(4000).optional().describe('Why — surfaced in the coord cancellation notice + audit (batch-level). Auto-truncated to 4000 chars if longer.'),
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

    // Local-process abort is best-effort and shared across the batch; resolve the
    // abort fn ONCE (the dynamic import statically pulls DBOS featurePipeline, which
    // must not load at tool-mount — mirrors fleet/spawn + operator/converse).
    let abortLocalSpawn: ((id: string) => boolean) | null = null;
    try {
      ({ abortLocalSpawn } = await import('../../fleet/operator-spawn'));
    } catch (err) {
      console.warn('[fleet:cancel] local process abort failed', err);
    }

    const env = await runBulk(
      ids,
      async (spawn_id) => {
        const rows = await sql<{ spawn_id: string }[]>`
          SELECT spawn_id
            FROM harness_shared.spawned_agents
           WHERE workspace_id = ${workspaceId}
             AND spawn_id = ${spawn_id}
           LIMIT 1
        `;
        if (!rows[0]) {
          return {
            ok: false as const,
            spawn_id,
            refused: true as const,
            error:
              `refused: ${spawn_id} is not a nursery spawn in workspace ${workspaceId}; ` +
              `fleet:cancel only cancels rows in harness_shared.spawned_agents. ` +
              `If this is an owner-directed OMP/static session, do not treat it as a cancellable fleet cup.`,
          };
        }
        const res = await cancelSubtree(sql, {
          workspaceId,
          rootSpawnId: spawn_id,
          reason: clampText(args.reason, 4000) ?? 'fleet:cancel',
          actor,
        });

        // EI-21662411450018664: `abortLocalSpawn` covers only children launched by
        // THIS operator process. Release-fixers and other task-manager-confined
        // agents survive an operator handoff in a durable `pc-*.scope`, so their
        // spawn row could be marked cancelled while the real cgroup kept running.
        // Address those jobs by their exact task-ledger handle and reuse the same
        // whole-subtree kill primitive exposed by processes:kill. Include already-
        // terminal spawn rows so a retry can reap a process left behind by an older
        // fleet:cancel call; reapTerminalResidue remains fail-closed unless the
        // task-manager positively re-verifies a live confined scope.
        const affectedSpawnIds = [
          ...new Set([
            ...res.cancelled.map((c) => c.spawnId),
            ...res.alreadyTerminal,
          ]),
        ];
        const taskRows = affectedSpawnIds.length
          ? await sql<{ task_id: string; spawn_id: string }[]>`
              SELECT task_id, detail->>'spawnRecordId' AS spawn_id
                FROM harness_shared.task_ledger
               WHERE workspace_id = ${workspaceId}
                 AND class = 'agent-session'
                 AND detail->>'spawnRecordId' = ANY(${affectedSpawnIds}::text[])
            `
          : [];
        const processAbortFailures: Array<{
          taskId: string;
          spawnId: string;
          error: string;
          detail?: string;
        }> = [];
        const abortedSpawnIds = new Set<string>();
        let taskScopesAborted = 0;
        for (const row of taskRows) {
          const outcome = await killTask(row.task_id, {
            signal: 'SIGTERM',
            includeSubtree: true,
            escalateAfterMs: 5_000,
            reapTerminalResidue: true,
          });
          if (outcome.ok) {
            taskScopesAborted++;
            abortedSpawnIds.add(row.spawn_id);
            continue;
          }
          // A raced task reconciliation or an already-empty terminal scope means
          // there is no process left to cancel. Every other refusal is actionable:
          // returning ok:true would recreate the registry/process divergence this
          // path exists to prevent.
          if (outcome.error === 'not_live') continue;
          processAbortFailures.push({
            taskId: row.task_id,
            spawnId: row.spawn_id,
            error: outcome.error,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          });
        }

        if (abortLocalSpawn) {
          for (const id of affectedSpawnIds) {
            if (abortLocalSpawn(id)) abortedSpawnIds.add(id);
          }
        }
        const processAbortOk = processAbortFailures.length === 0;
        return {
          ok: processAbortOk,
          spawn_id: res.rootSpawnId,
          cancelled: res.cancelled.map((c) => c.spawnId),
          processes_aborted: abortedSpawnIds.size,
          task_scopes_aborted: taskScopesAborted,
          ...(processAbortOk
            ? {}
            : {
                error: `cancelled the durable subtree, but ${processAbortFailures.length} task scope(s) could not be terminated`,
                process_abort_failures: processAbortFailures,
              }),
          already_terminal: res.alreadyTerminal,
          claims_released: res.claimsReleased,
          plan_claims_released: res.planClaimsReleased,
          file_locks_released: res.locks.filePathsReleased,
          resource_locks_released: res.locks.resourcesReleased,
          notified: res.notified,
        };
      },
      { keyOf: (spawn_id) => ({ spawn_id }) },
    );
    return bulkContent(env);
  },
});
