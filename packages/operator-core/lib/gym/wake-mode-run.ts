/**
 * CLI wrapper for the gym WAKE-MODE E2E (hive-loop-e2e-testing-2026-06-10 P-006)
 * — mirrors blueprint-cycle-run.ts. The machinery lives in wake-mode.ts.
 *
 *   cd apps/operator && \
 *     npx tsx ../../packages/operator-core/lib/gym/wake-mode-run.ts            # fake (zero-LLM, default)
 *     GYM_WAKE_FAKE=0 npx tsx ../../packages/operator-core/lib/gym/wake-mode-run.ts  # real (haiku-class, D-004)
 */
import { runGymWakeMode } from './wake-mode';
import { maskDsn } from './autoloop-cycle';

async function main(): Promise<void> {
  const out = await runGymWakeMode();
  process.stdout.write(
    '\n===== GYM WAKE-MODE (hive-loop-e2e P-006) REPORT =====\n' + maskDsn(JSON.stringify(out.report, null, 2)) + '\n',
  );
  process.stdout.write(out.ok ? '\nGYM-WAKE: OK\n' : '\nGYM-WAKE: FAIL\n');
  process.exit(out.ok ? 0 : 1);
}

void main();
