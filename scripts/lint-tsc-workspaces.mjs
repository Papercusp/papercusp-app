#!/usr/bin/env node
/**
 * typecheck fan-out over the SUPERPROJECT workspace roots — apps/*, packages/*, libs/generic/*.
 *
 * WI-7155 / EI-19376779013716004. `lint:tsc` resolves to packages/operator-core alone and
 * `test:affected` is type-blind by design (esbuild/Vitest strip types without checking), so a
 * type-only regression anywhere else in the superproject surfaced NOWHERE. WI-6841 fixed exactly
 * this for the libs/papercusp submodule; this is the same fix for the roots it did not cover.
 * The shared machinery lives in scripts/lib/typecheck-fanout.mjs — reused, not reimplemented.
 *
 * TWO POPULATIONS, TWO TREATMENTS — the distinction is the whole point:
 *
 *   1. GATED (blocking). Packages that declare a `typecheck` script. Discovery, not a roster:
 *      a new package that declares one is gated the moment it lands.
 *
 *   2. INVISIBLE (report-only). Directories with a tsconfig.json but NO `typecheck` script.
 *      The WI-6841 fan-out cannot reach these by construction — its discovery is by OPT-IN, so
 *      a package that never opts in is not "passing", it is unreachable, and nothing anywhere
 *      says so. Reporting them is what turns the ABSENCE of a gate into a finding rather than
 *      silence. 61 as of 2026-08-02 across these three roots; NOT blocking, deliberately (see
 *      below). The live count is printed on every run — trust THAT over this comment.
 *
 * WHY GATING IS SAFE TO TURN ON HERE, measured before wiring — the prerequisite the orchestrator
 * leg set for itself (green-checkpoint.ts:3929), because a leg that reds the moment it is added
 * blocks the whole fleet:
 *   - 8 of the 9 newly-covered packages are at a STRICT ZERO (measured 2026-08-02: all six
 *     libs/generic/* workspaces, apps/operator-public, packages/omp-plugin). No baseline to
 *     drift into, no cross-package baseline inheritance of the kind that makes the operator-vite
 *     gate name files the author never opened (EI-18649014117371738).
 *   - Those zeros are NOT vacuous — `tsc --listFiles` shows 78 real in-package files loaded
 *     across them. Re-verify that way, never from a "0 errors" summary line, which reads exactly
 *     the same whether it checked 78 files or none (WI-6826's lesson).
 *   - The CHECKPOINT TREE genuinely contains what this leg checks — sources AND node_modules are
 *     present there for every gated package (verified against papercusp-checkpoint 2026-08-02).
 *     A leg pointed at a tree missing its sources passes vacuously FOREVER.
 *   - The 9th, apps/papercusp-publish, carries 14 committed errors and is EXEMPTED below with
 *     its filed id — printed every run, asserted by a test, so it cannot go quiet.
 *
 * WHY THE INVISIBLE SET IS NOT BLOCKING: 61 directories have never been typechecked by anything.
 * Making their absence fatal in the same change that first measures it would red-pin the shared
 * green-checkpoint for the entire fleet — inflicting, with its own fix, precisely the failure
 * this work exists to prevent. Blocking is a later, separate, ratcheted step once the real error
 * counts behind those 61 are known. Report first.
 *
 * Usage:
 *   npm run lint:tsc:workspaces                     # gate the discovered packages
 *   npm run lint:tsc:workspaces -- --files=path.ts  # compile only the owning workspace
 *   npm run lint:tsc:workspaces -- --list           # discovery only, run nothing (what IS gated?)
 *   npm run lint:tsc:workspaces -- --list-invisible # name every invisible dir, not just counts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { orderByDependencies } from '@papercusp/dependency-order';
import { discover, discoverInvisible, realSpawn, runPackages } from './lib/typecheck-fanout.mjs';
import { resolvePinnedTscBin } from './lib/tsc-baseline-gate.mjs';
import { parseFilesArgs } from './lib/explicit-files.mjs';
export { parseFilesArgs } from './lib/explicit-files.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The superproject roots. `libs/papercusp` is deliberately ABSENT: it is a git submodule with its
 * own leg (`lint:tsc:papercusp-libs`) and its own stale-pin semantics. Covering it twice would
 * double every compile and report one regression as two.
 *
 * ⚠ THE ROOT IS `libs`, NOT `libs/generic` (EI-20549967837064185). Naming the SUBDIRECTORY made
 * the walk structurally blind to every OTHER libs/* workspace: nine of them — including
 * `libs/flags`, the feature-flag SSOT, and `libs/papercusp-shared` (imported by 51 files) — were
 * covered by no gate at all, and were not even reported as invisible, because a root that is
 * never scanned cannot produce a finding. That is the failure mode this whole leg exists to
 * prevent, reproduced one level up: a hole in the ROOT LIST is invisible in exactly the way a
 * hole in a package roster is, and it is worse, because the invisible-set report — the mechanism
 * that turns "no gate" into a finding — is itself scoped to the roots.
 *
 * Widening to `libs` keeps discovery total: a new `libs/<anything>` is walked the day it lands,
 * with no list to remember to update. Disjointness from the sibling submodule gate is preserved
 * by SIBLING_GATE_PREFIXES below, which is enforced against the SELECTION rather than against
 * this array's spelling — a string check on this constant cannot see a root that reaches
 * libs/papercusp by descent.
 */
