#!/usr/bin/env node
/**
 * P-007 — the SBOM/inventory half of the audit's F12 recommendation
 * (docs/audits/security-usability-2026-09-04.md:170, plan
 * security-boundary-remediation-and-usability-2026-09-04, WI-2144851):
 *
 *     "inventory shipped JS/Rust artifacts ... and add advisory/SBOM checks to the
 *      existing verification pipeline."
 *
 * WHY THIS EXISTS — IT IS A GENERALIZATION OF TWO MEASURED BLIND SPOTS
 *
 * Two advisory gates now guard this tree. Each scans exactly ONE lockfile:
 *
 *   check-reachable-advisories.mjs  ->  `npm audit` with cwd = REPO ROOT
 *   check-rust-advisories.mjs       ->  SHIPPED_LOCKFILES[0] (the desktop Cargo.lock)
 *
 * Both scopes are correct, and both were chosen by hand. Neither gate can see a lockfile
 * outside its own scope, so a package graph that enters the tree outside them is not
 * "reported as clean" — it is NOT MEASURED AT ALL, which reads identically from outside.
 * That is the failure mode this file exists to make loud, and it has already occurred
 * twice, both times found only because a human re-read the audit:
 *
 *   1. papercusp-desktop/src-tauri/Cargo.lock — 615 shipped crates, zero advisory
 *      coverage until 2026-09-05. `cargo audit` was not installed and
 *      check-reachable-advisories.mjs has no cargo cataloger. Fixed by the Rust gate.
 *
 *   2. papercusp-desktop/package-lock.json — the SHIPPED desktop app's own npm graph.
 *      `npm audit` at the repo root cannot reach it: papercusp-desktop is deliberately
 *      NOT a root workspace member (CLAUDE.md, "Run the emitted command"), so its
 *      dependencies are never hoisted into the root lockfile the audit walks.
 *
 * Finding #2 by hand, one day after fixing #1, is the whole argument for this guard: the
 * class recurs, and nothing in the pipeline announces it. So the census is DERIVED from
 * the filesystem and every row must be EXPLICITLY classified. A lockfile that is neither
 * scanned, nor provably subsumed by a scanned one, nor curated with a stated reason, is a
 * hard failure naming its own repair.
 *
 * This is the derived-truth ladder (CLAUDE.md) applied to the two curated scopes above:
 * rung 1 DERIVES the population, rung 4 CURATES the judgment, and the guard forces every
 * derived row into a curated bucket so the two cannot drift apart in silence.
 *
 * WHAT `subsumed` MEANS, AND WHY IT IS DERIVED RATHER THAN ASSERTED
 *
 * Three of this tree's nested package-lock.json files are vestigial: their package IS a
 * root workspace member, so npm hoists its dependencies into the root lockfile and the
 * root `npm audit` genuinely covers them. Writing that down as a curated claim would be a
 * second copy of a truth the root lockfile already owns. Instead it is read back from the
 * root lockfile's own `packages` map: a directory present there is a workspace npm
 * installed, and its transitive graph is in the audited tree. A package that stops being a
 * workspace member therefore stops being subsumed automatically, with no list to update.
 *
 * Measured 2026-09-05: 13 lockfiles — 7 Cargo.lock, 6 package-lock.json. 2 covered,
 * 3 subsumed, 1 build-only, 6 not-shipped, 1 uncovered-baselined.
 *
 * A THIRD BLIND SPOT, FOUND BY THIS FILE'S OWN FIRST RUN
 *
 * The counts above changed once the census stopped counting lockfile ENTRIES and started
 * measuring SHIPPED dependencies (see npmDepCounts). The desktop npm lockfile was
 * baselined as "12 deps ... SHIPPED ... the highest-priority row here"; all 12 entries
 * are `dev: true` build tooling and its shipped count is zero. The number was accurate
 * and the unit was wrong, which is the harder failure to see: nothing about a plausible
 * count announces that it is measuring something other than what its name says.
 *
 * FALSIFIABILITY
 *
 * Every leg of this guard fails CLOSED, because each of its inputs can go quietly empty:
 *   - a census that finds ZERO lockfiles is a broken walker, not a clean tree  -> refuse
 *   - a root lockfile that will not parse makes EVERY nested lock look unsubsumed, which
 *     would report the tree as full of new blind spots                          -> refuse
 *   - a curated entry naming a path that no longer exists is stale bookkeeping   -> report
 *
 * Usage:
 *   node scripts/check-lockfile-census.mjs           # report
 *   node scripts/check-lockfile-census.mjs --strict  # exit 1 on an unclassified lockfile
 *   node scripts/check-lockfile-census.mjs --sbom out.json   # emit the syft inventory
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');

/** Lockfile basenames that pin a resolved dependency graph, by ecosystem. */
export const LOCKFILE_ECOSYSTEMS = new Map([
  ['package-lock.json', 'npm'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'],
  ['poetry.lock', 'python'],
  ['uv.lock', 'python'],
  ['Pipfile.lock', 'python'],
  ['Gemfile.lock', 'rubygems'],
  ['composer.lock', 'composer'],
  ['pubspec.lock', 'pub'],
  ['mix.lock', 'hex'],
]);

/** Directories that never contain a lockfile we ship or audit. */
export const PRUNED_DIRS = new Set([
  'node_modules',
  'target',
  '.git',
  '_retired',
  'dist',
  '.next',
  '.papercusp',
  'coverage',
  'build',
  '.cache',
  'vendor-dist',
]);

/**
 * Lockfiles an advisory gate ACTUALLY scans, and the gate that scans each. Keep this
 * keyed by the gate's own exported scope wherever the gate exports one, so widening the
 * gate widens the census automatically instead of requiring two edits.
 */
export const COVERED_LOCKFILES = new Map([
  ['package-lock.json', 'check-reachable-advisories.mjs (npm audit, cwd=repo root)'],
  ['papercusp-desktop/src-tauri/Cargo.lock', 'check-rust-advisories.mjs (RustSec/OSV)'],
]);

/**
 * Lockfiles that do NOT describe a shipped artifact. Each states WHY — the judgment the
 * derivation cannot make. A path here that no longer exists is reported as stale so the
 * list shrinks with the tree instead of accumulating.
 */
export const NOT_SHIPPED_LOCKFILES = new Map([
  [
    'scripts/heap-retainers-native/Cargo.lock',
    'local heap-snapshot diagnostic adapter: built explicitly with the cargo build --locked command documented in scripts/analyze-heap-snapshots.mjs and invoked only when a caller supplies nativeExecutable; neither the operator host bundle nor the desktop sidecar script/resource copy includes this Cargo project or its target binary',
  ],
  [
    'apps/tui/Cargo.lock',
    'apps/tui is a developer terminal UI built from source on a dev box; it is not bundled into any desktop installer target',
  ],
  [
    'apps/pui-zellij-plugin/Cargo.lock',
    'a zellij WASM plugin for local development panes; not referenced by any tauri.conf bundle target',
  ],
  [
    'apps/pui-companion-proto/Cargo.lock',
    'prototype companion binary (12 crates); not built or bundled by the release pipeline',
  ],
  [
    'papercusp-desktop/src-tauri/vendor/tao/Cargo.lock',
    'vendored fork checked in for `[patch]` resolution — the crates that actually build are pinned by the parent src-tauri/Cargo.lock, which IS scanned',
  ],
  [
    'papercusp-desktop/src-tauri/vendor/tauri-runtime-wry/Cargo.lock',
    'vendored fork checked in for `[patch]` resolution — see the tao entry; the parent lockfile is the one that resolves the build',
  ],
  [
    'libs/papercusp/apps/desktop/src-tauri/Cargo.lock',
    'the superseded in-submodule desktop shell; papercusp-desktop/ is the shipped Tauri app (CLAUDE.md, "Running / testing this app")',
  ],
  [
    'libs/papercusp/packages/harness/docs-viewer/package-lock.json',
    'a local Starlight dev server (bin/docs-viewer.sh, port 4325) for reading docs the harness documenter role writes; it ships in NO artifact. FOUR independent reasons, the first decisive on its own: (1) papercusp-desktop/bin/build-desktop-sidecar.sh — the actual desktop harness-copy step — enumerates packages/harness with `find -type f` and passes `-not -path "./docs-viewer/*"`, excluding the viewer BY NAME, with the stated reason "It is an Astro sub-project that needs its own node_modules and is not required by the harness loop"; (2) the Tauri bundle declares resources ["sidecar/spa/**/*"] and externalBin null, so the viewer is not a bundled resource either; (3) apps/operator/bin/bundle-host.sh copies ONLY packages/harness/blueprints into the operator host graph, never the packages/harness tree; (4) its 509 deps are npm-installed LAZILY on first run into docs-viewer/node_modules by bin/docs-viewer.sh, are not vendored (15 tracked files, all config plus the lockfile), and are absent from a fresh checkout — there is no build step that could embed them. Reclassified 2026-09-05 (WI-2144851) from UNCOVERED_BASELINE, whose entry asked for exactly this determination. RETRACTION, recorded because the mistake is reusable: an earlier pass of this same work-item wrote here that build-desktop-sidecar.sh "does not exist in this tree" and that agent-insights/what-ships-in-a-knowledge-pack was therefore stale prose. BOTH claims were FALSE. The script exists (5147 lines) and the doc describes it correctly; the search that "proved" its absence was scoped to the superproject, and papercusp-desktop is a SUBMODULE — a repo-root find/grep silently omits it and returns an empty result that reads exactly like a real absence.',
  ],
]);

/**
 * Lockfiles that DO describe shipped or potentially-shipped code and are NOT covered by
 * any advisory gate. This is acknowledged debt, and it is SHRINK-ONLY: an entry leaves
 * when a gate starts scanning the lockfile, and a NEW uncovered lockfile is a hard
 * failure rather than a quiet append. `deps` is the measured graph size at the time of
 * baselining, so the cost of the gap is legible without re-measuring.
 */
/** @type {Map<string, { deps: number; reason: string }>} */
export const UNCOVERED_BASELINE = new Map([]);

/**
 * Count the entries in an npm lockfile that describe SHIPPED code, and the entries that
 * describe build tooling. `dev: true` is npm's own resolved verdict, written by the
 * installer that walked the manifest — not a guess from a dependency name.
 *
 * WHY THIS EXISTS — A COUNT WHOSE UNITS WERE WRONG SENT THE CENSUS TO THE WRONG FILE
 *
 * The first version of this file counted `packages` ENTRIES and called the total "deps",
 * then baselined `papercusp-desktop/package-lock.json` at "12 deps ... it is SHIPPED —
 * this is the highest-priority row here." Measured 2026-09-05, every one of those 12
 * entries is `dev: true` (`@tauri-apps/cli` plus its 11 platform binaries, 11 of which
 * are also `optional`), so the shipped-dependency count of that lockfile is ZERO. The
 * row was real, its number was real, and the conclusion drawn from it — gate this next —
 * was work that would have bought nothing.
 *
 * So the bucket is DERIVED from this measurement rather than curated: an npm lockfile
 * that resolves no runtime dependency ships nothing, and the lockfile itself says so.
 * A dependency promoted out of `devDependencies` moves that file back into the
 * classification set on the next run, with no list for anyone to remember to update.
 */
export function npmDepCounts(lockJson) {
  const packages = lockJson?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error(
      'npm lockfile has no `packages` map — cannot measure its shipped dependency count. ' +
        'Refusing rather than reporting an unreadable lockfile as shipping nothing.',
    );
  }
  const shipped = new Set();
  const devOnly = new Set();
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue;
    const name = entry?.name ?? key.split('node_modules/').pop();
    const id = `${name}@${entry?.version ?? '?'}`;
    if (entry?.dev === true) devOnly.add(id);
    else shipped.add(id);
  }
  // A package resolved at two paths — dev in one tree, runtime in another — SHIPS. Asking
  // "is this name dev anywhere?" instead gives the opposite answer, and it is the reading
  // that produced a false positive control while this file was being written: several
  // names sampled from the root lockfile looked dev-only and were present in the SBOM,
  // which appeared to disprove syft's dev exclusion. They were present because a
  // NON-dev copy of the same name existed elsewhere in the graph.
  for (const id of shipped) devOnly.delete(id);
  return {
    shipped: shipped.size,
    devOnly: devOnly.size,
    total: shipped.size + devOnly.size,
    // The lockfile's own root package — the artifact being inventoried, not one of its
    // dependencies. Carried so the SBOM count can exclude it by name rather than by path.
    rootName: packages['']?.name ?? null,
  };
}

