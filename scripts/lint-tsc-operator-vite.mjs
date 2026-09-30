#!/usr/bin/env node
/**
 * typecheck (operator-vite) — the SAME per-file baseline gate as `lint:tsc` (operator-core),
 * pointed at apps/operator-vite instead.
 *
 * EI-847: a raw `tsc -p apps/operator-vite/tsconfig.json --noEmit` floods with hundreds of
 * PRE-EXISTING errors from files transitively imported into the SPA's type graph (native-module
 * ambient-type gaps in packages/operator-core's p2p/hyperbee layer, a few genuine unrelated
 * bugs elsewhere) — an agent editing ONE operator-vite component gets no clean signal for
 * their own file and has to `| grep MyComponent` and hope nothing cascades. This is exactly the
 * problem `scripts/lint-tsc.mjs` already solved for operator-core (P-010/WI-4535): gate each
 * file against its OWN baseline, name regressions, and use `--mine` to scope the check to files
 * you actually changed. See `scripts/lib/tsc-baseline-gate.mjs` for the shared policy.
 *
 * Usage:
 *   npm run lint:tsc:operator-vite              # any file above its baseline fails, named
 *   npm run lint:tsc:operator-vite -- --mine    # only fail on regressions in files YOU changed
 *   npm run lint:tsc:operator-vite -- --update  # lower each improved file's baseline (never raises)
 *
 * Also wired as `apps/operator-vite`'s own `npm run typecheck` (replacing the old raw
 * `tsc --noEmit`), so the fleet-brief `npm run typecheck --if-present` idiom (EI-6479) gets a
 * clean, attributable signal there too instead of a flood.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTscBaselineGate } from './lib/tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'apps/operator-vite/.tsc-baseline.json');

// `--incremental false` for the same reason as operator-core's TSC_COMMAND (EI-487): a warm
// tsconfig.tsbuildinfo can under-report errors in affected-but-not-yet-reindexed files, which
// would silently ratchet a file's baseline down on `--update` and false-red a later fresh run.
/** @type {string} */
export const TSC_COMMAND =
  'npx tsc -p apps/operator-vite/tsconfig.json --noEmit --incremental false';

/**
 * A baseline owned by another package that this gate reads rather than maintains.
 *
 * @typedef {object} ForeignBaseline
 * @property {string} prefix - Repo-relative path prefix the owning package covers.
 * @property {string} baselineFile - Absolute path to that package's `.tsc-baseline.json`.
 * @property {string} [label] - Display name for the owning package, if it differs from `prefix`.
 */

/**
 * Cross-package files this gate MEASURES but does not OWN (EI-18649014117371738).
 *
 * The SPA's type graph pulls packages/operator-core in transitively, so ~27 of this baseline's
 * entries live there — deliberately covered, not ignored. But the two baselines were captured days
 * apart under DIFFERENT tsconfigs, so an operator-core file could be recorded (and tolerated) in
 * operator-core's baseline yet be ABSENT from this one, where absent⇒0 turned it into a phantom
 * regression: `lint:tsc` passed and `lint:tsc:operator-vite` failed on the SAME untouched file.
 * Pointing at the OWNING package's baseline makes the two gates agree by construction rather than
 * by two hand-maintained files happening to stay in sync.
 *
 * @type {ForeignBaseline[]}
 */
export const FOREIGN_BASELINES = [
  {
    prefix: 'packages/operator-core/',
    baselineFile: resolve(ROOT, 'packages/operator-core/.tsc-baseline.json'),
    label: 'operator-core',
  },
];

async function main() {
  await runTscBaselineGate({
    root: ROOT,
    tscCommand: TSC_COMMAND,
    // The gate calls this CLI directly, bypassing the app's pretypecheck hook.
    // A cold judging checkout has no Vite server to create FileRoutesByPath.
    // Reuse the runner's fail-closed preflight and the app's existing generator.
    preTscCommand: 'node apps/operator-vite/scripts/generate-route-tree.mjs',
    baselineFile,
    label: 'operator-vite',
    argv: process.argv.slice(2),
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
