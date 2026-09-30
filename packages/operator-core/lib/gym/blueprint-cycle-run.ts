/**
 * Brief 48 (gym tail) CLI — a thin wrapper over `runGymBlueprintCycle`
 * (blueprint-cycle.ts), which now owns the whole runnable: provision a dedicated
 * gym DB, boot a headless gym-operator, register the gym + target harnesses,
 * drive ONE optimization cycle of the `gym` blueprint THROUGH THE DURABLE
 * PIPELINE (deriveNext over the gym spine, D-022), tear down. The factoring
 * (mirrors gym-loop-run.ts → autoloop-cycle.ts) lets a test drive the SAME
 * machinery in-process; this CLI remains the manual entry point.
 *
 * Two modes (env GYM_BP_FAKE, DEFAULT fake):
 *   GYM_BP_FAKE=1 (default) → fixtures/fake-gym-agent.mjs walks the spine verbs with
 *                             ZERO LLM spend — the live-boot assembly check.
 *   GYM_BP_FAKE=0           → real AGENT_CMD agents (sonnet by default) actually
 *                             optimize the target; bounded by the spine's own
 *                             terminality + GYM_BP_TIMEOUT_MIN.
 *
 *   cd apps/operator && set -a; . ./.env.local; set +a; \
 *     npx tsx ../../packages/operator-core/lib/gym/blueprint-cycle-run.ts            # fake
 *     GYM_BP_FAKE=0 npx tsx ../../packages/operator-core/lib/gym/blueprint-cycle-run.ts  # real
 *
 * Env knobs (all read inside runGymBlueprintCycle): GYM_BP_PORT (pins the gym-operator's port;
 * omitted ⇒ a genuinely-free ephemeral port is probed per run, so concurrent cycles never
 * collide — EI-18154750714519366), GYM_BP_WORKSPACE,
 * GYM_BP_GYM_SLUG, GYM_BP_TARGET_SLUG, GYM_BP_FAKE, GYM_BP_TIMEOUT_MIN,
 * GYM_BP_AGENT_CMD, GYM_BP_KEEP.
 */
import { runGymBlueprintCycle, maskBpDsn } from './blueprint-cycle';

async function main(): Promise<void> {
  const { ok, report } = await runGymBlueprintCycle();
  process.stdout.write('\n===== GYM BLUEPRINT CYCLE (Brief 48) REPORT =====\n' + maskBpDsn(JSON.stringify(report, null, 2)) + '\n');
  process.stdout.write(ok ? '\nGYM-BP-CYCLE: OK\n' : '\nGYM-BP-CYCLE: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