/** `[[package]]` blocks in a Cargo.lock. Cargo has no dev/runtime split at this layer. */
export function cargoDepCounts(lockText) {
  const shipped = (lockText.match(/^\[\[package\]\]/gm) ?? []).length;
  if (shipped === 0) {
    throw new Error(
      'Cargo.lock declares ZERO [[package]] blocks — the file did not parse as a lockfile. ' +
        'Refusing rather than reporting an unreadable lockfile as shipping nothing.',
    );
  }
  return { shipped, devOnly: 0, total: shipped };
}

/**
 * Measure every census row. The IO half of the derivation above; `classifyCensus` stays
 * pure and takes the result. A row that cannot be measured is recorded as `null` rather
 * than as zero, because "we could not read it" and "it ships nothing" must not collapse
 * into the same bucket — that collapse is the whole defect this measurement repairs.
 */
export function measureLockfiles(root, lockfiles) {
  const measurements = new Map();
  for (const path of lockfiles) {
    const name = path.split('/').pop() ?? path;
    const ecosystem = LOCKFILE_ECOSYSTEMS.get(name) ?? 'unknown';
    try {
      if (ecosystem === 'npm') {
        measurements.set(path, npmDepCounts(JSON.parse(readFileSync(join(root, path), 'utf8'))));
      } else if (ecosystem === 'cargo') {
        measurements.set(path, cargoDepCounts(readFileSync(join(root, path), 'utf8')));
      } else {
        measurements.set(path, null);
      }
    } catch {
      measurements.set(path, null);
    }
  }
  return measurements;
}