export const DEFAULT_ROOTS = ['apps', 'packages', 'libs'];

/**
 * Repo-relative prefixes this leg walks INTO but must never SELECT, because another gate already
 * compiles them (EI-20549967837064185).
 *
 * `libs` contains `libs/papercusp`, a git submodule owned by `lint:tsc:papercusp-libs`. Excluding
 * it HERE — on the selection, by prefix — rather than by keeping the root narrow is what lets the
 * root stay wide enough to be total. The two mechanisms fail differently and that is the point:
 * a narrow root silently drops whatever it does not name, while an explicit exclusion is printed
 * on every run and is asserted by a test, so it cannot go quiet.
 *
 * @type {string[]}
 */
export const SIBLING_GATE_PREFIXES = ['libs/papercusp'];

/** True when `rel` is owned by a sibling gate (see SIBLING_GATE_PREFIXES). */
export const ownedBySiblingGate = (rel, prefixes = SIBLING_GATE_PREFIXES) =>
  prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));

/** Select only the gated workspace(s) that own the requested repo-relative files. */
export function selectPackagesForFiles(packages, files) {
  if (!files?.length) return { packages, unmatched: [] };
  const selected = new Map();
  const unmatched = [];
  for (const file of files) {
    const owners = packages
      .filter((pkg) => file === pkg.rel || file.startsWith(`${pkg.rel}/`))
      .sort((a, b) => b.rel.length - a.rel.length);
    const owner = owners[0];
    if (!owner) unmatched.push(file);
    else selected.set(owner.rel, owner);
  }
  return { packages: [...selected.values()].sort((a, b) => a.rel.localeCompare(b.rel)), unmatched };
}

/**
 * Roots where a bare `tsconfig.json` is enough to be GATED, with no `typecheck` script
 * (EI-19409185011887864).
 *
 * Deliberately NOT all of DEFAULT_ROOTS. Promotion makes a directory BLOCKING, so a root
 * earns a place here only once every package under it has actually been RUN and the ones
 * that fail are enumerated in UNTYPECHECKABLE. Adding a root on the assumption that it is
 * probably clean is how a gate goes red for a condition no commit caused: measured
 * 2026-08-03, `apps/` promoted unmeasured would have red-pinned the fleet gate on
 * apps/operator alone (hundreds of pre-existing errors, incl. an entire implicit-any test
 * file). Report-only is the correct state for an unmeasured root — it is visible, and it
 * is honest about what has been verified.
 */
export const PROMOTE_ROOTS = ['libs'];

/*
 * WIDENED FROM 'libs/generic' TO 'libs' ON 2026-08-15 (EI-20549967837064185), and the promotion
 * discipline above was honoured, not skipped: every libs/* workspace root outside libs/generic
 * was RUN first, with `node_modules/.bin/tsc --noEmit -p tsconfig.json` in each package dir —
 * the same command `promoted` issues — before this root was widened.
 *
 * MEASURED 2026-08-15, nine workspace roots:
 *   libs/host-platform 0 · libs/test-config 0 · libs/testing-shell 0   (already clean)
 *   libs/flags 46 -> 0            37 of the 46 were one missing `"node"` in tsconfig `types`;
 *                                 the SSOT compiles clean, so it is gated rather than held back
 *   libs/papercusp-db 0 · libs/papercusp-publish-auth 17 -> 0          (no tsconfig existed at
 *   libs/papercusp-shared 4 · libs/agent-chat 9                         all; one was written for
 *                                 each — a package with .ts sources and NO tsconfig is invisible
 *                                 even to the invisible-set report, which keys on tsconfig.json)
 *   libs/marketplace-public-ui 6
 * The three that failed at widening were held BY NAME in UNTYPECHECKABLE with those counts;
 * all three are now clean and gated, so the map below is empty.
 */

