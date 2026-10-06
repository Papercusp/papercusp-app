#!/usr/bin/env node
/**
 * Shared PER-FILE tsc baseline gate (extracted from scripts/lint-tsc.mjs, EI-847).
 *
 * `scripts/lint-tsc.mjs` pioneered this for operator-core (P-010/WI-4535 — see that file's
 * header for the full "why per-file, not a global count" rationale + the two hard rules
 * that carry to EVERY consumer of this module:
 *
 *   1. RATCHET-ONLY-DOWN, on an EXPLICIT `--update` only.
 *   2. TS1xxx HARD-FAIL: any TS1xxx diagnostic fails regardless of the counts. Most are parser
 *      errors, but the range also contains semantic/type errors such as TS1320.
 *
 * This module is the reusable core so a SECOND project (or a third, a fourth, …) gets the
 * same baseline-gated, `--mine`-scoped, ratchet-only-down typecheck WITHOUT forking the
 * policy logic — only `tscCommand` / `baselineFile` / `label` differ per project. See
 * `scripts/lint-tsc.mjs` (operator-core) and `scripts/lint-tsc-operator-vite.mjs`
 * (operator-vite) for the two thin per-project CLIs built on this.
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findUnextractedDeps } from '../check-declared-deps-extracted.mjs';
import { recordStandingReds, recordGateRun, DWELL_SEC } from './tsc-red-observations.mjs';
import { isRootWorkspace, rootWorkspacePatterns } from './submodule-installs.mjs';
import {
  baselineWithinScope,
  formatTscServiceBanner,
  tscServiceEligibility,
  typecheckViaService,
} from './tsc-service.mjs';

/**
 * One diagnostic parsed out of tsc's output.
 *
 * @typedef {object} TscErrorEntry
 * @property {string | null} file - null when the diagnostic carries no file (unattributable).
 * @property {string} code - The `TSnnnn` code.
 */

/**
 * One file's standing against its baseline.
 *
 * @typedef {object} PerFileGateEntry
 * @property {string} file
 * @property {number} baseline
 * @property {number} current
 * @property {number} delta - `current - baseline`; positive is a regression.
 * @property {boolean} [dirty] - Set when the dirty set could be read: the file is uncommitted in
 *   the shared working tree, i.e. a peer is very likely mid-edit (EI-19278299775574199). On a
 *   regression this is populated only for an unscoped/bare run, where a dirty row is otherwise
 *   reported as an unhedged failure. `undefined` means UNKNOWN, never "clean" — see
 *   `partitionNewFilesByLiveEdit`.
 */

/**
 * A baseline owned by ANOTHER package, whose recorded counts this gate inherits for
 * files under `prefix` rather than assuming an implicit 0 (EI-18649014117371738).
 *
 * @typedef {object} ForeignBaselineSource
 * @property {string} prefix - Repo-relative path prefix of the files the other package owns.
 * @property {Record<string, number>} files - That package's own per-file baseline map.
 * @property {string} [label]
 */

/**
 * The verdict vocabulary. `fail-new-file` is split out of `peerDrift` so `--mine` can
 * never greenwash a brand-new file: absence from the git-status changed set does not
 * prove a new file isn't yours, because git-sync auto-commits this shared tree every few
 * minutes (EI-18766822535373909).
 *
 * @typedef {'fail-syntax' | 'fail-regressed' | 'fail-attributed' | 'fail-new-file' | 'ok-peer-drift' | 'ok-ratchet' | 'ok-below' | 'ok'} PerFileGateVerdict
 */

/**
 * A cross-package baseline named by PATH, for `runTscBaselineGate`'s options. Distinct
 * from `ForeignBaselineSource`, which carries the already-LOADED `files` map — this is
 * what a CLI passes in before the gate reads it off disk.
 *
 * @typedef {object} ForeignBaselineRef
 * @property {string} prefix - Repo-relative path prefix the owning package covers.
 * @property {string} baselineFile - Absolute path to that package's `.tsc-baseline.json`.
 * @property {string} [label]
 */

/**
 * Options for the shared CLI entry point.
 *
 * ⚠ Written as a `@typedef` with `@property` tags, NOT as an inline `@param {{ … }}`
 * object type. TypeScript's JSDoc TYPE parser does not accept `//` comments inside a type
 * expression: this options bag was previously documented inline with a `//` gloss per
 * field, and everything from the first comment-only continuation line onward — including
 * `foreignBaselines` — was silently dropped from the emitted type while still reading as
 * fully documented. `@property` descriptions are prose by design, so the annotation and
 * the explanation can coexist without one eating the other.
 *
 * @typedef {object} RunTscBaselineGateOptions
 * @property {string} root - cwd the tscCommand runs from (repo root).
 * @property {string} tscCommand - e.g. 'npx tsc -p apps/foo/tsconfig.json --noEmit --incremental false'.
 * @property {string | null} [preTscCommand] - Optional generated-input preflight. The standard
 *   declaration generator publishes only explicitly selected modules on a scoped run.
 * @property {string} baselineFile - Absolute path to this project's `.tsc-baseline.json`.
 * @property {string} label - Human label for console output, e.g. 'operator-core'.
 * @property {string[]} argv - `process.argv.slice(2)`.
 * @property {string} [countField] - Baseline JSON field the derived total is written to on
 *   `--update` (default 'errorCount'; operator-core keeps its legacy 'operatorCoreErrorCount'
 *   name for back-compat with existing tooling).
 * @property {ForeignBaselineRef[]} [foreignBaselines] - Cross-package files this gate
 *   MEASURES but does not OWN: a file under `prefix` that is absent from this gate's
 *   baseline inherits the owning package's recorded count instead of an implicit 0. See
 *   `effectiveBaselineByFile` (EI-18649014117371738).
 */

/**
 * The full decision for one run.
 *
 * @typedef {object} PerFileGateResult
 * @property {PerFileGateVerdict} verdict
 * @property {PerFileGateEntry[]} regressions
 * @property {PerFileGateEntry[]} improvements
 * @property {PerFileGateEntry[]} [attributed]
 * @property {PerFileGateEntry[]} [typeAttributed] - Subset of `attributed` NOT in the caller's
 *   changed-file set, attributed instead because the file or its compiler diagnostic references
 *   an exported type/interface one of the changed files also exports (EI-18756182128903253's
 *   cause-aware widening).
 * @property {PerFileGateEntry[]} [peerDrift]
 * @property {PerFileGateEntry[]} [newFiles] - Regressions in files ABSENT from the baseline.
 * @property {number} total
 * @property {number} baselineTotal
 * @property {Record<string, number>} [newBaselineByFile] - FULL replacement map, written only by
 *   a BARE `--update` (no `--mine`/`--files`). Never set on a scoped run — see `ratchetFiles`.
 * @property {PerFileGateEntry[]} [ratchetFiles] - EI-19444246913245434. The caller's OWN improved
 *   files on a SCOPED `--update`, to be lowered individually via `mergeRatchetIntoBaseline`.
 *   Deliberately a payload rather than a verdict: a ratchet is an EFFECT, and modelling it as a
 *   mutually-exclusive verdict is what let `ok-peer-drift` silently swallow it. Carried on any
 *   non-failing verdict, so restoring the write costs the existing reporting nothing.
 * @property {string[]} [brokenFiles]
 * @property {string[]} [unattributedBrokenFiles] - Files with TS1xxx hard-fail diagnostics OUTSIDE the caller's
 *   `changedFiles` set (EI-19321179234197157). Never gates the verdict — reported so the caller
 *   knows tsc's counts for other files may be under/over-reported while these stay broken — but a
 *   TS1xxx diagnostic in a file the caller did not name must not fail a `--mine`/`--files`-scoped run,
 *   mirroring how an unattributed TYPE-error regression is `peerDrift`, not a gate failure.
 */

/**
 * `path/to/file.ts(12,5): error TS2322:` — a diagnostic tsc pinned to a location.
 *
 * Shared by `parseTscErrors` (which counts) and `diagnosticLinesForFiles` (which quotes) so the
 * two can never disagree about what counts as an attributed error: a file that shows `+1` in the
 * summary must be able to produce the line behind it.
 */
const LOCATED_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;

/**
 * Parse tsc output into { file, code } entries (file null when unattributable).
 *
 * @param {string} tscOutput
 * @returns {TscErrorEntry[]}
 */
export function parseTscErrors(tscOutput) {
  const errors = [];
  // EI-21523730940957057 — a compiler stream that repeats a diagnostic VERBATIM used to inflate
  // that file's count once per copy, because this loop counts lines and `countByFile` increments
  // per entry. A tripled stream became a tripled count, and the gate reported `status=regressed`
  // for files whose DISTINCT error count still equalled their baseline. The false red is shaped
  // exactly like a real one, so it costs a full triage every time it fires.
  //
  // The identity of a located diagnostic is file+line+column+code, and this is the LAST point
  // where it exists: the emitted entry is deliberately `{file, code}` (asserted with strict
  // equality by lint-tsc.test.ts, and explained in packages/operator-core/lib/tsc-diagnostics.ts),
  // so nothing downstream CAN tell a duplicate from a distinct error. Hence dedupe HERE, using
  // line/column without carrying them — the documented narrow shape is unchanged.
  //
  // Scoped deliberately to BYTE-IDENTICAL repeats, keyed on the raw pre-normalization spelling:
  //   - Unattributed diagnostics (the bare branch) carry no position, so they have no identity to
  //     dedupe on — two distinct global errors may share a code. They are left alone.
  //   - The same source reported under two path spellings (`pkg/x.ts` vs `../../../pkg/x.ts`,
  //     EI-21142032293145491) is NOT collapsed here: those are different keys at parse time, and
  //     `nested worktree diagnostic paths` in lint-tsc.test.ts asserts that two genuinely
  //     different errors arriving that way must still count as 2.
  const seenLocated = new Set();
  for (const line of String(tscOutput).split('\n')) {
    const m = line.match(LOCATED_DIAGNOSTIC);
    if (m) {
      const identity = `${m[1]}\x00${m[2]}\x00${m[3]}\x00${m[4]}`;
      if (seenLocated.has(identity)) continue;
      seenLocated.add(identity);
      errors.push({ file: m[1], code: m[4] });
      continue;
    }
    const bare = line.match(/error (TS\d+):/);
    if (bare) errors.push({ file: null, code: bare[1] });
  }
  return errors;
}

/**
 * Collapse a compiler path into the repo-relative spelling used by the baseline.
 * A linked worktree can report the same source as both `packages/foo.ts` and
 * `../../../packages/foo.ts`; this helper is pure so the path rule is unit-testable.
 *
 * @param {string | null} file
 * @param {{root:string, canonicalRoot?:string}} roots
 * @returns {string | null}
 */
export function normalizeDiagnosticPath(file, { root, canonicalRoot = root }) {
  if (file === null) return null;
  const absolute = resolve(root, file);
  const candidates = [...new Set([resolve(root), resolve(canonicalRoot)])];
  for (const candidate of candidates) {
    const repoRelative = relative(candidate, absolute);
    if (repoRelative === '' || (!repoRelative.startsWith('..') && !isAbsolute(repoRelative))) {
      return repoRelative.replaceAll('\\', '/');
    }
  }
  return file.replaceAll('\\', '/');
}

function realpathOrResolve(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function diagnosticPathRoots(root) {
  const workingRoot = realpathOrResolve(root);
  let canonicalRoot = workingRoot;
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    if (commonDir) canonicalRoot = realpathOrResolve(dirname(resolve(root, commonDir)));
  } catch {
    // A packaged/non-git checkout has no second root to normalize against.
  }
  return { root: workingRoot, canonicalRoot };
}

function normalizeResolvedDiagnosticPath(file, roots) {
  const physical = realpathOrResolve(resolve(roots.root, file));
  return normalizeDiagnosticPath(physical, roots);
}

/**
 * @param {TscErrorEntry[]} errors
 * @param {{root:string, canonicalRoot:string}} roots
 * @returns {TscErrorEntry[]}
 */
export function normalizeTscErrorPaths(errors, roots) {
  return errors.map((error) =>
    error.file === null
      ? error
      : { ...error, file: normalizeResolvedDiagnosticPath(error.file, roots) },
  );
}

/**
 * A module-resolution diagnostic that may be explained by a package being half-written during
 * a concurrent npm install. This is intentionally narrower than every TS2307/TS7016: one
 * missing module can be a real code defect, while a burst that names a directly-declared package
 * absent from node_modules is the distinctive shared-tree failure this guard can substantiate.
 *
 * @typedef {object} MissingModuleDiagnostic
 * @property {string | null} file
 * @property {'TS7016' | 'TS2307'} code
 * @property {string} module
 */

/**
 * Two matching diagnostics are the minimum signal. A single TS7016 is common for an intentionally
 * untyped package; two or more diagnostics for a package that the dependency doctor cannot find on
 * disk is the measured concurrent-install shape (EI-19366483607548056).
 */
export const MID_INSTALL_DIAGNOSTIC_MIN = 2;

const MISSING_MODULE_DIAGNOSTIC =
  /error (TS7016|TS2307):\s+(?:Could not find a declaration file for module|Cannot find module)\s+['"]([^'"]+)['"]/;

/**
 * Parse only TS7016/TS2307 diagnostics whose message names a module specifier.
 *
 * @param {string} tscOutput
 * @returns {MissingModuleDiagnostic[]}
 */
export function parseMissingModuleDiagnostics(tscOutput) {
  const diagnostics = [];
  for (const line of String(tscOutput ?? '').split('\n')) {
    const match = line.match(MISSING_MODULE_DIAGNOSTIC);
    if (!match) continue;
    const located = line.match(LOCATED_DIAGNOSTIC);
    diagnostics.push({
      file: located?.[1] ?? null,
      code: /** @type {'TS7016' | 'TS2307'} */ (match[1]),
      module: match[2],
    });
  }
  return diagnostics;
}

/**
 * Match a module subpath (`@scope/pkg/subpath`) to its declared package name.
 * Relative and absolute specifiers are deliberately not candidates.
 *
 * @param {string} moduleSpecifier
 * @returns {string | null}
 */
export function packageNameFromModuleSpecifier(moduleSpecifier) {
  const parts = String(moduleSpecifier ?? '').split('/');
  if (parts[0] === '.' || parts[0] === '..' || parts[0] === '' || parts[0].startsWith('/')) return null;
  if (parts[0].startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] ?? null;
}

/**
 * Decide whether the tsc output plus a dependency-doctor snapshot proves the mid-install shape.
 * The returned diagnostics are the subset that actually match a missing direct dependency, so
 * an unrelated TS2307 elsewhere cannot manufacture the warning.
 *
 * @param {{tscOutput:string, missing?:{dep:string,workspace?:string}[], minimum?:number}} input
 * @returns {{diagnostics:MissingModuleDiagnostic[], dependencies:string[]} | null}
 */
export function detectUnextractedDependencyDiagnostics({ tscOutput, missing = [], minimum = MID_INSTALL_DIAGNOSTIC_MIN }) {
  const diagnostics = parseMissingModuleDiagnostics(tscOutput);
  const missingDeps = [...new Set(
    missing
      .map((entry) => (typeof entry?.dep === 'string' ? entry.dep : ''))
      .filter(Boolean),
  )];
  if (missingDeps.length === 0) return null;
  const matched = diagnostics.filter((diagnostic) =>
    missingDeps.some(
      (dep) =>
        packageNameFromModuleSpecifier(diagnostic.module) === dep ||
        diagnostic.module === dep ||
        diagnostic.module.startsWith(`${dep}/`),
    ),
  );
  if (matched.length < minimum) return null;
  return {
    diagnostics: matched,
    dependencies: missingDeps.filter((dep) =>
      matched.some((d) => d.module === dep || d.module.startsWith(`${dep}/`)),
    ),
  };
}

/**
 * Format the shared marker used by test-file routing, enriched with the tsc/doctor evidence.
 * This is reporting only: callers must retain tsc's original non-zero exit status.
 *
 * @param {{label:string, diagnostics:MissingModuleDiagnostic[], dependencies:string[]}} input
 * @returns {string[]}
 */
export function formatMidInstallWarning({ label, diagnostics, dependencies }) {
  const modules = [...new Set(diagnostics.map((diagnostic) => diagnostic.module))];
  return [
    `TEST_FILE_MID_INSTALL_SUSPECTED label=${label} tscDiagnostics=${diagnostics.length} codes=TS7016/TS2307 modules=${modules.join(',')}`,
    `doctor:deps=DECLARED_DEPS_UNEXTRACTED dependencies=${dependencies.join(',')} — these diagnostics may be spurious while a peer runs npm install on the shared tree.`,
    'The typecheck remains non-zero; do not treat this annotation as a pass. Check locks:list / `ps aux | grep "npm install"`, then retry after the install finishes.',
  ];
}

/**
 * TypeScript parser/scanner diagnostic codes in the TS1xxx range.
 *
 * Do not use the whole /^TS1\d{3}$/ range here: TS1320 is a semantic await/type
 * diagnostic even though it shares that numeric range. This set is derived from
 * the parser and scanner's Diagnostics references in the TypeScript 6.0.3
 * bundled compiler. Keep the set explicit so a semantic diagnostic cannot be
 * mislabeled as a syntax failure just because the compiler assigned it a 1xxx
 * code.
 *
 * @type {Set<string>}
 */
const SYNTAX_DIAGNOSTIC_CODES = new Set(
  [
    1002, 1003, 1005, 1007, 1010, 1011, 1012, 1034, 1068, 1069, 1109, 1110, 1121, 1124, 1125,
    1126, 1127, 1128, 1129, 1130, 1131, 1132, 1134, 1135, 1136, 1137, 1138, 1139, 1140,
    1142, 1144, 1145, 1146, 1160, 1161, 1177, 1178, 1179, 1180, 1181, 1198, 1199, 1209,
    1223, 1228, 1260, 1351, 1352, 1353, 1357, 1359, 1369, 1381, 1382, 1385, 1386, 1387,
    1388, 1389, 1390, 1433, 1434, 1435, 1436, 1437, 1438, 1439, 1440, 1441, 1442, 1443,
    1472, 1477, 1478, 1487, 1488, 1489, 1490, 1499, 1500, 1501, 1502, 1503, 1504, 1505,
    1506, 1507, 1508, 1509, 1510, 1511, 1512, 1513, 1514, 1515, 1516, 1517, 1518, 1519,
    1520, 1521, 1522, 1523, 1524, 1525, 1526, 1527, 1528, 1529, 1530, 1531, 1532, 1533,
    1534, 1535, 1536, 1537, 1538,
  ].map((code) => `TS${code}`),
);

/**
 * Files carrying parser/scanner diagnostics. This is the syntax projection only;
 * the gate's hard-fail policy intentionally remains broader (see hardFailFiles).
 *
 * @param {TscErrorEntry[]} errors
 * @returns {string[]}
 */
export function syntaxBrokenFiles(errors) {
  /** @type {Set<string>} */
  const files = new Set();
  for (const e of errors) {
    if (SYNTAX_DIAGNOSTIC_CODES.has(e.code)) files.add(e.file ?? '(unattributed)');
  }
  return [...files].sort();
}

/**
 * Files carrying the gate's historical TS1xxx hard-fail diagnostics.
 *
 * A TS1xxx diagnostic still fails the baseline gate regardless of the baseline,
 * including semantic diagnostics such as TS1320. Keep this separate from
 * syntaxBrokenFiles so the failure policy does not misclassify the diagnostic.
 *
 * @param {TscErrorEntry[]} errors
 * @returns {string[]}
 */
function hardFailFiles(errors) {
  /** @type {Set<string>} */
  const files = new Set();
  for (const e of errors) {
    if (/^TS1\d{3}$/.test(e.code)) files.add(e.file ?? '(unattributed)');
  }
  return [...files].sort();
}

/**
 * Aggregate parsed errors into a { file: count } map. Unattributable errors bucket under '(unattributed)'.
 *
 * @param {TscErrorEntry[]} errors
 * @returns {Record<string, number>}
 */
export function countByFile(errors) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const e of errors) {
    const key = e.file ?? '(unattributed)';
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
}

/**
 * @param {Record<string, number>} map
 * @returns {number}
 */
export function sumValues(map) {
  let total = 0;
  for (const v of Object.values(map)) total += v;
  return total;
}

/**
 * The set of repo-relative paths the caller has changed (staged, unstaged, or untracked), for
 * `--mine` scoping. Fail-SOFT: a git failure (packaged install, detached state) returns an empty
 * set, which under `--mine` means "attribute nothing to me" — never a crash, never a false pass on
 * a real CI gate (CI runs bare, without `--mine`).
 *
 * @param {string} [root] - Repo root to run git in.
 * @returns {Set<string>}
 */
export function gitChangedFiles(root) {
  try {
    const out = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const files = new Set();
    for (const line of out.split('\n')) {
      if (line.length < 4) continue;
      // "XY <path>" or "XY <old> -> <new>" for renames — take the destination path.
      const rest = line.slice(3).trim();
      const path = rest.includes(' -> ') ? rest.split(' -> ').pop().trim() : rest;
      if (path) files.add(path.replace(/^"|"$/g, ''));
    }
    return files;
  } catch {
    return new Set();
  }
}

/**
 * Resolve the local source files reachable from a set of diagnostics. A full-tree tsc run is
 * not an atomic snapshot on the shared checkout: a peer can edit an imported module while tsc is
 * reading its importer, then leave only the importer in the diagnostic. Walking direct local
 * imports keeps the concurrency check scoped to the error site rather than declaring every
 * unrelated edit in the tree inconclusive.
 *
 * @param {{root:string, files:string[]|Set<string>}} input
 * @returns {Set<string>} repo-relative paths (including the seed files)
 */
