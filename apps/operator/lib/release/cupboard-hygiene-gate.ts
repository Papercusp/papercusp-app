/**
 * Cupboard prod-hygiene DEPLOY GATE (EI-11118: durable fix for
 * cupboard-public-release-2026-07-12 P-009 — E2E/federation/smoke flows that
 * exercise the real publish path against the LIVE prod Cupboard worker leave
 * junk listings behind, and nothing previously caught a re-accumulation).
 *
 * Modeled exactly on `perf-gate.ts` / `delta-gate.ts` (the established
 * deploy-gate precedent):
 *   - a PURE decision (`evaluateCupboardHygieneGate`) — no IO,
 *   - an IO-seam runner (`runCupboardHygieneGate`) that scans the live prod
 *     Cupboard storefront via the shared `scanCupboardForTestRows` (the same
 *     junk-pattern definition the manual fresh-install acceptance script
 *     uses — one definition, two call sites),
 *   - wired into green-checkpoint via an optional
 *     `CheckpointDeps.cupboardHygieneGate`.
 *
 * UNLIKE perf-gate/delta-gate, this gate defaults ENABLED (warn-only): the
 * check is a single cheap read-only fetch against the public `/listings`
 * endpoint (no heavy computation, no risk of false-blocking a healthy deploy
 * since warn never holds the pin), so there is no reason to ship it dark —
 * per this repo's "a flag left off is dead code" rule, the whole point of
 * this gate is to make a P-009-style re-accumulation VISIBLE the moment it
 * happens, not to sit inert until someone remembers to flip it on. Only
 * BLOCK-mode (which can hold a deploy) stays owner-armed, matching the
 * perf/delta precedent for anything that can stop the pin advancing.
 *
 * Fail-soft on infrastructure trouble: a browse failure (worker down, DNS,
 * timeout) degrades to `pass` — a green deploy must never be held hostage by
 * the Cupboard worker being unreachable, only by ACTUAL junk it found.
 */

import {
  scanCupboardForTestRows,
  liveCupboardBrowse,
  type CupboardTestRow,
  type CupboardBrowseFn,
} from '@papercusp/operator-core/lib/cupboard/prod-hygiene';
import { LISTING_KINDS } from '@papercusp/operator-core/lib/cupboard/types';

export type CupboardHygieneGateAction = 'pass' | 'warn' | 'block';

export interface CupboardHygienePolicy {
  /** Master switch. When false the gate is a no-op (`pass`) and reads nothing.
   *  Default-ON — see the file header for why this differs from perf/delta-gate. */
  enabled: boolean;
  /** Owner-armed block-mode. When false, found junk only `warn`s and the deploy
   *  still advances; when true it `block`s. Default-OFF (warn-only) until the
   *  owner trusts the scan has no false positives on real storefront content. */
  block: boolean;
}

export interface CupboardHygieneGateDecision {
  action: CupboardHygieneGateAction;
  reasons: string[];
  summary: string;
  testRows: CupboardTestRow[];
}

/** Read the gate policy from the environment (mirrors perfGatePolicyFromEnv).
 *  - `PAPERCUSP_CUPBOARD_HYGIENE_GATE=0`       → disable the gate (default ON).
 *  - `PAPERCUSP_CUPBOARD_HYGIENE_GATE_BLOCK=1` → arm block-mode (default warn-only). Owner-set. */
export function cupboardHygienePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): CupboardHygienePolicy {
  return {
    enabled: env.PAPERCUSP_CUPBOARD_HYGIENE_GATE !== '0',
    block: env.PAPERCUSP_CUPBOARD_HYGIENE_GATE_BLOCK === '1',
  };
}

function shaLabel(candidateSha?: string): string {
  return candidateSha ? candidateSha.slice(0, 8) : 'candidate';
}

/**
 * PURE: map a set of found test rows + policy → a deploy-gate action. No IO.
 *
 * Decision table:
 *   gate disabled           → pass (no-op; opt-out)
 *   no test rows found      → pass (storefront clean)
 *   test rows found         → block IFF policy.block else warn
 */