/**
 * One deliberate exclusion from this leg.
 *
 * @typedef {object} Exemption
 * @property {string} reason   short machine-ish tag, e.g. 'already-a-leg' | 'committed-errors'
 * @property {string} detail   why, in prose — printed verbatim on every run
 * @property {string} filedAs  the id/pointer that says how this exemption ENDS
 */

/**
 * Directories with a tsconfig.json that do NOT currently typecheck clean, so gating them on
 * that tsconfig (see `promoted` below) would red the fleet gate on a pre-existing condition
 * no commit caused.
 *
 * Held back BY NAME, never by a silent predicate. Every entry carries its MEASURED error count
 * and a filed id, is printed on every run, and disappears the moment the package is clean —
 * removing an entry is the entire fix. This is the same discipline as EXEMPT above: it decides
 * who is EXCLUDED, so a package that stops being listed becomes gated automatically rather than
 * silently staying dark.
 *
 * EMPTY IS THE GOAL STATE, AND IT IS THE CURRENT ONE — do not read the empty object as an
 * unused mechanism and delete it. Measured 2026-08-03 via `npx tsc --noEmit -p tsconfig.json`
 * in each of the 50 previously un-gated libs/generic packages: 46 were clean and were gated
 * that day; the remaining 6 (two papergrid packages surfaced later, once a TS5101 baseUrl
 * error stopped masking their compile) were held back here and are now ALL FIXED and gated —
 * 20 measured errors driven to 0 under EI-19409888189789017.
 *
 * So every libs/generic package with a tsconfig is now BLOCKING. The next package that fails
 * belongs here, with its measured count and a filed id, for exactly as long as it takes to
 * fix — that is what this map is for. Adding an entry is how a red package stays VISIBLE
 * instead of silently ungated; removing it is the entire fix.
 *
 * @type {Record<string, { detail: string, errors: number, filedAs: string }>}
 */
export const UNTYPECHECKABLE = {
};

/**
 * Packages that declare a `typecheck` script but are deliberately NOT run by THIS leg.
 *
 * This is a narrow, visible exception list — NOT the hardcoded roster the discovery above exists
 * to avoid. The difference that matters: a roster decides who IS gated (so anything missing is
 * silently ungated, the original bug), whereas this decides who is EXCLUDED, is printed in full
 * on every single run, and is asserted by a test. An entry cannot go quiet, and every entry
 * carries a filed id that says how it ends.
 *
 * ⚠ THE `@type` BELOW IS LOAD-BEARING, AND IT MUST STAY ADJACENT TO THE DECLARATION.
 * Without it, tsc infers a CLOSED object type from this literal's three keys, `gen:declarations`
 * emits that closed type into lint-tsc-workspaces.d.mts, and every caller that passes a partial
 * or empty exempt map starts failing TS2739 "Type {} is missing the following properties" — the
 * `exempt` parameter of `main()` below takes its type from the `exempt = EXEMPT` default, so the
 * blast radius is every caller, not just this constant.
 *
 * That is not hypothetical: this docblock was once separated from its declaration by the
 * UNTYPECHECKABLE insert above, which orphaned the annotation and put 11 committed tsc errors
 * into lint-tsc-workspaces.test.ts — a file nobody had touched — reding the fleet gate. A JSDoc
 * `@type` binds to the NEXT declaration, so inserting anything between the two silently drops it.
 *
 * @type {Record<string, Exemption>}
 */