export function relatedSourceFiles({ root, files }) {
  const importers = [...new Set(files ?? [])].filter((file) => file && file !== '(unattributed)');
  const seen = new Set(importers);
  const importRe = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const extensions = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.d.mts', '.d.cts'];
  for (const importer of importers) {
    let source;
    try {
      source = readFileSync(resolve(root, importer), 'utf8');
    } catch {
      continue;
    }
    importRe.lastIndex = 0;
    for (const match of source.matchAll(importRe)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      const importerDir = dirname(importer);
      const raw = resolve(root, importerDir, specifier);
      const candidates = [];
      for (const extension of extensions) candidates.push(raw + extension);
      for (const extension of extensions) candidates.push(resolve(raw, `index${extension}`));
      const resolved = candidates.find((candidate) => {
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
      if (!resolved) continue;
      const relativePath = relative(root, resolved).replaceAll('\\', '/');
      if (!relativePath.startsWith('..') && !seen.has(relativePath)) {
        seen.add(relativePath);
      }
    }
  }
  return seen;
}

/**
 * Find dependency-cone files whose mtime is newer than a typecheck's start. Such a file may have
 * been half-written while tsc read the tree, so a regression that names the cone is INCONCLUSIVE
 * until the caller re-runs against a settled snapshot.
 *
 * @param {{root:string, files:string[]|Set<string>, runStartMs:number, dirtyFiles?:Set<string>|null}} input
 * @returns {string[]} repo-relative paths, sorted and de-duplicated
 */
export function filesModifiedDuringRun({ root, files, runStartMs, dirtyFiles = null }) {
  if (!Number.isFinite(runStartMs)) return [];
  const candidates = relatedSourceFiles({ root, files });
  const modified = [];
  for (const file of candidates) {
    try {
      if (statSync(resolve(root, file)).mtimeMs > runStartMs && (dirtyFiles === null || dirtyFiles.has(file))) {
        modified.push(file);
      }
    } catch {
      // A file removed during the run cannot prove either a clean or a concurrent regression.
      // Keep the guard fail-soft; the compiler's own diagnostic remains authoritative.
    }
  }
  return modified.sort((a, b) => a.localeCompare(b));
}

/**
 * EI-18731016038876755 — parse an EXPLICIT `--files=a.ts,b.ts` or `--files a.ts,b.ts` CLI flag
 * naming exactly the files the caller changed THIS session, as an alternative to `--mine`'s implicit
 * git-status-derived scoping. Large callers may use `--files-from=/path/to/json`, where the
 * response file contains a JSON array of paths; keeping the list out of argv avoids Linux's
 * exec E2BIG limit without changing the scoped-verdict semantics.
 *
 * WHY: `gitChangedFiles` (above) attributes "mine" from working-tree dirt (`git status`), which
 * on this concurrently-edited shared checkout includes every PEER's uncommitted edits too — not
 * just the caller's own. Observed live: `--mine` reported a regression in a file the calling
 * agent had never opened, because a peer had it mid-edit at that exact moment; re-running the
 * gate a minute later (once the peer's edit settled) gave the opposite verdict on the identical
 * command against the identical tree. `git status` cannot distinguish WHICH agent dirtied a
 * file on a shared checkout — there is no session-scoped signal to read there.
 *
 * `--files=` sidesteps the ambiguity entirely: the caller states which files are theirs
 * (e.g. from their own edit history / Edit-tool log this turn), and that explicit set is used
 * VERBATIM instead of the git-status guess — no heuristic, no false attribution. Passing
 * `--files=` also implies `--mine`-style scoping (a caller naming exact files obviously wants
 * the check scoped to them), so `--mine` need not be passed alongside it.
 *
 * Returns `null` when the flag is absent (falls through to the existing `--mine`/bare behavior
 * unchanged) — never an empty Set for "flag absent", so callers can tell "not scoped" apart from
 * "scoped to zero files" (a malformed `--files=` with no content, which is now the caller's own
 * bug to fix, not a silent no-op).
 *
 * @param {string[]} argv
 * @returns {Set<string> | null} null when the flag is absent; an EMPTY set means "scoped to zero files".
 */
export function parseExplicitFiles(argv) {
  const list = [];
  let sawExplicitFlag = false;
  const appendInlineFiles = (raw) => {
    list.push(...raw.split(',').map((s) => s.trim()).filter(Boolean));
  };
  const readResponseFiles = (rawPath, flag) => {
    const responsePath = rawPath.trim();
    if (!responsePath) {
      throw new Error(`${flag} requires a JSON response-file path`);
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(responsePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `could not read --files-from response file ${responsePath}: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!Array.isArray(parsed) || parsed.some((file) => typeof file !== 'string')) {
      throw new Error(`--files-from response file ${responsePath} must contain a JSON array of strings`);
    }
    return parsed.map((file) => file.trim()).filter(Boolean);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--files' || arg === '--files-from') {
      sawExplicitFlag = true;
      const values = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        values.push(argv[++i]);
        if (arg === '--files-from') break;
      }
      if (values.length === 0) {
        throw new Error(
          arg === '--files'
            ? '--files requires at least one path'
            : '--files-from requires a JSON response-file path',
        );
      }
      if (arg === '--files') {
        for (const value of values) appendInlineFiles(value);
      } else {
        list.push(...readResponseFiles(values[0], arg));
      }
      continue;
    }
    if (arg?.startsWith('--files=')) {
      sawExplicitFlag = true;
      appendInlineFiles(arg.slice('--files='.length));
      continue;
    }
    if (arg?.startsWith('--files-from=')) {
      sawExplicitFlag = true;
      list.push(...readResponseFiles(arg.slice('--files-from='.length), '--files-from='));
    }
  }
  return sawExplicitFlag ? new Set(list) : null;
}

/**
 * EI-18756182128903253 — the cause-aware widening (fix option 1 of the filed bug): `--mine` /
 * `--files` scope attribution to the literal set of files the caller changed, which is
 * structurally BLIND to the single most common gate-redding change shape — adding a REQUIRED
 * field to a shared exported interface. By definition, the new type errors that causes land in
 * OTHER files (the fixtures/constructors that build that type and were never updated), not in
 * the file the caller edited. So the caller's own `--mine` reads clean, and the break first
 * surfaces hours later at green-checkpoint, redding the gate for the whole fleet.
 *
 * The fix: when a changed file exports a type/interface/class/enum, treat every OTHER file that
 * textually references that name as ALSO attributed to the caller if it regresses — not just the
 * changed file itself. This is a coarse, name-based proxy (it does not diff which specific
 * declaration line changed, and cannot tell a real reference from an unrelated identifier of the
 * same name) — deliberately so: for a lint GATE, the dangerous failure direction is a false
 * negative (silently missing the real cause), not a false positive (a name collision needlessly
 * widening attribution by one entry). Widening is always safe; missing is what cost the fleet a
 * gate cycle four times in 24 hours.
 *
 * Exported top-level type/interface/class/enum names declared in the given files' CURRENT
 * on-disk content.
 *
 * @param {string} root
 * @param {Iterable<string>} files
 * @returns {Set<string>}
 */
export function exportedTypeNames(root, files) {
  const names = new Set();
  const re = /^export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:interface|type|class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const file of files) {
    let content;
    try {
      content = readFileSync(resolve(root, file), 'utf-8');
    } catch {
      continue; // unreadable (deleted, renamed, outside cwd) — skip, never crash the gate over it
    }
    let m;
    while ((m = re.exec(content)) !== null) names.add(m[1]);
  }
  return names;
}

/**
 * Which of `candidateFiles` reference any of `typeNames` as a standalone identifier — the other
 * half of `exportedTypeNames` above (EI-18756182128903253): cross-reference a changed file's
 * exported type names against every OTHER file, so a fixture that never added the new required
 * field gets attributed to the change that added it, instead of reported as unrelated peer drift.
 *
 * @param {string} root
 * @param {Iterable<string>} candidateFiles
 * @param {Set<string>} typeNames
 * @returns {Set<string>}
 */
export function filesReferencingTypeNames(root, candidateFiles, typeNames) {
  const referencing = new Set();
  if (typeNames.size === 0) return referencing;
  const escaped = [...typeNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(?:${escaped.join('|')})\\b`);
  for (const file of candidateFiles) {
    let content;
    try {
      content = readFileSync(resolve(root, file), 'utf-8');
    } catch {
      continue;
    }
    if (re.test(content)) referencing.add(file);
  }
  return referencing;
}

/**
 * Find candidate files whose assignability diagnostic names a changed exported type.
 *
 * Source-text attribution misses inferred callback/object-literal errors: the dependent source
 * can omit the expected type while tsc names it in the diagnostic message. Keep this parser
 * narrow to the missing-property/assignability diagnostics emitted by required-field strands.
 *
 * @param {string} tscOutput
 * @param {Iterable<string>} candidateFiles
 * @param {Set<string>} typeNames
 * @param {{root?: string, canonicalRoot?: string}} [roots]
 * @returns {Set<string>}
 */
export function diagnosticFilesReferencingTypeNames(
  tscOutput,
  candidateFiles,
  typeNames,
  { root, canonicalRoot } = {},
) {
  const candidates = new Set(candidateFiles);
  const referencing = new Set();
  if (candidates.size === 0 || typeNames.size === 0) return referencing;

  const escaped = [...typeNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const typePattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`);
  const assignabilityCodes = new Set(['TS2322', 'TS2739', 'TS2741']);
  const pathRoots = root
    ? { root: realpathOrResolve(root), canonicalRoot: realpathOrResolve(canonicalRoot ?? root) }
    : null;

  for (const line of String(tscOutput).split('\n')) {
    const match = line.match(LOCATED_DIAGNOSTIC);
    if (!match || !assignabilityCodes.has(match[4])) continue;
    const file = pathRoots ? normalizeResolvedDiagnosticPath(match[1], pathRoots) : match[1];
    if (!candidates.has(file)) continue;
    // Inspect only the compiler message, not the path/code prefix, so a type name in a filename
    // cannot create attribution.
    if (typePattern.test(line.slice(match[0].length))) referencing.add(file);
  }
  return referencing;
}

/**
 * Resolve the EFFECTIVE per-file baseline, inheriting cross-package files from their OWNING
 * package's baseline (EI-18649014117371738).
 *
 * ## Why this exists
 *
 * `decidePerFile` treats a file ABSENT from the baseline as an implicit 0 — correct for a file this
 * gate OWNS (a fresh file that arrives with errors IS a named regression). It is WRONG for a file in
 * ANOTHER package that has its own baseline gate: this gate's baseline was captured at some other
 * moment, under a DIFFERENT tsconfig, so "absent" there means "this gate never recorded it", NOT
 * "it was clean". Absent ⇒ 0 turns that gap into a phantom regression.
 *
 * That is not hypothetical: operator-core's baseline records e.g.
 * `packages/operator-core/lib/agent-tools/memory/search.ts: 1` (a KNOWN, TOLERATED error), while
 * apps/operator-vite's baseline — seeded four days later — never listed it. So `lint:tsc` PASSED and
 * `lint:tsc:operator-vite` FAILED on the SAME source file, and 12 operator-core files read as
 * regressions to an agent who had opened none of them. Two gates over one tree giving opposite
 * verdicts makes neither number trustworthy — exactly the false-signal problem the per-file gate was
 * built to kill (EI-847), reintroduced at the cross-package seam.
 *
 * ## The rule
 *
 * For a file this gate MEASURED but did not record, that lives under a `prefix` owned by a package
 * with its own baseline, inherit that package's recorded count instead of defaulting to 0.
 *
 *   - Own baseline ALWAYS wins when present — an explicit entry is this gate's own measured truth
 *     under its own tsconfig, and ratchet-only-down must never be loosened by a foreign number.
 *   - Inheritance is scoped to files actually in `currentByFile`, so a foreign baseline can never
 *     inject files this gate does not measure (that would fabricate phantom "improvements" and
 *     inflate the reported total).
 *   - Absent from BOTH is still an implicit 0 — a genuinely NEW error in a foreign file still gates.
 *
 * @param {{
 *   baselineByFile: Record<string, number>,
 *   currentByFile: Record<string, number>,
 *   foreignBaselines?: {prefix:string, files:Record<string,number>, label?:string}[],
 * }} args
 * @returns {{ effective: Record<string, number>, inherited: {file:string,baseline:number,from:string}[] }}
 */
export function effectiveBaselineByFile({ baselineByFile, currentByFile, foreignBaselines = [] }) {
  if (!foreignBaselines.length) return { effective: baselineByFile, inherited: [] };

  const effective = { ...baselineByFile };
  const inherited = [];
  for (const file of Object.keys(currentByFile)) {
    if (effective[file] !== undefined) continue; // this gate's OWN recorded count wins, always
    for (const source of foreignBaselines) {
      if (!file.startsWith(source.prefix)) continue;
      const count = source.files?.[file];
      if (typeof count === 'number' && count > 0) {
        effective[file] = count;
        inherited.push({ file, baseline: count, from: source.label ?? source.prefix });
      }
      break; // first matching prefix OWNS the file — a second source never overrides it
    }
  }
  inherited.sort((a, b) => a.file.localeCompare(b.file));
  return { effective, inherited };
}

/**
 * EI-19444246913245434 — lower ONLY the named files in an existing baseline map.
 *
 * A SCOPED `--update` must never write a whole-project map: on this shared checkout every other
 * file's current count may include a peer's uncommitted edit, and baking that in creates a false
 * red the moment they revert. (That racy write is why the bug report ruled out bare `--update` as
 * a workaround — so the scoped ratchet had no working form at all.)
 *
 * Merges against the gate's OWN on-disk baseline, never the EFFECTIVE map `decidePerFile` judges
 * with: the effective map folds in entries INHERITED from foreign package baselines
 * (effectiveBaselineByFile), and persisting those would durably copy another package's rows into
 * this one. Pure + total so the "the VALUE changed" property is unit-testable without running tsc.
 *
 * @param {{ baselineFiles: Record<string, number>, ratchetFiles: PerFileGateEntry[] }} input
 * @returns {Record<string, number>}
 */
export function mergeRatchetIntoBaseline({ baselineFiles, ratchetFiles }) {
  const next = { ...baselineFiles };
  for (const entry of ratchetFiles) next[entry.file] = entry.current;
  return next;
}

/**
 * Pure per-file gate decision — the ONE place the policy lives, so it is unit-testable (EI-104).
 * A file is a REGRESSION when its current error count exceeds its baseline (a file absent from the
 * baseline has an implicit baseline of 0, so any new error in a fresh file is a named regression).
 * Regressions always win over improvements, preserving ratchet-only-down.
 *
 * @param {{
 *   currentByFile: Record<string, number>,
 *   baselineByFile: Record<string, number>,
 *   brokenFiles: string[],
 *   updateFlag?: boolean,
 *   changedFiles?: Set<string> | null,
 *   typeReferencedFiles?: Set<string> | null,
 *   dirtyFiles?: Set<string> | null,
 *   attributionDeclared?: boolean,
 * }} args
 * @returns {PerFileGateResult}
 */
export function decidePerFile({
  currentByFile,
  baselineByFile,
  brokenFiles,
  updateFlag = false,
  changedFiles = null,
  typeReferencedFiles = null,
  dirtyFiles = null,
  attributionDeclared = false,
}) {
  const total = sumValues(currentByFile);
  const baselineTotal = sumValues(baselineByFile);

  // EI-19321179234197157: SCOPE the TS1xxx hard-fail the same way a type-error regression is
  // scoped. Bare/unscoped (changedFiles === null) keeps the original behaviour — ANY broken file
  // fails, because there is no "yours vs a peer's" distinction to make. Under `--mine`/`--files`,
  // a TS1xxx hard-fail diagnostic OUTSIDE the caller's own changed-file set is a peer's in-flight edit on
  // this shared checkout (the same population `peerDrift`/`newFiles` already cover for type
  // errors) — it must not fail a run that named a specific, unrelated file set. A broken file the
  // caller DID name still hard-fails unconditionally, same as before.
  const attributedBroken = changedFiles ? brokenFiles.filter((f) => changedFiles.has(f)) : brokenFiles;
  const unattributedBroken = changedFiles ? brokenFiles.filter((f) => !changedFiles.has(f)) : [];
  if (attributedBroken.length > 0) {
    return {
      verdict: 'fail-syntax',
      brokenFiles: attributedBroken,
      unattributedBrokenFiles: unattributedBroken,
      regressions: [],
      improvements: [],
      total,
      baselineTotal,
    };
  }

  const allFiles = new Set([...Object.keys(currentByFile), ...Object.keys(baselineByFile)]);
  const regressions = [];
  const improvements = [];
  for (const file of allFiles) {
    const current = currentByFile[file] ?? 0;
    const baseline = baselineByFile[file] ?? 0;
    if (current > baseline) {
      const entry = { file, baseline, current, delta: current - baseline };
      // A bare run has no caller-owned file set to distinguish from the shared tree. Reuse the
      // existing git-status signal to annotate the row, but never let it change the verdict. A
      // dirty baseline-0 row is especially dangerous: the old wording said every quoted error
      // was new even when the compiler may have read a peer's in-flight edit.
      regressions.push(
        dirtyFiles && changedFiles === null ? { ...entry, dirty: dirtyFiles.has(file) } : entry,
      );
    } else if (current < baseline) improvements.push({ file, baseline, current, delta: current - baseline });
  }
  regressions.sort((a, b) => b.delta - a.delta || a.file.localeCompare(b.file));
  improvements.sort((a, b) => a.delta - b.delta || a.file.localeCompare(b.file));

  const base = { regressions, improvements, total, baselineTotal, unattributedBrokenFiles: unattributedBroken };

  // EI-19444246913245434 — the caller's OWN improved files: the only ones a SCOPED `--update` may
  // lower. Computed HERE, before any verdict is chosen, so every non-failing verdict can carry it.
  //
  // The bug this fixes: the ratchet used to BE a verdict (`ok-ratchet`), and `decidePerFile`
  // resolves exactly one. So the `regressions.length > 0` branch below returned first and the
  // caller's ratchet was dropped — even when that branch had just classified every regression as
  // explicitly NOT the caller's problem (`ok-peer-drift`, exit 0, a leading ✓). Peer drift is
  // near-permanent on this shared tree, so `--files=X --update` had no working form at all while
  // still reporting `scope=update exit=0 status=clean`. A ratchet is an EFFECT, not a
  // classification; carrying it as a payload lets the write survive whatever the verdict is.
  const scopedRatchetFiles =
    updateFlag && changedFiles ? improvements.filter((r) => changedFiles.has(r.file)) : [];
  const ratchetPayload = scopedRatchetFiles.length > 0 ? { ratchetFiles: scopedRatchetFiles } : {};

  if (regressions.length > 0) {
    if (changedFiles) {
      // EI-18756182128903253 / EI-21833727883305743 — cause-aware widening: a regression outside
      // `changedFiles` is STILL attributed (not peer drift) when the file's source OR its
      // compiler diagnostic references an exported type/interface one of the changed files also
      // exports — the shape of "I added a required field, the fixture that constructs it broke,
      // and the fixture is not in my diff". `typeAttributed` is kept separate from the directly-
      // changed subset so callers/reporting can say WHY a file outside the diff still gates.
      const isTypeAttributed = (file) =>
        !changedFiles.has(file) && !!typeReferencedFiles && typeReferencedFiles.has(file);
      // EI-23768041578113385 — a type-attributed file is BY CONSTRUCTION one the caller did not
      // name. The widening above is deliberate and stays (missing a stranded consumer is what
      // freezes `main`), but on this shared checkout that file may equally be a PEER's live
      // uncommitted edit which merely references a type the caller also exports — in which case
      // the errors are not the caller's to fix, and editing them stomps a live peer. Carry the
      // same live-edit signal the adjacent `newFiles` branch already carries
      // (EI-19278299775574199) so the reporter can say so. Annotating only the type-attributed
      // subset is deliberate: a file the caller DID name is expected to be dirty (they just
      // edited it), so marking that would be noise, not signal. `dirty` is left UNDEFINED when
      // the dirty set is unavailable, so an unreadable git state is never mistaken for "clean".
      const annotateLiveEdit = (r) => (dirtyFiles ? { ...r, dirty: dirtyFiles.has(r.file) } : r);
      const attributed = regressions
        .filter((r) => changedFiles.has(r.file) || isTypeAttributed(r.file))
        .map((r) => (isTypeAttributed(r.file) ? annotateLiveEdit(r) : r));
      const typeAttributed = regressions.filter((r) => isTypeAttributed(r.file)).map(annotateLiveEdit);
      const unattributed = regressions.filter((r) => !changedFiles.has(r.file) && !isTypeAttributed(r.file));
      // EI-18766822535373909 — a regression in a file with NO baseline entry is a BRAND-NEW file,
      // and it must never be dismissed as peer drift. Two independent reasons:
      //
      //  1. It is not "drift" in the only sense the peer-drift affordance is safe for. That
      //     affordance (EI-1984) exists to let pre-existing shared-tree debt flap without redding
      //     an unrelated agent — debt the baseline already KNOWS about. A file absent from the
      //     baseline has no known-good state to drift from; every error in it is NEW, which is
      //     precisely what this ratchet exists to catch. Bare mode already fails it
      //     ('fail-regressed'); only --mine was letting it through, so this closes an
      //     inconsistency between the two modes rather than adding a new policy.
      //  2. `changedFiles` CANNOT prove the file is not yours on this checkout. It is derived from
      //     `git status`, and git-sync auto-commits the whole tree every few minutes — so your own
      //     brand-new file stops being dirty, drops out of the "mine" set, and lands here. That is
      //     exactly how this was found: a new file's real TS2352 was reported under a leading ✓ as
      //     "peer drift — not your regression", and it would have red the green-checkpoint for the
      //     whole fleet hours later.
      //
      // '(unattributed)' (errors tsc did not pin to a file) is deliberately LEFT in peerDrift: it
      // is not a new file, and it is genuinely unattributable, so gating on it would red callers
      // for something they cannot act on.
      // EI-19278299775574199 — ANNOTATE (never re-classify) each new file with whether it is
      // uncommitted in the shared tree right now. Under `--files` the caller enumerated their own
      // files, so a new file outside that set which is ALSO dirty is a peer's live buffer: transient,
      // not yet pushed, and not yet a fleet-gate red. It still fails (the verdict below is
      // untouched) — but the reporter must not invite the caller to edit a file another agent is
      // actively writing. `dirty` is left UNDEFINED when the dirty set is unavailable, so an
      // unreadable git state can never be mistaken for "clean" (see partitionNewFilesByLiveEdit).
      const newFiles = unattributed
        .filter((r) => r.file !== '(unattributed)' && !(r.file in baselineByFile))
        .map(annotateLiveEdit);
      const peerDrift = unattributed.filter((r) => r.file === '(unattributed)' || r.file in baselineByFile);
      // Under --mine the gate fails when a regression lands in a file you changed, OR in a file so
      // new the baseline has never seen it. Drift in KNOWN files you did not touch stays reported
      // but not gated — that is the "verify MY change is clean" affordance (EI-1984), and it is why
      // --mine is opt-in and never the CI default.
      if (attributed.length > 0) return { verdict: 'fail-attributed', ...base, attributed, typeAttributed, peerDrift, newFiles };
      // EI-19305736771912430 — whether an unscoped NEW file may set the EXIT CODE turns on how the
      // changed-set was obtained, because that is what decides whether "not in the set" is evidence.
      //
      //  · `--mine` INFERS the set from `git status`. EI-18766822535373909's argument holds in full
      //    there: absence cannot clear you, because git-sync commits the tree every few minutes and
      //    your own new file is dirty for only a short window. So --mine still fails. Unchanged.
      //  · `--files` DECLARES the set: the caller enumerated their own files by hand. A new file
      //    outside that enumeration is one they asserted is not theirs — the very evidence git
      //    status cannot supply. Failing on it makes a SCOPED run non-deterministic (it reds or not
      //    depending on what peers happen to have dirty), and `--files` exists precisely to remove
      //    that (EI-18731016038876755, which fixed the REPORTING and left the exit code).
      //
      // The unscoped findings are NOT dropped — they ride the ok verdict and are still printed with
      // the same live-edit/standing split and fleet-gate warning. Silencing them would trade one
      // failure for another; the point is that a red must mean "something YOU must fix", or the
      // fleet learns to ignore reds — and the next one, which IS theirs, reads identically.
      if (newFiles.length > 0 && !attributionDeclared) {
        return { verdict: 'fail-new-file', ...base, attributed: [], peerDrift, newFiles };
      }
      // ...ratchetPayload: drift the gate just declared NOT the caller's problem must not also
      // silently discard the caller's own ratchet (EI-19444246913245434). Reporting unchanged.
      return { verdict: 'ok-peer-drift', ...base, attributed: [], peerDrift, newFiles, ...ratchetPayload };
    }
    return { verdict: 'fail-regressed', ...base };
  }

  if (improvements.length > 0) {
    if (!updateFlag) return { verdict: 'ok-below', ...base };
    // A BARE `--update` re-baselines the whole project (full map). A SCOPED one lowers ONLY the
    // caller's own files (payload) — writing the whole map there would bake every peer's
    // uncommitted count into a shared baseline, which is a false red the moment they revert, and
    // is exactly why the bug report ruled out bare `--update` as a workaround. Never both.
    if (!changedFiles) return { verdict: 'ok-ratchet', ...base, newBaselineByFile: { ...currentByFile } };
    // Scoped, but every improvement belongs to a peer: there is nothing of the caller's to lock
    // in, so this is honestly `ok-below` ("below baseline — NOT locked in"), not a silent no-op
    // dressed as a successful update.
    return scopedRatchetFiles.length > 0
      ? { verdict: 'ok-ratchet', ...base, ...ratchetPayload }
      : { verdict: 'ok-below', ...base };
  }
  return { verdict: 'ok', ...base };
}

function formatRow(r) {
  return `   ${r.file}: ${r.baseline} → ${r.current}  (${r.delta > 0 ? '+' : ''}${r.delta})`;
}

/**
 * Is this file's own commit age old enough that its NEW diagnostic cannot be its own doing?
 *
 * Exported and shared so the ROW wording and the caller's `unchangedCount` (which drives the
 * footer) can never disagree about which rows are unchanged — a divergence that would print the
 * per-file explanation with the wrong count, or omit it while rows are marked UNCHANGED.
 *
 * `null` (unknown) is deliberately NOT unchanged: `lastCommitTimes` fails soft to `null`, and a
 * path inside a submodule also reads `null` from the superproject, so treating unknown as
 * "unchanged" would manufacture an exoneration out of an absence of evidence.
 *
 * @param {number | null} [commitAgeSec]
 * @returns {boolean}
 */
export function isUnchangedForAttribution(commitAgeSec) {
  return typeof commitAgeSec === 'number' && commitAgeSec > LANDING_RACE_WINDOW_SEC;
}

/**
 * Describe a clean diagnostic site without inventing its causal provenance.
 *
 * A clean file is genuinely committed, but its NEW diagnostic may still be caused by another
 * uncommitted file in its import/type graph. `tsc` reports the error site, not the edit that made
 * the site invalid, so asserting "standing red" while any other path is dirty can send a caller
 * straight into a live peer's lane. Preserve the strong warning only when the working tree gives
 * us no uncommitted alternative cause.
 *
 * THREE readings, strongest evidence first (EI-19340874432965755):
 *   1. `commitAgeSec` says THIS FILE has not moved in longer than the landing-race window — then
 *      the cause is provably not this file's own content. Most actionable, and about the file
 *      itself rather than the tree, so it wins.
 *   2. `dirtyPathCount > 0` — some other path could be the cause, but we cannot say which.
 *   3. Neither — nothing else is in flight, so the strong standing-red warning is earned.
 *
 * WHY IT MATTERS, measured: the flat "COMMITTED: a standing red that WILL red the fleet" wording
 * produced THREE work-items from three agents on 2026-08-02 and TWO were not reproducible against
 * the file named (WI-6928, EI-19332542096444388). In WI-6928 the file was unchanged since 01:21
 * with no commits since the report, so its content never varied — a peer's edit elsewhere induced
 * the error and fixing that file cleared it. Reading 1 is exactly that case, named.
 *
 * @param {PerFileGateEntry} r
 * @param {{dirtyPathCount?: number, commitAgeSec?: number | null}} [opts] `commitAgeSec` is the
 *   file's age in seconds since its last commit, or `null` when unknown. It MUST be annotated
 *   `number | null` rather than left to inference: a bare `= null` default makes TS infer the
 *   parameter as `null | undefined`, so every real (numeric) caller fails to typecheck — this
 *   file is `.mjs`, so its types come from these JSDoc tags and nothing else.
 * @returns {string}
 */
export function formatStandingRedRow(r, { dirtyPathCount = 0, commitAgeSec = null } = {}) {
  // EI-19340874432965755 — the file's OWN commit age is the strongest signal available here, and
  // it is about THIS file rather than about the tree, so it outranks the dirtyPathCount caveat
  // below. A file whose content has not moved for longer than the landing-race window, but whose
  // error count just went 0 → N, cannot have caused that change itself: something in its import
  // graph did. `null` is UNKNOWN and never earns the exoneration (lastCommitTimes fails soft to
  // `null`, and a path inside a submodule reads `null` from the superproject) — the same "unknown
  // is never an exoneration" rule this file applies everywhere else.
  const status = isUnchangedForAttribution(commitAgeSec)
    ? `UNCHANGED ${Math.floor(commitAgeSec / 60)}min; error SURFACES here, so the cause is a change ELSEWHERE`
    : dirtyPathCount > 0
      ? `CLEAN ERROR SITE; causal origin unresolved while ${dirtyPathCount} other path(s) are uncommitted`
      : 'COMMITTED: a standing red that WILL red the fleet';
  return `${formatRow(r)}  ← ${status}`;
}

/**
 * The headline for an ATTRIBUTED failure, worded per how the changed-set was derived.
 *
 * This is a pure function purely so the wording is TESTABLE, because the wording is where
 * the bug was. `--files` means the caller NAMED the files, so "you changed" is a fact.
 * `--mine` infers them from `git status` — and this repo has ONE working tree shared by the
 * whole fleet, with every agent's edits unstaged until the next git-sync tick, so that set is
 * "dirty right now": yours AND every peer's. Claiming "YOU changed" over it is false, and it
 * is expensively false in BOTH directions — you chase a peer's error believing it is yours,
 * or your own genuine regression arrives amid peer noise under the same label and you dismiss
 * the lot as fleet drift. Filed four separate times before the wording was fixed
 * (EI-18731016038876755, which added `--files`, plus three later duplicates).
 *
 * WHY THE COUNT SPLITS (EI-23783377300333258). "YOU NAMED" is a claim about the caller's
 * ARGUMENTS, and under `--files` the reported set is deliberately WIDER than the argument:
 * cause-aware widening (EI-18756182128903253) also gates a file reached from a type one of the
 * named files exports — the "I added a required field, the fixture that constructs it broke, and
 * the fixture is not in my diff" shape. Measured: TWO paths named, NINE reported, all nine
 * labelled `file(s) YOU NAMED`. The result was correct and the widening is the whole point; only
 * the label lied. It lies expensively, because the natural reading of a false claim about your
 * arguments is "I passed the wrong --files", which sends the reader off to re-type the flag at
 * exactly the moment the gate is handing them a real finding — and re-scoping can NEVER clear a
 * type-reached file. `typeAttributed` is already carried separately for precisely this purpose
 * ("so callers/reporting can say WHY a file outside the diff still gates"), so the honest wording
 * costs one count. It defaults to 0, which reproduces the earlier wording verbatim.
 *
 * @param {{count: number, explicit: boolean, typeAttributedCount?: number}} opts
 * @returns {string}
 */
export function formatAttributionHeadline({ count, explicit, typeAttributedCount = 0 }) {
  // Clamp rather than trust: this count arrives from a sibling array, and a headline reporting a
  // negative or over-large subset would just be a NEW false claim in place of the old one.
  const reached = Math.max(0, Math.min(typeAttributedCount, count));
  const named = count - reached;
  if (explicit) {
    if (reached === 0) {
      return `❌ ${count} file(s) YOU NAMED added type errors above their baseline:`;
    }
    if (named === 0) {
      return (
        `❌ ${count} file(s) added type errors above their baseline — NONE of them are files you ` +
        `named: each is reached from a type one of your files exports. Your --files set was not ` +
        `wrong and re-scoping it cannot clear them:`
      );
    }
    return (
      `❌ ${count} file(s) added type errors above their baseline — ${named} YOU NAMED, and ` +
      `${reached} you did NOT name but which are reached from a type one of your files exports. ` +
      `Your --files set was not wrong and re-scoping it cannot clear the latter:`
    );
  }
  if (reached === 0) {
    return (
      `❌ ${count} file(s) DIRTY IN THE WORKING TREE added type errors above their baseline — ` +
      `on this shared checkout that set is yours AND every peer's, so a file here may not be yours ` +
      `(re-run with --files=<the files you edited> to scope it to your own):`
    );
  }
  return (
    `❌ ${count} file(s) added type errors above their baseline — ${named} DIRTY IN THE WORKING ` +
    `TREE and ${reached} reached from a type a dirty file exports. On this shared checkout the ` +
    `dirty set is yours AND every peer's, so a file here may not be yours ` +
    `(re-run with --files=<the files you edited> to scope it to your own):`
  );
}

/**
 * The explanation printed under a `fail-new-file` verdict, worded per how the changed-set was
 * DERIVED. The verdict itself never moves (EI-18766822535373909): a file the baseline has never
 * seen has no known-good state to drift from, so NO scoping can exonerate it. Only the remedy
 * differs.
 *
 * WHY IT BRANCHES (EI-18802204276510164). The single closing line used to read "re-run with
 * --files=<paths>" unconditionally — including for a caller who had just passed `--files`, in a
 * run that echoes `[--files]` in its own header two lines above. Prescribing the action already
 * taken reads as "I invoked it wrong", so the reader goes to this script hunting their own
 * mistake instead of to the actual next step, and it lands on precisely the agents doing the
 * right thing: scoping their check exactly, at the moment they are deciding whether their change
 * is safe to leave in the shared tree.
 *
 * @param {{explicit: boolean, liveEditCount?: number, standingCount?: number}} opts `explicit` —
 *   the changed-set came from `--files` (named by the caller) rather than `--mine` (inferred from
 *   `git status`). `liveEditCount`/`standingCount` split the new files into a peer's uncommitted
 *   live edits vs committed standing reds (EI-19278299775574199); omitting BOTH yields the full
 *   standing text, so a caller that does not supply the split is never quietly exonerated.
 * @returns {string[]} console lines, already indented.
 */
export function formatNewFileGuidance({ explicit, liveEditCount = 0, standingCount = 0 }) {
  const NO_BASELINE =
    `   These files are new, so every error in them is new — the baseline has no known-good state to drift from.`;
  const TELL_THE_AUTHOR =
    `   If a file here really isn't yours, its author needs to know — a bare run of this gate reds the fleet on it.`;

  if (explicit) {
    // EI-19278299775574199 — when every new file is a peer's uncommitted live edit, the old closing
    // line ("If one is yours, fix it") prescribed exactly the wrong action: it invited the caller to
    // hand-edit a file another agent had open. Say what is actually true instead.
    const lines = [NO_BASELINE];
    if (liveEditCount > 0) {
      lines.push(
        `   ${liveEditCount} of them is/are UNCOMMITTED in this shared tree — a peer is very likely mid-edit right now.`,
        `   Those are NOT attributed to you and are NOT yours to fix: do not edit them, or you stomp a live peer.`,
        `   They are transient (nothing has reached origin yet) and usually clear on their own within a few minutes —`,
        `   re-run this check shortly, or confirm with: git status --porcelain <path>`,
      );
    }
    // `standingCount === 0 && liveEditCount === 0` is a caller that did not supply the split at
    // all. Fall back to the full standing text — the same "unknown is never an exoneration" rule
    // partitionNewFilesByLiveEdit applies, and it keeps this function's no-arg behaviour identical
    // to before the split existed.
    if (standingCount > 0 || liveEditCount === 0) {
      lines.push(
        `   ${standingCount} of them is/are COMMITTED — a standing red that WILL red the fleet at the next bare run.`,
        `   They are OUTSIDE the --files set you named and reported anyway BECAUSE they are new:`,
        `   scoping only exonerates a file the baseline already knows, and these have no baseline at all.`,
        `   So this is not a bad invocation — naming them would not clear them either. If one is yours, fix it.`,
        // EI-19340874432965755 — "new" here means ABSENT FROM THE BASELINE, which is not the same
        // as RECENTLY WRITTEN, and readers conflate the two. In WI-6928 the named file had been
        // unchanged since 01:21 with no commits since the report; it was "new" only to the
        // baseline. Without this line the block above reads as "this file is broken and needs an
        // owner", which sent two of three agents into a file that never varied.
        `   ⚠ "New" means ABSENT FROM THE BASELINE, not recently written — a file here may not have`,
        `   changed in hours. A tsc error is reported where it SURFACES, not where it ORIGINATES, so`,
        `   check whether the file actually changed (git log -1 -- <path>) before investigating it;`,
        `   if it did not, look at its IMPORT GRAPH — start with: npm run lint:required-field-strands`,
        TELL_THE_AUTHOR,
      );
    }
    return lines;
  }
  return [
    NO_BASELINE,
    `   They are not in your git-status changed set, but that does NOT establish they aren't yours: git-sync`,
    `   auto-commits this shared tree every few minutes, which silently drops your own recent work out of that set.`,
    TELL_THE_AUTHOR,
    `   To scope this check to exactly the files you touched, re-run with --files=<comma-separated paths>.`,
  ];
}

/**
 * The closing lines of the SCOPED (`--files`) new-file report, for the COMMITTED population.
 *
 * WI-7153. This block used to end "…the committed one(s) above need an owner", which reads as an
 * instruction to FILE a work-item — and directly contradicts `recordStandingReds()`, called a few
 * lines later on this same population. That mechanism exists precisely BECAUSE filing on first
 * sight is wrong: these reds are dominated by self-healing (measured 2026-08-02: 4 of 5 gone in
 * 15min, unaided), so `tsc-red-sweep` deliberately waits DWELL_SEC before judging one ownerless.
 *
 * With the recording silent and the prose asking for an owner, every reader correctly concluded
 * "nobody has this, so I should file it". Two agents filed the SAME 9 paths 75 seconds apart on
 * 2026-08-02 (WI-7149 / WI-7150), at 1.9–7.1 minutes of observed life — 6–24x under the dwell —
 * which is exactly the backlog-noise outcome the hot-path/sweeper split was designed to avoid.
 *
 * The dwell is read from DWELL_SEC rather than written out, so this text cannot drift from the
 * policy it describes.
 */
export function formatStandingRedFooter({ dwellSec = DWELL_SEC, unchangedCount = 0 } = {}) {
  const lines = [
    `    Not YOUR gate failure (you did not name them), so this run stays green.`,
    `    ALREADY RECORDED — do NOT hand-file a work-item. tsc-red-sweep files only the ones still`,
    `    standing after ${Math.round(dwellSec / 60)}min; most self-heal first (measured: 4 of 5 gone in 15min), so`,
    `    filing on sight just makes duplicates (WI-7149/WI-7150, 75s apart). If one is YOURS, fix it.`,
  ];
  // EI-19340874432965755 — printed ONLY when at least one row is provably unchanged, because that
  // is the case where investigating the NAMED file is the wrong move and a reader needs to be told
  // where to look instead. Naming the existing tool matters: adding a required field to a shared
  // interface is the dominant cause of this shape, `lint:required-field-strands` was built for
  // exactly it, and the gate has never mentioned it — so every reader re-derived the search by hand.
  if (unchangedCount > 0) {
    lines.push(
      `    ⚠ ${unchangedCount} of the above has/have NOT been committed in a long time (marked UNCHANGED).`,
      `    A tsc error is reported where it SURFACES, not where it ORIGINATES: a required field added to`,
      `    a shared interface, a changed export type, or a resolution change strands sites in files`,
      `    nobody touched. Investigating an UNCHANGED file directly is the wrong move — look at what`,
      `    changed in its IMPORT GRAPH. For the dominant cause: npm run lint:required-field-strands`,
    );
  }
  return lines;
}

/**
 * Split `newFiles` into a peer's LIVE EDITS and STANDING reds — the two populations the
 * `fail-new-file` report used to conflate (EI-19278299775574199).
 *
 * The asymmetry that makes this safe. EI-18766822535373909 established that the verdict can never
 * move, because `changedFiles` cannot prove a file is not yours: git-sync commits this tree every
 * few minutes, so your own new file stops being dirty and drops out of the changed set. That
 * argument is about a file being CLEAN — and it is exactly right. It says nothing about a file that
 * is DIRTY *right now*, which is the opposite evidence: under `--files` the caller enumerated their
 * own files, so a dirty file they did not name has a live editor who is not them.
 *
 * `dirty === undefined` (dirty set unreadable, or `--mine`, where a dirty file is already
 * `attributed` and can never reach here) is deliberately treated as STANDING. Unknown must never
 * buy an exoneration — that would be the fail-open shape this gate's whole design avoids.
 *
 * @param {PerFileGateEntry[]} newFiles
 * @returns {{liveEdits: PerFileGateEntry[], standing: PerFileGateEntry[]}}
 */
export function partitionNewFilesByLiveEdit(newFiles) {
  return partitionEntriesByLiveEdit(newFiles);
}

/**
 * EI-23768041578113385 — the live-edit split, generic over ANY `PerFileGateEntry[]` carrying
 * `dirty`. `partitionNewFilesByLiveEdit` (above) is the new-file caller and delegates here; the
 * `typeAttributed` reporter is the second. Kept as ONE primitive so the two can never disagree
 * about the rule that actually matters: `dirty !== true` — which INCLUDES `undefined`, i.e. an
 * unreadable git state — routes to `standing`. Absence of evidence is never an exoneration.
 *
 * @param {PerFileGateEntry[]} entries
 * @returns {{liveEdits: PerFileGateEntry[], standing: PerFileGateEntry[]}}
 */
export function partitionEntriesByLiveEdit(entries) {
  return {
    liveEdits: entries.filter((r) => r.dirty === true),
    standing: entries.filter((r) => r.dirty !== true),
  };
}

/**
 * Split files with unattributed TS1xxx hard-fail diagnostics (outside the caller's `--mine`/`--files` set — see
 * `decidePerFile`'s `unattributedBrokenFiles`) into a peer's LIVE EDIT (uncommitted right now)
 * vs a COMMITTED standing red — the hard-fail analog of `partitionNewFilesByLiveEdit` above
 * (EI-19321397364088260).
 *
 * Before this split, every unattributed broken file was reported with one blanket "a peer is
 * likely mid-edit" line — true for a genuinely dirty file, but false reassurance for a file that
 * is actually COMMITTED and will red the fleet at the next bare run: a reader could dismiss a
 * real standing defect as transient noise. Both the bug that added the underlying scoping
 * (EI-19321179234197157) and the near-duplicate that re-found the gap (EI-19321397364088260)
 * asked for exactly this split.
 *
 * `dirtyFiles === null` covers two cases, and both correctly route every entry to `standing`:
 * under `--mine`, `changedFiles` IS the dirty set, so anything reaching this function (outside
 * `changedFiles`) is by construction already committed; an unreadable git state (see
 * `gitChangedFiles`'s fail-soft) must never manufacture an exoneration either — "unknown is
 * never an exoneration", the same rule `partitionNewFilesByLiveEdit` applies.
 *
 * @param {string[]} unattributedBrokenFiles
 * @param {Set<string> | null} dirtyFiles
 * @returns {{liveEdits: string[], standing: string[]}}
 */
export function partitionBrokenFilesByLiveEdit(unattributedBrokenFiles, dirtyFiles) {
  if (!dirtyFiles) return { liveEdits: [], standing: [...unattributedBrokenFiles] };
  const liveEdits = unattributedBrokenFiles.filter((f) => dirtyFiles.has(f));
  const liveSet = new Set(liveEdits);
  const standing = unattributedBrokenFiles.filter((f) => !liveSet.has(f));
  return { liveEdits, standing };
}

/**
 * Quote cap for a file whose errors are all new (a hard-fail or a file the baseline never saw).
 * Three lines are a fair sample of one homogeneous set — see REGRESSION_DIAGNOSTIC_MAX_PER_FILE
 * for why a MIXED (regressed) file needs a larger one.
 */
const DEFAULT_DIAGNOSTIC_MAX_PER_FILE = 3;

/**
 * The COMPILER LINES behind a new file's `+N` — the WHAT the count alone withholds (WI-6767).
 *
 * The gate holds the full tsc output and, until now, reported only `file: 0 → 1 (+1)`. Recovering
 * the message from that costs a fresh full-project compile, which on this box is ~100s under
 * contention and is exactly what the two agents who hit this could not afford: the WI-6764 filer
 * recorded that a full `tsc -p packages/operator-core` blew their shell budget TWICE, so they filed
 * a major bug without ever seeing the error; the next agent then spent ~20 minutes re-deriving it.
 * The line was sitting in a string the gate already had.
 *
 * It matters far beyond convenience, because the message is frequently the whole diagnosis. The
 * WI-6764 error read `TS2322: Type '"memory-recall-scale"' is not assignable to type
 * 'WatchdogSource'` — naming a type in a DIFFERENT file, which is the signature of a multi-file
 * change still landing (see `formatLandingRaceCaveat`). A bare `+1` cannot suggest that; the
 * message says it outright.
 *
 * Deliberately a separate projection rather than a widening of `parseTscErrors`: that function's
 * `{file, code}` shape is asserted with strict equality by `lint-tsc.test.ts` and its narrowness is
 * a documented decision (`packages/operator-core/lib/tsc-diagnostics.ts` explains why the gate
 * counts rather than carries messages). This is display-only and feeds nothing that decides a
 * verdict.
 *
 * @param {string} tscOutput - Raw compiler output.
 * @param {Iterable<string>} files - Repo-relative paths to quote lines for.
 * @param {{maxPerFile?: number, root?: string, canonicalRoot?: string}} [opts] - `maxPerFile` bounds the quote so a file with 40 errors
 *   cannot bury the guidance underneath it (the report stays readable; the count already told you
 *   the true total).
 * @returns {Map<string, string[]>} file → its diagnostic lines, in compiler order, capped.
 */
export function diagnosticLinesForFiles(
  tscOutput,
  files,
  { maxPerFile = DEFAULT_DIAGNOSTIC_MAX_PER_FILE, root, canonicalRoot } = {},
) {
  const wanted = new Set(files);
  /** @type {Map<string, string[]>} */
  const byFile = new Map();
  if (wanted.size === 0) return byFile;
  const roots = root
    ? { root: realpathOrResolve(root), canonicalRoot: realpathOrResolve(canonicalRoot ?? root) }
    : null;
  for (const line of String(tscOutput).split('\n')) {
    const m = line.match(LOCATED_DIAGNOSTIC);
    if (m === null) continue;
    const file = roots ? normalizeResolvedDiagnosticPath(m[1], roots) : m[1];
    if (!wanted.has(file)) continue;
    const acc = byFile.get(file) ?? [];
    if (acc.length < maxPerFile) acc.push(line.trim());
    byFile.set(file, acc);
  }
  return byFile;
}

/**
 * Per-file quote cap for a REGRESSED file, deliberately larger than the new-file cap of 3.
 *
 * A new file's every error is new, so three lines are a fair sample of one homogeneous set. A
 * regressed file's lines are a MIXTURE of pre-existing and new, and the reader has to find the new
 * ones among them — so cutting at 3 is far likelier to hide the very line the report exists to
 * surface. Ten bounds a pathological file without routinely truncating the ordinary 1–3 error case.
 */
export const REGRESSION_DIAGNOSTIC_MAX_PER_FILE = 10;

/** Opt out of the per-file quote caps for THIS run. */
export const ALL_ERRORS_FLAG = '--all-errors';

/**
 * The effective per-file quote cap: `defaultCap`, or uncapped under `--all-errors`.
 *
 * ## Why a flag rather than a bigger default (EI-19343733961745670)
 *
 * The caps exist so one pathological file cannot bury the guidance printed beneath it, and for the
 * ordinary 1–3 error case they never bind. But when they DO bind the reader is back in the hole
 * this whole feature was built to fill: the footer says `+30 more not shown`, and the only way to
 * read those 30 is the second full ~150s compile that queues behind pc-heavy. Capping by default
 * and letting the reader lift it keeps the common report readable without ever making the
 * expensive recompute the only route to a diagnostic the gate already has in hand.
 *
 * Applied at EVERY quoting site rather than only the regressed one. A flag honoured on some report
 * branches and silently ignored on others is worse than no flag: `--all-errors` that returns a
 * capped block reads as "that is all of them", and nothing in the output contradicts it.
 *
 * @param {string[] | undefined} argv - The gate's raw argv.
 * @param {number} defaultCap - The cap that applies without the flag.
 * @returns {number} `defaultCap`, or `Infinity` when `--all-errors` is present.
 */
export function diagnosticCapFromArgv(argv, defaultCap) {
  return Array.isArray(argv) && argv.includes(ALL_ERRORS_FLAG)
    ? Number.POSITIVE_INFINITY
    : defaultCap;
}

/**
 * The quoted-diagnostic block under ONE regressed file already present in the baseline.
 *
 * ## Why this is not simply `diagnosticLinesForFiles` again (EI-19454211066351073)
 *
 * The new-file branch (WI-6767) can quote lines and stop, because a file the baseline has never
 * seen has a baseline of 0 — every error in it is new, so any line quoted is a line you caused.
 *
 * A file at `2 → 4` is different in kind, and the difference is a trap. The baseline stores a
 * COUNT, not the errors themselves, so NOTHING in the gate knows WHICH 2 of the current 4 are new.
 * Diagnostics arrive in compiler (line) order, so quoting the first N can legitimately show only
 * pre-existing errors and never the regression at all. A reader handed three plausible errors,
 * none of which is theirs, does not discover the omission — they fix a pre-existing one and read
 * the still-red gate as flaky. That failure is worse than the silence this function replaces,
 * because it is confidently wrong rather than merely unhelpful (the same "a count delta is not
 * presence" class the containment recipe in CLAUDE.md warns about).
 *
 * So the block states its own limits: it never claims a quoted line is new, it names how many
 * pre-date the change, and it says plainly that the split is not mechanically determinable. Where
 * the baseline IS 0 the answer is unambiguous and it says THAT instead, because that is the common
 * case and the reader should not have to weigh a caveat that does not apply.
 *
 * Pure (no I/O) so the wording is unit-testable — the wording is the whole feature, mirroring
 * `formatAttributionHeadline` / `formatNewFileGuidance`.
 *
 * @param {{file: string, baseline: number, current: number, delta: number, dirty?: boolean}} row - The gate entry.
 * @param {string[]} lines - Already-capped diagnostic lines for this file (compiler order).
 * @returns {string[]} Indented lines to print beneath the row; empty when nothing was quoted.
 */
export function formatRegressedFileDiagnostics(row, lines) {
  const shown = Array.isArray(lines) ? lines : [];
  if (shown.length === 0) return [];

  const out = shown.map((line) => `      ${line}`);
  const baseline = Number(row?.baseline ?? 0);
  const current = Number(row?.current ?? shown.length);
  const hidden = Math.max(0, current - shown.length);

  if (hidden > 0) {
    out.push(`      … +${hidden} more error(s) in this file not shown (capped at ${shown.length}).`);
  }
  if (row?.dirty === true) {
    out.push(
      `      ← uncommitted, a peer is likely mid-edit — this shared-tree result may describe live bytes; do not edit from it alone.`,
    );
  }
  if (baseline > 0) {
    // Never say "your errors are above" — see the header. State the mixture and refuse to guess.
    out.push(
      `      ⚠ ${baseline} of this file's ${current} error(s) PRE-DATE your change. The baseline records only a`,
      `        COUNT, so which of the lines above are the ${current - baseline} new one(s) is NOT mechanically`,
      `        determinable — read them against what you just edited, don't assume it is the first one.`,
    );
  } else if (row?.dirty === true) {
    out.push(
      `      (this file's baseline is 0, but the uncommitted result may describe a peer's in-flight edit — do not assume every quoted error is yours.)`,
    );
  } else {
    out.push(`      (this file's baseline is 0 — every error above is new.)`);
  }
  return out;
}

/**
 * How recently a file must have been committed for its red to be treated as possibly still landing.
 *
 * 20 minutes, sized from the mechanism rather than taste: git-sync commits this tree on a schedule
 * of a few minutes, and the observed WI-6764 split was 7m49s between the two halves of one logical
 * change. 20min covers that with margin while staying far below the hours a genuine standing red
 * survives. It only ever adds a caveat — never removes one — so erring long is the safe direction.
 */
export const LANDING_RACE_WINDOW_SEC = 20 * 60;

/**
 * Last commit time (epoch seconds) per path. Fail-SOFT per file: anything unreadable maps to
 * `null`, which `partitionStandingByCommitRecency` treats as NOT recent — i.e. the loud, standing
 * reading. An unreadable git state must never manufacture a "probably fine, ignore it" caveat.
 *
 * Uses `execFileSync` (argv, no shell) so a path with a space or a shell metacharacter is passed
 * verbatim instead of being re-split or interpreted.
 *
 * @param {string} root - Repo root to run git in.
 * @param {Iterable<string>} files
 * @returns {Map<string, number | null>}
 */
export function lastCommitTimes(root, files) {
  /** @type {Map<string, number | null>} */
  const times = new Map();
  for (const file of files) {
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', file], {
        cwd: root,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });
      const parsed = Number.parseInt(out.trim(), 10);
      times.set(file, Number.isFinite(parsed) ? parsed : null);
    } catch {
      times.set(file, null);
    }
  }
  return times;
}

