/**
 * work_items:bulk_dedup — enqueue P-006's model-backed, ratcheted bulk pass.
 *
 * This extends the work_items family instead of adding a parallel maintenance
 * surface. Every invocation materializes a durable due-now one-shot; that
 * action writes a fresh pinned census/shard map and executes only the
 * D-002-selected scope. `confirm:true` is intentionally mandatory because
 * merge verdicts terminalize duplicate work-items.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { enqueueBulkDedupRun, newBulkDedupRunId } from '../../work-items-admission-bulk-dedup-enqueue';
import { applyReviewedAdmissionCleanup, previewReviewedAdmissionCleanup } from '../../work-items-admission-promoter';

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
    maxPairsPerStage: z.number().int().min(1).max(10_000).optional()
      .describe('Maximum pairs judged before each atomic stage commit; default 512. Residuals stay in the census.'),
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
    const runId = args.runId ?? newBulkDedupRunId();
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
    // One shared enqueue path with the daily system:work-item-admission-bulk-dedup-driver
    // routine (WI-10004722), so a scheduled run and a manual run are the same routine row.
    const result = await enqueueBulkDedupRun(sql, {
      workspaceId,
      harnessSlug: args.harness,
      runId,
      controls: {
        maxStages: args.maxStages,
        maxPairsPerStage: args.maxPairsPerStage,
        pairsPerCall: args.pairsPerCall,
        shardConcurrency: args.shardConcurrency,
        targetTokens: args.targetTokens,
        ceilingTokens: args.ceilingTokens,
        chunkCount: args.chunkCount,
        fullCorpusPairThreshold: args.fullCorpusPairThreshold,
      },
    });
    return { data: result };
  },
});
