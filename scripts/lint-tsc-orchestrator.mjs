#!/usr/bin/env node
/**
 * typecheck (libs/papercusp/packages/orchestrator) — the SAME per-file baseline gate as
 * `lint:tsc` (operator-core) and `lint:tsc:operator-vite` (EI-847), pointed at the orchestrator.
 *
 * WI-6826: this package's 157 TS sources were typechecked by NOTHING — no tsconfig meant
 * `build:typecheck` refused it with project_not_found, `lint:tsc` covers only
 * packages/operator-core, and vitest transforms via esbuild without ever typechecking. Adding
 * the tsconfig surfaced 61 errors, so a strict ZERO gate (what the seven CLEAN sibling packages
 * got under EI-19302566985147894 / EI-19305781578043773) was not available here: a
 * permanently-red gate is one nobody can honour, which is why libs/papercusp/packages/cli was
 * deliberately left with a tsconfig but NO script rather than wired red.
 *
 * The split is what makes a baseline the right instrument here rather than a concession:
 *   - PRODUCTION SOURCE is at a strict ZERO (the 2 real errors, both `readonly string[]`
 *     variance at parseBlueprintLocalRoots call sites, were FIXED in the same change).
 *   - The recorded debt is 59 errors in 11 TEST files — stale fixtures that drifted when the
 *     types they construct gained required fields (`BuildPromptInput` wants promptOverride /
 *     cwdOverride / featureId) or a helper's arity changed ("Expected 1 arguments, but got 2").
 * So the baseline tolerates KNOWN stale test fixtures while any NEW error — in src or test —
 * reds the gate, and `--update` can only ratchet the debt down.
 *
 * Usage:
 *   npm run lint:tsc:orchestrator              # any file above its baseline fails, named
 *   npm run lint:tsc:orchestrator -- --files=a.ts,b.ts   # scope to the files you edited
 *   npm run lint:tsc:orchestrator -- --update  # lower each improved file's baseline (never raises)
 *
 * ⚠ Do NOT use `--mine` on this tree: it infers "your" files from `git status`, and this repo has
 * ONE working tree shared by the whole fleet with every agent's edits unstaged until the next
 * git-sync tick, so `--mine` means "dirty in the tree" — yours AND every peer's
 * (EI-18731016038876755). `--files` is the only form whose attribution is trustworthy here.
 *
 * Also wired as the package's own `npm run typecheck`, so the fleet-brief
 * `npm run typecheck --if-present` idiom (EI-6479) reaches it.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTscBaselineGate } from './lib/tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = resolve(ROOT, 'libs/papercusp/packages/orchestrator/.tsc-baseline.json');

// `--incremental false` for the same reason as operator-core's TSC_COMMAND (EI-487): a warm
// tsconfig.tsbuildinfo can under-report errors in affected-but-not-yet-reindexed files, which
// would silently ratchet a file's baseline down on `--update` and false-red a later fresh run.
/** @type {string} */
export const TSC_COMMAND =
  'npx tsc -p libs/papercusp/packages/orchestrator/tsconfig.json --noEmit --incremental false';

async function main() {
  await runTscBaselineGate({
    root: ROOT,
    tscCommand: TSC_COMMAND,
    baselineFile,
    label: 'orchestrator',
    argv: process.argv.slice(2),
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
