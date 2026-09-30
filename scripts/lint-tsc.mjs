#!/usr/bin/env node
/**
 * lint:tsc — Gate NEW TypeScript type errors in operator-core against a PER-FILE baseline.
 *
 * ## Why per-file, not a global count (P-010 / WI-4535)
 *
 * The old gate compared ONE integer — the total operator-core error count — against a single
 * pinned number (224). On this heavily-parallel shared tree that number cannot attribute a
 * regression and it inherently FLAPS: the count shuffles ±N as peers edit the type-graph
 * concurrently, so a run that reads "231 vs 224" tells you seven errors appeared but NOT which
 * files, NOT whether YOUR change caused them, and NOT whether it is just the same deep-
 * instantiation ripple shuffling again. That drove a documented series of false-reds and
 * baseline-pinning wars (see the old .tsc-baseline.json note; EI-379 / EI-1984).
 *
 * The fix records the baseline PER FILE (`{ "packages/operator-core/lib/x.ts": 2, … }`) and
 * gates each file against its own count. A regression is therefore ATTRIBUTED to the file that
 * caused it — the gate NAMES it (`lib/x.ts: 2 → 4  (+2)`) — and a concurrent ±1 flap in file A
 * never reds an agent who only edited file B. `--mine` scopes the FAILURE to the files you
 * actually changed (from `git status`), so you can cheaply verify "my change is tsc-clean" even
 * while the shared tree carries unrelated peer drift.
 *
 * Two hard rules carry over (audit P-073, EI-104 — a frozen baseline must not neutralize strictness):
 *
 *   1. RATCHET-ONLY-DOWN, on an EXPLICIT `--update` only. When a file is BELOW its baseline,
 *      `--update` tightens that file's baseline to the new count — improvements lock in and can't
 *      silently regress; RAISING a file's baseline is a deliberate hand-edit of the JSON with a
 *      justification. A BARE run (CI / a peer's `npm run lint:tsc`) only CHECKS — it never
 *      rewrites the baseline. Per-file makes this safe where the global count could not be:
 *      auto-ratcheting a global count locked in a transient tree-wide low and then false-red the
 *      fleet when it reappeared; a per-file ratchet only ever lowers a file that genuinely improved.
 *   2. TS1xxx HARD-FAIL: any file with a TS1xxx diagnostic fails the lint regardless of the
 *      counts. Most TS1xxx diagnostics are parser errors, but some are semantic/type errors;
 *      the compiler diagnostic text is the authoritative explanation.
 *
 * Usage:
 *   npm run lint:tsc              # CI gate: any file above its baseline fails, and is NAMED
 *   npm run lint:tsc -- --mine    # fail on regressions in files DIRTY IN THE TREE (git status).
 *                                 # On this shared checkout that is yours AND every peer's — prefer
 *                                 # --files below, which is the only trustworthy attribution here.
 *   npm run lint:tsc -- --files=path/a.ts,path/b.ts
 *   npm run lint:tsc -- --files path/a.ts,path/b.ts
 *                                 # EI-18731016038876755: scope to EXACTLY these files instead of
 *                                 # guessing from `git status` — the safe choice on a shared,
 *                                 # concurrently-edited checkout where `--mine` can attribute a
 *                                 # PEER's in-flight edit to you. Implies --mine-style scoping.
 *   npm run lint:tsc -- --update  # lower each improved file's baseline to current (never raises)
 *   npm run lint:tsc -- --all-errors
 *                                 # EI-19343733961745670: quote EVERY diagnostic for a failing
 *                                 # file instead of the first 10 (3 for a new/hard-failing file).
 *                                 # Reporting is capped by default so one pathological file cannot
 *                                 # bury the guidance under it; lift the cap when the footer says
 *                                 # `+N more not shown` and you need those N — the alternative is
 *                                 # the second full ~150s compile this reporting exists to avoid.
 *
 * Exit codes:
 *   0 — OK (every file at/under its baseline; or --mine and your files are clean; or ratcheted down)
 *   1 — a file regressed above its baseline, a TS1xxx hard-fail diagnostic, or a script/toolchain error
 *
 * ## EI-847 — this is now a THIN per-project CLI over a shared gate
 *
 * The reusable policy (parse/aggregate/decide/report) lives in `scripts/lib/tsc-baseline-gate.mjs`
 * so a second project can get the same baseline-gated, `--mine`-scoped, ratchet-only-down
 * typecheck without forking this file. See `scripts/lint-tsc-operator-vite.mjs` for the
 * operator-vite counterpart — same policy, different tscCommand/baselineFile/label. The named
 * exports below are re-exported (not duplicated) from the shared module for `lint-tsc.test.ts`.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseTscErrors,
  normalizeDiagnosticPath,
  normalizeTscErrorPaths,
  MID_INSTALL_DIAGNOSTIC_MIN,
  parseMissingModuleDiagnostics,
  packageNameFromModuleSpecifier,
  detectUnextractedDependencyDiagnostics,
  formatMidInstallWarning,
  syntaxBrokenFiles,
  countByFile,
  gitChangedFiles,
  relatedSourceFiles,
  filesModifiedDuringRun,
  parseExplicitFiles,
  decidePerFile,
  effectiveBaselineByFile,
  exportedTypeNames,
  filesReferencingTypeNames,
  diagnosticFilesReferencingTypeNames,
  formatAttributionHeadline,
  formatNewFileGuidance,
  formatStandingRedRow,
  formatStandingRedFooter,
  partitionNewFilesByLiveEdit,
  partitionEntriesByLiveEdit,
  partitionBrokenFilesByLiveEdit,
  diagnosticLinesForFiles,
  formatRegressedFileDiagnostics,
  REGRESSION_DIAGNOSTIC_MAX_PER_FILE,
  ALL_ERRORS_FLAG,
  diagnosticCapFromArgv,
  partitionStandingByCommitRecency,
  formatLandingRaceCaveat,
  LANDING_RACE_WINDOW_SEC,
  isUnchangedForAttribution,
  projectPrefixFromTscCommand,
  normalizeExplicitFilesForProject,
  partitionFilesByCoverage,
  suggestTypecheckGate,
  formatUncoveredFilesBanner,
  coalesceWatermarkFor,
  declarationFilesFromConfig,
  mergeRatchetIntoBaseline,
  runTscBaselineGate,
  lintTscScopeFromArgv,
  formatLintTscResultMarker,
  discoverSiblingTypecheckGates,
  coveragePrefixesFromGateModule,
  gateCoveringFile,
} from './lib/tsc-baseline-gate.mjs';

export {
  parseTscErrors,
  normalizeDiagnosticPath,
  normalizeTscErrorPaths,
  MID_INSTALL_DIAGNOSTIC_MIN,
  parseMissingModuleDiagnostics,
  packageNameFromModuleSpecifier,
  detectUnextractedDependencyDiagnostics,
  formatMidInstallWarning,
  syntaxBrokenFiles,
  countByFile,
  gitChangedFiles,
  relatedSourceFiles,
  filesModifiedDuringRun,
  parseExplicitFiles,
  decidePerFile,
  effectiveBaselineByFile,
  exportedTypeNames,
  filesReferencingTypeNames,
  diagnosticFilesReferencingTypeNames,
  formatAttributionHeadline,
  formatNewFileGuidance,
  formatStandingRedRow,
  formatStandingRedFooter,
  partitionNewFilesByLiveEdit,
  partitionEntriesByLiveEdit,
  partitionBrokenFilesByLiveEdit,
  diagnosticLinesForFiles,
  formatRegressedFileDiagnostics,
  REGRESSION_DIAGNOSTIC_MAX_PER_FILE,
  ALL_ERRORS_FLAG,
  diagnosticCapFromArgv,
  partitionStandingByCommitRecency,
  formatLandingRaceCaveat,
  LANDING_RACE_WINDOW_SEC,
  isUnchangedForAttribution,
  projectPrefixFromTscCommand,
  normalizeExplicitFilesForProject,
  partitionFilesByCoverage,
  suggestTypecheckGate,
  formatUncoveredFilesBanner,
  coalesceWatermarkFor,
  declarationFilesFromConfig,
  mergeRatchetIntoBaseline,
  lintTscScopeFromArgv,
  formatLintTscResultMarker,
  discoverSiblingTypecheckGates,
  coveragePrefixesFromGateModule,
  gateCoveringFile,
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'packages/operator-core/.tsc-baseline.json');

/**
 * The tsc invocation used for EVERY measurement (bare check, --mine, --update).
 * `--incremental false` is EI-487's regression guard, not a stylistic choice:
 * operator-core's tsconfig has `incremental: true`, and a warm/stale
 * tsconfig.tsbuildinfo makes `tsc --noEmit` UNDER-REPORT errors in files that
 * are affected-but-not-yet-reindexed by the incremental cache (WI-4488 first
 * caught this masking +29 real errors as green for days). Worse under THIS
 * script specifically: an incomplete incremental count read as "clean" would
 * silently ratchet a file's baseline DOWN on `--update`, so a later fully-fresh
 * run (CI, or the same file once its cache catches up) trips the gate on code
 * that already passed its author's own `lint:tsc` — the exact fleet-wide false
 * red EI-487 traced back to this flag being absent. Exported (not inlined in
 * main()) so lint-tsc.test.ts can assert it directly instead of only trusting
 * that nobody deletes it later.
 */