export function evaluateCupboardHygieneGate(
  testRows: CupboardTestRow[],
  policy: CupboardHygienePolicy,
  candidateSha?: string,
): CupboardHygieneGateDecision {
  const sha = shaLabel(candidateSha);

  if (!policy.enabled) {
    return {
      action: 'pass',
      reasons: [],
      summary: `cupboard-hygiene-gate disabled — ${sha} not scanned`,
      testRows: [],
    };
  }

  if (testRows.length === 0) {
    return {
      action: 'pass',
      reasons: [],
      summary: `cupboard-hygiene-gate: prod storefront clean — ${sha} clears`,
      testRows: [],
    };
  }

  const reasons = testRows.map((r) => `${r.kind}: ${r.ref}`);
  const action: CupboardHygieneGateAction = policy.block ? 'block' : 'warn';
  const verb = action === 'block' ? 'BLOCKED (block-mode armed)' : 'flagged (warn — block-mode not armed)';
  return {
    action,
    reasons,
    summary:
      `🟥 cupboard-hygiene-gate: prod storefront has ${testRows.length} test/junk row(s) — deploy of ${sha} ${verb}: ` +
      `${reasons.slice(0, 5).join('; ')}${reasons.length > 5 ? `; +${reasons.length - 5} more` : ''}`,
    testRows,
  };
}

/** IO seam for `runCupboardHygieneGate` (injected as fakes in tests). */
export interface CupboardHygieneGateIO {
  browse: CupboardBrowseFn;
}

const defaultCupboardHygieneGateIO: CupboardHygieneGateIO = {
  browse: liveCupboardBrowse,
};

/**
 * Scan the live prod Cupboard storefront for junk rows and apply the gate
 * policy → a {@link CupboardHygieneGateDecision}. Fail-SOFT end-to-end: when
 * disabled it reads NOTHING and passes; if EVERY kind's browse fails (worker
 * unreachable), the scan can't say anything meaningful — this degrades to
 * `pass` (never hold a green deploy hostage to Cupboard-worker downtime). A
 * PARTIAL browse failure (some kinds ok, some errored) still evaluates the
 * kinds that succeeded — real junk found there still warns/blocks, just noted
 * as a partial scan in the summary.
 */
export async function runCupboardHygieneGate(
  policy: CupboardHygienePolicy,
  candidateSha?: string,
  io: CupboardHygieneGateIO = defaultCupboardHygieneGateIO,
): Promise<CupboardHygieneGateDecision> {
  if (!policy.enabled) {
    return evaluateCupboardHygieneGate([], policy, candidateSha);
  }

  const { testRows, errors } = await scanCupboardForTestRows(io.browse).catch(() => ({
    testRows: [] as CupboardTestRow[],
    errors: LISTING_KINDS.map((kind) => ({ kind, error: 'scan_threw' })),
  }));

  // Total failure (every kind unreachable): the scan says nothing meaningful —
  // fail-soft to `pass`, worded honestly as "unscanned", never as "clean".
  if (testRows.length === 0 && errors.length >= LISTING_KINDS.length) {
    return {
      action: 'pass',
      reasons: [],
      summary: `cupboard-hygiene-gate: prod Cupboard worker unreachable (${errors.length}/${LISTING_KINDS.length} kinds failed) — ${shaLabel(candidateSha)} not scanned, fail-soft pass`,
      testRows: [],
    };
  }

  const decision = evaluateCupboardHygieneGate(testRows, policy, candidateSha);
  if (errors.length > 0 && decision.action !== 'block') {
    // Surface the partial-scan caveat without escalating severity — a scan
    // that couldn't see every kind must not silently claim "clean".
    return {
      ...decision,
      summary: `${decision.summary} (partial scan — ${errors.length} kind(s) unreachable: ${errors
        .map((e) => e.kind)
        .join(', ')})`,
    };
  }
  return decision;
}