export const EXEMPT = {
  'packages/operator-core': {
    reason: 'already-a-leg',
    detail:
      "its `typecheck` delegates to scripts/lint-tsc.mjs, which green-checkpoint already runs as " +
      'the `lint:tsc` post-suite leg. Running it here would repeat a ~150s compile and report one ' +
      'regression twice.',
    filedAs: 'green-checkpoint.ts runPostSuiteLegs (lint:tsc leg)',
  },
  'apps/operator-vite': {
    reason: 'deliberately-not-gated',
    detail:
      'its `typecheck` delegates to scripts/lint-tsc-operator-vite.mjs, which green-checkpoint ' +
      'deliberately declined to make a leg (green-checkpoint.ts:3944): ~151 baseline entries plus ' +
      'cross-package inheritance make it capable of red-pinning promotion on drift that is not a ' +
      'regression. It stays CI-only until that is settled — this leg must not smuggle it in.',
    filedAs: 'green-checkpoint.ts:3944',
  },
  'apps/papercusp-publish': {
    reason: 'committed-errors',
    detail:
      '14 committed `error TS` lines, all in *.test.ts, from strict + noUncheckedIndexedAccess ' +
      'over untyped vitest mock helpers (measured 2026-08-02). Gating it today would red the ' +
      'shared gate on day one. Clear them and DELETE this entry — that is the whole exit path.',
    filedAs: 'WI-7166',
  },
};

/** Group the invisible set by top-level root, so the report stays readable at ~60 entries. */
export function groupByRoot(entries) {
  const groups = new Map();
  for (const e of entries) {
    const root = e.rel.split('/').slice(0, e.rel.startsWith('libs/generic') ? 3 : 2).join('/');
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  }
  return groups;
}

/**
 * THE gated-set selection — the single source of truth for "what does this leg compile?".
 *
 * ⚠ EXTRACTED SO IT HAS EXACTLY ONE IMPLEMENTATION (EI-19462776655300160). Both `main()` (which
 * RUNS the set) and `GATE_COVERAGE` (which DECLARES it to the sibling-gate resolver) read it from
 * here. A second, hand-maintained mirror of this selection is the drift-prone shape this whole
 * subsystem keeps getting bitten by, and drift would fail in the DANGEROUS direction: over-claimed
 * coverage routes an agent to a gate that silently skips their file — the mirror image of the very
 * bug EI-19461218392796337 fixed. Never re-derive this set anywhere; call this.
 *
 * Pure: it decides, it never prints. Reporting the populations it returns is `main()`'s job, which
 * is what lets `GATE_COVERAGE` reuse it without emitting a word.
 *
 * @param {{repoRoot?: string, roots?: string[], exempt?: Record<string, Exemption>, untypecheckable?: Record<string, {detail: string, errors: number, filedAs: string}>}} [opts]
 * @returns {{presentRoots: string[], absentRoots: string[], packages: any[], promoted: any[], exempted: any[], heldBack: any[], stillInvisible: any[], unreadable: any[], siblingOwned: any[]}}
 */