/**
 * Walk the tree for lockfiles. Returns repo-relative POSIX paths, sorted.
 *
 * Symlinked directories are NOT followed. That is deliberate and is the opposite of the
 * `find -L` advice for cross-checkout searches: here a symlink out of the repo would
 * import a SIBLING hive's lockfiles into this repo's census, which is a false positive,
 * not a missed row. The population is bounded by the repo, so a positive control on the
 * result (see censusOrThrow) is what protects against an under-read.
 */
export function walkLockfiles(root, { pruned = PRUNED_DIRS, names = LOCKFILE_ECOSYSTEMS } = {}) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue;
        if (pruned.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile() && names.has(entry.name)) {
        found.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  return found.sort();
}

/**
 * The census plus its own falsifier. A walk that returns nothing has either been pointed
 * at the wrong root or had its prune set widened until it excludes the whole tree; both
 * produce an EMPTY offender list, which is indistinguishable from a fully-classified one.
 * The repo's own root package-lock.json is the positive control: it is the one lockfile
 * whose presence is structurally guaranteed.
 *
 * @param {string} root
 * @param {{ pruned?: Set<string>, names?: Map<string,string> }} [options] forwarded to walkLockfiles
 */
export function censusOrThrow(root, options) {
  const rows = walkLockfiles(root, options);
  if (rows.length === 0) {
    throw new Error(
      `lockfile census found ZERO lockfiles under ${root} — the walker is broken or mis-rooted. ` +
        'Refusing rather than reporting an empty census as a clean tree.',
    );
  }
  if (!rows.includes('package-lock.json')) {
    throw new Error(
      `lockfile census did not find the repo root package-lock.json (found ${rows.length} other ` +
        'lockfile(s)). That file is the census positive control; without it the walk cannot be ' +
        'trusted to have covered the tree.',
    );
  }
  return rows;
}

