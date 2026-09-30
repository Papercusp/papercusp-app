/**
 * module-reachability.mjs — the MODULE-level companion to the npm-script census in
 * `check-lint-guard-reachability.mjs` (WI-41775, plan decisions D-013 → D-014 → D-015).
 *
 * WHY A SECOND POPULATION. The script census answers "is this declared `lint:*` guard
 * reachable from a blocking path?" It has no opinion about a detector that was never
 * given an npm script at all — a MODULE that exports a detector, ships with its own
 * passing unit test, is cited by a SHIPPED plan's code-truth audit, and is called by
 * nothing. Three of those were measured on 2026-08-26:
 *
 *   packages/operator-core/lib/release/external-prerequisite-ports.ts
 *   apps/operator/lib/release/prompt-divergence.ts
 *   apps/operator/lib/release/gitignored-asset-coverage.ts
 *
 * Each had zero production importers. Each passed `plans:audit`, because a code-truth
 * citation verifies that code EXISTS at a path, never that anything CALLS it.
 *
 * ── WHY NOT KNIP (measured, D-015 §4) ────────────────────────────────────────
 * knip asks "is this file imported by anything?" A module's OWN `*.test.ts` satisfies
 * that, because test files are knip entry points. Removing `lib/**` from the operator
 * entry glob surfaced 31 unused files and NEITHER target module among them. knip
 * cannot see this class at all — not as a configuration mistake, but definitionally:
 * "imported by nothing" and "called on no production path" are different questions,
 * and only the second one is the defect. A clean answer to the wrong question is
 * indistinguishable from a clean answer to the right one.
 *
 * ── THE PROBE, AND WHY IT NEEDS NO ROOT SET ──────────────────────────────────
 * A reachability walk normally needs entry roots, and a wrong root set silently
 * reclassifies the whole population — the expensive failure mode. This probe avoids
 * one entirely by running a FIXPOINT over the population instead:
 *
 *   a module is DEAD when every non-test file that imports it (or executes it by
 *   path) is itself already known dead — iterate until nothing changes.
 *
 * That is monotone, terminates in at most |population| rounds, and needs no notion of
 * "the real entry point". It catches transitive death INSIDE the population (module A
 * kept alive only by dead module B) at no extra cost. Its stated limit: a dead module
 * OUTSIDE the population still shields whatever it imports.
 *
 * ── FAIL OPEN, AND PROVE IT CAN SEE ──────────────────────────────────────────
 * `assessGraphHealth` is the instrument's own positive control. If the import graph
 * resolves nothing, or classifies EVERY population module as dead, the honest reading
 * is "the probe is broken", not "the repo is 100% dead code" — so the caller skips the
 * axis with a warning instead of red-pinning the fleet gate. This mirrors the coverage
 * axis's fail-open stance in the host script, and exists because a green whose scope
 * nobody checked is the failure this whole family of guards keeps rediscovering.
 */

/* ── THE SELF-OBSERVATION DEFECT (measured 2026-08-26, during this file's own bring-up)
 *
 * `parseReleasePathMentions` treats a literal `lib/release/**` path in a file as
 * evidence that the file EXECUTES that module. The guard's own acknowledged-unreachable
 * allowlist is a list of exactly those paths — so the first wired run reported ALL 21
 * known-dead modules as reachable, each with one "production importer":
 * `scripts/check-lint-guard-reachability.mjs`. The detector had observed itself and
 * concluded the patient was healthy.
 *
 * Note the DIRECTION, which is what makes it dangerous: it fails GREEN. An empty
 * finding set and a passing watermark are indistinguishable from a clean tree, so the
 * guard would have sat there measuring nothing, indefinitely, looking like diligence —
 * which is the precise failure mode this whole file exists to detect. It was caught
 * only because an earlier standalone probe had measured 21 and the numbers disagreed.
 *
 * The remedy is the repo's existing one for this class: `scripts/proc-guard.mjs` walks
 * the CALLER's own ancestor chain and excludes it before matching, so it cannot
 * self-match. `selfExclusionPaths()` is that idea for a file scan — and it is derived
 * from `import.meta.url`, never a hardcoded string, so renaming this file cannot
 * silently re-open the hole.
 */

