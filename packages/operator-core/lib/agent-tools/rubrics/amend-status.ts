/**
 * rubrics:amend-status — poll the receipt a slow rubrics:amend returned
 * (review-system-rework-reduction-2026-09-23 P-008, clause RSR-P-008-C).
 *
 * Answers in the order of certainty:
 *  1. the shared receipt (amend-receipts.ts): running / committed / failed,
 *     with the exact payload the synchronous call would have returned;
 *  2. the durable Decision a BAR-changing acceptance amendment commits
 *     atomically (`Amendment-Id: <key>`): committed, even if a worker died
 *     before it could finish its running receipt;
 *  3. neither: not_found. A same-key retry is safe after checking durable
 *     state because receipt registration precedes amendment execution.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { findAmendmentDecisionByKey } from '../../rubrics';
import { getAmendReceipt } from './amend-receipts';

export const rubricsAmendStatusArgs = z
  .object({
    rubricRef: z.string().min(1).describe('The rubric the amend targeted (receipt.rubricRef).'),
    idempotencyKey: z.string().min(1).describe('The receipt key rubrics:amend returned (receipt.idempotencyKey).'),
  })
  .strict();

export default defineTool({
  name: 'rubrics:amend-status',
  // @not-a-cell This keyed receipt and Decision lookup has one read door; no other resolver derives its per-key status.
  profile: 'engineer',
  description:
    'Poll a rubrics:amend receipt: running, committed (apply result), previewed (dry-run result), failed, or not_found. A missing dry-run receipt is safe to regenerate because dryRun does not write.',
  guidance: {
    when: 'A rubrics:amend returned { pending:true, receipt } and you need its outcome.',
    notWhen: 'You have no receipt — read the rubric with rubrics:get instead.',
    returns:
      "{ ok, state: 'running'|'committed'|'previewed'|'failed'|'not_found', source: 'receipt'|'decision'|'none', result?, error?, decisionId?, ageSec? }.",
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: rubricsAmendStatusArgs,
  // Structural shape behind `guidance.returns` (guidance-output-schema-live-guard).
  result: z
    .object({
      ok: z.boolean(),
      state: z.enum(['running', 'committed', 'previewed', 'failed', 'not_found']),
      source: z.enum(['receipt', 'decision', 'none']),
      result: z.record(z.string(), z.unknown()).optional(),
      error: z.string().optional(),
      decisionId: z.string().optional(),
      ageSec: z.number().optional(),
    })
    .passthrough(),
  async handler(args) {
    const reply = (payload: Record<string, unknown>) => ({ data: { ok: true, ...payload } });
    const receipt = await getAmendReceipt(args.rubricRef, args.idempotencyKey);
    // A worker can die after the amendment commits but before it updates the
    // receipt. In that case the atomic Decision outranks a stranded "running".
    if (receipt?.state === 'running' && !args.idempotencyKey.startsWith('preview-')) {
      const decision = await findAmendmentDecisionByKey(args.rubricRef, args.idempotencyKey);
      if (decision) {
        return reply({
          state: 'committed', source: 'decision', decisionId: decision.decisionId,
          subjectPlan: decision.subjectPlan,
          note: 'Committed; read the new revision with rubrics:get.',
        });
      }
    }
    if (receipt) {
      return reply({
        state: receipt.state,
        source: 'receipt',
        ageSec: Math.round(((receipt.finishedAt ?? Date.now()) - receipt.startedAt) / 1000),
        ...(receipt.result ? { result: receipt.result } : {}),
        ...(receipt.error ? { error: receipt.error } : {}),
      });
    }
    const decision = await findAmendmentDecisionByKey(args.rubricRef, args.idempotencyKey);
    if (decision) {
      return reply({
        state: 'committed',
        source: 'decision',
        decisionId: decision.decisionId,
        subjectPlan: decision.subjectPlan,
        note: 'Committed; read the new revision with rubrics:get.',
      });
    }
    return reply({
      state: 'not_found',
      source: 'none',
      note:
        args.idempotencyKey.startsWith('preview-')
          ? 'No dry-run preview with this receipt is running or retained in the shared store. dryRun is read-only; issue rubrics:amend with dryRun:true again for a fresh preview.'
          : 'No amendment with this key is retained in the shared store and no committed Decision carries it. ' +
            'The amendment is atomic and keyed, so re-issuing the same rubrics:amend with this idempotencyKey is safe.',
    });
  },
});