/**
 * Split committed new files into ones committed so recently they may be a LANDING RACE, and ones
 * settled long enough that the red is really standing (WI-6767).
 *
 * `null`/missing/future timestamps fall to `settled` — the same "unknown is never an exoneration"
 * rule `partitionNewFilesByLiveEdit` applies, and for the same reason: this caveat tells a reader
 * it is safe to wait rather than act, so it must be earned by positive evidence, never by an
 * absence of evidence.
 *
 * @param {PerFileGateEntry[]} standing - The COMMITTED subset (never a peer's live buffer).
 * @param {Map<string, number | null>} commitTimes
 * @param {number} nowSec - Current time, epoch seconds (injected so this stays pure/testable).
 * @param {number} [windowSec]
 * @returns {{recent: PerFileGateEntry[], settled: PerFileGateEntry[]}}
 */
export function partitionStandingByCommitRecency(
  standing,
  commitTimes,
  nowSec,
  windowSec = LANDING_RACE_WINDOW_SEC,
) {
  const recent = [];
  const settled = [];
  for (const r of standing) {
    const t = commitTimes.get(r.file);
    const age = typeof t === 'number' ? nowSec - t : null;
    if (age !== null && age >= 0 && age <= windowSec) recent.push(r);
    else settled.push(r);
  }
  return { recent, settled };
}

