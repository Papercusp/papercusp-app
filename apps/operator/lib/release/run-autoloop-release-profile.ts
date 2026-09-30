/**
 * run-autoloop-release-profile.ts — standalone CLI entry point for
 * `evaluateAutoloopReleaseProfile()` (WI-5144, follow-up from WI-4964 / plan
 * rubric-system-and-auto-loop-release-profile-2026-07-15 P-011).
 *
 * `evaluateAutoloopReleaseProfile()` (release-profile.ts, same directory) is fully
 * implemented, tested, and verified live — but nothing calls it on a recurring
 * cadence; today it's only ever run ad-hoc via a one-off tsx invocation. This CLI
 * is the standalone entry point the new `system:autoloop-release-readiness-monitor`
 * system action (packages/operator-core/lib/harness/routines/
 * autoloop-release-readiness-action.ts) shells out to on a cron tick — mirroring
 * exactly how `system:green-checkpoint` / `system:release-trigger` shell out to
 * green-checkpoint.ts / deploy-cli.ts (see release-actions.ts's file header:
 * "operator-core must not import the apps/operator tier").
 *
 * Prints ONE marker line on stdout (the verdict, JSON-encoded) for the caller to
 * parse; the pretty-printed verdict goes to stderr for human/log readability —
 * same convention as green-checkpoint.ts's `emitResult`.
 */
import { evaluateAutoloopReleaseProfile } from './release-profile';

export const AUTOLOOP_RELEASE_PROFILE_RESULT_MARKER = '__AUTOLOOP_RELEASE_PROFILE_RESULT__';

async function main(): Promise<void> {
  const verdict = await evaluateAutoloopReleaseProfile();
  console.error(JSON.stringify(verdict, null, 2));
  console.log(`${AUTOLOOP_RELEASE_PROFILE_RESULT_MARKER} ${JSON.stringify(verdict)}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[run-autoloop-release-profile] FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    });
}
