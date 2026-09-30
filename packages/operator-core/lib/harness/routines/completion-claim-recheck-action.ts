/**
 * Durable system action for the post-close completion-claim recheck (WI-2142447).
 *
 * Same shape as `dead-citation-sweep-action.ts` and for the same reasons: no LLM call —
 * "does this string literal still appear in that array literal" is a parse, not a judgment
 * call — and every dependency injected so `runCompletionClaimRecheckSweep` stays testable
 * with no database and no checkout.
 */
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getOrgPg } from '@papercusp/db-org';

import { repoSourceReader } from '../../completion-claims';
import { COMPLETION_CLAIM_RECHECK_KEY, type CompletionClaimRecheckRecord } from '../../completion-claim-recheck';
import {
  completionClaimRecheckWatchdogKey,
  renderCompletionClaimRecheckBody,
  runCompletionClaimRecheckSweep,
  type CompletionClaimRecheckCandidate,
  type CompletionClaimRecheckSweepDeps,
  type CompletionClaimRecheckSweepResult,
} from '../../completion-claim-recheck-sweep';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from '../../coord-lifecycle/records';
import { captureImprovement } from '../improvements/capture-core';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const COMPLETION_CLAIM_RECHECK = 'completion-claim-recheck';

/** Repo root: lib/harness/routines -> lib -> operator-core -> packages -> <repo root>. */
function repoRoot(): string {
  return path.resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
}

/**
 * Terminal rows carrying declared claims, LEAST-RECENTLY-RECHECKED FIRST so a pass that hits
 * the row limit still makes forward progress instead of re-checking the same head every time.
 * Rows never swept sort first (NULLS FIRST) — never-checked and checked-clean are different
 * states, and the never-checked ones are the only ones the audit bucket cannot yet see.
 *
 * Scoped to the install's own harness: a claim names a path relative to THIS checkout, so
 * evaluating another harness's rows against this tree would manufacture `unevaluatable`
 * verdicts (harmless, being fail-open) while burning the row budget that the rows this
 * checkout can actually judge need.
 */
async function productionCandidates(
  workspaceId: string,
  harnessSlug: string,
  limit: number,
): Promise<CompletionClaimRecheckCandidate[]> {
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      feature_id: string;
      harness_slug: string | null;
      title: string | null;
      claims: unknown;
      baseline: unknown;
      prior_verdict: string | null;
    }[]
  >`
    SELECT feature_id,
           harness_slug,
           title,
           payload->${TERMINAL_COMPLETION_EVIDENCE_KEY}->'claims'        AS claims,
           payload->${TERMINAL_COMPLETION_EVIDENCE_KEY}->'claimVerdicts' AS baseline,
           payload->${COMPLETION_CLAIM_RECHECK_KEY}->>'verdict'          AS prior_verdict
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND closed_ts IS NOT NULL
       AND payload->${TERMINAL_COMPLETION_EVIDENCE_KEY} ? 'claims'
     ORDER BY (payload->${COMPLETION_CLAIM_RECHECK_KEY}->>'at') ASC NULLS FIRST
     LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.feature_id,
    harnessSlug: r.harness_slug,
    title: r.title,
    claims: r.claims,
    baseline: r.baseline,
    priorVerdict: r.prior_verdict,
  }));
}

/**
 * Writes ONLY the sibling recheck key. It must never touch `_completionEvidence`: that
 * object is the close's own record, and a sweep running weeks later editing it would make
 * the evidence completion authority was computed from mutable after the fact.
 */
async function productionStamp(
  workspaceId: string,
  input: { id: string; harnessSlug: string | null; record: CompletionClaimRecheckRecord },
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.work_items
       SET payload = jsonb_set(
             coalesce(payload, '{}'::jsonb),
             ${[COMPLETION_CLAIM_RECHECK_KEY]}::text[],
             ${JSON.stringify(input.record)}::jsonb,
             true)
     WHERE workspace_id = ${workspaceId}
       AND feature_id = ${input.id}
       AND harness_slug IS NOT DISTINCT FROM ${input.harnessSlug}`;
}

export interface CompletionClaimRecheckActionDeps {
  run: (ctx: SystemActionCtx) => Promise<CompletionClaimRecheckSweepResult>;
  file: (input: {
    harnessSlug: string;
    result: CompletionClaimRecheckSweepResult;
  }) => Promise<{ filed: boolean }>;
  log: (message: string) => void;
}

async function productionFile(input: {
  harnessSlug: string;
  result: CompletionClaimRecheckSweepResult;
}): Promise<{ filed: boolean }> {
  // Only a REGRESSION files. `falsified-unbaselined` rows are reported in the body when a
  // filing already happened, but never cause one on their own: nothing establishes that
  // those claims ever held, and a bucket that fires without a transition is the false
  // positive this sweep is specifically built not to produce.
  if (input.result.regressed.length === 0) return { filed: false };
  await captureImprovement({
    title: `Declared completion claim(s) went FALSE after the close (${input.result.regressed.length} work-item(s))`,
    kind: 'bug',
    severity: 'minor',
    body: renderCompletionClaimRecheckBody(input.result),
    scope: `harness:${input.harnessSlug}`,
    foundDuring: `${COMPLETION_CLAIM_RECHECK}`,
    dedupScope: 'open',
    watchdogKey: completionClaimRecheckWatchdogKey(input.harnessSlug),
    sourceRole: 'system',
    createdBy: `system:${COMPLETION_CLAIM_RECHECK}`,
    payloadExtra: {
      completionClaimRecheck: {
        scannedRows: input.result.scannedRows,
        claimsChecked: input.result.claimsChecked,
        regressedIds: input.result.regressed.map((f) => f.id),
        falsifiedUnbaselinedIds: input.result.falsifiedUnbaselined.map((f) => f.id),
        malformedRows: input.result.malformedRows,
      },
    },
  });
  return { filed: true };
}

/**
 * The REAL dependency set, exported so a live probe can swap exactly ONE of them (usually
 * `candidates`, to drive a controlled row through the genuine reader and the genuine stamp)
 * instead of re-implementing the other two. A probe that hand-rolls its own stamp proves
 * only that the copy works, which is the failure this whole feature exists to catch one
 * level up.
 */
export function productionSweepDeps(ctx: SystemActionCtx): CompletionClaimRecheckSweepDeps {
  return {
    candidates: (limit) => productionCandidates(ctx.workspaceId, ctx.installSlug, limit),
    reader: repoSourceReader(repoRoot()),
    stamp: (input) => productionStamp(ctx.workspaceId, input),
  };
}

export function makeCompletionClaimRecheckAction(
  overrides: Partial<CompletionClaimRecheckActionDeps> = {},
) {
  const deps: CompletionClaimRecheckActionDeps = {
    run: (ctx) => runCompletionClaimRecheckSweep(productionSweepDeps(ctx)),
    file: productionFile,
    log: (message) => console.log(`[${COMPLETION_CLAIM_RECHECK}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    const { filed } = await deps.file({ harnessSlug: ctx.installSlug, result });
    deps.log(
      `${ctx.installSlug}: rows=${result.scannedRows} claims=${result.claimsChecked} ` +
        `regressed=${result.regressed.length} unbaselinedFalse=${result.falsifiedUnbaselined.length} ` +
        `malformed=${result.malformedRows} filed=${filed}`,
    );
  };
}

registerSystemAction(COMPLETION_CLAIM_RECHECK, makeCompletionClaimRecheckAction());