export function selectGatedPackages({
  repoRoot = REPO_ROOT,
  roots = DEFAULT_ROOTS,
  exempt = EXEMPT,
  untypecheckable = UNTYPECHECKABLE,
} = {}) {
  const presentRoots = roots.filter((r) => existsSync(join(repoRoot, r)));
  const absentRoots = roots.filter((r) => !existsSync(join(repoRoot, r)));

  const discovered = [];
  const invisible = [];
  for (const r of presentRoots) {
    const dir = join(repoRoot, r);
    discovered.push(...discover(dir, 0, repoRoot));
    invisible.push(...discoverInvisible(dir, 0, repoRoot));
  }

  // Drop what a SIBLING gate owns (EI-20549967837064185). The root is `libs`, which contains the
  // `libs/papercusp` submodule that `lint:tsc:papercusp-libs` compiles; selecting it here would
  // double every one of those compiles and report one regression as two. Applied to BOTH walks:
  // leaving it in `invisible` would be just as wrong, since that population is what promotion
  // draws from.
  const ownedElsewhere = (p) => ownedBySiblingGate(p.rel);
  const siblingOwned = [...discovered, ...invisible].filter(ownedElsewhere);
  for (const list of [discovered, invisible]) {
    for (let i = list.length - 1; i >= 0; i -= 1) if (ownedElsewhere(list[i])) list.splice(i, 1);
  }

  const unreadable = discovered.filter((p) => p.unreadable);
  const all = discovered.filter((p) => !p.unreadable).sort((a, b) => a.rel.localeCompare(b.rel));

  // A tsconfig IS the opt-in (EI-19409185011887864). Requiring a `typecheck` SCRIPT made this
  // a roster: 50 of the 53 libs/generic packages never declared one, so they were reported as
  // "unreachable by construction" forever, and every NEW package started out uncovered too.
  // Gating on the tsconfig makes coverage automatic and permanent — the property this fan-out
  // was built for. Measured before flipping it on: 46 of the 50 were already clean, so this
  // enrolled them at zero gate risk. The 6 that were not (two papergrid packages surfaced once
  // a TS5101 baseUrl error stopped masking their compile) were held back BY NAME below and have
  // since ALL been fixed — 20 errors to 0 — so UNTYPECHECKABLE is now empty and every
  // libs/generic package with a tsconfig is blocking.
  //
  // ⚠ SCOPED TO MEASURED ROOTS, and that scope is the whole safety property. Promotion turns a
  // report-only directory into a BLOCKING one, so it may only cover roots where every package
  // has actually been run and the dirty ones enumerated. libs/generic was measured on
  // 2026-08-03 (50 packages: 46 clean, 6 later-fixed). apps/* and packages/* were NOT — flipping
  // them on unmeasured immediately reds the gate (apps/operator alone carries hundreds of
  // errors, incl. a whole implicit-any test file). They stay report-only below until someone
  // measures them the same way and adds their root here.
  const promoted = invisible
    .filter((p) => PROMOTE_ROOTS.some((r) => p.rel.startsWith(`${r}/`)))
    .filter((p) => !exempt[p.rel] && !untypecheckable[p.rel])
    .map((p) => ({
      dir: p.dir,
      name: p.name ?? p.rel,
      rel: p.rel,
      command: ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.json'],
    }));
  const heldBack = invisible.filter((p) => untypecheckable[p.rel]).sort((a, b) => a.rel.localeCompare(b.rel));
  // Still unreachable: a tsconfig under a root nobody has measured yet. Shrinks to zero as
  // roots are measured and added to PROMOTE_ROOTS.
  const stillInvisible = invisible.filter(
    (p) => !untypecheckable[p.rel] && !PROMOTE_ROOTS.some((r) => p.rel.startsWith(`${r}/`)),
  );

  const packages = [...all.filter((p) => !exempt[p.rel]), ...promoted].sort((a, b) => a.rel.localeCompare(b.rel));
  const exempted = all.filter((p) => exempt[p.rel]);

  return {
    presentRoots,
    absentRoots,
    packages,
    promoted,
    exempted,
    heldBack,
    stillInvisible,
    unreadable,
    siblingOwned,
  };
}

/**
 * Replace only direct `npx tsc` fan-out commands with the repository's pinned native CLI.
 * Declared package scripts remain untouched: npm must still supply their package-local cwd/env
 * contract, while the direct promoted-tsconfig path has no reason to depend on an ambient bin.
 *
 * `resolveTscBin` is injectable so the command wiring can be tested against a synthetic tree
 * without manufacturing a node_modules installation inside that fixture.
 */
export function pinDirectTscCommands(
  packages,
  repoRoot,
  resolveTscBin = resolvePinnedTscBin,
) {
  let pinnedBin;
  return packages.map((pkg) => {
    if (pkg.command?.[0] !== 'npx' || pkg.command?.[1] !== 'tsc') return pkg;
    pinnedBin ??= resolveTscBin(repoRoot);
    return {
      ...pkg,
      command: [process.execPath, pinnedBin, ...pkg.command.slice(2)],
    };
  });
}

/**
 * The repo-relative prefixes this leg really compiles, for the sibling-gate resolver in
 * scripts/lib/tsc-baseline-gate.mjs (EI-19462776655300160).
 *
 * A THUNK, not a constant: this leg's coverage is DISCOVERED, so it cannot be written down. It
 * delegates to `selectGatedPackages` rather than restating the selection, which is what makes
 * "the resolver's view" and "what actually runs" the same fact instead of two facts that agree
 * until someone edits one of them.
 *
 * Exporting this is what lets the uncovered-files banner route a `libs/generic/**` file to
 * `npm run lint:tsc:workspaces` instead of degrading to "no gate FOUND … and the search was
 * INCOMPLETE".
 *
 * ⚠ Walks the filesystem, so it is not free and it CAN throw on a broken tree. Its consumer
 * (`coveragePrefixesFromGateModule`) treats a throw as "this gate is unresolved", never as
 * "this gate covers nothing" — the distinction the banner's honesty property rests on.
 *
 * @returns {string[]} Repo-relative directory prefixes, trailing slash.
 */
