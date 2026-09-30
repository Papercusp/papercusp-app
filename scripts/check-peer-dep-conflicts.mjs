#!/usr/bin/env node
/**
 * check-peer-dep-conflicts.mjs — shrink-only guard against a workspace peerDependency
 * range that the installed tree CANNOT satisfy (EI-20863237237162828).
 *
 * WHY THIS MATTERS: npm resolves peerDependencies tree-wide. A workspace that declares
 * `"dockview": "^5"` while the root tree installs dockview 6.6.1 makes `npm install`
 * fail with ERESOLVE — for EVERY agent, on EVERY package, tree-wide. That is not a
 * local breakage: `npm run install:safe` is the ONE sanctioned install path in this
 * repo, so while it is red there is NO sanctioned way to repair dependencies at all.
 * The incident that motivated this guard (2026-08-19) was exactly that: libs/papercusp-shared
 * declared a `dockview ^5` peer that was pure duplication of root's own `^6.2.2`
 * declaration and was never imported locally. Nothing caught it.
 *
 * The MIRROR guard already exists — scripts/check-workspace-deps-complete.mjs catches a
 * local @papercusp/* package that is IMPORTED BUT NOT DECLARED. Nothing caught the
 * opposite: an EXTERNAL peer that is DECLARED but conflicts with what the tree provides.
 *
 *   node scripts/check-peer-dep-conflicts.mjs         # check (npm run lint:peer-dep-conflicts)
 *   node scripts/check-peer-dep-conflicts.mjs --list  # print the current offender set (regenerate BASELINE)
 *
 * EXIT CODES (mirrors the guard family):
 *   0 = clean            1 = conflicts found (gating)
 *   2 = NOT CHECKED — nothing examinable, or a range/version form this checker does not
 *       understand. Deliberately NOT exit 0: "I could not judge this" must never render
 *       as "this is clean". Registered with notCheckedIsNonGating so a gate checkout with
 *       no installed tree cannot red the fleet gate on an empty measurement.
 *
 * WHY A HAND-ROLLED RANGE CHECKER RATHER THAN `semver`: `semver` is NOT a declared root
 * dependency here (measured 2026-08-19: zero repo files import it; it is present only
 * transitively). A repo-wide GATING guard that depends on a transitive package can be
 * broken by an unrelated dependency-tree change — the precise class of tree-wide breakage
 * this guard exists to prevent. The peer ranges actually in this repo are a small closed
 * grammar (measured: `*`, `^X[.Y[.Z]]`, `>=X[.Y[.Z]]`, `<X`, `>=A <B`, and `||` unions of
 * those), so the checker implements exactly that and REFUSES anything else as
 * `unsupported` (exit 2) instead of guessing. If you add a range form, extend
 * parseRange() AND its cases in the sibling test — do not widen it to pass silently.
 *
 * BASELINE is EMPTY and must stay empty: this guard was authored AFTER the offending
 * declaration was removed, against a measured-clean tree (76 peer declarations, 50
 * externally provided, 0 conflicts). There is no grandfathered debt to shrink, so ANY
 * entry appearing here is a regression, not history. Do NOT add entries to silence a
 * failure — fix the declaration.
 *
 * Pinned by packages/operator-core/lib/__tests__/check-peer-dep-conflicts.test.ts, which
 * drives this file against FIXTURE trees (never the real repo) via PEER_DEP_CONFLICTS_ROOT.
 */