/** @type {string} */
export const TSC_COMMAND =
  'npx tsc -p packages/operator-core/tsconfig.json --noEmit --incremental false';

/**
 * EI-21441555291852229 — operator-core imports enrolled `.mjs` helpers through tracked,
 * generated `.d.mts` companions. Refresh them before tsc resolves the type graph so the
 * first typecheck after an export change sees the same contracts as every later run.
 */
export const TSC_PREFLIGHT_COMMAND = 'npm run gen:declarations';

const USAGE = `Usage:
  npm run lint:tsc              # any file above its baseline fails, named
  npm run lint:tsc -- --mine    # fail on regressions in files dirty in the tree
  npm run lint:tsc -- --files=path/a.ts,path/b.ts
  npm run lint:tsc -- --files path/a.ts,path/b.ts
                               # scope to exactly these files
  npm run lint:tsc -- --update  # lower each improved file's baseline (never raises)
  npm run lint:tsc -- --all-errors
                               # quote every diagnostic for a failing file, not just the first 10
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  await runTscBaselineGate({
    root: ROOT,
    tscCommand: TSC_COMMAND,
    preTscCommand: TSC_PREFLIGHT_COMMAND,
    baselineFile,
    label: 'operator-core',
    argv,
    countField: 'operatorCoreErrorCount', // legacy field name — preserved for back-compat
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    // Never let a crash read as a pass: this gate's whole job is refusing to report clean when
    // it did not actually judge anything.
    console.error(err);
    process.exit(1);
  });
}
