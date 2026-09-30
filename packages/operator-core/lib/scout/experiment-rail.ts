/**
 * The dark Scout→experiment rail (experiment-registry-invocation-api-2026-06-14 #2,
 * "close the loop"). Behind the `SCOUT_EXPERIMENT_RAIL` flag (default OFF), each
 * TESTABLE (gym-rail) Scout proposal is ADDITIVELY expressed as a DRY-RUN experiment
 * spec — it does NOT change the proposal's gym routing and it NEVER spends (dryRun
 * returns before any substrate call).
 *
 * This is the mechanical (LLM-free) v1: the candidate arm's system-prompt overlay IS
 * the proposal's framing+mechanism prose, and the synthetic case is built from the
 * proposal. It proves the loop closes (Scout → experiment:run) with zero spend. The
 * LLM-polished candidate-overlay / case generation — turning prose into a sharp
 * overlay + a real resumable case — is the owner-reviewable follow-on.
 */
import { BASELINE_ID } from '@papercusp/eval-battery';
import type { Proposal } from './types';
import type { RoutingDecision } from './router';
import {
  runExperiment,
  type RunExperimentDeps,
  type RunExperimentInput,
  type RunExperimentOutcome,
} from '../experiment/run-core';
import type { ExperimentLedgerRow } from '../experiment/ledger';

const OVERLAY_CAP = 4000;

/** Map a Scout proposal → a dry-run replay experiment request. Mechanical, no LLM. */
export function proposalToExperimentRequest(p: Proposal): RunExperimentInput {
  const overlay = [p.framing, p.mechanism].filter(Boolean).join('\n\n').slice(0, OVERLAY_CAP);
  const intent = p.bet || p.cheapExperiment?.hypothesis || p.framing || p.mechanism;
  return {
    testId: 'replay',
    batteryId: `scout:${p.id}`,
    arms: [
      { id: 'baseline', knobs: {} },
      { id: 'candidate', label: (p.framing || p.id).slice(0, 80), knobs: { 'overlay.systemOverlay': overlay } },
    ],
    cases: [{ caseId: p.id, context: p.framing || p.mechanism || intent, intent }],
    repeats: 1,
    dryRun: true,
  };
}

/** The dispatch port — what the rail calls per testable proposal. */
export interface ExperimentDispatchPort {
  (request: RunExperimentInput): Promise<RunExperimentOutcome>;
}

/** Build a `proposed` ledger row from a dry-run plan (no scores yet) — what the
 *  scoreboard shows for a Scout-proposed experiment awaiting a run. When the owner
 *  later runs it (same batteryId) the row upserts with real scores. Pure. */
export function proposedLedgerRow(
  workspaceId: string,
  batteryId: string,
  plan: NonNullable<RunExperimentOutcome['plan']>,
): ExperimentLedgerRow {
  return {
    workspaceId,
    batteryId,
    testId: plan.testId,
    tier: plan.tier,
    arms: plan.arms.map((a) => ({ id: a.id, label: a.label, meanScore: null, cells: 0, scored: 0, costUsd: 0 })),
    baselineId: BASELINE_ID,
    winner: null,
    comparison: null,
    totalCostUsd: 0,
    budgetExhausted: false,
  };
}

/**
 * The default dispatch: DRY-RUN-validate the request through run-core (no spend, no run)
 * and RECORD the proposed spec to the experiment_runs ledger so it's VISIBLE on the
 * Learning-tab scoreboard (Scout proposed it; decision='proposed', no scores yet). Forces
 * `dryRun:true` so it can never spend. The recording + scoreboard push are best-effort —
 * a ledger/PG failure never fails the rail. The stub deps satisfy the type only; `dryRun`
 * returns before any is used.
 */
export function buildExperimentDispatchPort(
  recordProposed?: (row: ExperimentLedgerRow) => Promise<void>,
): ExperimentDispatchPort {
  const record =
    recordProposed ??
    (async (row: ExperimentLedgerRow) => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { PgExperimentLedger } = await import('../experiment/ledger');
      await new PgExperimentLedger(getOrgPg().sql).record(row);
      const { notifySyncInvalidate } = await import('../sync-sse');
      notifySyncInvalidate('learning.experiments');
    });
  return async (request) => {
    const { activeWorkspaceId } = await import('../workspace-registry');
    const workspaceId = activeWorkspaceId();
    const outcome = await runExperiment({ ...request, dryRun: true }, { workspaceId }, {
      runGovernedReplay: (async () => ({ verdict: { allow: false, remainingUsd: null }, result: null })) as RunExperimentDeps['runGovernedReplay'],
      replayRunner: (async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: false })) as RunExperimentDeps['replayRunner'],
      judge: (async () => ({ text: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as RunExperimentDeps['judge'],
    });
    if (outcome.ok && outcome.plan) {
      try {
        await record(proposedLedgerRow(workspaceId, request.batteryId, outcome.plan));
      } catch {
        // Best-effort: recording/visualizing the proposed spec must never fail the rail.
      }
    }
    return outcome;
  };
}

/**
 * For each TESTABLE (gym-rail) decision, build a dry-run experiment request from its
 * proposal and dispatch it. Best-effort + defensive — never throws into the cycle, and
 * does NOT touch the proposal's existing gym routing (purely additive).
 */
export async function forkTestableToExperiments(
  decisions: readonly RoutingDecision[],
  proposals: readonly Proposal[],
  dispatch: ExperimentDispatchPort,
  buildRequest: (p: Proposal) => Promise<RunExperimentInput> = async (p) => proposalToExperimentRequest(p),
): Promise<{ dispatched: number; failed: number }> {
  const byId = new Map(proposals.map((p) => [p.id, p]));
  let dispatched = 0;
  let failed = 0;
  for (const d of decisions) {
    if (d.rail !== 'gym') continue;
    const p = byId.get(d.proposalId);
    if (!p) continue;
    try {
      await dispatch(await buildRequest(p));
      dispatched += 1;
    } catch {
      failed += 1;
    }
  }
  return { dispatched, failed };
}
