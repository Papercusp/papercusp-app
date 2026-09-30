#!/usr/bin/env node
/**
 * typecheck fan-out over every `libs/papercusp` workspace that declares a `typecheck` script.
 *
 * WI-6841: eight libs/papercusp packages had earned a typecheck gate one at a time
 * (libs/db, packages/{file-claim, blueprint-distribution, harness, harness/docs-viewer,
 * locks}, plugins/gitnexus-bridge at a strict zero; packages/orchestrator on a per-file
 * baseline, WI-6826) — and NOTHING EXECUTED ANY OF THEM. `test:affected` is type-blind by
 * design (esbuild/Vitest never typechecks), `lint:tsc` resolves to packages/operator-core
 * alone, and `libs/papercusp/package.json` has no typecheck equivalent to `build`/`test
 * --workspaces`. So a type regression anywhere under libs/papercusp surfaced NOWHERE: the
 * gates existed, passed when run by hand, and gated nothing.
 *
 * ⚠ This script alone does NOT fix that — a fan-out nobody calls has the identical defect one
 * level up, which is the whole trap WI-6841 exists to avoid. It is wired as a POST-SUITE LEG in
 * `runPostSuiteLegs` (apps/operator/lib/release/green-checkpoint.ts), immediately after the
 * operator-core typecheck leg. The leg is what gives this teeth; keep them wired together.
 *
 * Cost (measured 2026-08-02 through `capability:bash` at load 107, uncoalesced):
 * orchestrator 6.4s (the largest, 157 files) · gitnexus-bridge 3.4s · blueprint-distribution
 * 2.7s · locks 1.9s · file-claim 1.6s · harness 1.6s · libs/db 15.1s. **≈33s total against a
 * ~55min suite (~1%).** One aggregating leg, not eight, keeps the failure block readable and
 * pays the pc-heavy admission toll once.
 * ⚠ Do NOT re-derive that from wall-clock on the dev box: `pc-heavy.sh`'s WI-3821 admission
 * gate QUEUES under load, so wall-clock = queue + execution and the queue is wildly variable
 * (the same orchestrator run read 6.4s and, minutes earlier, hit a 10-minute timeout).
 *
 * DISCOVERY, not a hardcoded list. A new libs/papercusp package that adds a `typecheck`
 * script is gated the moment it lands — a hardcoded roster would reproduce the exact
 * silently-not-gated defect this item is about, one level further down.
 *
 * ⚠ SCOPE: this covers the libs/papercusp SUBMODULE only. The superproject roots — apps/*,
 * packages/*, libs/generic/* — are covered by its sibling `lint:tsc:workspaces`
 * (scripts/lint-tsc-workspaces.mjs, WI-7155/EI-19376779013716004), which shares this script's
 * machinery via scripts/lib/typecheck-fanout.mjs. Keep the two roots disjoint: covering a
 * package twice doubles its compile and reports one regression as two.
 *
 * Usage:
 *   npm run lint:tsc:papercusp-libs           # every discovered package; any failure reds
 *   npm run lint:tsc:papercusp-libs -- --list # discovery only, run nothing (what IS gated?)
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discover, looksOom, realSpawn, runOne, runPackages } from './lib/typecheck-fanout.mjs';
import {
  parseExplicitFiles,
  partitionFilesByCoverage,
  formatLintTscResultMarker,
} from './lib/tsc-baseline-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIBS_ROOT = join(REPO_ROOT, 'libs', 'papercusp');

// Re-exported so this module stays the stable import surface for its own test and for any
// caller that already depends on it; the implementations now live in the shared core, which is
// what keeps this fan-out and lint-tsc-workspaces.mjs from drifting apart.
export { discover, looksOom, runOne };

/**
 * THE gated-set selection — the single source of truth for "what does this leg compile?".
 *
 * ⚠ EXTRACTED SO IT HAS EXACTLY ONE IMPLEMENTATION (EI-19462776655300160). Both `main()` (which
 * RUNS the set) and `GATE_COVERAGE` (which DECLARES it to the sibling-gate resolver) read it from
 * here, so the resolver's view of this leg and what the leg actually does are the same fact rather
 * than two facts that agree until someone edits one. Drift would fail in the DANGEROUS direction:
 * over-claimed coverage routes an agent to a gate that silently skips their file.
 *
 * Pure: it decides, it never prints. `present: false` is the legitimate submodule-absent opt-out
 * (a subject hive, an uninitialised checkout) and is DISTINCT from "present but gating nothing",
 * which `main()` treats very differently — see its `packages.length === 0` branch.
 *
 * @param {{libsRoot?: string, relativeTo?: string}} [opts]
 * @returns {{present: boolean, packages: any[], unreadable: any[]}}
 */
