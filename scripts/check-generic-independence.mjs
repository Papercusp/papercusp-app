#!/usr/bin/env node
/**
 * check-generic-independence.mjs — WI-4973 / decouple-generic-libs-private-deps-2026-08-03.
 *
 * A `libs/generic/*` package is advertised in BORROWABLE.md as independently
 * consumable — clone its submodule (or install it standalone) and use it. That
 * claim breaks silently in two ways this gate catches:
 *
 *   1. A hard `dependencies`/`devDependencies` entry on another `@papercusp/*`
 *      package. Inside THIS monorepo npm workspaces resolves it fine via
 *      symlinking regardless of which section it's declared in, so this is
 *      invisible in normal dev — but a standalone consumer's `npm install`
 *      tries to fetch that scoped package from the public registry, where it
 *      is not published, and the install fails. The fix is mechanical: declare
 *      it as a `peerDependencies` entry instead (the pattern `@papercusp/sync`
 *      already uses correctly for its `@papercusp/sse` dep) — npm workspaces
 *      still resolves it via symlinking in-repo, and a standalone consumer is
 *      simply told "you must also provide this" instead of a failed fetch.
 *
 *   2. A dependency (of ANY section, including a correctly-declared peer) on
 *      an `@papercusp/*` package that is not itself in the curated BORROWABLE
 *      set at all — i.e. genuinely private. No amount of dependency-section
 *      juggling fixes this; the target needs to be extracted to a standalone
 *      `libs/generic/*` lib first (or the source lib should not claim to be
 *      independently borrowable).
 *
 * `"private": true` in a lib's own package.json is NOT evidence either way —
 * see BORROWABLE-catalog.mjs D-001 (decouple-generic-libs-private-deps plan):
 * it appears on already-fully-public libs (sse, rrf, ipc-framing, …) too and
 * only means "not npm-published, workspace-local install". Classification
 * here is off the SAME curated `BORROWABLE` array `gen-borrowable-catalog.mjs`
 * uses to write BORROWABLE.md — imported, never re-curated, so the two can't
 * drift apart.
 *
 *   node scripts/check-generic-independence.mjs            # report (informational)
 *   node scripts/check-generic-independence.mjs --strict   # exit 1 on any HARD-COUPLED finding
 */
import { BORROWABLE, ROOT, readPkg, sourceFor, parseGitmodules } from './gen-borrowable-catalog.mjs';

export const HARD_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Pure core (testable without shelling out): given the curated borrowable
 * list + resolved submodule map, return every private-coupling /
 * hard-section finding. Defaults read the real repo tree; a test can pass a
 * narrower `borrowable`/`submodules` + a stub `readPkgFn` to exercise it
 * against a fixture instead of the live filesystem.
 */
export function computeFindings({
  borrowable = BORROWABLE,
  submodules = parseGitmodules(),
  readPkgFn = readPkg,
} = {}) {
  // path -> package name, for every borrowable lib (so a dep target is
  // classified as "borrowable" regardless of which row declared it).
  const borrowableNames = new Set();
  for (const [p] of borrowable) {
    try {
      borrowableNames.add(readPkgFn(p).name);
    } catch {
      // unreadable package.json is a separate problem (gen-borrowable-catalog's
      // own build() will throw on it too) — skip here, don't double-report.
    }
  }

  const findings = [];

  for (const [p] of borrowable) {
    let pkg;
    try {
      pkg = readPkgFn(p);
    } catch {
      continue;
    }
    const src = sourceFor(p, submodules);
    for (const section of [...HARD_SECTIONS, 'peerDependencies']) {
      const deps = pkg[section] || {};
      for (const dep of Object.keys(deps)) {
        if (!dep.startsWith('@papercusp/')) continue;
        const isBorrowable = borrowableNames.has(dep);
        const isHardSection = HARD_SECTIONS.includes(section);
        if (isHardSection) {
          findings.push({
            severity: isBorrowable ? 'hard-section' : 'private-target',
            lib: pkg.name,
            path: p,
            dep,
            section,
            submodule: src.kind === 'submodule',
          });
        } else if (!isBorrowable) {
          // peerDependencies is the right SHAPE, but the target itself is not
          // (yet) a standalone public lib — the peer promise can't be kept.
          findings.push({
            severity: 'private-target',
            lib: pkg.name,
            path: p,
            dep,
            section,
            submodule: src.kind === 'submodule',
          });
        }
      }
    }
  }
  return findings;
}

// Run as a CLI only when invoked directly (not when imported by a test).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();

function main() {
const strict = process.argv.includes('--strict');
const findings = computeFindings();

if (findings.length === 0) {
  console.log(`check-generic-independence: clean — ${BORROWABLE.length} borrowable libs, no private/hard-coupled @papercusp/* deps.`);
  process.exit(0);
}

const bySeverity = { 'private-target': [], 'hard-section': [] };
for (const f of findings) bySeverity[f.severity].push(f);

if (bySeverity['private-target'].length) {
  console.log(`\n🔴 PRIVATE-COUPLED (${bySeverity['private-target'].length}) — depends on a @papercusp/* package that is NOT in the borrowable set. No dependency-section fix helps; extract the target to libs/generic/* first, or drop the source lib from BORROWABLE.\n`);
  for (const f of bySeverity['private-target']) {
    console.log(`  ${f.lib} (${f.path}) [${f.section}] -> ${f.dep}`);
  }
}

if (bySeverity['hard-section'].length) {
  console.log(`\n🟡 HARD-SECTION (${bySeverity['hard-section'].length}) — depends on a borrowable @papercusp/* package via dependencies/devDependencies/optionalDependencies instead of peerDependencies. Works in this monorepo (workspace symlinking), breaks for a standalone consumer (npm tries the public registry). Fix: move to peerDependencies (see @papercusp/sync's @papercusp/sse dep for the working pattern).\n`);
  for (const f of bySeverity['hard-section']) {
    console.log(`  ${f.lib} (${f.path}) [${f.section}] -> ${f.dep}${f.submodule ? '' : '  (in-repo, not yet a submodule)'}`);
  }
}

console.log(`\n${findings.length} finding(s) across ${BORROWABLE.length} borrowable libs.`);

if (strict && findings.length) process.exit(1);
}