import { readFileSync, existsSync, globSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The tree to judge. Overridable ONLY so the sibling test can prove this guard is
 * falsifiable against a fixture tree without mutating the shared checkout — the repo's
 * mutation-probe rule (CLAUDE.md "Proving a guard is falsifiable"): tier 2, mutate a COPY
 * outside the tree and point the subject at it. Zero sweep race, no trap needed.
 */
const ROOT = process.env.PEER_DEP_CONFLICTS_ROOT
  ? resolve(process.env.PEER_DEP_CONFLICTS_ROOT)
  : REPO_ROOT;

export const EXIT_OK = 0;
export const EXIT_CONFLICTS = 1;
export const EXIT_NOT_CHECKED = 2;

/**
 * Shrink-only BASELINE: `${workspaceName}::${dep}` pairs grandfathered as known-conflicting.
 * EMPTY BY CONSTRUCTION — see the header. Do not add entries.
 * @type {string[]}
 */
export const BASELINE = [];

/** Local packages are workspace-linked, not registry-resolved; their peer ranges are internal. */
const LOCAL_SCOPES = ['@papercusp/', '@papercup/'];
const isLocalPackage = (name) => LOCAL_SCOPES.some((s) => name.startsWith(s));

/**
 * Parse a concrete version into [major, minor, patch]. Returns null for anything with a
 * prerelease tag or a shape this checker will not judge — the caller reports those as
 * `unsupported` rather than assuming they pass.
 * @param {string} v
 */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const cmp = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

/** Parse a partial version like "5", "5.2", "5.2.1" into [maj,min,patch] + how many parts. */
function parsePartial(s) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  return {
    v: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    parts: m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1,
  };
}

/**
 * Expand ONE comparator token into concrete bounds.
 * Supported: `*`, `^X[.Y[.Z]]`, `>=X`, `>X`, `<=X`, `<X`, `=X` / bare `X.Y.Z`.
 * Throws UnsupportedRange for anything else (`~`, `x` wildcards, hyphen ranges, tags).
 * @returns {{op:string, v:number[]}[]}
 */
function expandComparator(tok) {
  if (tok === '*' || tok === '') return [];

  const caret = /^\^(.+)$/.exec(tok);
  if (caret) {
    const p = parsePartial(caret[1]);
    if (!p) throw new UnsupportedRange(tok);
    const [maj, min] = p.v;
    // Caret: >= the stated version, < the next "compatible" boundary.
    // major >= 1 -> next major. major 0 -> next minor (0.x releases may break on minor).
    const upper = maj >= 1 ? [maj + 1, 0, 0] : [0, min + 1, 0];
    return [
      { op: '>=', v: p.v },
      { op: '<', v: upper },
    ];
  }

  const rel = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(tok);
  if (!rel) throw new UnsupportedRange(tok);
  const op = rel[1] || '=';
  const p = parsePartial(rel[2]);
  if (!p) throw new UnsupportedRange(tok);

  // A partial bare/= version ("5") means the whole 5.x line, not exactly 5.0.0.
  if (op === '=' && p.parts < 3) {
    const [maj, min] = p.v;
    const upper = p.parts === 1 ? [maj + 1, 0, 0] : [maj, min + 1, 0];
    return [
      { op: '>=', v: p.v },
      { op: '<', v: upper },
    ];
  }
  return [{ op, v: p.v }];
}

export class UnsupportedRange extends Error {
  constructor(token) {
    super(`unsupported version range token: ${JSON.stringify(token)}`);
    this.name = 'UnsupportedRange';
    this.token = token;
  }
}

/**
 * Parse a full range into alternatives (the `||` union), each a comparator conjunction.
 * @param {string} range
 */
export function parseRange(range) {
  const raw = String(range).trim();
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'latest') {
    if (raw === 'x' || raw === 'latest') throw new UnsupportedRange(raw);
    return [[]]; // one alternative, no constraints => always satisfied
  }
  return raw.split('||').map((alt) => {
    const toks = alt.trim().split(/\s+/).filter(Boolean);
    // Hyphen ranges ("1.0.0 - 2.0.0") are not used here and must not be misparsed.
    if (toks.includes('-')) throw new UnsupportedRange(alt.trim());
    return toks.flatMap(expandComparator);
  });
}

