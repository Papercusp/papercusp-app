/**
 * Operator adapter — assembles the `RunnerDeps` bag the generic
 * `@papercusp/testing-shell/llm` runner needs, from the operator's concrete
 * seams (Phase 7 P-073).
 *
 * The generic framework names no host app: every host-specific capability is
 * injected via `RunnerDeps` (see the lib's ./deps). This file is the one place
 * the operator maps its own transport / config / Postgres surfaces onto those
 * seams:
 *
 *   - llmCall        → ./llm-client      (runAgentChat + operator credentials)
 *   - getTarget      → ./targets         (Operator / Oracle / Architect targets)
 *   - resolveModels  → ../agent-config   (per-workspace judge/sim model prefs)
 *   - telemetry      → ./telemetry       (PG tool_invocations / continue_chains)
 *   - store          → ./storage         (PG harness_shared.llm_test_runs/findings)
 *   - claim          → ./ledger          (PG parallel-runner claim ledger)
 */

import type { RunnerDeps } from '@papercusp/testing-shell/llm';

import { readAgentConfig } from '../agent-config';

import { llmCall } from './llm-client';
import { tryClaim, release } from './ledger';
import { applyScenarioSetup } from './setup';
import { persistRunReport } from './storage';
import { getTarget } from './targets';
import { pullContinueChainRows, pullToolInvocations } from './telemetry';

export interface OperatorDepsOpts {
  /**
   * Persist the finished run report to PG (harness_shared.llm_test_runs /
   * findings) at end-of-run. Defaults to true; the CLI's `--no-persist` passes
   * false, which omits the `store` seam so the runner skips persistence.
   */
  persist?: boolean;
}

/**
 * Build the operator's `RunnerDeps`. Each seam is an existing operator module —
 * the runner stays generic; all host wiring lives here.
 */
export function operatorRunnerDeps(opts: OperatorDepsOpts = {}): RunnerDeps {
  const deps: RunnerDeps = {
    llmCall,
    getTarget,
    resolveModels: async () => {
      const cfg = await readAgentConfig();
      return {
        judgeModel: cfg.models['llm-testing-judge'],
        simModel: cfg.models['llm-testing-sim-user'],
      };
    },
    telemetry: { pullToolInvocations, pullContinueChainRows },
    claim: { tryClaim, release },
    // scenario.setup seeding (memory entries through the neutral seam) —
    // memory-backend-benchmark P-009; see ./setup.
    applySetup: applyScenarioSetup,
  };
  if (opts.persist !== false) {
    deps.store = { persistRunReport };
  }
  return deps;
}