export const GATE_COVERAGE = () => selectGatedPackages().packages.map((p) => `${p.rel}/`);

/**
 * Read one package's INTERNAL dependency names — its `@papercusp/*` entries from
 * dependencies + devDependencies.
 *
 * DECLARATIVE ON PURPOSE. The obvious alternative is scanning source for import statements, and
 * that is the wrong tool here: a hand-rolled import walker under-reports (it misses a form, or a
 * re-export, or a type-only import), and an under-reported edge does not fail loudly — it
 * silently relaxes the ordering back toward alphabetical while still looking like it worked.
 * package.json is the manifest npm itself resolves from, so it cannot disagree with what the
 * symlinks in node_modules actually point at.
 *
 * @returns {string[]} package NAMES (not paths); unreadable/absent manifest ⇒ [].
 */
export function internalDepNames(pkgDir) {
  try {
    const j = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    return Object.keys({ ...j.dependencies, ...j.devDependencies }).filter((n) =>
      n.startsWith('@papercusp/'),
    );
  } catch {
    // A manifest we cannot read yields no edges. That degrades this package to alphabetical
    // placement — never an error, and never a claim that it has no dependencies.
    return [];
  }
}

/**
 * Order the gated packages so every package is compiled AFTER the ones it depends on, and build
 * the blocker lookup `runPackages` short-circuits on.
 *
 * Both halves come from ONE traversal so they cannot disagree: the order and the edges a blocked
 * verdict cites are the same graph.
 *
 * ⚠ `key` is mandatory here, not decorative. A dependency is looked up as a DIFFERENT object than
 * the one in `nodes` (name → package record), and without `key` the helper compares by reference,
 * reads every edge as external, and returns the input order — an ordering that silently does
 * nothing. Keyed on `rel`, which is unique per package.
 *
 * @returns {{ordered: any[], blockersOf: (pkg: any) => string[], edges: number, external: string[], cycles: any[]}}
 */
export function orderPackages(packages) {
  const byName = new Map(packages.filter((p) => p.name).map((p) => [p.name, p]));
  /** rel -> the rels it depends on, restricted to packages this sweep actually compiles.
   *  This is the BLOCKER set: only a package we compile can be observed to fail. */
  const depRels = new Map();
  /** rel -> every @papercusp dep as a node, including ones this sweep does NOT compile. Those
   *  are handed to the helper deliberately so it reports them in `external` — a dep that should
   *  have resolved but did not shows up there instead of silently imposing no ordering. */
  const depNodes = new Map();
  let edges = 0;
  for (const p of packages) {
    const nodes = [];
    const rels = [];
    for (const name of internalDepNames(p.dir)) {
      const hit = byName.get(name);
      if (hit && hit.rel === p.rel) continue; // a package may devDepend on itself; not an edge
      // An unresolved dep becomes a stub node keyed by its package NAME. It is not in `nodes`,
      // so the helper classifies it external rather than treating it as an ordering constraint.
      nodes.push(hit ?? { rel: name, name, external: true });
      if (hit) rels.push(hit.rel);
    }
    depNodes.set(p.rel, nodes);
    depRels.set(p.rel, [...new Set(rels)]);
    edges += new Set(rels).size;
  }

  const result = orderByDependencies({
    nodes: packages,
    key: (p) => p.rel,
    dependenciesOf: (p) => depNodes.get(p.rel) ?? [],
  });

  return {
    ordered: result.order,
    blockersOf: (pkg) => depRels.get(pkg.rel) ?? [],
    edges,
    external: result.external ?? [],
    cycles: result.cycles ?? [],
  };
}