/**
 * The LANDING-RACE caveat — the third population the committed/uncommitted split cannot express.
 *
 * EI-19278299775574199 taught this report to separate a peer's UNCOMMITTED live edit ("don't touch
 * it") from a COMMITTED standing red ("fix it now"). That split is right and stays. But it assumes
 * `committed` means `settled`, and on this repo it does not: git-sync commits the WHOLE shared tree
 * on a schedule, so ONE logical multi-file change routinely lands across TWO ticks. Between them
 * the committed tree holds a half-landed change that typechecks as a genuine error belonging to
 * nobody.
 *
 * Measured, not hypothesised (WI-6764): commit 133317acd0 @20:25:57 landed a file emitting
 * `source: 'memory-recall-scale'`; the union that accepts that value arrived in watchdog.ts at
 * 82a0d03bef @20:33:46. For 7m49s the tree carried exactly one real type error. An agent ran this
 * gate inside that window, checked `git status` (clean), correctly concluded "committed ⇒ standing
 * red" — and filed a major bug for something that had healed itself ~1 minute earlier. Their
 * reasoning was sound; the report simply had no way to say "wait a moment first".
 *
 * Note what this does NOT do: it never moves the verdict, never suppresses a row, and never
 * downgrades the exit code. A landing race and a standing red are indistinguishable at this
 * instant, so the honest report is "still failing — and here is the one cheap check that tells you
 * which".
 *
 * @param {{recentCount: number, windowMin?: number}} opts
 * @returns {string[]} console lines, already indented; empty when nothing is recent.
 */
export function formatLandingRaceCaveat({ recentCount, windowMin = LANDING_RACE_WINDOW_SEC / 60 }) {
  if (recentCount <= 0) return [];
  return [
    `   ⚠ ${recentCount} of them was/were COMMITTED IN THE LAST ${windowMin} MINUTES — this may be a LANDING`,
    `   RACE rather than a standing red. git-sync commits this whole shared tree on a schedule, so ONE`,
    `   logical multi-file change routinely lands across TWO ticks; in between, the tree holds a`,
    `   half-landed change that fails to typecheck and belongs to nobody.`,
    `   BEFORE FILING A BUG: re-run this check in a few minutes and see if it clears itself.`,
    `   If the message above names a symbol defined in ANOTHER file, that is the signature — check when`,
    `   that file landed:  git log -1 --format=%ci -- <the file defining that symbol>`,
  ];
}

/**
 * V8 old-space ceiling (MB) for the `tsc` CHILD, applied by `tscChildEnv` below.
 *
 * WHY THIS EXISTS (WI-37503, measured 2026-08-09): every gate here shells out to
 * `npx tsc … --incremental false`, which builds the WHOLE program in memory —
 * 9013 files for operator-core. With no `--max-old-space-size` the child got
 * node's DEFAULT old-space (~4GB) and OOM'd mid-compile:
 *   FATAL ERROR: Ineffective mark-compacts near heap limit … heap out of memory
 *   Mark-Compact (reduce) 4086.9 (4109.7) -> 4068.3 (4086.9) MB
 * sitting exactly on the ceiling. This is a SIZE limit, not host pressure — the
 * box had ~80GB free at the time — so it recurs and worsens as the tree grows.
 *
 * It is applied HERE, at the one place every gate actually spawns, rather than
 * baked into each `TSC_COMMAND` string: there are four of those constants
 * (operator-core / operator / operator-vite / orchestrator) and a fifth would be
 * added without the number, which is precisely the drift this module's shared
 * policy half already exists to prevent.
 *
 * ⚠ It is NOT free: concurrent agents each run their own compile (WI-7191
 * measured 5 at once), so this is a per-process CEILING, not a reservation —
 * raise it deliberately. pc-heavy's coalescing window is what keeps the
 * concurrent count low enough for this to be safe.
 *
 * @type {number}
 */
export const TSC_HEAP_MB = Number(process.env.PAPERCUSP_TSC_HEAP_MB) || 8192;

/**
 * Resolve the repository's pinned TypeScript CLI by package identity, never through the
 * ambient `node_modules/.bin/tsc` slot (EI-21107417900847684).
 *
 * The toolchain contract deliberately installs TWO compilers: `@typescript/native` owns the
 * TypeScript 7 CLI, while `typescript` names the TypeScript 6 compiler API required by TypeDoc,
 * typescript-eslint, and declaration generation. During a concurrent install the shared `.bin`
 * slot briefly resolved to the unrelated placeholder `tsc` package, so `npx tsc` exited 1 with
 * zero diagnostics and red-pinned the release gate. Resolve the native package's declared bin
 * from the root manifest instead; this is the CLI counterpart of gen-declarations.ts resolving
 * its compiler-API input by package identity.
 *
 * @param {string} root repository root
 * @returns {string} absolute path to the pinned native tsc entrypoint
 */
