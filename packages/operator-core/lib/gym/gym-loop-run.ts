/**
 * P-022 / D-020 AUTOLOOP RUNNER CLI — a thin wrapper over `runOneAutoloopCycle`
 * (autoloop-cycle.ts), which now owns the whole runnable: boot a dedicated
 * headless gym-operator on a fresh gym DB, run the budget-capped human-gated
 * optimization loop (autoPromote:false), record proposals to the control plane,
 * tear down. The factoring (learning-system-audit P-031) lets the
 * `system:gym-cycle` routine action call the SAME machinery in-process; this CLI
 * remains the manual entry point.
 *
 * Two modes (env GYM_LOOP_FAKE):
 *   GYM_LOOP_FAKE=1 → fake agent + fake judge + fake proposer →
 *                     validates the WHOLE loop assembly end-to-end with ZERO LLM spend.
 *   default (real)  → real AGENT_CMD pipeline + real opus-4-8 judge + real proposer. Bounded
 *                     (D-019): GYM_LOOP_MAX_CYCLES (default 1) × a hard GYM_LOOP_BUDGET_USD.
 *
 *   From repo root (REPO_ROOT derives from __dirname, so this is cwd-independent):
 *     set -a; . apps/operator/.env.local; set +a; \
 *       GYM_LOOP_FAKE=1 npx tsx packages/operator-core/lib/gym/gym-loop-run.ts        # zero-LLM assembly check
 *       GYM_LOOP_MAX_CYCLES=1 npx tsx packages/operator-core/lib/gym/gym-loop-run.ts  # real run (on capacity)
 *
 * Env knobs (all read inside runOneAutoloopCycle): GYM_LOOP_PORT (pins the gym-operator's port;
 * omitted ⇒ a genuinely-free ephemeral port is probed per run, so concurrent/manual cycles never
 * collide — EI-18154750714519366), GYM_LOOP_WORKSPACE (WI-5675: the DURABLE axis — the workspace
 * the cycle is FOR, where proposals/autoloop/durable analytics land so the owner's /gym tab sees
 * them; default resolves like account routing → the operator's real workspace),
 * GYM_LOOP_EPHEMERAL_WORKSPACE (the isolated data workspace the throwaway gym stack runs under;
 * default 'gym-loop-ws' — almost never override),
 * GYM_LOOP_HARNESS, GYM_LOOP_MAX_CYCLES, GYM_LOOP_REPEATS, GYM_LOOP_BUDGET_USD,
 * GYM_LOOP_AGENT_CMD, GYM_LOOP_PROPOSER_MODEL, GYM_LOOP_NOVELTY_WEIGHT,
 * GYM_LOOP_CONTROL_DSN (control plane → the LIVE operator DB; else the gym DB — WITHOUT it a
 * manual run's proposals/analytics die with the ephemeral DB and nothing reaches /gym).
 */

// The gym judge + agents use the CODE backend (the `claude` CLI), not anthropic-direct — it paces
// against the subscription session rather than hammering api.anthropic.com (what tripped the
// rate limit). Set before llm-client loads (TEST_BACKEND read at module init). Overridable.
process.env.LLM_TEST_BACKEND = process.env.LLM_TEST_BACKEND ?? 'claude-code';

import { runOneAutoloopCycle, maskDsn } from './autoloop-cycle';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/**
 * WI-5811 [owner 2026-07-25]: "ALL LEARNINGS SHOULD BE SCOPED TO A POT."
 *
 * This used to default to the literal 'gymloopharness' — a slug that is NOT a
 * registered pot and belongs to NO hive. Every CLI gym run therefore wrote its
 * runs, proposals and QD archive into an orphan bucket that no pot's Learning
 * lens could ever resolve, which is why the gym tab read empty under every pot
 * while the gym was demonstrably running. (The old WI-5420 read-side "fallback"
 * papered over this by showing another pot's data instead — removed in WI-5809.)
 *
 * Default is now the operator's HOME pot, resolved through the SAME single
 * source of truth every other home-hive call site uses
 * (`operatorHomeHarnessSlug()` — `PAPERCUSP_POT_HOME_SLUG`, else the
 * `papercusp` legacy default; see operator-home-harness.ts). This used to
 * hand-roll its own fallback chain ending in the literal 'gymloopharness' —
 * a duplicate, DIVERGENT copy of the canonical resolver (its second rung,
 * `PAPERCUSP_HOME_HARNESS`, isn't even a real env pointer anywhere else in
 * the codebase) that reintroduced the orphan bucket as a "last resort" for
 * exactly the bare-env case `operatorHomeHarnessSlug()` already handles by
 * resolving to a REAL registered hive instead. `GYM_LOOP_HARNESS` still
 * overrides for a deliberate throwaway/bench run.
 */
const SLUG = process.env.GYM_LOOP_HARNESS ?? operatorHomeHarnessSlug();

async function main(): Promise<void> {
  // CLI semantics preserved: env-driven options + the autoloop-row writes
  // (enabled:true + budget + running → idle/paused + spent) around the run.
  const { ok, report } = await runOneAutoloopCycle(SLUG, { manageAutoloopRow: true });

  process.stdout.write('\n===== GYM LOOP (P-022 / D-020) REPORT =====\n' + maskDsn(JSON.stringify(report, null, 2)) + '\n');
  process.stdout.write(ok ? '\nGYM-LOOP: OK\n' : '\nGYM-LOOP: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
