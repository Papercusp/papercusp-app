#!/usr/bin/env node
/**
 * typecheck (apps/operator) — the SAME per-file baseline gate as `lint:tsc` (operator-core),
 * `lint:tsc:operator-vite`, and `lint:tsc:orchestrator` (EI-847), pointed at apps/operator.
 *
 * EI-19312097806511163: apps/operator's ~611 TS sources were typechecked by NOTHING routine —
 * `lint:tsc` covers packages/operator-core only, `test:affected` is esbuild/Vitest and
 * type-blind by construction, and the operator-vite SPA build (the closest thing apps/operator
 * has to a gate leg today) transpiles via esbuild/rolldown without full type-checking. A
 * strict ZERO gate was not available here (611 pre-existing errors), so — matching the
 * orchestrator precedent — a BASELINE is the right instrument: any file above its recorded
 * count reds the gate, and `--update` can only ratchet the debt down, never raise it.
 *
 * ⚠ NOT YET A GATE LEG. This script exists so an agent CAN typecheck their apps/operator edit
 * (`-- --files=...`) and so the debt has a tracked ratchet instead of drifting silently forever
 * — but it is NOT wired into green-checkpoint.ts's release gate (deliberately, this pass):
 * `lint:tsc:operator-vite` and `lint:tsc:orchestrator` were found to ALSO not be wired into the
 * gate despite existing as scripts (their sibling doc comments implied otherwise), which is a
 * wider, separate finding filed as EI-19375134577577530 rather than folded in here — actually
 * wiring three new legs into the release gate on a shared, heavily-parallel tree is a much
 * higher-blast-radius change than adding the ratchet mechanism itself, and deserves its own
 * careful, reviewed pass.
 *
 * Usage:
 *   npm run lint:tsc:operator              # any file above its baseline fails, named
 *   npm run lint:tsc:operator -- --files=a.ts,b.ts   # scope to the files you edited
 *   npm run lint:tsc:operator -- --update  # lower each improved file's baseline (never raises)
 *
 * ⚠ Do NOT use `--mine` on this tree: it infers "your" files from `git status`, and this repo has
 * ONE working tree shared by the whole fleet with every agent's edits unstaged until the next
 * git-sync tick, so `--mine` means "dirty in the tree" — yours AND every peer's
 * (EI-18731016038876755). `--files` is the only form whose attribution is trustworthy here.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTscBaselineGate } from './lib/tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'apps/operator/.tsc-baseline.json');

// `--incremental false` for the same reason as operator-core's TSC_COMMAND (EI-487): a warm
// tsconfig.tsbuildinfo can under-report errors in affected-but-not-yet-reindexed files, which
// would silently ratchet a file's baseline down on `--update` and false-red a later fresh run.
/** @type {string} */
export const TSC_COMMAND = 'npx tsc -p apps/operator/tsconfig.json --noEmit --incremental false';

// WI-2141049 — apps/operator consumes tracked `.d.mts` companions GENERATED from its own `.mjs`
// modules (9 of `tsconfig.declarations.json`'s inputs live under apps/operator, with 13 TS
// importers inside this project: psu-pty-host, psu-launcher, ptool, operator-discovery). Without
// this preflight, the FIRST typecheck after any `.mjs` export change measures the stale committed
// declaration and attributes the resulting phantoms to the caller — measured 2026-09-02 as 14
// phantom errors (11x TS2554 "Expected 2 arguments, but got 1", 3x TS2353 "'agent' does not exist
// in type '{ capBytes?: number }'") against a signature change that was already correct, reported
// as `status=regressed`. operator-core's leg has carried this guard since EI-21441555291852229;
// this leg owns 3x more generated inputs than that one and was missing it, so the trap stayed
// armed exactly where these modules actually live. Costs ~5s against a ~150s compile.
//
// ⚠ NOT the tsbuildinfo. That was this bug's first, WRONG diagnosis: `--incremental false` above
// is honoured (tsc 7.0.2 `--showConfig` resolves `incremental:false`, and the run writes no
// buildinfo), and a warm cache was measured to produce a byte-identical diagnostic set. The
// variable that actually moved was the regenerated `.d.mts`.
/** @type {string} */
export const TSC_PREFLIGHT_COMMAND = 'npm run gen:declarations';

// Cross-package files this gate MEASURES but does not OWN (EI-18649014117371738), mirroring
// lint-tsc-operator-vite.mjs's FOREIGN_BASELINES: apps/operator's type graph pulls
// packages/operator-core in transitively via the `@papercusp/operator-core` path alias, so a
// real share of this baseline's entries live there. Pointing at the OWNING package's baseline
// (rather than duplicating those counts here under a second, independently-drifting record)
// makes `lint:tsc` (operator-core) and `lint:tsc:operator` agree by construction on the same
// file instead of two hand-maintained baselines happening to stay in sync.
const FOREIGN_BASELINES = [
  {
    prefix: 'packages/operator-core/',
    baselineFile: resolve(ROOT, 'packages/operator-core/.tsc-baseline.json'),
    label: 'operator-core',
  },
];

const USAGE = `Usage:
  npm run lint:tsc:operator              # any file above its baseline fails, named
  npm run lint:tsc:operator -- --files=a.ts,b.ts   # scope to the files you edited
  npm run lint:tsc:operator -- --update  # lower each improved file's baseline (never raises)
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
    label: 'operator',
    argv,
    foreignBaselines: FOREIGN_BASELINES,
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