export function resolvePinnedTscBin(root) {
  const requireFromRoot = createRequire(resolve(root, 'package.json'));
  const manifestPath = requireFromRoot.resolve('@typescript/native/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const declaredBin =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.tsc;
  if (typeof declaredBin !== 'string' || declaredBin.length === 0) {
    throw new Error(
      `@typescript/native at ${manifestPath} does not declare a tsc bin`,
    );
  }
  return resolve(dirname(manifestPath), declaredBin);
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * Replace only the canonical `npx tsc …` prefix with the pinned native compiler. Arbitrary
 * injected commands (the focused tests use `cat <fixture>`) remain byte-for-byte unchanged.
 *
 * @param {string} root repository root
 * @param {string} tscCommand configured command
 * @returns {string}
 */
export function resolvePinnedTscCommand(root, tscCommand) {
  const command = String(tscCommand ?? '');
  const prefix = command.match(/^\s*npx(?:\s+--no-install)?\s+tsc(?=\s|$)/);
  if (!prefix) return command;
  const suffix = command.slice(prefix[0].length);
  return `${shellQuote(process.execPath)} ${shellQuote(resolvePinnedTscBin(root))}${suffix}`;
}

/**
 * The child env for a tsc spawn: `process.env` plus `extra`, with
 * `--max-old-space-size` appended to NODE_OPTIONS.
 *
 * An existing LARGER `--max-old-space-size` is left alone — an operator who
 * pinned more must win — and a second copy is never appended (that would
 * silently take the LAST occurrence rather than erroring).
 *
 * ⚠ A SMALLER existing value is RAISED, not deferred to. This is a correction
 * (WI-37450, measured 2026-08-09): the previous rule deferred to ANY existing
 * pin, reasoning that "a constrained CI box that pinned a smaller one must win".
 * That is wrong for THIS workload and it froze the fleet gate for ~10h across 11
 * consecutive reds. The chain:
 *
 *   buildGreenCheckpointEnv (green-checkpoint.ts:3145) unconditionally sets
 *   NODE_OPTIONS = sanitizeForkNodeOptions(...), which always pins
 *   `--max-old-space-size=GREEN_CHECKPOINT_FORK_HEAP_MB` (4096) so eight
 *   concurrent TEST forks cannot each inherit the bg-host's 128 GiB heap. That
 *   env is then handed to runPostSuiteLegs, which spawns `npm run lint:tsc`
 *   with it — so the tsc child inherited a cap meant for a FORK POOL, this
 *   function deferred to it, and TSC_HEAP_MB never applied. Measured red:
 *   `Mark-Compact (reduce) 4081.5 (4104.6) -> 4060.6 (4078.6) MB`, i.e. a ~4 GB
 *   ceiling on a compile that needs 8 GB.
 *
 * Deferring BELOW what the compile provably needs is never a graceful
 * degradation — it converts "this box might be tight" into "this gate is
 * structurally unpassable", which is strictly worse and silent. The 4096 pin is
 * correct for its own purpose (a per-FORK cap) and simply is not a statement
 * about a single whole-program tsc process.
 *
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string | undefined>}
 */
export function tscChildEnv(extra = {}) {
  const existing = process.env.NODE_OPTIONS ?? '';
  const pinned = /--max-old-space-size(?:=|\s+)(\d+)/.exec(existing);
  let nodeOptions;
  if (!pinned) {
    nodeOptions = `${existing} --max-old-space-size=${TSC_HEAP_MB}`.trim();
  } else if (Number(pinned[1]) >= TSC_HEAP_MB) {
    nodeOptions = existing;
  } else {
    // Rewrite in place: appending a second copy would depend on last-wins.
    nodeOptions = existing.replace(
      /--max-old-space-size(?:=|\s+)\d+/,
      `--max-old-space-size=${TSC_HEAP_MB}`,
    );
  }
  // EI-21459562605356711: an exclusive dependency materializer may cooperatively
  // preempt this ordinary heavy-slot holder. pc-heavy reports that exact outcome
  // as exit 75 plus `PC_HEAVY_RESULT status=preempted`, but without an opted-in
  // retry this wrapper receives no compiler stdout and mislabels the attributable,
  // retryable transition as "tsc produced no output — toolchain failure". Give the
  // compiler a small bounded retry budget. Explicit caller/extra values remain
  // authoritative so diagnostics and constrained environments can disable or tune it.
  const retryPreemptions = process.env.PC_HEAVY_RETRY_PREEMPTIONS ?? '3';
  return {
    ...process.env,
    PC_HEAVY_RETRY_PREEMPTIONS: retryPreemptions,
    ...extra,
    NODE_OPTIONS: nodeOptions,
  };
}

/**
 * EI-19341572300046923 — the repo-relative directory prefix a `tsc -p <dir>/tsconfig.json`
 * invocation actually COMPILES.
 *
 * Every per-project CLI here is a thin wrapper whose `tscCommand` is a per-project constant
 * (`lint-tsc.mjs` → `packages/operator-core/`, `lint-tsc-operator-vite.mjs` →
 * `apps/operator-vite/`, …). `--files=` is a GATE-scoping flag that never reaches tsc, so
 * naming a file OUTSIDE that project does not widen the compile — it just scopes the verdict
 * to files this run never looked at. Deriving the prefix from the command itself (rather than
 * a hand-maintained roster) means a new per-project CLI inherits the guard below for free;
 * a roster would reproduce the very "gate exists, gates nothing" defect WI-6841 documents.
 *
 * @param {string} tscCommand
 * @returns {string | null} prefix with a trailing slash, `''` for a whole-repo project, or
 *   `null` when no `-p` operand is parseable (callers must then FAIL OPEN — an unparseable
 *   command is not evidence that a file is uncovered).
 */
export function projectPrefixFromTscCommand(tscCommand) {
  const m = /(?:^|\s)-p\s+(\S+)/.exec(String(tscCommand ?? ''));
  if (!m) return null;
  const withoutConfig = m[1].replace(/^["']|["']$/g, '').replace(/(?:^|\/)tsconfig[^/]*\.json$/, '');
  if (withoutConfig === '' || withoutConfig === '.') return '';
  return withoutConfig.endsWith('/') ? withoutConfig : `${withoutConfig}/`;
}

/**
 * Canonicalize an explicit `--files=` set to repository-relative paths while accepting paths
 * relative to the workspace that launched the gate.
 *
 * The operator-core gate is exposed both from the repository root and as the package's own npm
 * script. npm runs a workspace script with that workspace as `cwd`, so `--files=lib/foo.ts`
 * means `packages/operator-core/lib/foo.ts` in the latter form. Existing callers also pass
 * repository-relative paths, including from a workspace cwd. Prefer a direct repository spelling
 * whenever it is already covered (or names an existing repository path), then resolve the entry
 * from `cwd` only when that candidate lands under a covered gate prefix. An unresolved direct
 * path is preserved when neither interpretation is covered, so the caller still receives the
 * normal out-of-scope diagnostic instead of a guessed green verdict.
 *
 * @param {{files: Iterable<string>, root: string, coveredPrefixes: Iterable<string>, cwd?: string, pathExists?: (path: string) => boolean}} opts
 * @returns {Set<string>}
 */
export function normalizeExplicitFilesForProject({
  files,
  root,
  coveredPrefixes,
  cwd = process.cwd(),
  pathExists = (path) => existsSync(resolve(root, path)),
}) {
  const prefixes = [...coveredPrefixes]
    .filter((prefix) => typeof prefix === 'string')
    .map((prefix) => (prefix === '' || prefix.endsWith('/') ? prefix : `${prefix}/`));
  const isCovered = (path) => prefixes.some((prefix) => prefix === '' || path.startsWith(prefix));
  const normalizePath = (path) => String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  const toRepoRelative = (raw) => {
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    const relativePath = relative(root, absolute);
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
    return normalizePath(relativePath);
  };

  const normalized = new Set();
  for (const rawValue of files) {
    const raw = String(rawValue);
    const direct = normalizePath(raw);
    const directIsCovered = isCovered(direct);
    const directExists = !isAbsolute(raw) && direct !== '' && pathExists(direct);
    if (directIsCovered || directExists) {
      normalized.add(direct);
      continue;
    }

    const fromCwd = toRepoRelative(raw);
    if (fromCwd !== null && isCovered(fromCwd)) normalized.add(fromCwd);
    else normalized.add(direct);
  }
  return normalized;
}

/**
 * Split the caller's `--files=` set into the files this invocation can actually judge and the
 * ones it cannot.
 *
 * A `''` prefix (whole-repo project) covers everything.
 *
 * @param {{files: Iterable<string>, coveredPrefixes: Iterable<string>}} opts
 * @returns {{covered: string[], uncovered: string[]}}
 */
export function partitionFilesByCoverage({ files, coveredPrefixes }) {
  const prefixes = [...coveredPrefixes].filter((p) => typeof p === 'string');
  const covered = [];
  const uncovered = [];
  for (const raw of files) {
    const file = String(raw).replace(/^\.\//, '');
    if (prefixes.some((p) => p === '' || file.startsWith(p))) covered.push(file);
    else uncovered.push(file);
  }
  return { covered, uncovered };
}

/**
 * Which typecheck gate DOES cover `file`? Discovery, not a hardcoded map: walk up to the
 * nearest `package.json` and read its `typecheck` script.
 *
 * The four per-project gates in this repo are reachable this way because each workspace's own
 * `typecheck` script points at the right one (e.g. apps/operator-vite's is
 * `node ../../scripts/lint-tsc-operator-vite.mjs`, the baseline-gated form — not a raw `tsc`).
 * So a workspace that earns a gate later is routed to automatically.
 *
 * @param {string} root Absolute repo root.
 * @param {string} file Repo-relative path.
 * @returns {{workspaceDir: string, packageName: string, standalone: boolean, command: string | null} | null}
 *   `command: null` = the owning workspace declares NO typecheck script (a real coverage gap,
 *   worth saying out loud); `null` = no owning package.json found at all. `standalone: true` =
 *   no root `workspaces` pattern names the package, so it is run with `npm --prefix`.
 */
export function suggestTypecheckGate(root, file) {
  const parts = String(file).replace(/^\.\//, '').split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = parts.slice(0, i).join('/');
    const pkgPath = resolve(root, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      continue;
    }
    const hasTypecheck = Boolean(pkg?.scripts?.typecheck);
    const standalone = !isRootWorkspace(dir, rootWorkspacePatterns(root));
    return {
      workspaceDir: dir,
      packageName: typeof pkg?.name === 'string' ? pkg.name : dir,
      standalone,
      command: hasTypecheck ? `npm ${workspaceTypecheckArgs(dir, standalone).join(' ')}` : null,
    };
  }
  return null;
}

/**
 * WI-10003822 — the `npm` argv that runs `typecheck` inside ONE owning package.
 *
 * A STANDALONE package (a package.json that no root `workspaces` pattern names, e.g.
 * `tools/perf-test/wdio` or `papercusp-desktop`) is not an npm workspace, so
 * `npm run --workspace <dir> typecheck` answers "No workspaces found" and exits 1 having
 * checked nothing. `npm --prefix <dir> run typecheck` runs the same script there. Measured
 * 2026-09-29 on tools/perf-test/wdio: the --workspace form exits 1, the --prefix form runs
 * `tsc --noEmit` and exits 0. affected-tests' formatWorkspaceCommand makes the same split
 * (EI-22152426246970496).
 *
 * Misclassifying a real workspace as standalone is the safe direction: `--prefix` still runs
 * that package's script. Only the reverse ever fails.
 *
 * @param {string} workspaceDir Repo-relative package directory.
 * @param {boolean} standalone True when no root `workspaces` pattern covers it.
 * @returns {string[]} argv for `npm`, executed without a shell.
 */
export function workspaceTypecheckArgs(workspaceDir, standalone) {
  return standalone
    ? ['--prefix', workspaceDir, 'run', 'typecheck']
    : ['run', '--workspace', workspaceDir, 'typecheck'];
}

/**
 * EI-19461218392796337 — the repo-relative prefixes ONE sibling gate module actually compiles.
 *
 * Read from the module's REAL exports, never re-derived from its source text: a static mirror of
 * a value the module already exports is exactly the drift-prone shape these gates keep getting
 * bitten by, and the whole defect this closes is a conclusion drawn from a partial view.
 *
 * Two declaration forms, in priority order:
 *  - `GATE_COVERAGE` — an explicit prefix list (or a thunk returning one), for FAN-OUT gates
 *    whose coverage is a discovered set rather than a single `-p` project.
 *  - `TSC_COMMAND` — the per-project constant the four single-project CLIs already export.
 *
 * ⚠ A `GATE_COVERAGE` THUNK MAY THROW, and that must degrade rather than crash. The fan-out gates
 * compute their coverage by WALKING THE FILESYSTEM (EI-19462776655300160), so a broken tree, a
 * permission error or an unreadable package.json raises here — on the uncovered-files ERROR path,
 * i.e. exactly when the gate is already reporting something and least able to afford an
 * unhandled throw. A throw is caught and reported as `null`, so the gate lands in `unresolved`
 * with its reason and the banner says "none FOUND": the same honest degradation as a module that
 * declares nothing. Never let it read as "this gate covers nothing", which would be a confident
 * claim derived from a failure to look.
 *
 * @param {Record<string, unknown>} mod An imported gate module.
 * @param {{onCoverageError?: (err: unknown) => void}} [opts] Notified when a `GATE_COVERAGE` thunk
 *   THREW, so the caller can say so instead of reporting the generic "exports neither" reason —
 *   which would be false here (it does export one; it failed). Both are `null`, but only one of
 *   them is the module's fault, and a reason that misattributes the cause sends the reader to the
 *   wrong file.
 * @returns {string[] | null} Prefixes (trailing slash, `''` = whole repo), or `null` when this
 *   module declares nothing parseable — which callers MUST treat as "unknown", never "covers
 *   nothing" (see `discoverSiblingTypecheckGates`).
 */
export function coveragePrefixesFromGateModule(mod, { onCoverageError } = {}) {
  let raw;
  try {
    raw = typeof mod?.GATE_COVERAGE === 'function' ? mod.GATE_COVERAGE() : mod?.GATE_COVERAGE;
  } catch (err) {
    onCoverageError?.(err);
    return null;
  }
  if (Array.isArray(raw)) {
    const prefixes = raw
      .filter((p) => typeof p === 'string')
      .map((p) => (p === '' || p.endsWith('/') ? p : `${p}/`));
    return prefixes.length > 0 ? prefixes : null;
  }
  if (typeof mod?.TSC_COMMAND === 'string') {
    const prefix = projectPrefixFromTscCommand(mod.TSC_COMMAND);
    return prefix === null ? null : [prefix];
  }
  return null;
}

/**
 * EI-19461218392796337 — every `lint:tsc*` gate declared in the root package.json, with the
 * prefixes each one really covers.
 *
 * ## Why this exists
 *
 * The uncovered-files banner used to conclude, from two things it could see (the file is outside
 * MY project; its workspace declares no `typecheck` script), a universal it could not:
 * "NO typecheck gate covers these — nothing local will ever catch a type error here." The
 * per-project SIBLING gates are a third case it never consulted, and being covered by a sibling
 * while declaring no workspace script is the NORMAL arrangement in this repo — so the sentence
 * was wrong in the common case, not a rare one.
 *
 * Measured cost of that one sentence (2026-08-03): it talked an agent out of
 * `npm run lint:tsc:operator` — which covers the file exactly — into hand-grepping a raw
 * 579-error `tsc` run, where they classified 5 type errors they had just introduced into
 * `green-checkpoint.test.ts` as a pre-existing file-wide pattern and shipped them. The file it
 * declared uncoverable implements the fleet's release gate.
 *
 * ## The discipline this function has to keep
 *
 * A wider view is still a partial view. Every gate that cannot be resolved is returned in
 * `unresolved` WITH a reason, so the banner can say "none found" instead of "none exists" — a
 * fix that replaced one confident universal with a slightly better-informed confident universal
 * would be the same defect wearing a bigger hat. Symmetrically, coverage is only ever claimed
 * from a gate's own declared prefixes, so this never routes a caller to a gate that would not in
 * fact check their file.
 *
 * Discovery, not a roster: a new `lint:tsc:*` script is picked up the moment it lands.
 *
 * @param {string} root Absolute repo root.
 * @param {{exclude?: string[]}} [opts] npm-script names to skip (e.g. the gate doing the asking).
 * @returns {Promise<{gates: {npmScript: string, prefixes: string[]}[], unresolved: {npmScript: string, reason: string}[], rosterReadable: boolean}>}
 *   `rosterReadable: false` means the root package.json itself could not be read — the roster is
 *   entirely unknown, so NO absence claim of any strength is available.
 */
export async function discoverSiblingTypecheckGates(root, { exclude = [] } = {}) {
  /** @type {{npmScript: string, prefixes: string[]}[]} */
  const gates = [];
  /** @type {{npmScript: string, reason: string}[]} */
  const unresolved = [];

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  } catch (err) {
    return { gates, unresolved, rosterReadable: false };
  }

  for (const [npmScript, command] of Object.entries(pkg?.scripts ?? {})) {
    if (!/^lint:tsc(?::|$)/.test(npmScript)) continue;
    if (exclude.includes(npmScript)) continue;

    const entry = /node\s+(\S+\.mjs)/.exec(String(command ?? ''));
    if (!entry) {
      unresolved.push({ npmScript, reason: 'npm script has no `node <script>.mjs` entrypoint' });
      continue;
    }
    const scriptPath = resolve(root, entry[1]);
    if (!existsSync(scriptPath)) {
      unresolved.push({ npmScript, reason: `entrypoint ${entry[1]} does not exist` });
      continue;
    }

    let mod;
    try {
      // Safe to import: gate CLIs use the bundle-aware `isCliEntry(import.meta.url)` primitive,
      // so importing one reads its declarations without running its CLI main. The companion
      // source and bundle guards reject new hand-rolled `import.meta.url`/argv entry checks.
      mod = await import(pathToFileURL(scriptPath).href);
    } catch (err) {
      unresolved.push({
        npmScript,
        reason: `could not import ${entry[1]}: ${String(err?.message ?? err)}`,
      });
      continue;
    }

    /** @type {unknown} */
    let coverageError = null;
    const prefixes = coveragePrefixesFromGateModule(mod, {
      onCoverageError: (err) => {
        coverageError = err;
      },
    });
    if (prefixes === null) {
      unresolved.push({
        npmScript,
        reason: coverageError
          ? `${entry[1]} exports GATE_COVERAGE but calling it THREW: ${String(
              /** @type {any} */ (coverageError)?.message ?? coverageError,
            )}`
          : `${entry[1]} exports neither GATE_COVERAGE nor a parseable TSC_COMMAND`,
      });
      continue;
    }
    gates.push({ npmScript, prefixes });
  }

  return { gates, unresolved, rosterReadable: true };
}

/**
 * The MOST SPECIFIC sibling gate covering `file`, or `null`.
 *
 * Longest matching prefix wins, so a file under `libs/papercusp/packages/orchestrator/` routes to
 * `lint:tsc:orchestrator` rather than the broader `lint:tsc:papercusp-libs` fan-out that also
 * contains it — the narrower gate is the faster, more attributable answer.
 *
 * @param {{npmScript: string, prefixes: string[]}[]} gates
 * @param {string} file Repo-relative path.
 * @returns {{npmScript: string, prefix: string} | null}
 */
export function gateCoveringFile(gates, file) {
  const target = String(file).replace(/^\.\//, '');
  /** @type {{npmScript: string, prefix: string} | null} */
  let best = null;
  for (const gate of gates ?? []) {
    for (const prefix of gate.prefixes ?? []) {
      if (prefix !== '' && !target.startsWith(prefix)) continue;
      if (best === null || prefix.length > best.prefix.length) {
        best = { npmScript: gate.npmScript, prefix };
      }
    }
  }
  return best;
}

const AUTO_TYPECHECK_ROUTE_ENV = 'PAPERCUSP_TSC_AUTO_ROUTE';

/**
 * Build the verified commands that can judge an out-of-project file set.
 *
 * A workspace `typecheck` script is the owning workspace's whole-project gate, while a
 * discovered sibling `lint:tsc*` gate is an exact-file gate. The distinction matters: appending
 * `--files` to an arbitrary workspace script is not safe, but a sibling lint gate explicitly
 * accepts that selector. Files with neither route stay in `unknown`; callers MUST NOT execute a
 * partial route set and then claim the original request was covered.
 *
 * @param {{files: Iterable<string>, suggestions: Map<string, ReturnType<typeof suggestTypecheckGate>>, siblingGates?: {npmScript: string, prefixes: string[]}[]}} opts
 * @returns {{routes: {key: string, workspaceDir?: string, standalone?: boolean, npmScript?: string, files: string[], scoped: boolean, command: string, args: string[]}[], unknown: string[]}}
 */
export function collectAutoTypecheckRoutes({ files, suggestions, siblingGates = [] }) {
  /** @type {Map<string, {key: string, workspaceDir?: string, standalone?: boolean, npmScript?: string, files: string[], scoped: boolean}>} */
  const grouped = new Map();
  const unknown = [];

  for (const raw of files) {
    const file = String(raw).replace(/^\.\//, '');
    const suggestion = suggestions?.get(file);
    /** @type {{key: string, workspaceDir?: string, standalone?: boolean, npmScript?: string, scoped: boolean} | null} */
    let route = null;

    // Prefer a verified exact-file sibling gate over a workspace's generic
    // `typecheck` script. The root command was previously selecting the broad
    // workspace suggestion first, silently dropping the caller's --files scope
    // and turning a two-file verification into a verdict over every peer edit.
    const sibling = gateCoveringFile(siblingGates, file);
    if (sibling) {
      route = {
        key: `sibling:${sibling.npmScript}`,
        npmScript: sibling.npmScript,
        scoped: true,
      };
    }

    // `suggestTypecheckGate` constructs this command from a repo-relative workspace directory.
    // Require the directory as a separate field so callers cannot turn an arbitrary display
    // string into a command to execute.
    if (
      route === null &&
      suggestion?.command &&
      typeof suggestion.workspaceDir === 'string' &&
      suggestion.workspaceDir.length > 0 &&
      !suggestion.workspaceDir.startsWith('/') &&
      !suggestion.workspaceDir.split('/').includes('..')
    ) {
      route = {
        key: `workspace:${suggestion.workspaceDir}`,
        workspaceDir: suggestion.workspaceDir,
        standalone: suggestion.standalone === true,
        scoped: false,
      };
    }

    if (!route) {
      unknown.push(file);
      continue;
    }
    const existing = grouped.get(route.key) ?? { ...route, files: [] };
    existing.files.push(file);
    grouped.set(route.key, existing);
  }

  const routes = [...grouped.values()].map((route) => {
    if (route.scoped) {
      const filesArg = `--files=${route.files.join(',')}`;
      return {
        ...route,
        command: `npm run ${route.npmScript} -- ${filesArg}`,
        args: ['run', route.npmScript, '--', filesArg],
      };
    }
    const args = workspaceTypecheckArgs(route.workspaceDir, route.standalone === true);
    return {
      ...route,
      command: `npm ${args.join(' ')}`,
      args,
    };
  });
  return { routes, unknown };
}

/**
 * Execute an already-validated set of owning gates and return the first non-zero status.
 *
 * The environment marker prevents a malformed workspace script from recursively routing back
 * into this gate forever. A routed child owns the actual verdict; this caller only aggregates its
 * exit status. `execFile` is injectable for unit tests and never receives a shell command string.
 *
 * @param {{root: string, routes: {args: string[]}[], execFile?: Function}} opts
 * @returns {number}
 */
export function runAutoTypecheckRoutes({ root, routes, execFile = execFileSync }) {
  if (!Array.isArray(routes) || routes.length === 0) return 1;
  let firstFailure = 0;
  for (const route of routes) {
    try {
      execFile('npm', route.args, {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, [AUTO_TYPECHECK_ROUTE_ENV]: '1' },
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status > 0 ? error.status : 1;
      if (firstFailure === 0) firstFailure = status;
    }
  }
  return firstFailure;
}

/**
 * The banner for `--files=` entries this run cannot judge.
 *
 * Written to be impossible to mistake for a pass: the failure this closes is that a scoped run
 * naming only out-of-project files printed a clean verdict having typechecked NONE of them —
 * indistinguishable from a real green, which is the same silent-zero shape `build:typecheck`
 * already refuses (it will not report a clean run that checked zero files).
 *
 * @param {{label: string, uncovered: string[], suggestions: Map<string, ReturnType<typeof suggestTypecheckGate>>, fatal: boolean, autoRoute?: boolean, siblingGates?: {npmScript: string, prefixes: string[]}[], unresolvedGates?: {npmScript: string, reason: string}[], rosterReadable?: boolean}} opts
 * @returns {string[]} console lines.
 */
export function formatUncoveredFilesBanner({
  label,
  uncovered,
  suggestions,
  fatal,
  autoRoute = false,
  siblingGates = [],
  unresolvedGates = [],
  rosterReadable = true,
}) {
  const lines = [''];
  // EI-21985804122617157 — the header states the OUTCOME, so it must agree with what happens
  // next. Both non-routing headers say the files were not typechecked, which was true when the
  // only follow-up was a command printed for the caller to run. Now that routing also fires for a
  // MIXED set, that wording would sit one line above "AUTO-ROUTING to check them" and flatly
  // contradict it — and a reader who believes the header stops reading there, which is the whole
  // failure this banner exists to prevent, re-created by stale wording.
  lines.push(
    autoRoute
      ? `→ ${uncovered.length} of the file(s) you named are outside \`${label}\` — ROUTING them to the gate that owns them.`
      : fatal
        ? `❌ NOTHING YOU NAMED WAS TYPECHECKED — all ${uncovered.length} file(s) are outside \`${label}\`.`
        : `⚠ ${uncovered.length} of the file(s) you named are OUTSIDE \`${label}\` and were NOT typechecked.`,
  );
  lines.push(`   \`--files=\` scopes this gate's VERDICT; it does not widen what tsc compiles.`);
  lines.push('');

  /** @type {Map<string, {files: string[], scoped: boolean}>} */
  const byCommand = new Map();
  const ungated = [];
  const addCommand = (command, file, scoped) => {
    const entry = byCommand.get(command) ?? { files: [], scoped: false };
    entry.files.push(file);
    entry.scoped ||= scoped;
    byCommand.set(command, entry);
  };
  for (const file of uncovered) {
    const s = suggestions.get(file);
    // Keep the displayed route identical to the executable route assembled by
    // collectAutoTypecheckRoutes: an exact-file sibling gate outranks a broad
    // workspace typecheck whenever both exist.
    const sibling = gateCoveringFile(siblingGates, file);
    if (sibling) {
      const command = `npm run ${sibling.npmScript}`;
      addCommand(command, file, true);
      continue;
    }
    if (s?.command) {
      // A workspace's own `typecheck` script usually invokes raw `tsc` and does not promise
      // to accept the caller's `--files` selector. Run that command for the whole workspace;
      // sibling lint:tsc* gates below explicitly support exact-file scoping.
      addCommand(s.command, file, false);
      continue;
    }
    // EI-19461218392796337 — before concluding anything is uncovered, ask the SIBLING gates.
    // A workspace that declares no `typecheck` script but IS covered by a per-project
    // `lint:tsc:*` gate is the normal arrangement here, and it was the case this banner used to
    // declare permanently uncheckable.
    ungated.push({ file, workspaceDir: s?.workspaceDir ?? null });
  }

  for (const [command, entry] of byCommand) {
    // Preserve the caller's scoped-verdict contract when handing off to a sibling gate. A bare
    // sibling command would typecheck its whole project (and lose the exact file attribution
    // that led us here), while a workspace-owned `typecheck` command is not assumed to support
    // the same selector and must be run without an appended compiler flag.
    const scope = entry.scoped ? ` -- --files=${entry.files.join(',')}` : '';
    lines.push(
      `   ${autoRoute ? 'AUTO-ROUTING to check them' : 'RUN THIS to check them'}:  ${command}${scope}`,
    );
    for (const f of entry.files) lines.push(`     - ${f}`);
  }
  if (ungated.length) {
    // Deliberately NOT "no gate covers these / nothing local will ever catch a type error here".
    // That was a universal claimed from a partial view, and it cost an agent a shipped regression
    // by arguing them out of the gate that did cover their file. State what was SEARCHED and what
    // could not be seen; let the reader draw the conclusion the evidence actually supports.
    lines.push(`   ⚠ No typecheck gate FOUND for these:`);
    for (const u of ungated) {
      lines.push(`     - ${u.file}${u.workspaceDir ? `   (workspace ${u.workspaceDir} declares no \`typecheck\` script)` : ''}`);
    }
    const blind = !rosterReadable || unresolvedGates.length > 0;
    if (blind) {
      lines.push(
        `     ⚠ …and the search was INCOMPLETE, so this is "none found", NOT "none exists":`,
      );
      if (!rosterReadable) {
        lines.push(`       · the root package.json could not be read — no gate roster available`);
      }
      for (const g of unresolvedGates) lines.push(`       · ${g.npmScript} — ${g.reason}`);
    } else {
      lines.push(
        `     Searched: every \`lint:tsc*\` gate in package.json, plus each file's own workspace \`typecheck\` script.`,
      );
    }
    lines.push(
      `     To check them by hand:  npx tsc --noEmit -p <workspace>/tsconfig.json  (NOT \`-p .\` — there is no root tsconfig.json)`,
    );
  }
  lines.push('');
  return lines;
}

/**
 * The `.d.mts` companions of the `.mjs` modules declared in `tsconfig.declarations.json`
 * (WI-6394's naming convention: `foo.mjs` -> `foo.d.mts`, same directory) — the hidden
 * dependency `coalesceWatermarkFor` folds in below (EI-19483243844876537).
 *
 * Deliberately duplicated rather than imported from `scripts/gen-declarations.ts`: that
 * module calls `generate()`/`check()` UNCONDITIONALLY at module load — no entrypoint guard —
 * so importing it here would regenerate declarations as a side effect of every gate call,
 * including read-only ones on a shared, concurrently-edited checkout. `generated-
 * declarations.test.ts` already duplicates `BANNER_MARKER` for the identical reason; this
 * follows the same precedent rather than introducing a new one.
 *
 * By default, read/parse errors return an empty array for the supplementary freshness
 * signal. Publishing callers use strict mode so unreadable enrollment fails the preflight.
 *
 * @param {string} root
 * @param {{ strict?: boolean }} [options] - Publishing callers must reject unreadable enrollment.
 * @returns {string[]} repo-relative `.d.mts` paths
 */
export function declarationFilesFromConfig(root, { strict = false } = {}) {
  try {
    const raw = readFileSync(resolve(root, 'tsconfig.declarations.json'), 'utf8');
    // tsc accepts JSONC (`//` comments) here — strip before parsing, same approach as
    // gen-declarations.ts's own `inputs()`.
    const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
    const parsed = JSON.parse(stripped);
    if (strict && (!Array.isArray(parsed.files) || parsed.files.length === 0 ||
      parsed.files.some((file) => typeof file !== 'string' || !file.endsWith('.mjs')))) {
      throw new Error('tsconfig.declarations.json must name at least one .mjs input');
    }
    const mjsFiles = Array.isArray(parsed.files) ? parsed.files : [];
    return mjsFiles.map((f) => String(f).replace(/\.mjs$/, '.d.mts'));
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

/**
 * The freshness watermark this run may safely replay a COALESCED compile from
 * (epoch seconds), or `null` to opt out of sharing entirely.
 *
 * ## Why a watermark makes sharing safe where a tree token could not
 *
 * A full compile that STARTED at S read every file as of S. So its diagnostics are a
 * true answer about file F iff F has not changed since S. The dominant caller here is
 * an agent that edited F and immediately asked "did I break it?" — for that caller the
 * only thing that can invalidate a shared result is a change to *its own* files, never
 * a peer's edit somewhere else in the tree.
 *
 * pc-heavy's tree-state token asks the whole-tree question instead, which is sound but
 * far stricter, and on this repo strictly worse than useless: the token moves ~every 18s
 * against a ~170s compile, so two callers seconds apart never share a key and every one
 * of them pays a full compile (measured 2026-08-02; 3-5 byte-identical operator-core
 * compiles observed running at once, three separate times that day). Passing the
 * watermark lets pc-heavy drop the token and answer the narrower question exactly.
 *
 * ## The two opt-outs, and why each is a correctness requirement
 *
 * - **Unscoped run** (no `--files`): a bare `npm run lint:tsc` (CI, green-checkpoint)
 *   renders a verdict over EVERY file, so its watermark would have to be "no file in the
 *   project has changed since S" — which is the tree-token question again, and would be
 *   wrong to approximate with anything narrower. Return null: run fresh, share nothing.
 * - **`--update`**: the ratchet WRITES `.tsc-baseline.json`, lowering a file's recorded
 *   count. Ratcheting off a replayed compile would persist a number nobody re-measured
 *   from this tree state, and a too-low baseline is the failure mode the whole gate
 *   exists to prevent (EI-487 / WI-4488: an under-report that ratchets in reads as clean
 *   for days). A run that WRITES the baseline measures it itself.
 *
 * ## KNOWN NARROWING — name every file you edited, not just the one you are asking about
 *
 * The watermark is computed from the files you NAMED, so the guarantee it buys is exactly
 * "the shared compile postdates edits to the files this run renders a verdict on". If you
 * edit G and then ask only about F, a replay may come from a compile that predates the G
 * edit — and since F imports G, F's reported count could be pre-G. The tree token used to
 * cover that incidentally (any edit anywhere busted the key), so this is a real narrowing
 * and not merely a restatement.
 *
 * It is accepted rather than closed for the GENERAL case, because every way of closing it
 * re-widens the watermark to "any uncommitted edit in the tree", which on a checkout ~16
 * agents are saving into is `now` on every call — i.e. exactly the churn that made
 * coalescing impossible in the first place (~1 change/18s vs a ~170s compile). The
 * mitigation is the instruction the gate already gives everywhere: pass `--files=` listing
 * what you actually changed. That is also what makes the VERDICT trustworthy here, so the
 * two align.
 *
 * ONE instance of "G edited, F asked about" IS closed, narrowly, because it doesn't share
 * the churn problem above: generated `.d.mts` declarations (EI-19483243844876537). They are
 * a small, fixed, enumerable set (`tsconfig.declarations.json`'s `files`, currently ~11) that
 * only moves on an explicit `npm run gen:declarations` run — not on every peer's save — so
 * folding them in doesn't reintroduce the per-18s churn the general fix was rejected for. See
 * `declarationFilesFromConfig` below.
 *
 * @param {{ root: string, files: Set<string> | null, updateFlag: boolean }} args
 * @returns {number | null} epoch seconds, or null to disable coalescing for this run
 */
export function coalesceWatermarkFor({ root, files, updateFlag }) {
  if (updateFlag) return null;
  if (files === null || files.size === 0) return null;

  let newestMs = 0;
  for (const rel of files) {
    let st;
    try {
      st = statSync(resolve(root, rel));
    } catch {
      // A named file we cannot stat (deleted, or a path typo) is not evidence that
      // nothing changed. Fail CLOSED — give up on sharing rather than compute a
      // watermark from an incomplete view of what the caller asked about.
      return null;
    }
    if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
  }

  // EI-19483243844876537: a checked file's OWN mtime says nothing about a GENERATED
  // `.d.mts` a different, already-tracked `.mjs` module exports through — tsc resolves
  // an importer's types via the companion declaration, not the `.mjs` source, so
  // `npm run gen:declarations` can flip a checked file's verdict without the checked
  // file itself moving. Without this, a compile that started AFTER the checked files'
  // own mtimes but BEFORE a `gen:declarations` run is wrongly accepted as fresh —
  // reproduced 2026-08-04: added exports to a `.mjs`, regenerated declarations, then
  // `lint:tsc --files=<tests using the new export>` replayed a pre-regen cached compile
  // reporting TS2305 for exports that provably existed on disk.
  //
  // Fold in the newest declaration mtime alongside the checked files' own. Best-effort
  // and fails OPEN per file (unlike the loop above): an unreadable/missing declaration
  // is not evidence of anything about THIS caller's freshness question, so it is
  // skipped rather than aborting the whole watermark. This can only make the watermark
  // MORE conservative (never less) — worst case is an occasional unnecessary fresh
  // compile, never a wrongly-stale replay.
  for (const rel of declarationFilesFromConfig(root)) {
    let st;
    try {
      st = statSync(resolve(root, rel));
    } catch {
      continue;
    }
    if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
  }

  if (newestMs <= 0) return null;

  // +1 and floor, deliberately: mtime carries sub-second precision and pc-heavy stamps
  // whole seconds. A file written at t.900 floors to t, so a compile that started at
  // t.100 — BEFORE the edit — would also stamp t and compare equal, replaying a
  // pre-edit answer as if it were fresh. Rounding the watermark UP past the whole
  // second the edit falls in makes the comparison sound at one-second granularity, at
  // the cost of rejecting a replay in the <1s window where it might just have been ok.
  return Math.floor(newestMs / 1000) + 1;
}

/**
 * Build the argv handed to pc-heavy for one compiler pass.
 *
 * `--files` scopes the GATE verdict, not TypeScript itself, so it is deliberately
 * absent from {@link executableTscCommand}. Put the stable `lint:tsc` sentinel after
 * `sh -c`'s command string for EVERY compile — `sh` consumes it as `$0`, while
 * pc-heavy uses it to recognize the finite-cgroup typecheck shape even though the
 * real compiler command is inside one shell-string argument. A scoped invocation
 * also carries the stable `--files` marker as `$1`, which lets release-gate
 * materialization route only those calls through the focused lane. Neither sentinel
 * includes the caller's real comma-separated file list, preserving coalescing.
 */
export function pcHeavyCompileArgv(executableTscCommand, scoped) {
  const argv = ['sh', '-c', `${executableTscCommand} 2>&1`, 'lint:tsc'];
  if (scoped) argv.push('--files=__pc_heavy_scoped__');
  return argv;
}

/**
 * Which scope the caller asked this gate to judge — reported on the completion marker so a
 * reader can tell a whole-project verdict from one scoped to a handful of files. `--update`
 * leads because it MUTATES the baseline rather than judging against it.
 *
 * EI-19444246913245434 — `--update` used to be reported ALONE, swallowing any scope flag beside
 * it, so `--files=X --update` announced a whole-project `scope=update` for a run that judged (and,
 * before the same fix, wrote) only X. The label was the more visible of the two disagreeing
 * facts, which is what made the silent no-op read as a successful ratchet. A composite label
 * cannot drift from the run's actual scope because both halves are read from the same argv.
 *
 * @param {string[]} argv
 * @returns {'update'|'update:files'|'update:mine'|'files'|'mine'|'all'}
 */
export function lintTscScopeFromArgv(argv) {
  const scoped = parseExplicitFiles(argv) !== null ? 'files' : argv.includes('--mine') ? 'mine' : null;
  if (argv.includes('--update')) return scoped ? `update:${scoped}` : 'update';
  return scoped ?? 'all';
}

/**
 * The terminal completion marker (EI-19395061642732083). Pure so it is unit-testable —
 * the `process.on('exit')` hook that prints it is not.
 *
 * `status` is derived from the exit code the gate actually exited with, never from a
 * separately-tracked verdict variable that could drift out of sync with it.
 *
 * `nothingTypechecked` is the ONE deliberate exception, and it is a REFINEMENT of the
 * failure, never the verdict itself (EI-20072775668558359). The exit code alone genuinely
 * cannot separate the two ways this gate exits 1:
 *
 *   - a real REGRESSION — files were compiled and some sit above baseline;
 *   - NOTHING WAS TYPECHECKED — every `--files=` path lies outside this project, so the
 *     gate compiled none of them and has no verdict to give.
 *
 * Reporting the second as `status=regressed` is a false alarm in the machine-readable
 * field, which is the one a caller greps. It fails in both directions: read literally it
 * sends someone hunting a type error that does not exist, and once learned as "regressed
 * here can mean nothing ran" it corrodes the token that must stay trustworthy when a
 * regression IS real. Most edits in this repo are NOT in operator-core, so a `--files=` run
 * naming out-of-scope paths is a common shape, not an exotic one.
 *
 * The drift the original note warns about is still excluded: `nothingTypechecked` cannot
 * make a FAILING run look clean (a truthy value is only consulted when `code !== 0`, and
 * `code === 0` still reports `clean` unconditionally), and it is set at the same site that
 * computes `fatal` and calls `process.exit(1)` — so the flag and the exit cannot disagree
 * without that one branch being wrong about itself. Pinned by
 * packages/operator-core/lib/lint-tsc.test.ts.
 *
 * ## EI-20712456514085524 — PARTIAL coverage is the third outcome, and it exited 0 as `clean`
 *
 * `nothingTypechecked` above covers the ALL-uncovered case. The mixed case — some named files
 * inside the project, some outside — took the other branch: the banner warns on stderr, the
 * covered verdict is genuinely true, so the gate exits 0 and the marker read `status=clean`.
 * That is the same false-coverage failure the all-uncovered branch exists to prevent, arriving
 * through the door left open beside it. `--files=a,b,c,d` naming two operator-core files and two
 * `packages/agent-mcp` ones printed `exit=0 status=clean`, and an agent who names four files and
 * reads `clean` concludes four files compiled. Two never did.
 *
 * The exit CODE is deliberately unchanged (0): the covered files really were judged, and making
 * the mixed case fatal would red the common, legitimate "check my edit across two packages" run.
 * What changes is the machine-readable token, because that is what is actually misread:
 * `status=partial filesUnchecked=N`. `partial` is chosen over `clean-partial` so that the
 * established consumer idiom — a substring `grep 'status=clean'` — CANNOT match a run that left
 * files unchecked. A run with full coverage still reports exactly `status=clean`, so this is
 * additive for every caller that was already honest.
 *
 * ## EI-21467670625776948 — a PREFLIGHT abort is the fourth exit-1 shape, and it read `regressed`
 *
 * The `gen:declarations` preflight compiles the WHOLE declarations project, so ANY agent's
 * in-flight file anywhere in the repo can abort it — for a caller whose own files are clean and
 * were never measured. The exit hook then printed `status=regressed`: a verdict about the
 * caller's work, emitted when the truthful statement is "nothing of yours was judged". Same
 * repair as `nothingTypechecked`/`partial`: refine the machine token (`preflight-failed`),
 * keep the exit code. Scoped to exit 1 exactly like `nothingTypechecked` — an abnormal code
 * stays `error(N)` — and `preflightFailed` wins over `nothingTypechecked` because it is the
 * more specific claim about WHY nothing was typechecked (in practice they are mutually
 * exclusive: the coverage branch exits before the preflight runs).
 *
 * ## EI-22405627533381152 — `filesRoutedAway` names the fifth shape, and it is NOT a status
 *
 * A MIXED `--files` set now delegates its out-of-project files to the owning gate and keeps
 * compiling its own (see `runTscBaselineGate`'s coverage branch). That run's verdict is still
 * this gate's own — `clean` or `regressed` — so `status` must NOT change; what would otherwise
 * be lost is that part of the answer came from a delegate. `filesRoutedAway=N` is therefore an
 * additive FIELD beside `filesUnchecked`, never a status value: a caller grepping
 * `status=clean` still matches a fully-covered run, which is the property EI-20712456514085524
 * established and this must not break. `routed`/`routed-failed` remain reserved for the case
 * where this gate had NO verdict of its own and handed the whole request over.
 *
 * @param {{ label: string, scope: string, code: number, nothingTypechecked?: boolean, preflightFailed?: boolean, concurrentEditInconclusive?: boolean, filesUnchecked?: number, filesRoutedAway?: number, routed?: boolean, runStartIso?: string | null, headSha?: string | null }} input
 * @returns {string}
 */
export function formatLintTscResultMarker({
  label,
  scope,
  code,
  nothingTypechecked = false,
  preflightFailed = false,
  concurrentEditInconclusive = false,
  filesUnchecked = 0,
  filesRoutedAway = 0,
  routed = false,
  // EI-19323399466378077 — run-start stamp, OPTIONAL and APPENDED LAST. Every existing call site
  // in this file's own test suite omits these two, so their exact `.toBe(...)` assertions on the
  // full marker string stay byte-identical; only `runTscBaselineGate`'s real exit hook supplies
  // them, mirroring the same additive-suffix convention scripts/test-files.mjs uses for its own
  // TEST_FILE_RESULT/TEST_FILE_PROVENANCE lines (same item, same fix shape, two files).
  runStartIso = null,
  headSha = null,
}) {
  // The refinement applies ONLY to the gate's own considered failure (exit 1). An abnormal
  // code — SIGTERM, OOM, a toolchain crash — means the run is UNMEASURED, and it must keep
  // reading as `error(N)` rather than borrowing the tidy out-of-scope label just because the
  // flag happened to be set before the process died.
  const unchecked = Number.isFinite(filesUnchecked) && filesUnchecked > 0 ? filesUnchecked : 0;
  const status =
    routed && code === 0
      ? 'routed'
      : routed && code === 1
        ? 'routed-failed'
        : code === 0
      ? // Same rule as `nothingTypechecked`, in the other direction: a coverage refinement may
        // narrow what a PASS claims, but it must never turn a pass into a failure. exit stays 0.
        unchecked > 0
        ? 'partial'
        : 'clean'
      : code === 1
        ? concurrentEditInconclusive
          ? 'inconclusive-concurrent-edit'
          : preflightFailed
            ? 'preflight-failed'
            : nothingTypechecked
              ? 'out-of-scope'
              : 'regressed'
        : `error(${code})`;
  const marker = `LINT_TSC_RESULT label=${label} scope=${scope} exit=${code} status=${status}`;
  // Reported on a REGRESSION too: "3 files regressed" and "2 more were never looked at" are
  // independent facts, and suppressing the second because the first is louder is how a caller
  // fixes the named files and ships the unexamined ones.
  const withUnchecked = unchecked > 0 ? `${marker} filesUnchecked=${unchecked}` : marker;
  // Appended AFTER filesUnchecked so every existing marker string stays a byte-identical prefix
  // of the new one: a run that routed nothing is unchanged, and the two fields can legitimately
  // co-occur (some uncovered files routed, others with no known owner left unchecked).
  const routedAwayCount = Number.isFinite(filesRoutedAway) && filesRoutedAway > 0 ? filesRoutedAway : 0;
  const withRouted =
    routedAwayCount > 0 ? `${withUnchecked} filesRoutedAway=${routedAwayCount}` : withUnchecked;
  // EI-19323399466378077 — a backgrounded run's log body is byte-identical whether it is 30
  // seconds or three hours old, and filesystem mtime cannot disambiguate on a tree git-sync
  // commits on a schedule (the commit time is when the SWEEP ran, not when the edit landed).
  // Stamping the run-start time + the HEAD it judged ON THE TERMINAL LINE — not just a banner —
  // is deliberate: it is the line a `| tail -N` reads and the one a caller pastes as evidence.
  return runStartIso != null ? `${withRouted} at=${runStartIso} head=${headSha ?? 'unknown'}` : withRouted;
}

/**
 * The pre-run stamp (EI-19323399466378077): what this run is about to judge, printed BEFORE the
 * compile so a killed/hung run still leaves it on disk. Mirrors scripts/test-files.mjs's
 * `TEST_FILE_PROVENANCE` banner (same item, same fix shape, two files) — the resolved file set
 * lives here (a caller `| tail -N`ing the terminal line does not need it repeated there), while
 * the run-start time + HEAD are ALSO appended to the terminal `LINT_TSC_RESULT` line above.
 *
 * @param {{ label: string, runStartIso: string, headSha: string|null, scope: string, files: string[]|null }} input
 * @returns {string}
 */
export function formatLintTscRunStamp({ label, runStartIso, headSha, scope, files }) {
  const head = headSha ?? 'unknown';
  const lines = [
    `LINT_TSC_RUN_STAMP label=${label} at=${runStartIso} head=${head} scope=${scope} ` +
      `files=${files && files.length > 0 ? files.length : 'all'}`,
  ];
  if (files && files.length > 0) {
    files.forEach((f, index) => {
      lines.push(`  ${index === 0 ? 'checked files :' : '              '} ${f}`);
    });
  }
  return lines.join('\n');
}

/** Where the standing-verdict marker lives, relative to the repo root. */
export const LINT_TSC_RUN_MARKER_REL = '.papercusp/scratch/lint-tsc-last-run.json';

const LINT_TSC_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Return the session-owned marker path, or null when this process has no safe
 * Papercusp session identity. Never fall back to the historical repo-wide
 * marker: that would let one agent overwrite another agent's standing verdict.
 */
function lintTscRunMarkerRelForSession(sessionId) {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!LINT_TSC_SESSION_ID_PATTERN.test(normalized)) return null;
  return `.papercusp/scratch/lint-tsc-last-run.${normalized}.json`;
}

/**
 * Persist the same run stamp to disk (EI-19421388108187854).
 *
 * The stamp above is printed to STDOUT, which means it exists only in whatever
 * terminal scrollback the run happened to land in. Nothing downstream can ask
 * "is the standing tsc verdict still current?", because the answer — when the
 * last run started and which files it covered — was never recorded anywhere a
 * later process can read.
 *
 * That gap is what makes the typecheck→test→fix-the-test loop bank a stale
 * verdict: the last edit in that loop is almost always a TEST file, edited
 * AFTER the typecheck ran, and the green suite that follows carries zero type
 * information (vitest transforms via esbuild and never typechecks). The agent
 * ends holding a fresh green signal that is silent on types beside a stale
 * clean one that is not, and reads the pair as agreement.
 *
 * Written at run START (like the stamp), so a killed or hung run still leaves a
 * marker — a verdict that never finished is exactly the kind that must not be
 * quoted as clean. Best-effort by construction: a marker is an advisory input
 * to a nudge, so failing to write one must never fail the typecheck itself.
 *
 * @param {{ root: string, label: string, runStartIso: string, headSha: string|null, scope: string, files: string[]|null, sessionId?: string|null }} input
 * @returns {boolean} true iff the marker was written
 */
export function writeLintTscRunMarker({
  root,
  label,
  runStartIso,
  headSha,
  scope,
  files,
  sessionId = process.env.PAPERCUSP_SID,
}) {
  const markerRel = lintTscRunMarkerRelForSession(sessionId);
  if (!markerRel) return false;

  try {
    const target = resolve(root, markerRel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify(
        {
          label,
          at: runStartIso,
          atMs: Date.parse(runStartIso),
          head: headSha ?? null,
          scope,
          files: files && files.length > 0 ? [...files] : null,
        },
        null,
        2,
      ) + '\n',
    );
    return true;
  } catch {
    return false;
  }
}

/** Short HEAD sha at call time, or null when git cannot answer (never a fabricated value). */
export function gitHeadShaForLintTsc(root) {
  try {
    const out = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
    });
    const sha = out.trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

/**
 * Run the full CLI gate for one project and `process.exit(...)` with its verdict — the shared
 * `main()` every per-project CLI (lint-tsc.mjs, lint-tsc-operator-vite.mjs, …) delegates to.
 *
 * @param {RunTscBaselineGateOptions} options
 */
export async function runTscBaselineGate({
  root,
  tscCommand,
  preTscCommand = null,
  baselineFile,
  label,
  argv,
  countField = 'errorCount',
  foreignBaselines = [],
}) {
  // EI-19395061642732083 — emit a terminal COMPLETION MARKER, so a killed run is
  // distinguishable from a clean one.
  //
  // This gate is the repo's mandated post-edit check (vitest is type-blind, so it is the
  // only thing between a type-only regression and a fleet-wide gate red). It takes ~150s,
  // which is comfortably past the agent Bash tool's 120s DEFAULT timeout — and the way that
  // failure presents is the whole problem. A SIGTERM'd run prints its partial output and
  // stops; the usual caller idiom (`... 2>&1 | tail -20`, or a `grep <my-file>` over the
  // output) then shows nothing alarming, which is INDISTINGUISHABLE from "my files are
  // clean". The caller concludes green, and the first real observer is a ~55min suite in
  // someone else's triage queue hours later — the identical failure shape this file already
  // documents for uncovered `--files` above, arriving by a different route.
  //
  // The marker deliberately rides `process.on('exit')` rather than being stamped at each
  // `process.exit(...)` site: there are nine-plus of them and a tenth added later would
  // silently opt out. It also means the marker CANNOT be printed on SIGTERM/SIGKILL, since
  // Node runs no exit handler for those — which is exactly the property we want.
  //
  //   marker present => the gate ran to a verdict, and `status` IS that verdict
  //   marker absent  => the run did not finish; the output is UNMEASURED, not clean
  //
  // This mirrors `TEST_FILE_RESULT` in scripts/test-files.mjs, whose consumer idiom
  // (`if ! grep -q 'TEST_FILE_RESULT'; then UNMEASURED; fi`) is already established in this
  // repo — the convention is reused, not reinvented.
  // EI-20072775668558359 — set ONLY by the all-uncovered branch below, on the line before its
  // `process.exit(1)`, so the flag and the exit it describes are the same decision. It refines
  // WHICH failure this is; it can never turn a failure into a pass (see the formatter's note).
  let nothingTypechecked = false;
  // EI-21467670625776948 / EI-22438149246482169 — set ONLY by a pre-compile validation failure,
  // on the line before its `process.exit(1)`. A failed preflight or an explicit `--files` path
  // validation abort measures ZERO of the caller's files, and the marker must say that instead
  // of `regressed` (a verdict about work this run never judged).
  let preflightFailed = false;
  // EI-20211153048499132 — a bare full-tree compile can straddle a peer's edit and observe a
  // source graph that never existed atomically. This is set after the compile, then read by the
  // exit hook so the terminal marker cannot mislabel that unrepeatable observation as REGRESSED.
  let concurrentEditInconclusive = false;
  // A fatal out-of-project run may delegate its complete file set to verified owning gates. The
  // parent marker must say that explicitly; `status=clean` would falsely claim this gate itself
  // compiled the named files, while `status=out-of-scope` would hide that the delegated checks ran.
  let autoRouted = false;
  // EI-20712456514085524 — how many named files this project never compiles. Set by the SAME
  // coverage branch that sets `nothingTypechecked`, so the two can never disagree about one run;
  // it is the PARTIAL case (`fatal === false`), where the gate still exits 0 on a true verdict
  // about the covered files and the marker must not let that read as coverage of all of them.
  let filesUnchecked = 0;
  // EI-21985804122617157 — how many named files a DELEGATE compiled on this run's behalf.
  // Distinct from `autoRouted`, which means "this gate had no verdict of its own and handed the
  // whole request over". Here the parent keeps its own verdict and a sibling gate judged the
  // remainder, so `status` must stay the parent's own word (`clean`/`regressed`) while the
  // marker still discloses that part of the answer came from somewhere else.
  let filesRoutedAway = 0;

  // EI-19323399466378077 — captured HERE, before anything else runs, so it is the run's actual
  // start (not the compile's) and survives into the exit-hook closure below regardless of which
  // branch this run takes or how long the compile itself runs.
  const runStartIso = new Date().toISOString();
  const headShaAtStart = gitHeadShaForLintTsc(root);

  process.on('exit', (code) => {
    console.log(
      formatLintTscResultMarker({
        label,
        scope: lintTscScopeFromArgv(argv),
        code,
        nothingTypechecked,
        preflightFailed,
        concurrentEditInconclusive,
        filesUnchecked,
        filesRoutedAway,
        routed: autoRouted,
        runStartIso,
        headSha: headShaAtStart,
      }),
    );
  });

  const updateFlag = argv.includes('--update');
  const projectPrefix = projectPrefixFromTscCommand(tscCommand);
  const parsedExplicitFiles = parseExplicitFiles(argv);
  const explicitFiles =
    parsedExplicitFiles !== null && projectPrefix !== null
      ? normalizeExplicitFilesForProject({
          files: parsedExplicitFiles,
          root,
          cwd: process.cwd(),
          coveredPrefixes: [projectPrefix, ...foreignBaselines.map((baseline) => baseline.prefix)],
        })
      : parsedExplicitFiles;
  const mineFlag = argv.includes('--mine') || explicitFiles !== null;

  // EI-19323399466378077 — the pre-run stamp: what this run is about to judge, printed before the
  // compile so a killed/hung run still leaves it on disk (the terminal LINT_TSC_RESULT line only
  // ever prints on a clean `process.on('exit')`, which SIGTERM/SIGKILL never reach).
  const runStampScope = lintTscScopeFromArgv(argv);
  const runStampFiles = explicitFiles !== null ? [...explicitFiles] : null;
  console.log(
    formatLintTscRunStamp({
      label,
      runStartIso,
      headSha: headShaAtStart,
      scope: runStampScope,
      files: runStampFiles,
    }),
  );
  // EI-19421388108187854 — also record it on disk, so a later process can ask
  // whether the standing verdict still covers the current tree. Best-effort:
  // never let marker bookkeeping fail a typecheck.
  writeLintTscRunMarker({
    root,
    label,
    runStartIso,
    headSha: headShaAtStart,
    scope: runStampScope,
    files: runStampFiles,
  });

  // EI-22438149246482169 — an explicit selector is a caller assertion that each named path is
  // real. A typo in `--files=` used to survive normalization and project-coverage checks, then
  // run the generated-declaration preflight and tsc anyway; with no diagnostic for the typo, the
  // gate printed a clean verdict about a file that never existed. Validate AFTER the run stamp so
  // the forensic banner still records the exact normalized selection, but BEFORE any preflight,
  // sibling routing, or compiler work.
  if (explicitFiles !== null && explicitFiles.size > 0) {
    const missingExplicitFiles = [...explicitFiles].filter((file) => {
      const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
      try {
        return !statSync(absolute).isFile();
      } catch {
        return true;
      }
    });
    if (missingExplicitFiles.length > 0) {
      console.error(
        `❌ ${label} explicit file selection contains ${missingExplicitFiles.length} missing/non-file path(s):`,
      );
      for (const file of missingExplicitFiles) console.error(`   - ${file}`);
      console.error(
        '   Refusing to run the typecheck preflight or tsc; correct the --files/--files-from selection and retry.',
      );
      preflightFailed = true;
      process.exit(1);
      return;
    }
  }

  // EI-19341572300046923 — REFUSE to report a verdict about files this project never compiles.
  //
  // `lint:tsc` is `tsc -p packages/operator-core/tsconfig.json`. Passing
  // `--files=apps/operator-vite/src/Foo.tsx` scoped the verdict to a file that compile never
  // saw, so the gate found zero recorded errors for it and printed GREEN — a clean report that
  // had typechecked nothing the caller named. That is indistinguishable from a real pass, and it
  // is exactly how two operator-vite gate reds reached the fleet green-checkpoint on 2026-08-02:
  // the author ran the scoped check, saw green, and the first real observer was a ~55min suite
  // hours later in someone else's triage queue.
  //
  // Deliberately placed BEFORE the compile: the answer is a pure path comparison, so the
  // all-uncovered case fails in milliseconds instead of paying ~150s (plus pc-heavy queue) for a
  // run that could not have judged anything. Coverage is DERIVED from `tscCommand` + the
  // foreign baselines this gate already reads, so a new per-project CLI inherits it for free.
  //
  // Fail-open on an unparseable `-p` operand: not knowing the project's prefix is not evidence
  // that a file lies outside it, and a lint gate must never invent a red it cannot substantiate.
  if (explicitFiles !== null && explicitFiles.size > 0) {
    if (projectPrefix !== null) {
      const { covered, uncovered } = partitionFilesByCoverage({
        files: explicitFiles,
        coveredPrefixes: [projectPrefix, ...foreignBaselines.map((b) => b.prefix)],
      });
      if (uncovered.length > 0) {
        const suggestions = new Map(uncovered.map((f) => [f, suggestTypecheckGate(root, f)]));
        const fatal = covered.length === 0;
        // Stamped for BOTH branches: the fatal one already reports `out-of-scope`, and the
        // partial one below exits 0 — which is precisely the case that used to read `clean`.
        filesUnchecked = uncovered.length;
        // EI-19461218392796337 — resolve against the SIBLING lint:tsc* gates before saying
        // anything about coverage. Only reached on the error path, so the imports cost nothing
        // on a normal run.
        const { gates, unresolved, rosterReadable } = await discoverSiblingTypecheckGates(root);
        const autoRoutes = collectAutoTypecheckRoutes({
          files: uncovered,
          suggestions,
          siblingGates: gates,
        });
        // EI-21985804122617157 — deliberately NOT gated on `fatal`. Routing used to fire only
        // when EVERY named file was out of project; a MIXED set (the shape this file's own
        // comment above calls "the common, legitimate 'check my edit across two packages' run")
        // fell through to exit 0 with the out-of-project files never compiled. The three
        // conditions that remain are the real preconditions: not already inside a routed child
        // (no recursion), every uncovered file has a known owner (collectAutoTypecheckRoutes'
        // contract forbids executing a PARTIAL route set and then claiming coverage), and there
        // is something to run.
        const canAutoRoute =
          process.env[AUTO_TYPECHECK_ROUTE_ENV] !== '1' &&
          autoRoutes.unknown.length === 0 &&
          autoRoutes.routes.length > 0;
        for (const line of formatUncoveredFilesBanner({
          label,
          uncovered,
          suggestions,
          fatal,
          autoRoute: canAutoRoute,
          siblingGates: gates,
          unresolvedGates: unresolved,
          rosterReadable,
        })) {
          console.error(line);
        }
        // Some covered, some not: the covered verdict below is still TRUE and worth having, so
        // warn and continue. Nothing covered: there is no honest verdict to print at all.
        if (fatal) {
          if (canAutoRoute) {
            autoRouted = true;
            process.exit(runAutoTypecheckRoutes({ root, routes: autoRoutes.routes }));
          }
          // Paired with the exit on the very next line so the marker cannot claim `regressed`
          // about a run that compiled nothing (EI-20072775668558359).
          nothingTypechecked = true;
          process.exit(1);
        }
        // EI-21985804122617157 — the MIXED case: this gate has a real verdict to give about the
        // covered files, AND a delegate can judge the rest. Run the delegates FIRST, before the
        // ~150s compile below, so a red among the caller's own named files is reported in
        // seconds instead of behind the slowest leg.
        //
        // ⚠ THE TWO OUTCOMES ARE DELIBERATELY ASYMMETRIC, and the marker is why:
        //  - a delegate FAILED  => the caller has a genuine type error among the files they
        //    named. Exit with the child's code and set `autoRouted`, so the marker reads
        //    `routed-failed` — the failure came from the route, and saying `regressed` would
        //    point at operator-core, which this run never even compiled.
        //  - every delegate PASSED => keep going and let this gate's OWN compile decide the
        //    exit code. `autoRouted` stays FALSE on purpose: setting it would make a later
        //    operator-core regression print `routed-failed` and hide a real red behind a
        //    routing label. The delegation is disclosed by `filesRoutedAway=N` instead.
        //
        // `filesUnchecked` drops to 0 because every uncovered file WAS compiled — by the owning
        // gate. Leaving it set would keep reporting `status=partial` about files that now have a
        // verdict, which is the same false-coverage claim in the opposite direction.
        if (canAutoRoute) {
          const routedExit = runAutoTypecheckRoutes({ root, routes: autoRoutes.routes });
          if (routedExit !== 0) {
            autoRouted = true;
            process.exit(routedExit);
          }
          filesRoutedAway = uncovered.length;
          filesUnchecked = 0;
        }
      }
    }
  }

  let tscOutput = '';
  let tscThrew = false;
  // EI-21441555291852229 — some projects consume tracked declarations generated from
  // JavaScript modules. Running tsc before refreshing those companions makes the first
  // typecheck after an export change fail on the stale `.d.mts`, even though that same
  // validation workflow then writes the declaration that makes its second run green.
  // Keep this an explicit per-project hook: most gates have no generated-input preflight.
  // Immutable qualification must inspect the COMMITTED companions instead of repairing them:
  // publication here hides stale artifacts from the later freshness test and dirties the
  // candidate whose clean source identity is required by proof capture/reuse.
  if (preTscCommand) {
    let command = String(preTscCommand);
    try {
      // EI-24783793601501800 — a scoped verdict must not publish every peer's
      // declaration. Reuse the generator's selected-output mode across every
      // declaration-consuming leg, without changing unrelated custom preflights.
      const immutableInputs = process.env.PAPERCUSP_LINT_AS_COMMITTED_CLONE === '1' ||
        process.env.PAPERCUSP_ADMISSION_PRECHECK === '1' ||
        Boolean(process.env.PAPERCUSP_TEST_RUN_COMMIT?.trim());
      if (command.trim() === 'npm run gen:declarations' && immutableInputs) {
        // Reuse the non-publishing generator check and the existing runtime markers.
        // Check the whole enrolled cohort even when the tsc verdict is scoped: an unchanged
        // importer can still resolve a stale companion outside the selected source paths.
        command = 'npm run gen:declarations:check';
      } else if (command.trim() === 'npm run gen:declarations' && explicitFiles !== null) {
        const selectedInputs = declarationFilesFromConfig(root, { strict: true })
          .filter((declaration) => {
            const normalized = declaration.replace(/\\/g, '/').replace(/^\.\//, '');
            return explicitFiles.has(normalized) ||
              explicitFiles.has(normalized.replace(/\.d\.mts$/, '.mjs'));
          })
          .map((declaration) => declaration.replace(/\.d\.mts$/, '.mjs'));
        command = selectedInputs.length > 0
          ? `${command} -- ${shellQuote(`--files=${selectedInputs.join(',')}`)}`
          : '';
        if (!command) console.log('gen:declarations: no enrolled modules explicitly selected; no declarations published');
      }
      if (command) {
        execSync(command, {
          cwd: root,
          encoding: 'utf-8',
          stdio: 'inherit',
          env: tscChildEnv(),
        });
      }
    } catch (error) {
      console.error(`❌ ${label} typecheck preflight failed: ${command}`);
      if (error instanceof Error) console.error(error.message);
      // EI-21467670625776948: the preflight compiles generated-declaration INPUTS across the
      // whole repo, so the failure above is routinely a PEER's in-flight file, not the
      // caller's. Zero of the caller's files were typechecked — say so explicitly, because
      // the absence of the per-file section otherwise reads as "clean" to a grep.
      console.error(
        `   ${label}: zero of your files were typechecked — this is NOT a verdict about your ` +
          `changes. The failing file belongs to the preflight's own compile (see the tsc ` +
          `error above); re-run once it settles, or check that file's owner.`,
      );
      // Paired with the exit on the next line so the marker reports `preflight-failed`,
      // never `regressed` (mirrors the nothingTypechecked pairing at the coverage branch).
      preflightFailed = true;
      process.exit(1);
    }
  }
  // WI-7017 — throttle + coalesce the COMPILE, not the whole gate.
  //
  // `--files` is a GATE-scoping flag that never reaches tsc (`tscCommand` is a
  // per-project constant; see lint-tsc.mjs's TSC_COMMAND). But the npm scripts used to
  // wrap the whole CLI in pc-heavy, so `--files=a.ts` and `--files=b.ts` presented
  // DIFFERENT argv and pc-heavy's (cwd, argv, tree-token) coalescing key never matched.
  // N agents each paid for a byte-identical ~104s compile while the semaphore queued 49
  // deep (measured 2026-08-02: load1 186, three concurrent identical compiles).
  //
  // Wrapping only the compile makes argv IDENTICAL across callers in the same admission
  // class, so concurrent runs coalesce onto ONE compile. Scoped callers carry one stable
  // sentinel (never their real file list) so pc-heavy can route them through its focused
  // lane during gate materialization without reintroducing per-file-set coalescing keys.
  // Each caller still filters the RAW diagnostics by its own `--files` and computes its
  // OWN exit code below, so a caller-specific VERDICT is never shared — that sharing is
  // what made naive coalescing-key widening unsafe (a red for file A is a green for a
  // caller who named only file B).
  //
  // pc-heavy's own stderr is deliberately kept OUT of the captured stream (only tsc's own
  // `2>&1` is captured, inside the wrapped child). If pc-heavy's chatter were captured, a
  // pc-heavy failure BEFORE tsc ever ran would leave `tscOutput` non-empty with zero
  // parseable diagnostics — which reads as "0 errors" and, under `--update`, would ratchet
  // every file's baseline to 0 and mask everything. The `!tscOutput` toolchain-failure
  // guard below is what catches that, and it only works if the stream stays clean.
  //
  // Fail-open (matching pc-heavy's own contract): no wrapper on disk ⇒ run tsc directly.
  // Admission control must never be the reason a legitimate typecheck cannot start.
  //
  // COALESCING WINDOW — the window is raised for THIS invocation only (env on the child, not a
  // global default), because pc-heavy's follower loop gives up at `now + PC_HEAVY_COALESCE_SEC`
  // (default 90s, `pc-heavy.sh:423,452`) and a full operator-core compile is ~150s: with the
  // default a follower always times out just BEFORE the leader finishes and compiles anyway.
  //
  // ⚠ THE WINDOW ALONE NEVER MADE THIS COALESCE — the KEY did, and it took two corrections.
  //
  // (1) An early revision claimed the 420s window made concurrent callers share one compile, on
  // the strength of a 09:23Z sample showing the tree token stable (0 changes in 60s). That
  // sample caught a quiet window mid-incident and generalised from it. Re-measured 2026-08-02
  // 11:18:19-11:21:29Z: **11 distinct tree tokens in 199s — one change every ~18s** (shortest gap
  // 4s; 2 were git-sync commits moving branch.oid, the rest peers' saves). The key was
  // sha1(cwd + argv + tree-token), so during ONE ~150s compile the token moved ~8 times and two
  // callers arriving seconds apart computed DIFFERENT keys — they could not even see each other's
  // lock. Zero coalescing; N full compiles. Fact `pc-heavy-tree-token-churns-faster-than-a-compile`.
  //
  // (2) The correction to THAT then over-corrected, concluding the token could not be removed
  // because it is "what makes the gate's answer TRUE", and that the only remaining lever was to
  // make the per-file check cheap elsewhere. The first half is right about the HAZARD and wrong
  // about the REMEDY, and the distinction is the whole fix: the token is a *proxy*, and a very
  // loose one. The hazard (EI-18688348461605365) is replaying a compile that started BEFORE the
  // caller's edit, handing back a clean verdict on a file they just broke. But that is a
  // per-caller, per-FILE question —
  //
  //     a run that started at S is a valid answer for file F  iff  mtime(F) < S
  //
  // — whereas the token asks the whole-tree question "did ANYTHING change?". On a fleet-edited
  // tree those differ by ~9 orders of churn per compile: my answer is invalidated only by edits
  // to MY files, and the token throws it away for every peer's save as well.
  //
  // So the token is not dropped, it is REPLACED, by something exact: `coalesceWatermarkFor`
  // computes max(mtime) over the files this run was actually asked about and passes it as
  // PC_HEAVY_FRESH_AFTER, which lets pc-heavy skip the token and admit a replay only from a run
  // that started after it. Correctness is preserved file-by-file instead of approximated
  // tree-wide, and callers with no scoped file set (bare CI runs) or `--update` opt out entirely
  // and still run fresh — see that function for why each opt-out is required rather than
  // cautious.
  //
  // The win is not only cache hits: it makes the coalescer SERIALIZE. A follower whose watermark
  // the running leader cannot satisfy no longer races off to start its own compile — it waits the
  // leader out, becomes the next leader, and the peers queued behind it replay ITS run. N
  // concurrent compiles collapse to one at a time with arrivals batched behind it, which is the
  // pathology this whole thread started from (2026-08-02: 5, then 3, then 4 byte-identical
  // operator-core compiles live at once, load1 120-186).
  //
  // Also kept by wrapping only the compile: pc-heavy no longer holds a slot for the whole gate
  // CLI, and argv is identical across callers so the key can match at all.
  //
  // ✅ CLOSED 2026-08-03 (EI-19424611266793426). This used to read: the token uses
  // `--untracked-files=no`, so a NEW UNTRACKED .ts picked up by the tsconfig does not bust the
  // key — "accepted because the gate's verdict is per-file against a committed baseline, and an
  // untracked file has no baseline entry. Revisit if that ever stops being true."
  //
  // It stopped being true, and the note's own escape clause is what caught it. That reasoning
  // holds only while a new file's effect is CONFINED TO ITSELF. A declaration file breaks the
  // premise by construction: a `.d.mts` is never judged on its own account, it changes the
  // verdict of an ALREADY-TRACKED, already-baselined file. Measured: adding an entry to
  // tsconfig.declarations.json and running gen:declarations emitted an untracked `.d.mts` that
  // took full-replacement-mock-guard.test.ts from 1 error to 0 — while the token, blind to the
  // creation, replayed the pre-fix red for the whole (now 420s) window. The same applies to any
  // new file that RESOLVES an import rather than adding one: TS7016 and TS2307 are both fixed by
  // creating a file, so the hole was inverted against the error class this gate is re-run to fix.
  //
  // pc-heavy's token now uses `--untracked-files=all` and its suite carries the two
  // creation-busts-the-cache cases (proven by differential: both fail under `=no`, and the
  // untracked-directory one still fails under `=normal`). Nothing here needs to compensate.
  //
  // WI-10003404 / P-004 — before any of that, an explicit `--files` run asks the shared typecheck
  // service (scripts/lib/tsc-service.mjs), which checks only the files this verdict can depend on
  // inside one already-loaded program: ~2 s and no 13 GB compile per caller. It returns the CLI's
  // own text format, so everything below parses it unchanged. Any refusal or failure falls back to
  // the compile below with one printed line.
  const serviceRoute = tscServiceEligibility({ tscCommand, explicitFiles, argv, root });
  const served = serviceRoute.eligible
    ? await typecheckViaService({ root, project: serviceRoute.project, files: [...explicitFiles], label })
    : null;
  if (served !== null) {
    tscOutput = served.output;
    tscThrew = served.errorCount > 0;
    for (const line of formatTscServiceBanner(served)) console.log(line);
  } else {
    const pcHeavyPath = resolve(root, 'scripts', 'pc-heavy.sh');
    const freshAfter = coalesceWatermarkFor({ root, files: explicitFiles, updateFlag });
    const executableTscCommand = resolvePinnedTscCommand(root, tscCommand);
    try {
      tscOutput = existsSync(pcHeavyPath)
        ? execFileSync('bash', [pcHeavyPath, ...pcHeavyCompileArgv(executableTscCommand, explicitFiles !== null)], {
            cwd: root,
            encoding: 'utf-8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'inherit'],
            env: tscChildEnv({
              PC_HEAVY_COALESCE_SEC: process.env.PC_HEAVY_COALESCE_SEC ?? '420',
              ...(freshAfter === null ? {} : { PC_HEAVY_FRESH_AFTER: String(freshAfter) }),
            }),
          })
        : execSync(`${executableTscCommand} 2>&1`, {
            cwd: root,
            encoding: 'utf-8',
            maxBuffer: 64 * 1024 * 1024,
            env: tscChildEnv(),
          });
    } catch (e) {
      tscThrew = true;
      tscOutput = e.stdout || '';
    }
  }
  if (tscThrew && !tscOutput) {
    // tsc itself failed to run (no diagnostics at all) — never treat that as zero errors, it would
    // ratchet every file's baseline to 0 and mask everything.
    console.error('❌ tsc produced no output — toolchain failure, not a clean run.');
    process.exit(1);
  }

  const diagnosticRoots = diagnosticPathRoots(root);
  const errors = normalizeTscErrorPaths(parseTscErrors(tscOutput), diagnosticRoots);
  const diagnosticPathOptions = {
    root: diagnosticRoots.root,
    canonicalRoot: diagnosticRoots.canonicalRoot,
  };

  // EI-19366483607548056 — a peer's concurrent npm install can remove declared packages while
  // tsc is reading the shared tree. The resulting TS7016/TS2307 flood looks like unrelated code
  // regressions. Reuse the existing dependency doctor as a read-only corroborating check, but
  // only after a non-zero tsc result and only when the diagnostic modules match missing direct
  // dependencies. This annotation never retries, swallows, or changes the tsc verdict.
  if (tscThrew) {
    try {
      const suspect = detectUnextractedDependencyDiagnostics({
        tscOutput,
        missing: findUnextractedDeps({ repoRoot: root }),
      });
      if (suspect) {
        for (const line of formatMidInstallWarning({ label, ...suspect })) console.error(line);
      }
    } catch {
      // Diagnostic only: a broken dependency snapshot must never change the typecheck result.
    }
  }

  // EI-19478xxxxxx (WI-37485): the guard above only catches an EMPTY-output crash. A crash that
  // exits non-zero and prints NON-diagnostic garbage — most measured: a V8 "FATAL ERROR:
  // Ineffective mark-compacts near heap limit ... JavaScript heap out of memory" trace followed
  // by "Aborted (core dumped)" when `tsc` OOMs mid-compile on a loaded box — sails straight past
  // it: `tscOutput` is non-empty (the crash trace itself), so `!tscOutput` is false, and execution
  // falls through to parseTscErrors, which correctly finds ZERO lines matching the TS-diagnostic
  // format in a stack trace and returns `[]`. That empty list is then compared against a non-empty
  // baseline and reported as "every file improved to 0 errors" — a real, un-fixed type regression
  // (confirmed reproduced against candidate b15ff819ad2e: a genuine TS2741 in
  // federated-presence.ts) reads as a clean gate.
  //
  // A LEGITIMATE tsc run that exits non-zero because it found real compile errors ALWAYS reports
  // them as parseable diagnostics — that is the one and only way `tsc --noEmit` produces a
  // non-zero exit under normal operation (exit 1 = diagnostics reported; a genuine exit 2 config
  // failure also emits a parseable TS5xxx line). So `tscThrew` true together with ZERO parsed
  // diagnostics is never a legitimate "0 errors" answer — it is the abnormal-crash signature this
  // gate's whole job is refusing to report clean on. Fail loudly instead of silently ratcheting
  // every file's baseline to 0.
  if (tscThrew && errors.length === 0) {
    console.error(
      '❌ tsc exited non-zero (crashed) but produced ZERO parseable diagnostics — ' +
        'toolchain failure (e.g. an OOM crash), not a clean run. Raw output follows:',
    );
    console.error(tscOutput.slice(0, 4000));
    process.exit(1);
  }

  // Keep the verdict's historical TS1xxx hard-fail policy separate from the
  // syntax-only projection exposed by syntaxBrokenFiles (TS1320 is semantic).
  const brokenFiles = hardFailFiles(errors);
  const currentByFile = countByFile(errors);

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
  } catch {
    console.error(`❌ Failed to read baseline file: ${baselineFile}`);
    process.exit(1);
    return;
  }
  const ownBaselineByFile = baseline.files ?? {};

  // Load each owning package's baseline BEFORE any initialization path. A new gate must know
  // which measured files belong to another package before it persists its first snapshot; otherwise
  // --seed copies foreign rows into this gate's own baseline and effectiveBaselineByFile can never
  // inherit the owner's canonical count on later runs.
  //
  // Fail-SOFT per source on ordinary checks: an unreadable foreign baseline degrades to the old
  // absent⇒0 behaviour (a possible false red we WARN about) rather than silently passing. Seeding
  // is stricter below: it refuses when any owner baseline is unavailable because it cannot safely
  // partition canonical owner rows from consumer-context-only diagnostics.
  const loadedForeign = [];
  const unavailableForeign = [];
  for (const source of foreignBaselines) {
    try {
      const parsed = JSON.parse(readFileSync(source.baselineFile, 'utf-8'));
      loadedForeign.push({ ...source, files: parsed.files ?? {} });
    } catch {
      unavailableForeign.push(source);
      console.warn(
        `⚠ Could not read the baseline owning ${source.prefix} (${source.baselineFile}) — ` +
          `files under it fall back to an implicit 0 baseline and may report as false regressions.`,
      );
    }
  }

  // --seed: one-time initialization for a BRAND-NEW project's baseline. `--update` cannot do this
  // (by design — decidePerFile always treats a file absent from the baseline as a REGRESSION, per
  // EI-18766822535373909, so a truly empty baseline can never self-populate via the normal ratchet
  // path: `regressions.length > 0` short-circuits before the `updateFlag` improvements branch is
  // ever reached). Discovered live seeding apps/operator's first baseline (EI-19312097806511163) —
  // `--update` against an empty `files: {}` reported every file as a `fail-regressed` hard error
  // instead of seeding anything. --seed bypasses the regression gate entirely and writes the
  // CURRENT per-file counts as the starting baseline — a debt SNAPSHOT, not a clean bill of health.
  // Refuses when the baseline already has entries, so it can never be used to silently wipe out a
  // real, populated ratchet (that would erase tracked debt/regressions) — use --update for every
  // subsequent run once a project has a real baseline. Still hard-fails on a TS1xxx diagnostic,
  // same as every other path, so a broken file can never be seeded in as "0 errors elsewhere, ignore
  // me" debt.
  if (argv.includes('--seed')) {
    if (Object.keys(ownBaselineByFile).length > 0) {
      console.error(
        `❌ --seed refused: ${baselineFile} already has ${Object.keys(ownBaselineByFile).length} file(s) recorded. ` +
          `--seed is ONLY for a brand-new, empty baseline (files: {}) — use --update to ratchet an existing one.`,
      );
      process.exit(1);
      return;
    }
    if (brokenFiles.length > 0) {
      console.error(
        `❌ ${brokenFiles.length} file(s) have hard-failing TS1xxx diagnostics — fix these before seeding a baseline:`,
      );
      for (const f of brokenFiles) console.error(`   - ${f}`);
      process.exit(1);
      return;
    }
    // Seeding needs the owning baselines in hand so it can distinguish a canonical owner row from
    // a diagnostic that exists ONLY in this consumer's compile context. Guessing either way is
    // unsafe: dropping every foreign-prefix row makes context-only diagnostics permanently red,
    // while retaining every row forks debt already tracked by the owner.
    if (unavailableForeign.length > 0) {
      console.error(
        `❌ --seed refused: ${unavailableForeign.length} owning baseline(s) could not be read. ` +
          `Restore them before partitioning inherited and consumer-context diagnostics.`,
      );
      process.exit(1);
      return;
    }

    // Reuse the normal effective-baseline resolver as the ownership authority. Only files with a
    // real row in the owning package are omitted here and inherited later. A foreign-prefix file
    // absent from the owner baseline is a consumer-context delta (for example, an error introduced
    // by this package's tsconfig options) and MUST remain in this gate's own baseline.
    const { inherited: inheritedSeed } = effectiveBaselineByFile({
      baselineByFile: {},
      currentByFile,
      foreignBaselines: loadedForeign,
    });
    const inheritedSeedFiles = new Set(inheritedSeed.map((entry) => entry.file));
    const contextOnlyForeignSeedFiles = Object.keys(currentByFile).filter(
      (file) =>
        foreignBaselines.some((source) => file.startsWith(source.prefix)) &&
        !inheritedSeedFiles.has(file),
    );
    const ownSeedByFile = Object.fromEntries(
      Object.entries(currentByFile)
        .filter(([file]) => !inheritedSeedFiles.has(file))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    baseline.files = ownSeedByFile;
    baseline[countField] = sumValues(ownSeedByFile);
    baseline.updatedAt = new Date().toISOString();
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
    console.log(
      `✓ seeded: baseline → ${sumValues(ownSeedByFile)} errors across ${Object.keys(ownSeedByFile).length} file(s) (${baselineFile})`,
    );
    if (inheritedSeedFiles.size > 0) {
      console.log(
        `   (${inheritedSeedFiles.size} cross-package file(s) omitted from this baseline; ` +
          `they inherit from their owning package on later runs.)`,
      );
    }
    if (contextOnlyForeignSeedFiles.length > 0) {
      console.log(
        `   (${contextOnlyForeignSeedFiles.length} foreign-prefix file(s) retained because their ` +
          `diagnostics exist only in this gate's compile context.)`,
      );
    }
    return;
  }

  const { effective: effectiveBaseline, inherited } = effectiveBaselineByFile({
    baselineByFile: ownBaselineByFile,
    currentByFile,
    foreignBaselines: loadedForeign,
  });
  // A service run judged only `served.checked`; every other baselined file would otherwise read as
  // "improved to 0" (WI-10003404).
  const baselineByFile =
    served === null
      ? effectiveBaseline
      : baselineWithinScope(effectiveBaseline, new Set([...served.checked, ...Object.keys(currentByFile)]));
  // EI-18731016038876755: an explicit --files= list is authoritative — the caller SAID which
  // files are theirs, so never fall back to the git-status guess for the same run.
  const changedFiles = explicitFiles ?? (mineFlag ? gitChangedFiles(root) : null);

  // EI-18756182128903253 / EI-21833727883305743 — cause-aware widening: when scoped (--mine or
  // --files), also attribute a regression OUTSIDE the changed set when the file's source OR its
  // compiler diagnostic references an exported type/interface one of the changed files also
  // exports (the "I added a required field, an unchanged fixture broke" shape --mine was
  // otherwise structurally blind to). Cheap: only reads the changed files plus files that already
  // have a regression, never a tree-wide scan.
  const typeReferencedFiles = changedFiles
    ? (() => {
        const candidates = Object.keys(currentByFile).filter(
          (f) => f !== '(unattributed)' && !changedFiles.has(f),
        );
        const typeNames = exportedTypeNames(root, changedFiles);
        return new Set([
          ...filesReferencingTypeNames(root, candidates, typeNames),
          ...diagnosticFilesReferencingTypeNames(
            tscOutput,
            candidates,
            typeNames,
            diagnosticPathOptions,
          ),
        ]);
      })()
    : null;

  // EI-19278299775574199 — under `--files`, `changedFiles` is the caller's OWN enumeration, so
  // working-tree dirt is a separate, independent signal ("someone has this open"). A bare run has
  // no caller-owned set at all, so it also reads git status to annotate ordinary regression rows;
  // without that annotation a dirty baseline-0 row is printed as if every quoted error were a
  // settled, actionable failure. Under `--mine` the two sets are the same query, so keep the
  // existing null signal: anything outside `changedFiles` is already committed, and anything in
  // it is attributed rather than a bare `fail-regressed` row.
  const dirtyFiles = explicitFiles !== null || !mineFlag ? gitChangedFiles(root) : null;

  // EI-19305736771912430 — `--files` DECLARES the caller's own file set; `--mine` only INFERS it
  // from git status. Only the declared form may stop an unscoped new file setting the exit code.
  const result = decidePerFile({
    currentByFile,
    baselineByFile,
    brokenFiles,
    updateFlag,
    changedFiles,
    typeReferencedFiles,
    dirtyFiles,
    attributionDeclared: explicitFiles !== null,
  });
  const concurrentEditFiles =
    ['fail-regressed', 'fail-attributed', 'fail-new-file'].includes(result.verdict)
      ? filesModifiedDuringRun({
          root,
          files:
            result.verdict === 'fail-attributed'
              ? result.attributed.map((entry) => entry.file)
              : result.regressions.map((entry) => entry.file),
          runStartMs: Date.parse(runStartIso),
        })
      : [];
  concurrentEditInconclusive = concurrentEditFiles.length > 0;
  console.log(
    `TSC ${label}: ${result.total} type errors across ${Object.keys(currentByFile).length} file(s) ` +
      `(baseline total ${result.baselineTotal})${explicitFiles ? ' [--files]' : mineFlag ? ' [--mine]' : ''}`,
  );
  if (inherited.length > 0) {
    console.log(
      `   (${inherited.length} cross-package file(s) inherited their baseline from the package that OWNS them — ` +
        `already-known errors there, not regressions to this gate.)`,
    );
  }

  const writeBaseline = (byFile, why) => {
    baseline.files = Object.fromEntries(Object.entries(byFile).sort(([a], [b]) => a.localeCompare(b)));
    baseline[countField] = sumValues(byFile); // derived total, kept for humans/back-compat
    baseline.updatedAt = new Date().toISOString();
    writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`✓ ${why}: baseline → ${sumValues(byFile)} errors across ${Object.keys(byFile).length} file(s)`);
  };

  // EI-19444246913245434 — a SCOPED `--update` lowers ONLY the files the caller named, merged onto
  // the gate's OWN on-disk baseline. Deliberately NOT `baselineByFile`: that is the EFFECTIVE map,
  // which folds in entries inherited from foreign package baselines (effectiveBaselineByFile), and
  // persisting those would durably copy another package's rows into this one.
  const ratchetScoped = (entries, why) => {
    writeBaseline(
      mergeRatchetIntoBaseline({ baselineFiles: baseline.files ?? {}, ratchetFiles: entries }),
      why,
    );
    for (const r of entries) console.log(formatRow(r));
  };

  // EI-19321179234197157: a file with a TS1xxx hard-fail diagnostic OUTSIDE the caller's own --mine/--files set never
  // gates the verdict (see decidePerFile), but it is still surfaced here — unconditionally, ahead
  // of the verdict switch, so it is never lost whichever branch below returns. tsc's diagnostics
  // for OTHER files can be incomplete while a file fails to parse, so this doubles as a caveat on
  // how much to trust an 'ok' verdict alongside it.
  //
  // EI-19321397364088260 — split into a peer's LIVE EDIT (uncommitted right now) vs a COMMITTED
  // standing red, the same split `newFiles`/`fail-new-file` already give unattributed type-error
  // regressions (EI-19278299775574199) and the same split BOTH bug reports for this path asked
  // for. Before this, every unattributed broken file was reported with one blanket "a peer is
  // likely mid-edit" line — true for a genuinely dirty file, but false reassurance for a file
  // that is actually COMMITTED and will red the fleet at the next bare run: a reader could
  // dismiss a real standing defect as transient noise.
  //
  // `dirtyFiles` is only populated under `--files` (see above) — under `--mine`, `changedFiles`
  // IS the dirty set, so by construction anything outside it (i.e. everything reaching this
  // branch) is already committed; no live-edit population is possible there, and `dirtyFiles`
  // being `null` correctly routes every entry to `standing` rather than fabricating an
  // exoneration out of an unknown (the same "unknown is never an exoneration" rule this file
  // applies everywhere else).
  if (result.unattributedBrokenFiles && result.unattributedBrokenFiles.length > 0) {
    const { liveEdits: brokenLiveEdits, standing: brokenStanding } = partitionBrokenFilesByLiveEdit(
      result.unattributedBrokenFiles,
      dirtyFiles,
    );
    console.error(
      `   ⚠ ${result.unattributedBrokenFiles.length} file(s) have hard-failing TS1xxx diagnostics but are NOT in ` +
        `the set you named — not gating this run, but tsc's counts for other files may be incomplete while these ` +
        `stay broken:`,
    );
    for (const f of brokenLiveEdits) {
      console.error(`     - ${f}  ← uncommitted, a peer is likely mid-edit`);
    }
    for (const f of brokenStanding) {
      console.error(`     - ${f}  ← COMMITTED: a standing red that WILL red the fleet at the next bare run`);
    }
  }

  // EI-20064603102922814 — the OTHER half of the sampler. recordStandingReds() below remembers
  // that a red EXISTS; nothing recorded that a compile RAN, so a red that got FIXED simply
  // stopped being mentioned and its work-item sat open forever as a severity:major false
  // critical (5 of 5 open ones were stale at one measurement, 4 by ~30h). A heartbeat makes the
  // silence readable: a later run that did NOT re-sight a file is positive evidence it is clean,
  // because a run that still saw it would have re-recorded it in the same store.
  //
  // Placed BEFORE the switch on purpose: every `process.exit()` lives inside it, so this is the
  // last point every verdict still passes through. Soundness is enforced inside recordGateRun,
  // which drops any verdict that did not observe the complete standing set — so the `fail-*`
  // exits below record nothing, and a future verdict nobody classified is ignored rather than
  // trusted. Fail-soft like its sibling: TSC_EXIT can never depend on it.
  //
  // A service-served run (WI-10003404) never records one: it checked a scoped subset, so its
  // silence about a standing red is NOT evidence the red is gone.
  if (!concurrentEditInconclusive && served === null) {
    recordGateRun({
      verdict: result.verdict,
      project: label ?? '',
      standingCount: Array.isArray(result.newFiles)
        ? partitionNewFilesByLiveEdit(result.newFiles).standing.length
        : 0,
    });
  }

  if (concurrentEditInconclusive) {
    console.error(
      `⚠ INCONCLUSIVE — ${concurrentEditFiles.length} source file(s) in the reported regression's ` +
        `dependency cone changed after this typecheck started:`,
    );
    for (const file of concurrentEditFiles) console.error(`   - ${file}`);
    console.error(
      `   The compiler may have read a half-written cross-file state that never existed as a settled tree. ` +
        `Do NOT edit the named files from this result; re-run the focused check against the current tree.`,
    );
    process.exit(1);
    return;
  }

  switch (result.verdict) {
    case 'fail-syntax': {
      console.error(`❌ ${result.brokenFiles.length} file(s) have hard-failing TS1xxx diagnostics — hard fail regardless of baseline:`);
      // The compiler output already contains the location and message for each hard-failing
      // TS1xxx diagnostic. Quote those diagnostics here so a reader does not need a second full
      // compile to learn the actual problem (which is not necessarily a syntax error).
      const diagnostics = diagnosticLinesForFiles(tscOutput, result.brokenFiles, {
        ...diagnosticPathOptions,
        maxPerFile: diagnosticCapFromArgv(argv, DEFAULT_DIAGNOSTIC_MAX_PER_FILE),
      });
      for (const f of result.brokenFiles) {
        console.error(`   - ${f}`);
        for (const line of diagnostics.get(f) ?? []) console.error(`      ${line}`);
      }
      process.exit(1);
      break;
    }
    case 'fail-regressed': {
      console.error(`❌ ${result.regressions.length} file(s) added type errors above their baseline:`);
      // EI-19454211066351073 — quote the compiler lines the `+N` stands for. The gate has already
      // run tsc and already parsed it per-file (that is where the delta comes from), so the
      // messages are in hand at this exact moment and were being discarded. Without them the
      // report says "you broke something" but not what, and the only way to find out is a second
      // full ~150s compile that queues behind pc-heavy.
      const diagnostics = diagnosticLinesForFiles(
        tscOutput,
        result.regressions.map((r) => r.file),
        {
          ...diagnosticPathOptions,
          maxPerFile: diagnosticCapFromArgv(argv, REGRESSION_DIAGNOSTIC_MAX_PER_FILE),
        },
      );
      for (const r of result.regressions) {
        console.error(formatRow(r));
        for (const line of formatRegressedFileDiagnostics(r, diagnostics.get(r.file) ?? [])) {
          console.error(line);
        }
      }
      console.error(`   Fix the new errors in the named file(s). The baseline only ratchets DOWN (raising a file is a hand-edit of ${baselineFile} with justification).`);
      process.exit(1);
      break;
    }
    case 'fail-attributed': {
      console.error(
        formatAttributionHeadline({
          count: result.attributed.length,
          explicit: explicitFiles !== null,
          // The subset of `attributed` the caller did NOT name (cause-aware widening reached it
          // from a type one of the named files exports). Defaulted here rather than assumed:
          // `typeAttributed` rides only the fail-attributed verdict, and a missing array must
          // degrade to the old wording, never to a wrong split.
          typeAttributedCount: result.typeAttributed?.length ?? 0,
        }),
      );
      // EI-19454211066351073 — this is the branch the `--files` flag exists to reach, and the one
      // where the omission cost the most: `--files` is the only trustworthy attribution on this
      // shared tree, so having just established that the regression IS yours, "what is it" is the
      // very next question and the report used to stop exactly there.
      const attributedDiagnostics = diagnosticLinesForFiles(
        tscOutput,
        result.attributed.map((r) => r.file),
        {
          ...diagnosticPathOptions,
          maxPerFile: diagnosticCapFromArgv(argv, REGRESSION_DIAGNOSTIC_MAX_PER_FILE),
        },
      );
      for (const r of result.attributed) {
        // EI-23768041578113385 — only a TYPE-attributed row (one you did not name) carries
        // `dirty`, so this marker cannot fire for a file you listed yourself. The verdict is
        // deliberately UNCHANGED — it still gates — but an uncommitted file you never named may
        // be a peer's live edit, and the caller must not be sent to fix hunks that are not
        // theirs. Deliberately weaker than the `newFiles` marker, which can say "not attributed
        // to you" because those rows genuinely are not the caller's.
        console.error(
          r.dirty === true
            ? `${formatRow(r)}  ← uncommitted: verify these hunks are YOURS before editing (a peer may own them)`
            : formatRow(r),
        );
        for (const line of formatRegressedFileDiagnostics(r, attributedDiagnostics.get(r.file) ?? [])) {
          console.error(line);
        }
      }
      if (result.typeAttributed && result.typeAttributed.length > 0) {
        console.error(
          `   (${result.typeAttributed.length} of the above are NOT in your changed-file set — attributed because ` +
            `their source or compiler diagnostic references an exported type/interface one of your changed files also exports. This is the ` +
            `EI-18756182128903253 fix: a required-field addition breaks a fixture/constructor your diff never ` +
            `touched, and that fixture now gates with your change instead of surfacing hours later at green-checkpoint.)`,
        );
        // EI-23768041578113385 — the widening above is correct but over-inclusive by design, and
        // on this shared checkout its false positive has a cheap, specific tell: the file is
        // UNCOMMITTED and you never named it, so a peer may be mid-edit in it. Naming those files
        // converts a silent misattribution into a routing hint. Without this, narrowing `--files`
        // to your own files returns a confident `status=regressed` for errors that are entirely
        // someone else's — and the natural next move is to go edit a live peer's hunks.
        const typeAttributedLive = partitionEntriesByLiveEdit(result.typeAttributed).liveEdits;
        if (typeAttributedLive.length > 0) {
          console.error(
            `   (of those, ${typeAttributedLive.length} is/are UNCOMMITTED and not named by you: ` +
              `${typeAttributedLive.map((r) => r.file).join(', ')} — a peer may be mid-edit there. ` +
              `Check \`git diff\` on those hunks before editing: if they are not yours, this red is not yours to fix.)`,
          );
        }
      }
      if (result.newFiles.length > 0) {
        // EI-19278299775574199 — same split as the fail-new-file branch: an uncommitted new file is
        // a peer's live buffer, not part of the caller's regression.
        const { liveEdits } = partitionNewFilesByLiveEdit(result.newFiles);
        const newFileDiagnostics = diagnosticLinesForFiles(
          tscOutput,
          result.newFiles.map((r) => r.file),
          {
            ...diagnosticPathOptions,
            maxPerFile: diagnosticCapFromArgv(argv, DEFAULT_DIAGNOSTIC_MAX_PER_FILE),
          },
        );
        console.error(
          `   (also ${result.newFiles.length} NEW file(s) with errors` +
            `${liveEdits.length > 0 ? `, ${liveEdits.length} uncommitted — a peer is likely mid-edit, NOT yours` : ''} — see below)`,
        );
        for (const r of result.newFiles) {
          console.error(r.dirty === true ? `${formatRow(r)}  ← uncommitted, not attributed to you` : formatRow(r));
          for (const line of newFileDiagnostics.get(r.file) ?? []) console.error(`      ${line}`);
        }
      }
      if (result.peerDrift.length > 0) {
        console.error(`   (also ${result.peerDrift.length} regressed file(s) not in your changed set — not gated under --mine)`);
      }
      process.exit(1);
      break;
    }
    case 'fail-new-file': {
      // EI-18766822535373909: these are files the baseline has NEVER seen. Absence from the
      // changed set does not clear you — git-sync commits the tree every few minutes, so your own
      // new file is dirty for only a short window. Never greenwash this one.
      //
      // EI-19278299775574199 splits the LISTING (never the verdict) so the two populations that
      // need opposite actions stop looking identical: a peer's uncommitted live buffer must not be
      // edited, a committed standing red must be.
      const { liveEdits, standing } = partitionNewFilesByLiveEdit(result.newFiles);
      // WI-6767 — quote the compiler lines the `+N` stands for. The gate already holds them; the
      // alternative for the reader is a fresh ~100s full-project compile, which is precisely what
      // the WI-6764 filer could not afford and so filed a major bug without ever seeing the error.
      const diagnostics = diagnosticLinesForFiles(
        tscOutput,
        result.newFiles.map((r) => r.file),
        {
          ...diagnosticPathOptions,
          maxPerFile: diagnosticCapFromArgv(argv, DEFAULT_DIAGNOSTIC_MAX_PER_FILE),
        },
      );
      const emitRow = (r, suffix = '') => {
        console.error(`${formatRow(r)}${suffix}`);
        for (const line of diagnostics.get(r.file) ?? []) console.error(`      ${line}`);
      };
      if (liveEdits.length > 0) {
        console.error(
          `❌ ${result.newFiles.length} NEW file(s) (not in the baseline) have type errors — ` +
            `${liveEdits.length} of them uncommitted (a peer is likely mid-edit; NOT yours):`,
        );
        for (const r of liveEdits) emitRow(r, '  ← uncommitted, not attributed to you');
        for (const r of standing) emitRow(r);
      } else {
        console.error(`❌ ${result.newFiles.length} NEW file(s) (not in the baseline) have type errors:`);
        for (const r of result.newFiles) emitRow(r);
      }
      // EI-18802204276510164 — the remedy is worded per how the changed-set was derived, so a
      // caller who already passed --files is never told to pass --files.
      for (const line of formatNewFileGuidance({
        explicit: explicitFiles !== null,
        liveEditCount: liveEdits.length,
        standingCount: standing.length,
      })) {
        console.error(line);
      }
      // WI-6767 — the landing-race caveat, computed over the COMMITTED subset only (a peer's live
      // buffer is already correctly explained above, and git log would say nothing about it).
      // Costs one `git log -1` per committed new file, and nothing at all when there are none.
      const { recent } = partitionStandingByCommitRecency(
        standing,
        lastCommitTimes(
          root,
          standing.map((r) => r.file),
        ),
        Math.floor(Date.now() / 1000),
      );
      for (const line of formatLandingRaceCaveat({ recentCount: recent.length })) {
        console.error(line);
      }
      process.exit(1);
      break;
    }
    case 'ok-peer-drift': {
      console.log(`✓ Your changed files are tsc-clean. ${result.peerDrift.length} file(s) already in the baseline regressed but are not in your changed set:`);
      for (const r of result.peerDrift) console.log(formatRow(r));
      console.log(`   (Not gated under --mine. Note the changed set comes from git status, and git-sync auto-commits this tree`);
      console.log(`    every few minutes — so a file you edited a while ago can appear here. Use --files= to scope precisely.`);
      console.log(`    A bare npm run of this gate will still catch these for whoever owns them.)`);
      // EI-19305736771912430 — under `--files` an unscoped NEW file no longer sets the exit code,
      // but it is emphatically still REPORTED: a committed one is a standing red that WILL red the
      // fleet at the next bare run, and someone has to see it. Not gating it is what stops a SCOPED
      // run crying wolf; not printing it would just move the problem.
      if (result.newFiles.length > 0) {
        const { liveEdits, standing } = partitionNewFilesByLiveEdit(result.newFiles);
        console.log(
          `   ⚠ ${result.newFiles.length} NEW file(s) (absent from the baseline) also have type errors, ` +
            `none of them in the set you named:`,
        );
        for (const r of liveEdits) console.log(`${formatRow(r)}  ← uncommitted, a peer is likely mid-edit`);
        // EI-19340874432965755 — HOISTED. This map was already being computed a few lines below for
        // the landing-race caveat, but only AFTER the rows had been printed, so the rows themselves
        // could not see the one piece of evidence that exonerates a file: its own commit age. One
        // `git log -1` per committed file now serves BOTH, so this attribution costs no extra
        // subprocess (it previously cost the same map, discarded for row-wording purposes).
        const nowSec = Math.floor(Date.now() / 1000);
        const standingCommitTimes = lastCommitTimes(
          root,
          standing.map((r) => r.file),
        );
        /** @param {string} file @returns {number | null} */
        const commitAgeOf = (file) => {
          const t = standingCommitTimes.get(file);
          return typeof t === 'number' ? nowSec - t : null;
        };
        let unchangedCount = 0;
        for (const r of standing) {
          const commitAgeSec = commitAgeOf(r.file);
          if (isUnchangedForAttribution(commitAgeSec)) unchangedCount += 1;
          console.log(
            formatStandingRedRow(r, {
              dirtyPathCount: dirtyFiles?.size ?? 0,
              commitAgeSec,
            }),
          );
        }
        // WI-7153 — the footer is an exported pure function so the "do not hand-file" contract is
        // unit-testable; inline console.log in a process.exit branch was untestable, which is why
        // the contradiction with recordStandingReds() below survived unnoticed.
        if (standing.length > 0) {
          for (const line of formatStandingRedFooter({ unchangedCount })) console.log(line);
        }
        // EI-19340930095511759 — this branch is the `ok-peer-drift` twin of `fail-new-file`, and
        // until now it was missing the LANDING-RACE caveat that branch already has (WI-6767). A
        // file this gate calls "COMMITTED" here can still be a half-landed, self-healing red: this
        // gate's OWN compile can be served from a coalesced/replayed tsc run up to
        // PC_HEAVY_COALESCE_SEC (420s) old for any file OUTSIDE the caller's own --files set (see
        // coalesceWatermarkFor's freshness guarantee above — it only covers the caller's OWN
        // files), so a peer's fix can already be committed by the time this prints while the count
        // above still reflects the pre-fix compile. Confidently asserting "COMMITTED … WILL red the
        // fleet" with no caveat is exactly what invited a duplicate fix that collided with the
        // peer who wrote it (the filing that prompted this fix). Never move the verdict — this only
        // adds the same "wait a moment, then verify" caveat `fail-new-file` already prints.
        // Reuses the map hoisted above (EI-19340874432965755) rather than re-shelling one
        // `git log -1` per file a second time; `nowSec` is shared too, so the recency split and
        // the per-row UNCHANGED marks are computed against ONE instant and cannot disagree.
        const { recent } = partitionStandingByCommitRecency(standing, standingCommitTimes, nowSec);
        for (const line of formatLandingRaceCaveat({ recentCount: recent.length })) {
          console.log(line);
        }
        // EI-19342686127995790 — this is the exact line the fleet computes ~9x/hour and discards.
        // Remember it so a red that OUTLIVES its author can be found later; the sweeper (never this
        // hot path) decides whether it has persisted long enough to deserve an owner. Local append
        // only, and every failure is swallowed inside recordStandingReds — the gate's verdict and
        // exit code must not depend on it. `standing` excludes dirty paths by construction.
        // `root` is what scopes the record to the tree it was measured against
        // (EI-21985631427355996). Without it a gate run against a synthetic fixture root —
        // `lint-tsc.test.ts` drives one — appends paths relative to THAT root into the same
        // process-global store the fleet's sweeper reads, and the sweeper cannot tell them
        // apart. Still a swallowed local append: the stamp cannot change TSC_EXIT.
        recordStandingReds({ entries: standing, project: label ?? '', root });
      }
      // EI-19444246913245434 — THE DROPPED WRITE. Everything above is a report ABOUT PEERS; the
      // caller's own `--update` still has to happen. Before this, it silently did not: the run
      // exited 0 with a leading ✓ and a `scope=update` marker having written nothing, so the next
      // agent measured against a stale baseline and inherited slack that absorbs a real
      // regression. Placed last so the ratchet line reads after the drift it is unrelated to.
      if (result.ratchetFiles) {
        ratchetScoped(result.ratchetFiles, 'Ratcheted YOUR improved file(s) down (--update, scoped)');
      }
      process.exit(0);
      break;
    }
    case 'ok-ratchet':
      // Reached ONLY on an explicit `--update` with at least one improved file (decidePerFile gates it).
      if (result.ratchetFiles) {
        // Scoped run: lower the caller's own files only (EI-19444246913245434).
        ratchetScoped(result.ratchetFiles, 'Ratcheted YOUR improved file(s) down (--update, scoped)');
      } else {
        writeBaseline(result.newBaselineByFile, 'Ratcheted improved file(s) down (--update)');
        for (const r of result.improvements) console.log(formatRow(r));
      }
      process.exit(0);
      break;
    case 'ok-below':
      console.log(`✓ ${result.improvements.length} file(s) below baseline — NOT locked in. Re-run with --update on a quiet tree to lower them deliberately:`);
      for (const r of result.improvements) console.log(formatRow(r));
      process.exit(0);
      break;
    default:
      if (updateFlag) console.log('✓ --update: every file is at its baseline — nothing to lower.');
      console.log(`✓ Every ${label} file is at or under its type-error baseline.`);
      process.exit(0);
  }
}
