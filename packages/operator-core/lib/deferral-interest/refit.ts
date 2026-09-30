/**
 * refit.ts — the deferral-interest refit tick (self-learning-frontier P-042 /
 * FB-14): backfill realized deferral costs from history, fit the v0 pricing
 * model, append the new version. One tick IS the backfill — every run
 * recomputes over the full readable corpus (idempotent; no watermark), so the
 * first armed run and the nightly cadence are the same code path.
 *
 * SQL + pure math only — zero LLM spend. Deps are injectable so the tick is
 * unit-testable without PG (the negative-space scan.ts pattern); the flag +
 * governor gates live in the routine action (deferral-interest-action.ts),
 * NOT here (FB-01's default-on-flag-glue-vs-hermetic-unit-tests insight —
 * factories stay hermetic, glue wires at the registrar).
 *
 * Candidates arrive through readImprovementItems, which defaults to ORGANIC
 * provenance only (frontier P-002/D-002) — the pricing model never learns
 * from drill/replay/shadow rows.
 */

import type { Sql } from 'postgres';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { readImprovementItems } from '../harness/improvements/read-items';
import { computeDeferralOutcomes, type TimedEdge } from './outcomes';
import { fitDeferralPricingModel, type DeferralPricingModel } from './model';
import { readDeferralEdges, saveDeferralModel } from './store';

/** listIssues hard-caps at 500; the whole improvement corpus is a few hundred
 *  rows today. When it outgrows the cap the read truncates newest-first —
 *  surfaced in the tick log so the truncation is never silent. */
const READ_LIMIT = 500;

export interface DeferralRefitDeps {
  readCandidates: () => Promise<ImprovementCandidate[]>;
  readEdges: (issueIds: readonly string[]) => Promise<TimedEdge[]>;
  saveModel: (model: DeferralPricingModel) => Promise<void>;
  log?: (message: string) => void;
}

export interface DeferralRefitOptions {
  /** Clock — deterministic tests pass a fixed ms. Default Date.now(). */
  nowMs?: number;
  priorWeeks?: number;
}

export interface DeferralRefitResult {
  candidates: number;
  /** Human-lane items that trained the model (the backfill set). */
  deferrals: number;
  decided: number;
  stillOpen: number;
  globalRatePerWeek: number;
  weak: boolean;
}

/** The live PG-backed deps (the routine action's default wiring). */
export function defaultDeferralRefitDeps(sql: Sql, workspaceId: string): DeferralRefitDeps {
  return {
    readCandidates: () => readImprovementItems({ limit: READ_LIMIT }),
    readEdges: (ids) => readDeferralEdges(sql, ids),
    saveModel: (model) => saveDeferralModel(sql, workspaceId, model),
    log: (m) => console.log(m),
  };
}

/** One refit tick: read → backfill outcomes → fit → append model version. */
export async function runDeferralInterestRefit(
  deps: DeferralRefitDeps,
  opts: DeferralRefitOptions = {},
): Promise<DeferralRefitResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const log = deps.log ?? (() => {});

  const candidates = await deps.readCandidates();
  if (candidates.length >= READ_LIMIT) {
    log(`[deferral-interest] corpus at the ${READ_LIMIT}-row read cap — training on the newest ${READ_LIMIT} (truncation is NOT silent; widen the read when this fires)`);
  }
  const edges = await deps.readEdges(candidates.map((c) => c.id));
  const outcomes = computeDeferralOutcomes(candidates, edges, { nowMs });
  const model = fitDeferralPricingModel(outcomes, {
    trainedAt: new Date(nowMs).toISOString(),
    ...(opts.priorWeeks !== undefined ? { priorWeeks: opts.priorWeeks } : {}),
  });
  await deps.saveModel(model);

  const decided = outcomes.filter((o) => o.decidedAtMs !== null).length;
  const result: DeferralRefitResult = {
    candidates: candidates.length,
    deferrals: outcomes.length,
    decided,
    stillOpen: outcomes.length - decided,
    globalRatePerWeek: model.globalRatePerWeek,
    weak: model.weak,
  };
  log(
    `[deferral-interest] refit: ${result.deferrals} deferral(s) (${result.decided} decided, ` +
      `${result.stillOpen} open) from ${result.candidates} candidate(s) → ` +
      `global ${result.globalRatePerWeek}/wk${result.weak ? ' (WEAK — small sample, by design at v0)' : ''}`,
  );
  return result;
}
