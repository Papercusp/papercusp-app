/**
 * work_items:bulk_dedup — enqueue P-006's model-backed, ratcheted bulk pass.
 *
 * This extends the work_items family instead of adding a parallel maintenance
 * surface. Every invocation materializes a durable due-now one-shot; that
 * action writes a fresh pinned census/shard map and executes only the
 * D-002-selected scope. `confirm:true` is intentionally mandatory because
 * merge verdicts terminalize duplicate work-items.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg, upsertRoutine } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { computeNextFireAt } from '../../harness/routines/cron';
import { WORK_ITEM_ADMISSION_BULK_DEDUP } from '../../work-items-admission-bulk-dedup';
import { applyReviewedAdmissionCleanup, previewReviewedAdmissionCleanup } from '../../work-items-admission-promoter';

type RoutineSql = Parameters<typeof upsertRoutine>[0];

interface ActiveBulkDedupFire {
  routineId: string;
  workflowUuid: string;
  status: 'PENDING' | 'ENQUEUED';
}

function bulkDedupRoutineId(harness: string, routineName: string): string {
  return `rt_${harness}_${routineName}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * A routine's payload is serialized into the DBOS workflow input at enqueue
 * time. Updating the routine row while that deduplicated fire is live only
 * changes the NEXT fire; it cannot change the already-serialized workflow
 * input. Surface that state before upsertRoutine so a same-run rearm cannot
 * report success while silently retaining stale controls.
 */
async function activeBulkDedupFire(sql: RoutineSql, routineId: string): Promise<ActiveBulkDedupFire | null> {
  try {
    const rows = await sql<ActiveBulkDedupFire[]>`
      SELECT r.id AS "routineId", d.workflow_uuid AS "workflowUuid", d.status
        FROM harness_shared.routines r
        JOIN dbos.workflow_status d
          ON d.deduplication_id = ('routine:' || r.id)
         AND d.status IN ('PENDING', 'ENQUEUED')
       WHERE r.id = ${routineId}
       ORDER BY d.created_at DESC
       LIMIT 1
    `;
    return rows[0] ?? null;
  } catch (error) {
    // Some read-only/unit environments do not provision DBOS. That means
    // there cannot be a live routineFire dedup row to protect. All other
    // failures stay loud: updating a payload without the protection query
    // would recreate the very outcome-unknown hazard this guard prevents.
    const code =
      error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    if (code === '42P01') return null;
    throw error;
  }
}