export function main({
  repoRoot = REPO_ROOT,
  roots = DEFAULT_ROOTS,
  exempt = EXEMPT,
  untypecheckable = UNTYPECHECKABLE,
  listOnly = process.argv.includes('--list'),
  listInvisible = process.argv.includes('--list-invisible'),
  files = parseFilesArgs(),
  spawn = realSpawn,
  // Production resolves the pinned CLI. Focused tests inject `spawn` and keep their synthetic
  // package commands untouched unless they explicitly exercise pinDirectTscCommands.
  resolveTscBin = spawn === realSpawn ? resolvePinnedTscBin : null,
  log = console.log,
  warn = console.warn,
  error = console.error,
} = {}) {
  const {
    presentRoots,
    absentRoots,
    packages: discoveredPackages,
    promoted: discoveredPromoted,
    exempted,
    heldBack,
    stillInvisible,
    unreadable,
    siblingOwned,
  } = selectGatedPackages({ repoRoot, roots, exempt, untypecheckable });
  const focused = selectPackagesForFiles(discoveredPackages, files);
  const packages = focused.packages;
  const selectedRels = new Set(packages.map((pkg) => pkg.rel));
  const promoted = files.length > 0 ? discoveredPromoted.filter((pkg) => selectedRels.has(pkg.rel)) : discoveredPromoted;

  if (focused.unmatched.length > 0) {
    error(
      `✗ --files did not resolve to a gated workspace: ${focused.unmatched.join(', ')}. ` +
        'Refusing to fall back to the full fan-out; pass a file beneath a discovered gated package.',
    );
    return 1;
  }
  if (files.length > 0) {
    log(`focused file scope: ${files.length} file(s) → ${packages.length} owning workspace(s)`);
  }

  for (const r of absentRoots) {
    warn(`⚠ root ${r} does not exist in this tree — skipping (nothing to gate there).`);
  }

  // Printed every run for the same reason EXEMPT is: this is the ONE thing standing between a
  // deliberately-wide root and double-compiling the sibling gate's submodule. An exclusion nobody
  // can see is indistinguishable from a root that silently lost coverage.
  if (siblingOwned.length) {
    log(
      `\n  ⓘ ${siblingOwned.length} director${siblingOwned.length === 1 ? 'y' : 'ies'} under ` +
        `${SIBLING_GATE_PREFIXES.join(', ')} skipped — a sibling gate ` +
        `(lint:tsc:papercusp-libs) compiles them; covering them here would report one ` +
        `regression as two.`,
    );
  }

  for (const p of unreadable) {
    error(`✗ ${p.rel}: package.json exists but could not be parsed — ${p.unreadable}`);
  }

  log(
    `workspace typecheck fan-out over ${presentRoots.join(', ')} — ` +
      `${packages.length} package(s) gated (${promoted.length} via tsconfig alone), ` +
      `${exempted.length} exempt, ${heldBack.length} held back:`,
  );
  for (const p of packages) log(`  · ${p.rel}`);

  // Printed EVERY run, never summarised away: an exemption that stops being visible is how a
  // temporary exclusion becomes permanent without anyone deciding that it should.
  if (exempted.length) {
    log(`\n  exempt from this leg (${exempted.length}):`);
    for (const p of exempted) {
      const x = exempt[p.rel];
      log(`  ⊘ ${p.rel} [${x.reason}] — ${x.detail} (see ${x.filedAs})`);
    }
  }

  // Packages gated on their tsconfig rather than on a declared script. Printed as its own
  // population so it stays obvious that coverage no longer depends on anyone remembering.
  if (promoted.length) {
    log(
      `\n  ⓘ ${promoted.length} of those are gated on their tsconfig.json alone (no \`typecheck\` script\n` +
        '    declared) — run as `npx tsc --noEmit -p tsconfig.json`. A new package is covered the\n' +
        '    moment it has a tsconfig; nobody has to enroll it.',
    );
    for (const [root, entries] of [...groupByRoot(promoted)].sort((a, b) => a[0].localeCompare(b[0]))) {
      log(`      ${root}: ${entries.length}`);
    }
    if (listInvisible) {
      log('');
      for (const e of promoted) log(`      · ${e.rel}`);
    }
  }

  // The report-only population: a tsconfig under a root that has NOT been measured, so it
  // cannot be promoted yet. A count alone would let it drift silently, so the grouping is
  // always printed and --list-invisible names every one.
  if (stillInvisible.length) {
    log(
      `\n  ⓘ REPORT-ONLY — ${stillInvisible.length} director${stillInvisible.length === 1 ? 'y' : 'ies'} have a\n` +
        '    tsconfig.json under a root that has not been measured, so NO routine gate reaches them.\n' +
        '    This is not a pass and not a failure. Not blocking: promoting a root unmeasured would\n' +
        '    red-pin the fleet gate on pre-existing errors no commit caused. To fix a root for good,\n' +
        '    run `npx tsc --noEmit -p tsconfig.json` in each of its packages, list the failures in\n' +
        '    UNTYPECHECKABLE, and add the root to PROMOTE_ROOTS.',
    );
    for (const [root, entries] of [...groupByRoot(stillInvisible)].sort((a, b) => a[0].localeCompare(b[0]))) {
      log(`      ${root}: ${entries.length}`);
    }
    if (listInvisible) {
      log('');
      for (const e of stillInvisible.sort((a, b) => a.rel.localeCompare(b.rel))) log(`      · ${e.rel}`);
    } else {
      log('      (re-run with --list-invisible to name them)');
    }
  }

  // The held-back population — the ONLY directories a routine gate still cannot reach. Printed
  // every run, never summarised away: an exclusion that stops being visible is how a temporary
  // one becomes permanent without anyone deciding that it should.
  if (heldBack.length) {
    log(
      `\n  ⚠ NOT GATED — ${heldBack.length} director${heldBack.length === 1 ? 'y' : 'ies'} with a tsconfig.json\n` +
        '    that do NOT currently typecheck clean. Held back BY NAME so the other packages can be\n' +
        '    gated today; each one is a filed, owned defect, not an accepted state:',
    );
    for (const p of heldBack) {
      const x = untypecheckable[p.rel];
      log(`      ⊘ ${p.rel} — ${x.detail} (${x.errors} error(s); see ${x.filedAs})`);
    }
  }

  if (listOnly) return unreadable.length > 0 ? 1 : 0;

  // Present but gating NOTHING must never be reported as a pass. Unlike the libs/papercusp
  // fan-out — whose submodule pin can legitimately predate its typecheck scripts, so it only
  // warns — these roots are in the superproject and always have packages, so discovering none
  // means discovery itself broke. Fail loudly rather than return a green that checked nothing.
  if (packages.length === 0) {
    error(
      '\n✗ discovered NO gated package across ' +
        `${presentRoots.join(', ')} — these are superproject roots that always contain packages,\n` +
        '  so this is a broken discovery walk, NOT a clean tree. Refusing to report a vacuous green.',
    );
    return 1;
  }

  // Leaves-first (workstream G adoption, WI-36257). The gain is not speed for its own sake: a
  // dependent compiled against a BROKEN dependency re-reports that dependency's errors against a
  // file it does not own, so alphabetical order turns one defect into N indistinguishable
  // failures. Ordering lets the sweep name the root cause and skip the cascade.
  const { ordered, blockersOf, edges, external, cycles } = orderPackages(packages);
  if (edges > 0) {
    log(
      `\n  ⓘ dependency-ordered: ${edges} internal @papercusp edge(s) among the gated set — ` +
        'dependencies compile first,\n    and a package whose dependency fails is reported BLOCKED rather than compiled into a cascade.',
    );
    // Cycles are normal in a live tree; the helper batches them instead of throwing. Say so,
    // because within a cycle no order is more correct than any other and a reader should know
    // the ordering guarantee is weaker there.
    if (cycles.length) {
      log(`    ⚠ ${cycles.length} dependency cycle(s) — each compiles as one batch, order within it arbitrary.`);
    }
    // The external list is the ordering's own health check, and it is printed rather than
    // asserted because the honest expectation is a RANGE, not a number: these are real
    // @papercusp packages that this sweep does not compile (the libs/papercusp submodule has
    // its own fan-out). It earns its line because the failure it catches is silent — if the
    // name→package mapping broke, edges would collapse to ~0 and this list would swell, and
    // the sweep would still print a perfectly ordinary green.
    if (external.length) {
      log(`    ⓘ ${external.length} @papercusp dep(s) resolve outside this sweep (own fan-out) — not ordering constraints.`);
    }
  }

  const executablePackages = resolveTscBin
    ? pinDirectTscCommands(ordered, repoRoot, resolveTscBin)
    : ordered;
  const { failed } = runPackages({
    packages: executablePackages,
    label: 'workspaces',
    unreadableCount: unreadable.length,
    spawn,
    blockersOf,
    log,
    warn,
    error,
  });
  return failed.length > 0 || unreadable.length > 0 ? 1 : 0;
}

// Only run when invoked as a CLI — the test imports the pure pieces above, and a module-level
// process.exit() would tear the test runner down on import (same pattern as lint-tsc.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
