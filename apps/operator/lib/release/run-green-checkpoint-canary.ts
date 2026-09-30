/**
 * run-green-checkpoint-canary.ts — standalone CLI entry point for the
 * green-checkpoint result-parser canary (WI-6005, the deferred follow-on named
 * in gate-canary-sweep-action.ts's own file header).
 *
 * `gate-canary-sweep-action.ts` (operator-core) sweeps ONLY the federation-probe
 * canary today — it must not import this apps/operator-tier module directly
 * (operator-core cannot depend on the apps/operator tier; the SAME layering
 * `system:green-checkpoint` / `system:release-trigger` / `system:autoloop-
 * release-readiness-monitor` already respect — see release-actions.ts's and
 * autoloop-release-readiness-action.ts's file headers). This CLI is the
 * standalone entry point the `gate-canary-sweep` system action shells out to on
 * the same cadence as the federation-probe canary, so a silently-unreachable
 * green-checkpoint parser is caught too, instead of only ever being exercised
 * ad-hoc.
 *
 * Prints ONE marker line on stdout (the `GateCanaryRunResult`, JSON-encoded)
 * for the caller to parse; a human-readable line goes to stderr — same
 * convention as run-autoloop-release-profile.ts / green-checkpoint.ts's
 * emitResult.
 */
import { checkResultParser } from './green-checkpoint-canary';

export const GREEN_CHECKPOINT_CANARY_RESULT_MARKER = '__GREEN_CHECKPOINT_CANARY_RESULT__';

async function main(): Promise<void> {
  const result = checkResultParser();
  console.error(`[run-green-checkpoint-canary] ok=${result.ok} — ${result.detail}`);
  console.log(`${GREEN_CHECKPOINT_CANARY_RESULT_MARKER} ${JSON.stringify(result)}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[run-green-checkpoint-canary] FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    });
}
