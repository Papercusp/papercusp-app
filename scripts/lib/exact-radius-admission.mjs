// @ts-check
/**
 * When may the checkpoint's `--related --print-affected` probe hand out an EXACT file radius
 * (`RELATED_AFFECTED_FILES status=selected …`) instead of widening every affected test task?
 *
 * WI-10004928 / plan p2p-public-release-endgame-2026-09-01 D-129 (1): repo-wide invariant guards
 * no longer force the radius to full. Each guard is emitted as its own `AFFECTED_GUARD` line and
 * the repair-head consumer (`parseRepairHeadRadius` in green-checkpoint.ts) runs it as a separate
 * gate leg, so an exact file list and the guards coexist without under-testing anything. Before
 * this, ANY attached guard (and most real changes attach one) threw every repair round back to a
 * full widened run.
 *
 * What still refuses an exact radius:
 *  - a selected task the exact file runner cannot execute (a non-unit-vitest script);
 *  - an empty affected-file list (a graph gap is not proof that nothing is affected);
 *  - ANY changed global runner input. A runner input (root config, lockfile, manifest, tsconfig,
 *    test setup, patch) changes how EVERY test runs, while the import graph that builds the file
 *    radius cannot see it. A root-level input maps to no workspace at all, so before D-129 the
 *    guard it attaches was the only thing keeping it from narrowing; this check replaces that
 *    accidental protection with an explicit one.
 *
 * The global-input definition reuses `isGlobalRunnerInput` from test-pass-reuse.mjs at its MOST
 * conservative setting (no main-process / toolchain narrowing), then also treats nested runner
 * configuration as global. Test-pass reuse may narrow nested configs because each proof records
 * the config it ran under; a file radius has no such record.
 */
import { isGlobalRunnerInput } from "./test-pass-reuse.mjs";

/** Nested runner configuration that a file radius cannot see through the import graph. */
const NESTED_RUNNER_INPUT = [
  /(?:^|\/)vitest[^/]*config[^/]*$/,
  /(?:^|\/)vite[^/]*config[^/]*$/,
  /(?:^|\/)package\.json$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  // `setup.ts`, `test-setup.mts`, `vitest.setup.ts`, `setup.dom.ts` — but not `setupWizard.tsx`.
  /(?:^|\/)(?:vitest[.-])?(?:test[.-])?setup(?:[.-][^/]*)?\.[cm]?[jt]sx?$/,
];

/**
 * @param {string} rel repo-relative POSIX path
 * @returns {boolean}
 */
export function isExactRadiusGlobalInput(rel) {
  const path = rel.replaceAll("\\", "/");
  if (isGlobalRunnerInput(path)) return true;
  // A test FILE (e.g. `vitest-config.test.ts`) is an ordinary test the radius selects by itself,
  // not runner configuration — the same carve-out isGlobalRunnerInput makes for test-config.
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  return NESTED_RUNNER_INPUT.some((re) => re.test(path));
}

/**
 * @param {{
 *   everyTaskNarrowable: boolean,
 *   affectedFileCount: number,
 *   changedPaths: readonly string[],
 * }} input
 * @returns {{ admitted: true } | { admitted: false, reason: string, path?: string }}
 */
export function exactRadiusAdmission({ everyTaskNarrowable, affectedFileCount, changedPaths }) {
  if (!everyTaskNarrowable) return { admitted: false, reason: "non-file-runner-task" };
  if (!(affectedFileCount > 0)) return { admitted: false, reason: "no-affected-files" };
  const global = changedPaths.find((p) => isExactRadiusGlobalInput(p));
  if (global !== undefined) {
    return { admitted: false, reason: "global-runner-input", path: global };
  }
  return { admitted: true };
}