/**
 * Directories whose npm dependencies are hoisted into the root lockfile.
 *
 * Read back from the root lockfile's `packages` map rather than asserted: every root
 * workspace member appears there as its own directory key. Throws on an unreadable or
 * shapeless root lockfile, because a silent {} makes every nested lock look UNSUBSUMED —
 * turning a parse failure into a page of fabricated blind spots.
 */
export function rootWorkspaceDirs(rootLockJson) {
  const packages = rootLockJson?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error(
      'root package-lock.json has no `packages` map — cannot derive which nested lockfiles are ' +
        'subsumed by the audited root graph. Refusing rather than reporting every nested lockfile ' +
        'as a new uncovered blind spot.',
    );
  }
  const dirs = new Set();
  for (const key of Object.keys(packages)) {
    if (key === '' || key.startsWith('node_modules/')) continue;
    dirs.add(key);
  }
  if (dirs.size === 0) {
    throw new Error(
      'root package-lock.json declares no workspace directories — expected dozens. Refusing: a ' +
        'zero-workspace read makes every nested lockfile look unsubsumed.',
    );
  }
  return dirs;
}

/**
 * Classify every census row into exactly one bucket. Pure: all IO is the caller's.
 *
 * @param {object} input
 * @param {string[]} input.lockfiles          repo-relative census rows
 * @param {Set<string>} input.workspaceDirs   directories hoisted into the root lockfile
 * @param {Map<string,{shipped:number,devOnly:number,total:number,rootName?:string|null}|null>} [input.measurements]
 *   per-path output of measureLockfiles. A null VALUE means UNMEASURABLE, never zero — the
 *   distinction the build-only classifier turns on. `rootName` is npm-only; cargoDepCounts
 *   has no root package node to name.
 * @param {Map<string,string>} [input.covered]
 * @param {Map<string,string>} [input.notShipped]
 * @param {Map<string,{deps:number,reason:string}>} [input.uncovered]
 */