/**
 * Does `version` satisfy `range`? Throws UnsupportedRange when it cannot be judged.
 * @param {string} version @param {string} range
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) throw new UnsupportedRange(`version:${version}`);
  const alts = parseRange(range);
  return alts.some((comparators) =>
    comparators.every(({ op, v: b }) => {
      const c = cmp(v, b);
      switch (op) {
        case '>=': return c >= 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        case '<': return c < 0;
        case '=': return c === 0;
        default: throw new UnsupportedRange(op);
      }
    }),
  );
}

/** Enumerate workspace package dirs from the root `workspaces` globs. */
function workspaceDirs(root) {
  const rootPkgPath = join(root, 'package.json');
  if (!existsSync(rootPkgPath)) return [];
  let rootPkg;
  try {
    rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  } catch {
    return [];
  }
  const dirs = new Set();
  for (const pattern of rootPkg.workspaces || []) {
    let matches = [];
    try {
      matches = globSync(pattern, { cwd: root });
    } catch {
      continue;
    }
    for (const d of matches) if (existsSync(join(root, d, 'package.json'))) dirs.add(d);
  }
  return [...dirs].sort();
}

/**
 * Compare each workspace's DECLARED peers against the copy package-lock.json records.
 *
 * WHY THIS IS A SEPARATE CHECK, and why the guard was incomplete without it: `npm install`
 * re-resolves from the MANIFESTS, but `npm ci` installs strictly from the LOCK. They are
 * two independent copies of the same declaration, and fixing one does not fix the other.
 * Measured 2026-08-19 on this repo: after libs/papercusp-shared's bad `dockview ^5` peer
 * was removed from its package.json, `npm install --dry-run` went green while
 * package-lock.json STILL carried `"dockview": "^5.0.0"` — so the clean-checkout `npm ci`
 * hydration path stayed broken (EI-20453932158555033, open 5 days), and a manifest-only
 * guard reported CLEAN the whole time. That false-clean is the failure this catches.
 *
 * Drift is judged as EQUALITY, not satisfiability: any divergence means the two install
 * paths can disagree, which is the defect regardless of which copy is "right".
 * @returns {{workspace:string, dir:string, dep:string, manifest:string|null, lock:string|null}[]}
 */
export function scanLockDrift(root = ROOT) {
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) return null; // caller reports NOT CHECKED rather than clean
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  const drift = [];
  for (const dir of workspaceDirs(root)) {
    const entry = lock.packages?.[dir];
    if (!entry) continue; // not recorded as a workspace in this lock — nothing to compare
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const fromManifest = pkg.peerDependencies || {};
    const fromLock = entry.peerDependencies || {};
    for (const dep of new Set([...Object.keys(fromManifest), ...Object.keys(fromLock)])) {
      const m = fromManifest[dep] ?? null;
      const l = fromLock[dep] ?? null;
      if (m !== l) drift.push({ workspace: pkg.name || dir, dir, dep, manifest: m, lock: l });
    }
  }
  return drift;
}

/**
 * Scan a tree for peer-range conflicts.
 * @returns {{conflicts:object[], unsupported:object[], drift:object[]|null, checked:number, unprovided:number, declarations:number, workspaces:number}}
 */
