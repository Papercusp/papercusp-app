/** scorecards:get — evidence-first read of one scorecard for grading-integrity audits. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS } from '@papercusp/tooldef';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { getDoorConstantsSync } from '../../context-doors-config';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readScorecardEvidence, type ScorecardEvidenceRow } from '../../scorecards';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

export const scorecardGetArgs = z.object({
  issueId: z
    .string()
    .min(1)
    .max(120)
    .describe('the scorecard issue id (EI-/WI-) whose criterion evidence must be re-run'),
  criterionKey: z.string().min(1).max(200).optional()
    .describe('Read one criterion from an oversized card index. Evidence remains exact; follow evidenceRead.next until complete.'),
  evidenceOffset: z.number().int().min(0).optional()
    .describe('UTF-16 offset from evidenceRead.next for one criterion. Concatenate pages in order; never grade from an incomplete page.'),
});

// Bound the JSON-encoded result before both payload shaping and the later MCP
// result door. The latter is much smaller than the shared 30k payload ceiling;
// if it clips a complete criterion page, evidenceRead.complete lies about what
// reached the model. Keep the exact same effective door settings as the host.
function inlineResultBudgetChars(ownerId?: string | null): number {
  const resultDoorChars =
    computeTurnDoors(0, getDoorConstantsSync(ownerId)).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  return Math.max(1, Math.min(Math.floor(PAYLOAD_TIER_HARD_CEILING_CHARS / 2), resultDoorChars));
}

const evidenceReadCall = (issueId: string, criterionKey: string, evidenceOffset = 0) => ({
  tool: 'scorecards:get',
  args: { issueId, criterionKey, evidenceOffset },
});

function boundedEvidenceRead(
  scorecard: ScorecardEvidenceRow,
  args: z.infer<typeof scorecardGetArgs>,
  inlineBudgetChars: number,
) {
  if (args.criterionKey === undefined) {
    if (args.evidenceOffset !== undefined) {
      return { ok: false as const, error: 'criterion_required_for_offset' };
    }
    const full = { ok: true as const, scorecard, evidenceRead: { complete: true } };
    if (JSON.stringify(full).length <= inlineBudgetChars) return full;
    const index = {
      ok: true as const,
      scorecard: { ...scorecard, criteria: [] },
      evidenceRead: {
        complete: false,
        reason: 'card-exceeds-inline-budget',
        instruction: 'Evidence has NOT been read. Read every indexed criterion and concatenate its pages before grading; this index is not evidence of a missing probe.',
        criteria: scorecard.criteria.map(({ key, rating, evidence }) => ({
          key, rating, evidenceChars: evidence.length,
          read: evidenceReadCall(args.issueId, key),
        })),
      },
    };
    if (JSON.stringify(index).length > inlineBudgetChars) {
      return {
        ok: false as const,
        error: 'scorecard_index_exceeds_inline_budget',
        message: 'No evidence was read. Select a criterionKey from the source rubric and read its pages.',
      };
    }
    return index;
  }
  const criterion = scorecard.criteria.find(({ key }) => key === args.criterionKey);
  if (!criterion) return { ok: false as const, error: 'unknown_criterion' };
  const offset = args.evidenceOffset ?? 0;
  if (offset > criterion.evidence.length || (offset === criterion.evidence.length && offset !== 0)) {
    return { ok: false as const, error: 'invalid_evidence_offset' };
  }
  let count = Math.min(inlineBudgetChars, criterion.evidence.length - offset);
  const page = () => {
    const nextOffset = offset + count;
    const complete = nextOffset === criterion.evidence.length;
    return {
      ok: true as const,
      scorecard: { ...scorecard, criteria: [{ ...criterion, evidence: criterion.evidence.slice(offset, nextOffset) }] },
      evidenceRead: {
        complete,
        scope: 'selected-criterion',
        offset,
        totalChars: criterion.evidence.length,
        instruction: 'Concatenate this criterion’s pages in offset order. Complete applies only to this criterion; audit every key from the card index.',
        ...(!complete ? { next: evidenceReadCall(args.issueId, criterion.key, nextOffset) } : {}),
      },
    };
  };
  let result = page();
  while (JSON.stringify(result).length > inlineBudgetChars && count > 1) {
    count = Math.max(1, Math.floor(count / 2));
    result = page();
  }
  if (JSON.stringify(result).length > inlineBudgetChars) {
    return { ok: false as const, error: 'scorecard_metadata_exceeds_inline_budget' };
  }
  return result;
}

export default defineTool({
  name: 'scorecards:get',
  profile: 'engineer',
  description:
    'Read ONE rubric scorecard by issue id using an evidence-first projection. The scorecard includes its stored evidenceFingerprint when present, so auditors can verify the exact evidence scope. Small cards return exact criterion evidence. Oversized cards return evidenceRead.complete:false and a criterion index: follow each read, then evidenceRead.next, concatenating pages before grading. Never interpret an index or incomplete page as missing evidence. criterionKey narrows the existing read; evidenceOffset resumes it. History-only payload is omitted.',
  guidance: {
    when: 'You are auditing one existing scorecard and must re-run the probe stated in every criterion evidence string. Pass the scorecard issueId returned by scorecards:list or a grading-audit dispatch reservation.',
    notWhen:
      'You want scorecard history, trend inputs, or multiple rows — scorecards:list. You want a rubric definition — rubrics:get. You are filing a scorecard — scorecards:emit.',
    chaining:
      'scorecards:get { issueId } → if evidenceRead.complete:false, follow the criterion index, then fetch independent criterion roots with Promise.all (keep each criterion’s evidenceRead.next page loop sequential) → concatenate every complete page → re-run every evidence probe → scorecards:emit the grading-integrity audit. A partial read cannot establish probe absence.',
    returns:
      'Returns `{ ok, scorecard, evidenceRead }`. The scorecard includes `evidenceFingerprint` when recorded. Full reads contain every exact criterion; an oversized read contains criteria:[] plus an explicit index, not absent evidence. Criterion pages retain full-card identity and nKeys/missingKeys and report offset/totalChars/next; concatenate before grading.',
    seeAlso: ['scorecards:list', 'scorecards:emit', 'rubrics:get'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  // This tool's projection is intentionally bounded at the source. It still
  // opts out of ambient tier shaping so a trimmed audit session cannot replace
  // evidence strings with depth-limit placeholders. The shared 30k ceiling
  // remains active as a final safety rail.
  ignoreSessionPayloadTier: true,
  args: scorecardGetArgs,
  result: z
    .object({
      ok: z.boolean(),
      scorecard: z.unknown().optional(),
      evidenceRead: z.unknown().optional(),
      error: z.string().optional(),
      retryable: z.boolean().optional(),
      pgCode: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      try {
        const result = await readScorecardEvidence(args.issueId);
        if (result.kind === 'not_found') {
          return { data: { ok: false as const, error: `scorecard '${args.issueId}' not found` } };
        }
        if (result.kind === 'not_scorecard') {
          return { data: { ok: false as const, error: `'${args.issueId}' is not a scorecard` } };
        }
        return { data: boundedEvidenceRead(result.scorecard, args, inlineResultBudgetChars(identity.ownerId)) };
      } catch (error) {
        if (error instanceof OrgTxnTimeoutError || error instanceof DbCallDeadlineError) {
          return {
            data: {
              ok: false as const,
              error: 'timeout',
              retryable: true,
              ...(error instanceof OrgTxnTimeoutError ? { pgCode: error.pgCode } : {}),
              message:
                `scorecards:get read hit transient database contention: ${error.message}. ` +
                'No scorecard was returned; retry shortly.',
            },
          };
        }
        throw error;
      }
    });
  },
});