export default defineTool({
  name: 'work_items:bulk_dedup',
  profile: 'engineer',
  description:
    'Preview an explicit reviewed historical-cleanup ledger without mutation/model calls, apply that exact preview under a scope-bound hash and transactional revalidation, or enqueue the durable staged work-item bulk deduplicator. Reviewed apply is reserved for the centralized reconciliation owner, merges only still-eligible entries through the shared guarded writer, and records the preview/evidence binding in reversal receipts. The model-backed run keeps its pinned census ratchet. Requires confirm:true.',
  guidance: {
    when: 'A reviewed historical cohort needs a current evidence/readiness preflight, its centralized owner is applying the exact accepted preview, or a reviewed bulk-dedup plan is ready to execute under the admission census ratchet.',
    notWhen:
      'Quick filing or ordinary pending-item admission — the durable work-item admission promoter handles those automatically.',
    chaining:
      'work_items:bulk_dedup { op:"preview-reviewed", reviewedEntries:[...], harness, confirm:true } → retain previewHash → the centralized reconciliation owner calls op:"apply-reviewed" with the unchanged entries + previewHash; ordinary work_items:bulk_dedup { harness, confirm:true } still enqueues the model-backed run.',
    seeAlso: [
      'work_items:search (inspect candidate rows before an exceptional manual intervention)',
      'work_items:get (inspect one canonical or merged row)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    op: z
      .enum(['run', 'preview-reviewed', 'apply-reviewed'])
      .optional()
      .describe('Default run; preview-reviewed is read-only; apply-reviewed mutates only an exact accepted preview.'),
    harness: z.string().min(1).max(80).describe('Harness whose active non-observation corpus is deduplicated.'),
    workspace: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Workspace override; defaults to call context/active workspace.'),
    confirm: z.literal(true).describe('Required acknowledgement that r-finding-merge verdicts terminalize duplicates.'),
    reviewedEntries: z
      .array(
        z.object({
          itemId: z.string().min(1).max(200),
          action: z.enum(['merge', 'preserve']),
          canonicalId: z.string().min(1).max(200).optional(),
          evidence: z.object({
            status: z.enum(['ready', 'unknown', 'not-ready']),
            ref: z.string().min(1).max(2_000),
            reason: z.string().min(1).max(4_000),
            sourceSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/i)
              .optional(),
          }),
        }),
      )
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Explicit reviewed ledger entries for preview-reviewed/apply-reviewed; preserves omit canonicalId, merges require it.',
      ),
    previewHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional()
      .describe('Exact scope-bound hash returned by preview-reviewed; required by apply-reviewed.'),
    runId: z.string().min(1).max(160).optional().describe('Optional stable root run id for operator correlation.'),
    maxStages: z.number().int().min(1).max(50).optional().describe('Full-corpus convergence ceiling; default 12.'),
    pairsPerCall: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Maximum pair verdicts per model call; default 150.'),
    shardConcurrency: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe('Maximum shards judged concurrently; default 4.'),
    targetTokens: z
      .number()
      .int()
      .min(1_000)
      .max(1_000_000)
      .optional()
      .describe('Shard member-token target; default 300k.'),
    ceilingTokens: z
      .number()
      .int()
      .min(1_000)
      .max(1_000_000)
      .optional()
      .describe('Per-item/shard safety ceiling; default 1M.'),
    chunkCount: z.number().int().min(1).max(256).optional().describe('Pinned edge-scan chunk count; default 16.'),
    fullCorpusPairThreshold: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe('D-002 outside-machine pair threshold; default 150.'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ??
      (ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : ctx.principal?.workspaceId) ??
      activeWorkspaceId();
    const runId = args.runId ?? `bulk-dedup-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const routineName = `${WORK_ITEM_ADMISSION_BULK_DEDUP}-${runId}`.slice(0, 180);
    const sql = getOrgPg().sql;
    const op = args.op ?? 'run';
    if (op === 'preview-reviewed') {
      if (!args.reviewedEntries?.length) {
        throw new Error('work_items:bulk_dedup preview-reviewed requires reviewedEntries');
      }
      if (args.previewHash !== undefined) {
        throw new Error('work_items:bulk_dedup previewHash is valid only with op=apply-reviewed');
      }
      const preview = await previewReviewedAdmissionCleanup(sql, {
        workspaceId,
        harnessSlug: args.harness,
        proposals: args.reviewedEntries,
      });
      return { data: { ok: true, mode: 'preview-reviewed', ...preview } };
    }
    if (op === 'apply-reviewed') {
      if (!args.reviewedEntries?.length) {
        throw new Error('work_items:bulk_dedup apply-reviewed requires reviewedEntries');
      }
      if (!args.previewHash) {
        throw new Error('work_items:bulk_dedup apply-reviewed requires previewHash');
      }
      const result = await applyReviewedAdmissionCleanup(sql, {
        workspaceId,
        harnessSlug: args.harness,
        proposals: args.reviewedEntries,
        previewHash: args.previewHash,
        runId,
        actor: ctx.principal?.slug ?? `role:${ctx.role}`,
        nowMs: Date.now(),
      });
      return { data: { ok: result.applied, mode: 'apply-reviewed', ...result } };
    }
    if (args.reviewedEntries !== undefined) {
      throw new Error('work_items:bulk_dedup reviewedEntries are valid only with a reviewed operation');
    }
    if (args.previewHash !== undefined) {
      throw new Error('work_items:bulk_dedup previewHash is valid only with op=apply-reviewed');
    }
    const activeFire = await activeBulkDedupFire(sql, bulkDedupRoutineId(args.harness, routineName));
    if (activeFire) {
      return {
        data: {
          ok: false,
          enqueued: false,
          alreadyRunning: true,
          reason: 'already_running',
          runId,
          routineId: activeFire.routineId,
          workflowUuid: activeFire.workflowUuid,
          workflowStatus: activeFire.status,
          message:
            'A routineFire for this run is still pending/enqueued. Its serialized payload is immutable until the deduplication row reaches a terminal state; retry this runId after that.',
        },
      };
    }
    const routine = await upsertRoutine(
      sql,
      {
        workspaceId,
        installSlug: args.harness,
        name: routineName,
        triggerKind: 'cron',
        triggerConfig: {},
        targetRole: `system:${WORK_ITEM_ADMISSION_BULK_DEDUP}`,
        payloadTemplate: {
          runId,
          maxStages: args.maxStages,
          pairsPerCall: args.pairsPerCall,
          shardConcurrency: args.shardConcurrency,
          targetTokens: args.targetTokens,
          ceilingTokens: args.ceilingTokens,
          chunkCount: args.chunkCount,
          fullCorpusPairThreshold: args.fullCorpusPairThreshold,
        },
        concurrency: 'skip',
        catchup: 'skip-old',
        active: true,
        nextFireAt: new Date(),
      },
      computeNextFireAt,
    );
    return {
      data: {
        ok: true,
        enqueued: true,
        runId,
        routineId: routine.id,
        nextFireAt: routine.nextFireAt?.toISOString() ?? null,
        targetRole: routine.targetRole,
        completionEvidence: {
          query: 'workItemAdmission.runs',
          expectedRunPrefix: runId,
          terminalStates: ['complete', 'failed'],
        },
      },
    };
  },
});