export function scan(root = ROOT) {
  const conflicts = [];
  const unsupported = [];
  let checked = 0;
  let unprovided = 0;
  let declarations = 0;
  const dirs = workspaceDirs(root);

  for (const dir of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const peers = pkg.peerDependencies || {};
    const wsName = pkg.name || dir;

    for (const [dep, range] of Object.entries(peers)) {
      declarations++;
      if (isLocalPackage(dep)) continue;

      // What the tree ACTUALLY provides is what npm resolves against — read the
      // installed copy, not root's declared range. A declared range is an intention;
      // the installed version is the fact that ERESOLVE is computed from.
      const installedPath = join(root, 'node_modules', dep, 'package.json');
      if (!existsSync(installedPath)) {
        // Not installed => an UNMET peer, a different class npm handles separately.
        // Out of scope on purpose: reporting it here would be a false positive.
        unprovided++;
        continue;
      }
      let installed;
      try {
        installed = JSON.parse(readFileSync(installedPath, 'utf8')).version;
      } catch {
        unsupported.push({ workspace: wsName, dir, dep, range, reason: 'unreadable installed package.json' });
        continue;
      }

      try {
        const ok = satisfies(installed, range);
        checked++;
        if (!ok) conflicts.push({ workspace: wsName, dir, dep, range, installed });
      } catch (err) {
        if (err instanceof UnsupportedRange) {
          unsupported.push({ workspace: wsName, dir, dep, range, installed, reason: err.message });
        } else throw err;
      }
    }
  }
  return {
    conflicts,
    unsupported,
    drift: scanLockDrift(root),
    checked,
    unprovided,
    declarations,
    workspaces: dirs.length,
  };
}

const key = (c) => `${c.workspace}::${c.dep}`;

