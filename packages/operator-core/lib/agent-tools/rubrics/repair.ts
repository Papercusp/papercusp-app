/**
 * rubrics:repair — conservative repair for pre-enriched rubric revision rows.
 *
 * This is intentionally a targeted maintenance door, not a general historical
 * reconstruction tool. The core only admits a first-party standard rubric whose
 * live body/data still match the bundled source and whose complete revision chain
 * is byte-identical to that current body. Run the default dry-run first; pass
 * `dryRun:false` only after the candidate is visible.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolvePlanWriteScope } from '../plans/_write-scope';
import { repairLegacyRubricRevisionSnapshots } from '../../rubrics';

const argsSchema = z.object({
  harness: harnessArg,
  rubricRef: z.string().trim().min(1).max(200).describe('Exact first-party rubric slug whose legacy revision chain is being repaired.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('Preview the exact eligible rows without changing snapshots. Defaults to true; pass false to apply the repair.'),
});

export default defineTool({
  name: 'rubrics:repair',
  description:
    'Repair a first-party rubric revision chain whose legacy markdown-only snapshots are provably the exact current body. Requires the live rubric data to match the bundled first-party source and every revision to have the current body hash; rewrites only content_snapshot, preserving ids, seq, hashes, authorship, sessions, and timestamps. Dry-run by default; pass dryRun:false to apply an atomic CAS-guarded repair.',
  guidance: {
    when: 'rubrics:get reports an existing immutable first-party revision cannot be projected and the complete chain is known to be unchanged since the current body was written.',
    notWhen: 'A revision differs from the current body, the rubric is locally edited, the source is unavailable, or the rubric is acceptance/delegated-class history. Those cases must remain fail-closed.',
    chaining: 'rubrics:repair { rubricRef, dryRun:true } → inspect the candidate counts → rubrics:repair { rubricRef, dryRun:false } → rubrics:get { rubricRef, revision }.',
    seeAlso: ['rubrics:get (verify an exact immutable revision after repair)', 'plans:revisions (inspect the revision chain)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const { workspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const result = await repairLegacyRubricRevisionSnapshots(
      args.rubricRef,
      { workspaceId, harnessSlug },
      { dryRun: args.dryRun },
    );
    const ctxAny = ctx as { metadata?: (data: Record<string, unknown>) => void };
    ctxAny.metadata?.({
      rubricId: result.rubricId,
      status: result.status,
      revisionsInspected: result.revisionsInspected,
      revisionsToRepair: result.revisionsToRepair,
      revisionsRepaired: result.revisionsRepaired,
    });
    return { data: { ok: true, workspaceId, harnessSlug, ...result } };
  },
});