export function classifyCensus({
  lockfiles,
  workspaceDirs,
  measurements = new Map(),
  covered = COVERED_LOCKFILES,
  notShipped = NOT_SHIPPED_LOCKFILES,
  uncovered = UNCOVERED_BASELINE,
}) {
  const rows = [];
  for (const path of lockfiles) {
    const name = path.split('/').pop() ?? path;
    const ecosystem = LOCKFILE_ECOSYSTEMS.get(name) ?? 'unknown';
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const measured = measurements.get(path) ?? null;

    if (covered.has(path)) {
      rows.push({ path, ecosystem, bucket: 'covered', measured, note: covered.get(path) });
      continue;
    }
    // Derived, not asserted: an npm lockfile whose directory is a root workspace member
    // has its graph hoisted into the audited root lockfile.
    if (ecosystem === 'npm' && dir !== '' && workspaceDirs.has(dir)) {
      rows.push({
        path,
        ecosystem,
        bucket: 'subsumed',
        measured,
        note: `${dir} is a root workspace member; its dependencies hoist into the audited root lockfile`,
      });
      continue;
    }
    // Derived, not asserted (see npmDepCounts): an npm lockfile that resolves no runtime
    // dependency ships no third-party code, so no advisory gate can owe it coverage. The
    // measurement must be PRESENT to reach this bucket — an unmeasurable lockfile stays
    // in the classification set rather than being excused by a failed read.
    if (ecosystem === 'npm' && measured !== null && measured.shipped === 0 && measured.devOnly > 0) {
      rows.push({
        path,
        ecosystem,
        bucket: 'build-only',
        measured,
        note: `all ${measured.devOnly} resolved entries are dev-only build tooling; the lockfile resolves zero runtime dependencies, so it ships no third-party code`,
      });
      continue;
    }
    if (notShipped.has(path)) {
      rows.push({ path, ecosystem, bucket: 'not-shipped', measured, note: notShipped.get(path) });
      continue;
    }
    if (uncovered.has(path)) {
      const entry = uncovered.get(path);
      rows.push({
        path,
        ecosystem,
        bucket: 'uncovered-baselined',
        // The BASELINED figure and the LIVE measurement are kept apart on purpose: a
        // baseline is a record of the debt when it was accepted, and `measured` is what
        // the lockfile says now. Collapsing them would hide a graph that grew.
        deps: entry.deps,
        measured,
        note: entry.reason,
      });
      continue;
    }
    rows.push({ path, ecosystem, bucket: 'UNCLASSIFIED', measured });
  }

  // A curated entry pointing at a path the census no longer contains is stale. Reported,
  // never fatal: deleting a lockfile is a good thing, and failing the build for it would
  // punish the cleanup.
  const present = new Set(lockfiles);
  const stale = [];
  for (const [source, map] of [
    ['COVERED_LOCKFILES', covered],
    ['NOT_SHIPPED_LOCKFILES', notShipped],
    ['UNCOVERED_BASELINE', uncovered],
  ]) {
    for (const path of map.keys()) {
      if (!present.has(path)) stale.push({ path, source });
    }
  }

  const offenders = rows.filter((r) => r.bucket === 'UNCLASSIFIED');
  const byBucket = {};
  for (const row of rows) byBucket[row.bucket] = (byBucket[row.bucket] ?? 0) + 1;

  return { rows, offenders, stale, byBucket, total: rows.length };
}