import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_RE = /\.test\.tsx?$/;
const DECLARATION_RE = /\.d\.[cm]?ts$/;
const SOURCE_RE = /\.(?:tsx?|[cm]?js|[cm]ts)$/;
const EXECUTION_MANIFEST_RE =
  /(?:^|\/)package\.json$|^\.github\/(?:workflows|actions)\/.*\.ya?ml$/;

/** Repo-relative paths under a `lib/release/` directory — the gate's own detector domain. */
const DETECTOR_DIR_RE = /(?:^|\/)lib\/release\//;

/** A repo-relative path spelled inside a file (a spawn/exec target, not an import). */
const RELEASE_PATH_MENTION_RE =
  /(?:apps|packages|libs)\/[\w./-]*lib\/release\/[\w./-]+\.(?:tsx?|[cm]ts)/g;

/**
 * A WORKSPACE-relative detector path, as an npm script in that workspace's own
 * `package.json` must spell it: `"tsx lib/release/x-cli.ts"`.
 *
 * `RELEASE_PATH_MENTION_RE` above requires an `apps|packages|libs` prefix, so it can
 * NEVER match a manifest script — yet "named in an npm script" is the first case the
 * path-mention scan exists to cover. The result was a CLI whose npm script runs it
 * being reported as called by nothing, under a "wire or delete" remedy.
 *
 * The lookbehind is load-bearing: without it this also matches the TAIL of a
 * repo-relative mention (`packages/operator-core/lib/release/x.ts`), which would then
 * resolve against the WRONG workspace and could invent an edge to a same-named file —
 * a false NEGATIVE, a dead module reported alive. Applied to manifests only, where the
 * containing directory IS the workspace root that such a path is relative to.
 */
const WORKSPACE_RELATIVE_MENTION_RE =
  /(?<![\w./-])lib\/release\/[\w./-]+\.(?:tsx?|[cm]ts)/g;

/**
 * The instrument's own source files, repo-relative — the reacher set that must be
 * excluded so the census cannot resurrect a module merely by NAMING it in an allowlist
 * or a report. See the SELF-OBSERVATION note above.
 *
 * Derived from `import.meta.url`, so a rename moves the exclusion with the file instead
 * of silently re-opening the hole. The host script adds its own path the same way.
 *
 * @param {string} root absolute repo root
 * @returns {Set<string>} repo-relative paths
 */
export function selfExclusionPaths(root) {
  const here = fileURLToPath(import.meta.url);
  const rel = relative(root, here).split(sep).join('/');
  return new Set([rel]);
}

/** True for a test file — a test importer is NOT production usage (that is the whole point). */
export function isTestFile(file) {
  return TEST_RE.test(String(file));
}

/**
 * The population: non-test, non-declaration TypeScript modules under a `lib/release/`
 * directory. Derived by scanning the tracked file list, never hand-listed, so a module
 * added or deleted re-classifies itself with no edit here.
 *
 * `git ls-files` intentionally includes an index-known path that is deleted in the
 * working tree until that deletion is committed. The optional `exists` predicate lets
 * a current-tree caller exclude those paths immediately; otherwise the guard asks the
 * operator to DELETE a module and continues reporting it after the file is gone.
 *
 * @param {string[]} files repo-relative tracked paths
 * @param {(file:string)=>boolean} [exists] current-tree existence predicate
 * @returns {string[]} sorted repo-relative module paths
 */
export function selectDetectorModules(files, exists = () => true) {
  return files
    .filter((f) => exists(f))
    .filter((f) => /^(?:apps|packages|libs)\//.test(f))
    .filter((f) => DETECTOR_DIR_RE.test(f))
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !isTestFile(f) && !DECLARATION_RE.test(f))
    .sort();
}