export function selectGatedPackages({ libsRoot = LIBS_ROOT, relativeTo = REPO_ROOT } = {}) {
  if (!existsSync(join(libsRoot, 'package.json'))) {
    return { present: false, packages: [], unreadable: [] };
  }

  const discovered = discover(libsRoot, 0, relativeTo);
  return {
    present: true,
    packages: discovered.filter((p) => !p.unreadable).sort((a, b) => a.rel.localeCompare(b.rel)),
    unreadable: discovered.filter((p) => p.unreadable),
  };
}

/**
 * The repo-relative prefixes this leg really compiles, for the sibling-gate resolver in
 * scripts/lib/tsc-baseline-gate.mjs (EI-19462776655300160).
 *
 * A THUNK, not a constant: this leg's coverage is DISCOVERED, so it cannot be written down. It
 * delegates to `selectGatedPackages` rather than restating the selection.
 *
 * An ABSENT submodule correctly yields `[]` — this leg then covers nothing, which is true. The
 * resolver reads an empty list as "declares nothing parseable" and files this gate under
 * `unresolved`, so a stale/uninitialised pin degrades to "none FOUND" rather than to a false
 * claim in either direction.
 *
 * ⚠ Walks the filesystem, so it is not free and it CAN throw on a broken tree. Its consumer
 * (`coveragePrefixesFromGateModule`) treats a throw as "this gate is unresolved", never as
 * "this gate covers nothing".
 *
 * @returns {string[]} Repo-relative directory prefixes, trailing slash.
 */
export const GATE_COVERAGE = () => selectGatedPackages().packages.map((p) => `${p.rel}/`);

/**
 * WI-39727 — `--files=` is a VERDICT SCOPE here, exactly as it is for every sibling gate.
 *
 * It used to be accepted and completely ignored: this leg fanned out over all 8 packages and
 * reported a whole-project verdict, so `--files=packages/not-a-real-workspace/src/synthetic.ts`
 * printed "8 passed, 0 failed" and exited 0. A caller who scoped to their edit got a green that
 * said nothing about the paths they named.
 *
 * The sibling gates inherit this partitioning free from `runTscBaselineGate`; this leg has a
 * different architecture and never calls it, so it is wired here explicitly against the SAME
 * shared helpers rather than reimplemented — the two must not drift.
 *
 * Coverage is DISCOVERED (see `selectGatedPackages`), so the prefixes are the discovered
 * packages' own directories. A named file under one of them selects that package; a named file
 * under none of them is `uncovered` and is reported as such instead of being silently absorbed
 * into a whole-project pass.
 *
 * @param {{packages: any[], files: Set<string> | null}} input
 * @returns {{selected: any[], uncovered: string[]}}
 */
export function selectByExplicitFiles({ packages, files }) {
  if (!files) return { selected: packages, uncovered: [] };

  const { covered, uncovered } = partitionFilesByCoverage({
    files,
    coveredPrefixes: packages.map((p) => `${p.rel}/`),
  });
  const selected = packages.filter((p) => covered.some((f) => f.startsWith(`${p.rel}/`)));
  return { selected, uncovered };
}