/** Lockfiles the SBOM should inventory: everything that ships and is not vestigial. */
export function sbomSubjects(rows) {
  return rows
    .filter((r) => r.bucket === 'covered' || r.bucket === 'uncovered-baselined')
    .map((r) => r.path);
}

/**
 * Emit a CycloneDX inventory of the shipped lockfiles via syft.
 *
 * syft is a dev-box tool, not a pipeline dependency, so its ABSENCE must refuse loudly:
 * an SBOM step that silently skips when the binary is missing produces no file and a
 * green exit, which is the same "measured nothing" reading this whole guard is built to
 * prevent. The gate legs above never touch syft, so the gate stays runnable without it.
 */
export function emitSbom(subjects, outPath, { root = ROOT, syft = process.env.SYFT_BIN, measurements = new Map() } = {}) {
  const bin = syft || join(process.env.HOME ?? '', '.local', 'bin', 'syft');
  if (!existsSync(bin)) {
    throw new Error(
      `syft not found at ${bin} — cannot emit the shipped-artifact inventory. Install syft or set ` +
        'SYFT_BIN. Refusing rather than writing no SBOM and exiting 0.',
    );
  }
  const documents = [];
  for (const subject of subjects) {
    const out = execFileSync(
      bin,
      ['scan', `file:${join(root, subject)}`, '-o', 'cyclonedx-json', '-q'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
    );
    const parsed = JSON.parse(out);
    const measured = measurements.get(subject) ?? null;
    const catalogued = countCataloguedDependencies(parsed, subject, root, measured?.rootName ?? null);
    assertSbomCoverage(subject, catalogued, measured);
    documents.push({ subject, components: parsed.components?.length ?? 0, catalogued, bom: parsed });
  }
  // mkdir the parent rather than requiring the caller to have made it. The output path is
  // a gitignored artifact directory that does not exist on a fresh checkout, and an ENOENT
  // here would fail the SBOM leg for a reason that has nothing to do with the inventory.
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ generatedFrom: subjects, documents }, null, 2)}\n`);
  return documents.map(({ subject, components, catalogued }) => ({ subject, components, catalogued }));
}

/**
 * Dependency components in a CycloneDX document, excluding the two components that are
 * present whether or not the cataloger read anything: the synthetic `type: 'file'` node
 * syft emits for the scanned path, and the subject lockfile's own root package.
 *
 * This distinction is the entire reason the previous `components === 0` check could not
 * fire. Measured 2026-09-05 against `papercusp-desktop/package-lock.json`, syft
 * catalogued exactly those two components and no dependency at all — a 2, not a 0, so
 * the guard passed and reported an inventory containing none of the file's packages.
 * A threshold placed below the value that "catalogued nothing" actually produces is not
 * a weak guard; it is an unfalsifiable one.
 *
 * @param {any} bom
 * @param {string} subject
 * @param {string} [root]
 * @param {string|null} [rootPackageName] the subject lockfile's own root package name, from
 *   `measureLockfiles`. Typed explicitly because the `= null` default alone generates the
 *   parameter as `null`, which makes every real call site a type error.
 */
export function countCataloguedDependencies(bom, subject, root = ROOT, rootPackageName = null) {
  const components = bom?.components ?? [];
  const subjectAbs = join(root, subject);
  return components.filter((c) => {
    if (c?.type === 'file') return false;
    if (c?.name === subjectAbs || c?.name === subject) return false;
    if (rootPackageName !== null && c?.name === rootPackageName) return false;
    return true;
  }).length;
}

/**
 * The POSITIVE control on the inventory: two independent readings of the same lockfile
 * must agree. `measured.shipped` is this file's own parse of the lockfile; `catalogued`
 * is what syft's cataloger produced from it. A cataloger that silently declined the file
 * makes the second number collapse while the first stays intact, which is the only way
 * to tell "this artifact genuinely has few dependencies" from "nothing read it".
 *
 * syft excludes npm `dev` dependencies, which is why the comparison is against
 * `measured.shipped` and not the entry total. Calibrated 2026-09-05 across every shipped
 * subject: docs-viewer 509 shipped / 509 catalogued, Cargo 615 / 615, root 2469 / 2481
 * (the +12 are workspace package nodes, which the root lockfile does not count as
 * dependencies). Catalogued runs at or just above shipped, never below, so a SHORTFALL —
 * and only a shortfall — is signal. The comparison is deliberately one-sided: an excess
 * is a naming difference between two catalogers, while a deficit can only mean one of
 * them declined to read something.
 */
export function assertSbomCoverage(subject, catalogued, measured) {
  if (measured === null) {
    if (catalogued === 0) {
      throw new Error(
        `syft catalogued ZERO dependency components from ${subject}, and this file could not ` +
          'independently measure the lockfile either, so the emptiness cannot be corroborated. ' +
          'Refusing rather than writing an inventory that may simply not have been read.',
      );
    }
    return;
  }
  if (catalogued < measured.shipped) {
    throw new Error(
      `syft catalogued ${catalogued} dependency component(s) from ${subject}, but the lockfile ` +
        `itself resolves ${measured.shipped} shipped dependenc(ies). The inventory is missing ` +
        `${measured.shipped - catalogued} of them. A short catalog is not a small graph — it ` +
        'means the cataloger declined part or all of the file. Refusing to write it.',
    );
  }
}

/**
 * `--sbom` takes a PATH OPERAND, and a missing one must REFUSE rather than resolve to
 * `undefined` and skip the emit block.
 *
 * MEASURED 2026-09-05, and the reason this function exists as its own export: the npm
 * script `lint:lockfile-census:sbom` was `check-lockfile-census.mjs --strict --sbom` with
 * nothing after the flag. `argv[sbomIdx + 1]` was `undefined`, the `if (sbomOut)` block
 * never ran, and the script printed the plain census and EXITED 0 — no syft invocation,
 * no assertSbomCoverage positive control, no file, and no line saying any of that was
 * skipped. A script whose entire name is `:sbom` was a silent duplicate of the one
 * without the suffix.
 *
 * That is this guard's own thesis in its cheapest possible form. Every instrument aimed
 * at the SCRIPT reported green because the script WAS green: `emitSbom` works,
 * `assertSbomCoverage` is a real positive control, the unit tests pass. The defect was one
 * absent word in a package.json string, and nothing that tested a FUNCTION could see it.
 * Hence both halves of the repair: refuse here, and pin the INVOCATION in the guard test.
 *
 * A flag-shaped operand (`--sbom --strict`) is refused for the same reason — silently
 * writing an SBOM to a file named `--strict` is not a better outcome than refusing.
 */
export function parseSbomOut(argv) {
  const sbomIdx = argv.indexOf('--sbom');
  if (sbomIdx < 0) return null;
  const operand = argv[sbomIdx + 1];
  if (operand === undefined || operand.startsWith('-')) {
    throw new Error(
      '--sbom requires an output PATH operand (e.g. `--sbom .papercusp/tmp/lockfile-census.sbom.json`), ' +
        `but got ${operand === undefined ? 'nothing' : `the flag \`${operand}\``}. Refusing rather than ` +
        'skipping the inventory and exiting 0 — a silently absent SBOM reads exactly like a clean one.',
    );
  }
  return operand;
}

function main(argv) {
  const strict = argv.includes('--strict');
  const sbomOut = parseSbomOut(argv);

  const lockfiles = censusOrThrow(ROOT);
  const rootLock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const workspaceDirs = rootWorkspaceDirs(rootLock);
  const measurements = measureLockfiles(ROOT, lockfiles);
  const result = classifyCensus({ lockfiles, workspaceDirs, measurements });

  const order = [
    'covered',
    'subsumed',
    'build-only',
    'not-shipped',
    'uncovered-baselined',
    'UNCLASSIFIED',
  ];
  console.log(`lockfile census: ${result.total} lockfile(s)`);
  for (const bucket of order) {
    if (result.byBucket[bucket]) console.log(`  ${String(result.byBucket[bucket]).padStart(3)}  ${bucket}`);
  }

  const buildOnly = result.rows.filter((r) => r.bucket === 'build-only');
  for (const row of buildOnly) {
    console.log(`\n   build-only: ${row.path} — ${row.note}`);
  }

  const uncoveredRows = result.rows.filter((r) => r.bucket === 'uncovered-baselined');
  if (uncoveredRows.length > 0) {
    // Report the LIVE shipped count, not the baselined one. The baseline records what the
    // debt was when it was accepted; quoting it back as the current size is how a graph
    // that grew keeps reporting its old, smaller number.
    const deps = uncoveredRows.reduce((n, r) => n + (r.measured?.shipped ?? r.deps ?? 0), 0);
    console.log(`\n⚠ ${uncoveredRows.length} shipped lockfile(s) with NO advisory coverage (~${deps} shipped deps) — baselined debt, shrink-only:`);
    for (const row of uncoveredRows) {
      const live = row.measured ? `${row.measured.shipped} shipped, ${row.measured.devOnly} dev-only` : 'UNMEASURABLE';
      const drift = row.measured && row.measured.shipped > row.deps
        ? `  ⚠ GREW since baselining (${row.deps} → ${row.measured.shipped})`
        : '';
      console.log(`     ${row.path}  (${live}; baselined at ${row.deps})${drift}\n       ${row.note}`);
    }
  }

  for (const row of result.stale) {
    console.log(`\n⚠ stale ${row.source} entry: ${row.path} is no longer in the tree — remove it.`);
  }

  if (result.offenders.length > 0) {
    console.log(`\n❌ ${result.offenders.length} lockfile(s) are in NO classification:`);
    for (const row of result.offenders) console.log(`     ${row.path}  [${row.ecosystem}]`);
    console.log(
      '\n   A lockfile nobody has classified is a dependency graph nobody is scanning — the exact\n' +
        '   shape of the two blind spots this guard was built from. Pick one, deliberately:\n' +
        '     • COVER it — extend an advisory gate to scan it, then add it to COVERED_LOCKFILES.\n' +
        '     • DECLARE it unshipped — add it to NOT_SHIPPED_LOCKFILES with the reason it does not ship.\n' +
        '     • BASELINE it — add it to UNCOVERED_BASELINE with its measured dep count and why the\n' +
        '       coverage is not there yet. That list is shrink-only; it is debt, recorded, not hidden.',
    );
  }

  if (sbomOut) {
    const emitted = emitSbom(sbomSubjects(result.rows), sbomOut, { measurements });
    console.log(`\nSBOM written to ${sbomOut}:`);
    for (const row of emitted) {
      console.log(`     ${row.subject}  ${row.catalogued} dependency components (${row.components} total)`);
    }
  }

  if (strict && result.offenders.length > 0) process.exit(1);
}

/**
 * Basename pin, not `import.meta.url === file://${argv[1]}`. This gate must stay
 * importable with no operator-core dependency (it runs standalone, before any build), and
 * the naive URL comparison becomes true for EVERY inlined module once esbuild bundles a
 * tree — which is how an imported CLI's main() ends up running during host boot.
 */
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])check-lockfile-census\.mjs$/.test(entryPath);
}

if (isDirectCliInvocation()) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