/**
 * Every module specifier in `text`: `from '...'`, bare `import '...'`, dynamic
 * `import('...')`, and `require('...')`.
 *
 * ⚠ Pass COMMENT-STRIPPED text. A commented-out import would otherwise read as usage,
 * which is a false NEGATIVE — the module looks alive while it is dead.
 *
 * ⚠ THE GAP BEFORE THE SPECIFIER IS `\s*`, NOT `[ \t]*` — it MUST cross newlines.
 * A long specifier is wrapped by the formatter onto its own line, which is the
 * ORDINARY shape of a dynamic import of a workspace subpath:
 *
 *     const { x } = await import(
 *       "@papercusp/operator-core/lib/release/frozen-repair-agent-routing"
 *     );
 *
 * With a horizontal-only gap that edge is silently dropped while the single-line
 * spelling of the very same import resolves — so whether a module counts as wired
 * depended on how PRETTIER happened to wrap it. That under-counts importers, which
 * is the direction that INVENTS dead modules (see `buildImportGraph`'s note on
 * quietly dropped edges): three live green-checkpoint dependencies were reported
 * `TESTED-BUT-UNWIRED`, whose documented remedy is "wire or delete". Deleting them
 * would have removed live gate code. Regression-pinned in
 * `packages/operator-core/lib/__tests__/module-reachability.test.ts`.
 *
 * @param {string} text comment-stripped file contents
 * @returns {string[]} raw specifiers, in source order, deduplicated
 */