function main() {
  const listMode = process.argv.includes('--list');
  const result = scan(ROOT);

  if (listMode) {
    console.log(`# peer-dep conflicts (${result.conflicts.length}) — BASELINE regeneration`);
    for (const c of result.conflicts) console.log(`  '${key(c)}', // peer ${c.range} vs installed ${c.installed}`);
    process.exit(EXIT_OK);
  }

  if (result.workspaces === 0) {
    console.error('check-peer-dep-conflicts: NOT CHECKED — no workspaces resolved under');
    console.error(`  ${ROOT}`);
    console.error('  (exit 2: could-not-judge is reported as such, never as clean)');
    process.exit(EXIT_NOT_CHECKED);
  }

  // ⚠ ORDER IS LOAD-BEARING: manifest/lock DRIFT is judged BEFORE the "nothing
  // examinable" and "unsupported range" exits below. Drift is a pure manifest-vs-lock
  // comparison and does not need anything installed — but both of those exits return
  // NOT_CHECKED, which is registered non-gating, so evaluating them first would
  // downgrade a real gating drift into a silent pass. Caught by the sibling test's
  // "FIRES when the lock still records a peer the manifest has dropped" case, whose
  // fixture has an empty manifest and therefore nothing installed to examine.
  if (result.drift === null) {
    console.error('check-peer-dep-conflicts: NOT CHECKED — package-lock.json is missing or');
    console.error(`  unreadable under ${ROOT}, so manifest/lock peer drift could not be judged.`);
    process.exit(EXIT_NOT_CHECKED);
  }

  if (result.checked === 0 && result.conflicts.length === 0 && result.drift.length === 0) {
    console.error('check-peer-dep-conflicts: NOT CHECKED — no externally-provided peer');
    console.error(`  declarations were examinable (declarations=${result.declarations},`);
    console.error(`  unprovided=${result.unprovided}). Is node_modules installed?`);
    process.exit(EXIT_NOT_CHECKED);
  }

  // Same load-bearing ordering rule as above: only take the non-gating "unsupported
  // range" exit when there is no gating drift waiting below it. A could-not-judge must
  // never preempt a finding we CAN judge.
  if (result.unsupported.length > 0 && result.drift.length === 0) {
    console.error(`check-peer-dep-conflicts: NOT CHECKED — ${result.unsupported.length} declaration(s)`);
    console.error('  use a range/version form this checker does not implement:\n');
    for (const u of result.unsupported) {
      console.error(`  ${u.workspace} (${u.dir})`);
      console.error(`    ${u.dep}: ${JSON.stringify(u.range)}  installed=${u.installed ?? '?'}`);
      console.error(`    ${u.reason}`);
    }
    console.error('\n  Extend parseRange() in scripts/check-peer-dep-conflicts.mjs AND add the case to');
    console.error('  packages/operator-core/lib/__tests__/check-peer-dep-conflicts.test.ts.');
    console.error('  Do NOT widen it to pass silently — an unjudged range must stay unjudged.');
    process.exit(EXIT_NOT_CHECKED);
  }

  if (result.drift.length > 0) {
    console.error(
      `check-peer-dep-conflicts: ${result.drift.length} peer declaration(s) DRIFTED between\n` +
        '  package.json and package-lock.json.\n',
    );
    console.error('`npm install` re-resolves from the MANIFEST; `npm ci` installs strictly from the');
    console.error('LOCK. While these disagree the two paths install different trees — so a green');
    console.error('`npm install` can sit next to a clean-checkout `npm ci` that still fails ERESOLVE.\n');
    for (const d of result.drift) {
      console.error(`  ${d.workspace} (${d.dir}) — ${d.dep}`);
      console.error(`    package.json      : ${d.manifest ?? '(absent)'}`);
      console.error(`    package-lock.json : ${d.lock ?? '(absent)'}\n`);
    }
    console.error('  Fix: regenerate the lock from the manifests —');
    console.error('    npm run install:safe -- install --package-lock-only --ignore-scripts');
    console.error('  (lock-only: it does NOT rewrite node_modules, so it cannot disturb other');
    console.error('   agents\' in-flight test runs on this shared tree.)');
    process.exit(EXIT_CONFLICTS);
  }

  const baseline = new Set(BASELINE);
  const fresh = result.conflicts.filter((c) => !baseline.has(key(c)));

  if (fresh.length === 0) {
    console.log(
      `check-peer-dep-conflicts: OK — ${result.checked} externally-provided peer ` +
        `declaration(s) across ${result.workspaces} workspaces satisfy the installed tree ` +
        `(${result.declarations} declared, ${result.unprovided} not installed/skipped).`,
    );
    process.exit(EXIT_OK);
  }

  console.error(`check-peer-dep-conflicts: ${fresh.length} peer range(s) the installed tree CANNOT satisfy.\n`);
  console.error('This breaks `npm install` / `npm run install:safe` TREE-WIDE with ERESOLVE —');
  console.error('for every agent, on every package, not just the workspace below.\n');
  for (const c of fresh) {
    console.error(`  ${c.workspace} (${c.dir})`);
    console.error(`    peerDependencies["${c.dep}"] = ${JSON.stringify(c.range)}`);
    console.error(`    but the installed tree provides ${c.dep}@${c.installed}\n`);
  }
  console.error('  Fix (pick one):');
  console.error('   (a) DROP the peer declaration if the workspace does not actually import the');
  console.error('       package — a peer that merely duplicates root\'s own dependency is not');
  console.error('       load-bearing, and duplication is what caused the incident this guards.');
  console.error('   (b) WIDEN the range to include the installed major (e.g. "^5 || ^6").');
  console.error('   (c) If the workspace genuinely needs the older major, that is a real');
  console.error('       conflict to resolve deliberately — do not paper over it here.');
  console.error('\n  Re-check:  npm run lint:peer-dep-conflicts');
  console.error('  Verify the tree resolves:  npm install --dry-run   (exit 0, no ERESOLVE)');
  process.exit(EXIT_CONFLICTS);
}

/**
 * Only run as the named CLI entry.
 *
 * Do not compare `import.meta.url` with `process.argv[1]` here. This module is also
 * imported by check-declared-deps-extracted.mjs, which is reachable from the bundled
 * Hono host through tsc-baseline-gate.mjs. Esbuild gives every bundled module the host
 * bundle's `import.meta.url`; an URL-equality guard therefore mistakes
 * dist-host/hono-host.mjs for this script and calls process.exit() during host boot.
 */
export const isDirectCliInvocation = (entryPath = process.argv[1]) =>
  typeof entryPath === 'string' &&
  /(?:^|[\\/])check-peer-dep-conflicts\.mjs$/.test(entryPath);

if (isDirectCliInvocation()) main();