export function main({
  libsRoot = LIBS_ROOT,
  relativeTo = REPO_ROOT,
  argv = process.argv,
  listOnly = argv.includes('--list'),
  spawn = realSpawn,
  log = console.log,
  warn = console.warn,
  error = console.error,
} = {}) {
  const explicitFiles = parseExplicitFiles(argv);
  const { present, packages, unreadable } = selectGatedPackages({ libsRoot, relativeTo });

  /**
   * EI-19395061642732083's completion marker, which this leg never emitted (WI-39727 defect 2).
   * Its contract is "marker ABSENT => the run did not finish; the output is UNMEASURED, not
   * clean", so the established consumer idiom could not tell this gate's normal successful run
   * from a killed one — while the caller's other signal, exit 0, said clean.
   *
   * Deliberately NOT emitted on the three branches that measure nothing (`--list`, submodule
   * absent, zero packages declaring a script). For those, "absent" is the accurate reading; a
   * marker there would read `status=clean` and claim a coverage that did not happen — the very
   * false green this item is about. Each of those branches already says so in prose.
   */
  const finish = (code, { filesUnchecked = 0, nothingTypechecked = false } = {}) => {
    log(
      formatLintTscResultMarker({
        label: 'papercusp-libs',
        scope: explicitFiles ? 'files' : 'all',
        code,
        nothingTypechecked,
        filesUnchecked,
      }),
    );
    return code;
  };

  // The submodule genuinely absent (a subject hive, an uninitialised checkout) is a legitimate
  // opt-out — there is nothing to gate. Distinct from "present but gating nothing" below.
  if (!present) {
    log('libs/papercusp not present in this tree — nothing to typecheck.');
    return 0;
  }

  for (const p of unreadable) {
    error(`✗ ${p.rel}: package.json exists but could not be parsed — ${p.unreadable}`);
  }

  log(`libs/papercusp typecheck fan-out — ${packages.length} package(s) declare a typecheck script:`);
  for (const p of packages) log(`  · ${p.rel}`);

  if (listOnly) return unreadable.length > 0 ? 1 : 0;

  // Present but gating NOTHING must never be reported as a pass — but it must not RED the
  // release gate either, and that distinction was worth getting right. `libs/papercusp` is a
  // git SUBMODULE: the candidate tree checks it out at the superproject's PINNED commit, which
  // can legitimately predate the typecheck scripts (the live papercup-checkpoint tree, pinned
  // Jul 2, declares ZERO of them). Reddening here would hold `main` for the WHOLE FLEET on a
  // stale pin — "a condition no commit caused", which is precisely what the WI-6768 adoption
  // probe was made report-only to avoid.
  //
  // So the anti-silent-un-gating protection lives where it cannot hold the fleet hostage: a
  // WARN here (never a silent green — the operator log says the gate covered nothing), plus a
  // test asserting the REAL tree still declares them (lint-tsc-papercusp-libs.test.ts). A
  // genuine removal reds a TEST at development time; a stale submodule pin just warns.
  //
  // ⚠ Its sibling lint-tsc-workspaces.mjs FAILS in the same situation rather than warning. The
  // asymmetry is deliberate, not an inconsistency: those roots are in the superproject and
  // always contain packages, so discovering none there means discovery itself broke.
  if (packages.length === 0) {
    warn(
      '\n⚠ libs/papercusp is present but NO package declares a `typecheck` script — this run\n' +
        '  gated NOTHING. Not failing the release (the submodule pin may simply predate the\n' +
        '  scripts), but this is NOT evidence that libs/papercusp typechecks. If the scripts were\n' +
        '  removed or moved, restore them / update discovery in scripts/lib/typecheck-fanout.mjs.',
    );
    return 0;
  }

  const { selected, uncovered } = selectByExplicitFiles({ packages, files: explicitFiles });

  // Every named file lies outside this leg's coverage: it compiled none of them and has NO
  // VERDICT TO GIVE. Reporting that as a pass is the filed defect — a whole-project green
  // standing in for files this gate never looked at. Same contract as the sibling gates'
  // all-uncovered branch: fatal, and marked `status=out-of-scope` so the machine-readable token
  // cannot be misread as a regression the caller must hunt.
  if (explicitFiles && selected.length === 0) {
    error(
      `\n✗ none of the ${uncovered.length} file(s) you named is under a libs/papercusp package` +
        ` that declares a typecheck script — this leg checked NOTHING.\n` +
        `  Named: ${uncovered.join(', ')}\n` +
        `  Covered prefixes: ${packages.map((p) => `${p.rel}/`).join(', ')}\n` +
        `  (Use \`--list\` to see what this gate covers, or run the gate that owns your path.)`,
    );
    return finish(1, { filesUnchecked: uncovered.length, nothingTypechecked: true });
  }

  if (uncovered.length > 0) {
    // ⚠ This text must never contain the literal marker token a consumer greps for. The
    // established idiom is a SUBSTRING grep over this gate's whole output, so spelling the
    // full-coverage token here — even inside prose explaining that it does not apply — makes a
    // partial run match it. Measured while verifying this very change: the run below reported
    // `status=partial`, and an earlier draft of this warning still made the grep hit.
    warn(
      `\n⚠ ${uncovered.length} of the file(s) you named are outside this leg's coverage and were` +
        ` NOT typechecked: ${uncovered.join(', ')}\n` +
        `  The verdict below covers only the selected package(s) — the completion marker reports` +
        ` a PARTIAL run, not a full-coverage one.`,
    );
  }

  const { failed } = runPackages({ packages: selected, label: 'libs/papercusp', unreadableCount: unreadable.length, spawn, log, warn, error });
  return finish(failed.length > 0 || unreadable.length > 0 ? 1 : 0, {
    filesUnchecked: uncovered.length,
  });
}

// Only run when invoked as a CLI — the test imports the pure pieces above, and a module-level
// process.exit() would tear the test runner down on import (same pattern as lint-tsc.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