export function parseImportSpecifiers(text) {
  const src = String(text);
  const out = new Set();
  for (const m of src.matchAll(/(?:\bfrom|^[ \t]*(?:import|export))\s*['"]([^'"\n]+)['"]/gm)) {
    out.add(m[1]);
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  return [...out];
}

/**
 * Repo-relative `lib/release/**` paths spelled literally in `text` — how an executed
 * entry point (spawned with `tsx`, named in an npm script, referenced by a workflow) is
 * reached without ever being imported. Without this, every gate ENTRY module would be
 * reported dead, which is the obvious false positive this population invites.
 *
 * @param {string} text comment-stripped file contents
 * @returns {string[]} deduplicated repo-relative paths
 */
export function parseReleasePathMentions(text) {
  return [...new Set(String(text).match(RELEASE_PATH_MENTION_RE) ?? [])];
}

/**
 * Workspace-relative `lib/release/**` paths spelled literally in `text` — the npm-script
 * spelling of an executed entry point. The caller resolves each against the workspace
 * root; see `WORKSPACE_RELATIVE_MENTION_RE` for why that caller must be a manifest.
 *
 * @param {string} text comment-stripped file contents
 * @returns {string[]} deduplicated workspace-relative paths
 */
export function parseWorkspaceRelativeMentions(text) {
  return [...new Set(String(text).match(WORKSPACE_RELATIVE_MENTION_RE) ?? [])];
}

/**
 * Files whose literal detector paths can be execution evidence.
 *
 * Source files can import/spawn a detector. Package manifests and GitHub workflow /
 * composite-action manifests can execute one by command. Other JSON/YAML files are
 * passive data: baselines, corpora, evidence matrices and file-set hash manifests name
 * code without calling it. Counting those as reachers false-greens dead modules.
 *
 * @param {string} file repo-relative path
 * @returns {boolean}
 */
export function isExecutionPathMentionSource(file) {
  const path = String(file);
  return SOURCE_RE.test(path) || EXECUTION_MANIFEST_RE.test(path);
}

/** Normalize a POSIX-ish path, resolving `.` and `..` segments. */
function normalizePath(p) {
  const out = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function dirOf(file) {
  const i = String(file).lastIndexOf('/');
  return i === -1 ? '' : String(file).slice(0, i);
}

const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.mts',
  '/index.js',
  '/index.mjs',
];

/**
 * Resolve one specifier to a repo-relative file, or null when it points outside the
 * repo (a node_modules package, a node: builtin).
 *
 * Handles the two shapes that matter here: a relative specifier, and a workspace
 * package subpath (`@papercusp/operator-core/lib/release/x`). NodeNext's `./x.js`
 * spelling of a TypeScript `./x.ts` is resolved too — missing that would under-count
 * importers, i.e. report a live module as dead.
 *
 * @param {{specifier:string, fromFile:string, fileSet:Set<string>, workspaceDirByName?:Map<string,string>}} args
 * @returns {string|null}
 */
export function resolveSpecifier({ specifier, fromFile, fileSet, workspaceDirByName = new Map() }) {
  const spec = String(specifier);
  let base = null;

  if (spec.startsWith('.')) {
    base = normalizePath(`${dirOf(fromFile)}/${spec}`);
  } else {
    // Longest package name wins, so `@papercusp/x-core` is not matched by `@papercusp/x`.
    let bestName = null;
    for (const name of workspaceDirByName.keys()) {
      if (spec === name || spec.startsWith(`${name}/`)) {
        if (!bestName || name.length > bestName.length) bestName = name;
      }
    }
    if (bestName === null) return null;
    const dir = workspaceDirByName.get(bestName);
    const rest = spec === bestName ? 'index' : spec.slice(bestName.length + 1);
    base = normalizePath(`${dir}/${rest}`);
  }

  const bases = [base];
  const rewritten = base.replace(/\.(?:js|mjs|cjs)$/, '');
  if (rewritten !== base) bases.push(rewritten);

  for (const b of bases) {
    for (const suffix of RESOLUTION_SUFFIXES) {
      const candidate = b + suffix;
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Build the reverse edge map: target module -> the files that reach it, either by
 * importing it or by naming its path (an executed entry).
 *
 * Unresolved RELATIVE specifiers are reported rather than swallowed: a relative import
 * that fails to resolve means the resolver is wrong, and a resolver that quietly drops
 * edges under-counts importers in the exact direction that invents dead modules.
 *
 * PERFORMANCE, and why the prefilter is SOUND rather than a shortcut. Only a POPULATION
 * module can ever be classified dead, so every edge whose target is not one is computed
 * and discarded. A file can reach a `lib/release/**` module only by containing the
 * substring `release/` (in a path mention or a non-sibling specifier) or by sitting
 * inside a `lib/release/` directory itself, where a sibling import like
 * `'./prompt-divergence'` legitimately omits the word. Files failing both tests are
 * skipped before the expensive comment-strip — ~31k reads down to a few hundred parses.
 * `readFile` therefore returns RAW text and `stripComments` is applied here, by the
 * graph, which is the only layer that knows what it actually needs to parse.
 *
 * @param {{files:string[], readFile:(f:string)=>string, stripComments?:(t:string)=>string, workspaceDirByName?:Map<string,string>}} args
 */
export function buildImportGraph({
  files,
  readFile,
  stripComments = (t) => t,
  workspaceDirByName = new Map(),
}) {
  const fileSet = new Set(files);
  const importers = new Map();
  const pathMentions = new Map();
  const unresolvedRelative = [];
  let resolvedEdges = 0;

  const add = (map, target, from) => {
    if (target === from) return;
    if (!map.has(target)) map.set(target, new Set());
    map.get(target).add(from);
  };

  for (const file of files) {
    if (!isExecutionPathMentionSource(file)) continue;
    const raw = readFile(file);
    if (!raw) continue;

    // Sound prefilter — see the header. A sibling inside lib/release/ may import with a
    // bare './name', so directory membership is checked as well as the substring.
    if (!raw.includes('release/') && !DETECTOR_DIR_RE.test(file)) continue;
    const text = stripComments(raw);
    if (!text) continue;

    if (SOURCE_RE.test(file)) {
      for (const spec of parseImportSpecifiers(text)) {
        const target = resolveSpecifier({ specifier: spec, fromFile: file, fileSet, workspaceDirByName });
        if (target === null) {
          if (spec.startsWith('.')) unresolvedRelative.push({ from: file, specifier: spec });
          continue;
        }
        resolvedEdges += 1;
        add(importers, target, file);
      }
    }

    for (const mentioned of parseReleasePathMentions(text)) {
      if (fileSet.has(mentioned)) add(pathMentions, mentioned, file);
    }

    // A manifest's own npm scripts spell detector paths relative to the workspace root,
    // which for a package.json is exactly its own directory. See
    // WORKSPACE_RELATIVE_MENTION_RE for why this is restricted to manifests.
    if (/(?:^|\/)package\.json$/.test(file)) {
      for (const rel of parseWorkspaceRelativeMentions(text)) {
        const resolved = normalizePath(`${dirOf(file)}/${rel}`);
        if (fileSet.has(resolved)) add(pathMentions, resolved, file);
      }
    }
  }

  return { importers, pathMentions, unresolvedRelative, resolvedEdges };
}

/**
 * The fixpoint. A population module is DEAD when no live, non-test file imports it and
 * no live, non-test file executes it by path — iterated until stable, so a module kept
 * alive only by another dead population module dies with it.
 *
 * @param {{population:string[], importers:Map<string,Set<string>>, pathMentions?:Map<string,Set<string>>, excludeReachers?:Set<string>}} args
 */
export function findUnreachableModules({
  population,
  importers,
  pathMentions = new Map(),
  excludeReachers = new Set(),
}) {
  const dead = new Set();
  const reachersOf = (m) =>
    [...new Set([...(importers.get(m) ?? []), ...(pathMentions.get(m) ?? [])])].filter(
      (f) => f !== m && !excludeReachers.has(f),
    );

  let changed = true;
  let rounds = 0;
  while (changed) {
    changed = false;
    rounds += 1;
    for (const m of population) {
      if (dead.has(m)) continue;
      const live = reachersOf(m).filter((f) => !isTestFile(f) && !dead.has(f));
      if (live.length === 0) {
        dead.add(m);
        changed = true;
      }
    }
  }

  const rows = population.map((m) => {
    const reachers = reachersOf(m);
    const testOnly = reachers.filter(isTestFile).sort();
    const production = reachers.filter((f) => !isTestFile(f)).sort();
    return {
      module: m,
      dead: dead.has(m),
      // Retained even for a dead module: "imported only by a module that is itself
      // dead" and "imported by nothing" are different findings, and the reader needs
      // to be able to tell them apart without re-deriving the graph.
      productionImporters: production,
      testImporters: testOnly,
      testedButUnwired: dead.has(m) && testOnly.length > 0,
    };
  });

  return { rows, dead: [...dead].sort(), rounds };
}

/**
 * @typedef {{
 *   module: string,
 *   dead: boolean,
 *   productionImporters?: string[],
 *   testImporters?: string[],
 *   testedButUnwired?: boolean,
 * }} ShipmentReachabilityRow
 *
 * @typedef {{
 *   status: 'classified' | 'unclassified',
 *   kind?: string,
 *   citation?: {kind: string, path: string},
 *   decision?: string,
 *   test?: string,
 *   action?: string,
 *   reason?: string,
 *   errors?: string[],
 * }} ShipmentDisposition
 *
 * @typedef {ShipmentReachabilityRow & {shipmentDisposition: ShipmentDisposition}} ShipmentDispositionInventoryRow
 */

/**
 * Turn the measured graph into the shipment-facing module inventory.
 *
 * A module with a live non-test importer is automatically classified as `wired`, and
 * the importer path is retained as the citation. A module with no production caller
 * must carry a structured attestation: either an approved `seam` decision plus a test,
 * or an explicit `dead` disposition with an action/reason. Missing or malformed
 * attestations remain visible as unclassified rows instead of silently becoming an
 * allowlist entry.
 *
 * @param {{rows: ShipmentReachabilityRow[], dispositions?: Map<string, object|string>}} args
 * @returns {ShipmentDispositionInventoryRow[]} generated shipment inventory rows
 */
export function buildShipmentDispositionInventory({ rows, dispositions = new Map() }) {
  return (rows ?? []).map((row) => {
    const productionCaller =
      !row.dead && (row.productionImporters ?? []).find((file) => !isTestFile(file));
    if (productionCaller) {
      return {
        ...row,
        shipmentDisposition: {
          status: 'classified',
          kind: 'wired',
          citation: {
            kind: 'non-test-production-caller',
            path: productionCaller,
          },
        },
      };
    }

    const raw = dispositions.get(row.module);
    const attestation =
      typeof raw === 'string'
        ? { kind: 'dead', action: 'wire-or-delete', reason: raw }
        : raw && typeof raw === 'object'
          ? raw
          : null;
    const errors = [];

    if (!attestation) {
      errors.push('missing shipment disposition');
    } else if (attestation.kind === 'seam') {
      if (!/^D-\d+$/.test(String(attestation.decision ?? ''))) {
        errors.push('seam disposition requires an approved D-NNN decision');
      }
      if (!/\.test\.[cm]?[jt]sx?$/.test(String(attestation.test ?? ''))) {
        errors.push('seam disposition requires a test-file citation');
      }
    } else if (attestation.kind === 'dead') {
      if (!String(attestation.action ?? '').trim()) {
        errors.push('dead disposition requires an explicit action');
      }
      if (!String(attestation.reason ?? '').trim()) {
        errors.push('dead disposition requires a reason');
      }
    } else {
      errors.push(`unknown shipment disposition kind: ${String(attestation.kind ?? '(missing)')}`);
    }

    return {
      ...row,
      shipmentDisposition: {
        status: errors.length ? 'unclassified' : 'classified',
        ...(attestation ?? {}),
        errors,
      },
    };
  });
}

/**
 * Find modules whose generated inventory has no valid shipment disposition.
 *
 * @param {ShipmentDispositionInventoryRow[]} inventory
 * @returns {ShipmentDispositionInventoryRow[]}
 */
export function findUnclassifiedShipmentModules(inventory) {
  return (inventory ?? []).filter((row) => row.shipmentDisposition?.status !== 'classified');
}

/**
 * The instrument's positive control. Answers "did this probe actually SEE the tree?"
 * before any verdict derived from it is believed.
 *
 * A probe that classifies the entire population dead has almost certainly failed to
 * resolve imports at all — the graph is broken, not the repo. Reporting that as a wall
 * of violations would red-pin the fleet gate on an instrument fault, so the caller is
 * told to skip the axis instead.
 *
 * @param {{resolvedEdges:number, population:string[], dead:string[], unresolvedRelative:{from:string,specifier:string}[]}} args
 * @returns {{measurable:boolean, reason:string|null, unresolvedRelativeCount:number}}
 */
export function assessGraphHealth({ resolvedEdges, population, dead, unresolvedRelative }) {
  const unresolvedRelativeCount = unresolvedRelative.length;
  if (resolvedEdges === 0) {
    return {
      measurable: false,
      reason: 'the import graph resolved ZERO edges — the resolver, not the tree, is broken',
      unresolvedRelativeCount,
    };
  }
  if (population.length > 0 && dead.length === population.length) {
    return {
      measurable: false,
      reason:
        `every one of ${population.length} modules classified unreachable — a probe that finds ` +
        'nothing alive has failed to see the tree, not proven the tree is dead',
      unresolvedRelativeCount,
    };
  }
  return { measurable: true, reason: null, unresolvedRelativeCount };
}

/**
 * DEFAULT GRACE PERIOD for a newly-added detector module, in days.
 *
 * Sized from measurement, not taste: 16 new `lib/release/**` modules were added in the
 * 7 days to 2026-08-26 (35 in 30 days). A module is normally WRITTEN in one commit and
 * WIRED in a later one, and git-sync sweeps the whole tree into commits every few
 * minutes — so without a grace period this axis fails the build on the ordinary
 * intermediate state of a peer's in-flight work, several times a day, for everybody.
 */
export const NEW_MODULE_GRACE_DAYS = 7;

/**
 * Split unreachable modules into the ones this axis may JUDGE and the ones that are
 * still IN FLIGHT.
 *
 * ⚠ THIS IS THE DIFFERENCE BETWEEN A DETECTOR AND A FLEET-WIDE OUTAGE. The axis exists
 * to catch modules that a SHIPPED plan certified while nothing calls them — those are
 * old by construction. A module added twenty minutes ago is not that; it is someone
 * mid-task whose next commit wires it. Judging it is not a false positive (the module
 * really is unreachable) — it is a PREMATURE TRUE positive, which is worse, because it
 * is unarguable and still wrong to block on.
 *
 * FAIL-OPEN on unknown age, deliberately, matching `assessGraphHealth`: a module with no
 * recorded add-date (untracked, or a git query that returned nothing) is treated as in
 * flight. An axis that red-pins the fleet whenever its OWN date lookup degrades teaches
 * everyone to distrust the leg, and a missed report costs one cycle where a false red
 * costs every agent's cycle.
 *
 * Pure by design: the caller supplies the dates, so this is testable without git.
 *
 * @param {{modules:{module:string}[], addedAtByModule:Map<string,number>, now:number, graceMs?:number}} args
 * @returns {{judged:{module:string}[], inFlight:{module:string, addedAt:number|null, ageDays:number|null}[]}}
 */
export function partitionByGracePeriod({
  modules,
  addedAtByModule,
  now,
  graceMs = NEW_MODULE_GRACE_DAYS * 24 * 60 * 60 * 1000,
}) {
  const judged = [];
  const inFlight = [];
  for (const row of modules) {
    const addedAt = addedAtByModule.get(row.module) ?? null;
    if (addedAt === null) {
      inFlight.push({ ...row, addedAt: null, ageDays: null });
      continue;
    }
    const age = now - addedAt;
    if (age < graceMs) {
      inFlight.push({ ...row, addedAt, ageDays: age / (24 * 60 * 60 * 1000) });
      continue;
    }
    judged.push(row);
  }
  return { judged, inFlight };
}

/**
 * How many of HEAD's most recent commits the grace clock reads. Wide enough that a frozen
 * repair queue's run of synthetic admission commits can never fill it.
 */
export const GRACE_CLOCK_WINDOW = 500;

/**
 * The clock the grace period is judged against: the JUDGED TREE's own newest commit time,
 * never the wall clock.
 *
 * ⚠ A FROZEN GATE CANDIDATE MUST GET THE SAME VERDICT EVERY TIME IT IS JUDGED. With
 * `Date.now()` the same sha passed at 00:36Z and failed at 01:39Z on 2026-09-30 (WI-10004093):
 * a module's 7-day grace expired between the two runs while the content stayed byte-identical,
 * so a queue that was converging went red on nothing anyone changed. Measuring age against the
 * tree's commits makes the verdict a function of the sha alone. On a working tree git-sync
 * commits every few minutes, so this trails the wall clock by minutes and the ordinary
 * behaviour is unchanged.
 *
 * The NEWEST time in HEAD's recent ancestry, not HEAD's own: repair-queue admission commits
 * carry a deterministic 2000-01-01 committer stamp, so on a repair head HEAD's time would put
 * every module decades before its own add date and the axis could never fail there. Their
 * ancestry reaches the frozen candidate, whose real time is the right clock.
 *
 * Falls back to the wall clock only when no commit time is readable, and says so via `source`,
 * so a degraded lookup is visible instead of silently reintroducing the drift.
 *
 * Pure by design: the caller supplies both readings, so this is testable without git.
 *
 * @param {{commitTimesMs:number[], wallClockMs:number}} args
 * @returns {{now:number, source:'commit-history'|'wall-clock'}}
 */
export function resolveGraceClock({ commitTimesMs, wallClockMs }) {
  const valid = commitTimesMs.filter((ms) => Number.isFinite(ms) && ms > 0);
  if (valid.length) return { now: Math.max(...valid), source: 'commit-history' };
  return { now: wallClockMs, source: 'wall-clock' };
}

/**
 * Source-level markers that a module is a HUMAN-INVOKED CLI ENTRYPOINT.
 *
 * ⚠ WHY THIS EXISTS. The reachability axis is keyed on IMPORT EDGES, so it structurally
 * cannot see the caller of a module whose only caller is a person typing
 * `tsx apps/operator/lib/release/foo.ts` per the module's own usage header. Measured
 * 2026-08-26: 10 of the 20 acknowledged-unreachable modules are exactly this. For them
 * "0 callers" is TRUE AND MEANINGLESS, and the natural reading of it — retire the module
 * — deletes working operator tooling.
 *
 * This does NOT feed the dead/alive computation. An entrypoint with nothing invoking it
 * anywhere in the tree really is unreachable FROM THE TREE, and that stays reportable.
 * It changes what the report SAYS about such a module, so a reader is told which of the
 * two very different remedies applies (wire it / retire it / neither — it is a tool).
 *
 * Heuristic and deliberately generous, matching this file's standing doctrine: a false
 * ENTRYPOINT credit costs a slightly softer report line, while a missed one restores the
 * misleading "0 callers — wire-or-retire" that this exists to stop.
 *
 * @param {string} source raw module text
 * @returns {string[]} marker names, empty when the module shows no entrypoint shape
 */
export function detectEntrypointMarkers(source) {
  if (typeof source !== 'string' || source.length === 0) return [];
  const markers = [];
  if (/^#!/.test(source)) markers.push('shebang');
  if (/\bprocess\.argv\b/.test(source)) markers.push('process.argv');
  if (/\bimport\.meta\.url\b/.test(source)) markers.push('import.meta.url');
  return markers;
}

/**
 * Cross-check each ACKNOWLEDGED module's hand-written REASON against what the import
 * graph actually measured, and report the ones that disagree.
 *
 * ⚠ WHY A GUARD NEEDS A GUARD. The acknowledgement list pairs a path with a prose reason
 * a human typed. That reason is code-describing metadata, and CLAUDE.md's standing rule
 * is that such metadata must be DERIVED, PINNED, or ATTESTED — never hand-maintained.
 * It was hand-maintained, and it drifted before it was a day old: measured 2026-08-26,
 * 3 of 20 reasons asserted "no caller" / "0 callers" for modules with real production
 * importers. Those strings are what a burn-down reads when deciding what to delete, so a
 * false one nominates a module that two live siblings import as the "strongest retire
 * candidate". This turns that from prose nobody re-checks into a build failure.
 *
 * Only DEAD rows are checked. A module that got WIRED is already reported by the
 * staleAcknowledged path, and reporting it twice for one cause buries the second finding.
 *
 * ⚠ DELIBERATELY NOT CHECKED: numeric claims ("1 test", "3 tests"). Test FILES vs test
 * CASES is genuinely ambiguous in the existing strings, so pinning counts would
 * manufacture failures for prose that is arguably correct. Only the CATEGORICAL claims
 * are unambiguous, and only those are pinned.
 *
 * @param {{rows: {module:string, dead:boolean, productionImporters:string[], testImporters:string[]}[],
 *          acknowledgements: Map<string,string>}} args
 * @returns {{module:string, reason:string, claim:string, contradictedBy:string[]}[]}
 */
export function findInaccurateAcknowledgements({ rows, acknowledgements }) {
  const violations = [];
  for (const row of rows ?? []) {
    if (!row?.dead) continue;
    const acknowledgement = acknowledgements?.get(row.module);
    const reason =
      typeof acknowledgement === 'string' ? acknowledgement : acknowledgement?.reason;
    if (typeof reason !== 'string' || reason.length === 0) continue;

    const production = row.productionImporters ?? [];
    const tests = row.testImporters ?? [];

    if (/\b(?:no callers?|0 callers?|zero callers?)\b/i.test(reason) && production.length > 0) {
      violations.push({
        module: row.module,
        reason,
        claim: 'no-caller',
        contradictedBy: [...production],
      });
    }
    if (/\b(?:no tests?|0 tests?|zero tests?)\b/i.test(reason) && tests.length > 0) {
      violations.push({
        module: row.module,
        reason,
        claim: 'no-test',
        contradictedBy: [...tests],
      });
    }
  }
  return violations;
}
