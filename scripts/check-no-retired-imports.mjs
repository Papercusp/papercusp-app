#!/usr/bin/env node
/**
 * check-no-retired-imports.mjs — fail-loud guard for `_retired/` code.
 *
 * Code under `_retired/` (superproject) and `libs/papercusp/_retired/`
 * (submodule) is preserved-not-active: dropped from the workspace globs,
 * not built/tested, not to be imported. This guard keeps that boundary
 * permanent — if live code starts importing a `_retired/` module, or
 * re-introduces the retired `POST /api/plugins/orchestrator/spawn` fetch
 * (the dead orchestrator-spawn plugin endpoint, replaced by `fleet:spawn`),
 * CI fails with a clear message instead of the dead path silently re-accruing.
 *
 *   node scripts/check-no-retired-imports.mjs
 *
 * Anchored on import/fetch CONTEXTS (not bare mentions), so prose comments
 * that reference a `_retired/` path or explain the retired endpoint don't
 * trip it. Scope: tracked ts/tsx/mjs/cjs/js. Excludes `_retired/` itself,
 * node_modules, dist, generated docs, and this script.
 *
 * See plan archive-legacy-orchestrator-deadcode-2026-06-06 (P-013). The
 * companion "no NEW raw agent-CLI spawn" guard lives with the spawn
 * chokepoint work (unify-agent-spawn-chokepoint-2026-06-06 P-008).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { firstLiveMatch, stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * True only when this file is the process entrypoint — so a test can IMPORT the
 * predicate below without the whole guard running (and calling process.exit) on
 * import. Same idiom, for the same reason, as the sibling
 * `check-retired-resurrection.mjs`: realpath both sides, because `import.meta.url`
 * resolves symlinks while `process.argv[1]` keeps the path as typed.
 */
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.startsWith('libs/papercusp/_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.startsWith('apps/operator/docs/plans/') ||
  f.startsWith('apps/operator/public/internal/docs/') ||
  f.endsWith('.d.ts') ||
  f === 'scripts/check-no-retired-imports.mjs';

// An import/require/from whose module string contains a `_retired/` segment.
const RETIRED_IMPORT =
  /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*['"`][^'"`]*_retired\//;
// A fetch() to the dead orchestrator-spawn plugin endpoint (404; use fleet:spawn).
const DEAD_SPAWN_FETCH = /fetch\s*\(\s*['"`][^'"`]*plugins\/orchestrator\/spawn/;

/**
 * The per-file scan, exported so a test can prove this guard can still FAIL without
 * duplicating the two regexes above — a second copy in a test would drift from these,
 * and a guard whose test checks a stale copy of its own rule is worse than untested.
 */
export function findOffendersInText(f, text) {
  const offenders = [];
  if (!text.includes('_retired/') && !text.includes('plugins/orchestrator/spawn')) {
    return offenders;
  }
  // WI-6730 skipped comment LINES, because `RETIRED_IMPORT` keys on the word `from`, so ordinary
  // prose about this very policy matches it. WI-37717: that line-start test saw only a comment
  // OPENING a line — a trailing comment, a block-comment body, and above all a TEMPLATE LITERAL
  // quoting an import all walked straight through it, and this repo's prompt/doc sources embed
  // code examples routinely.
  //
  // Neither stripper alone fixes it: both patterns SPAN code and string content (the `from`
  // keyword is code, the `_retired/` specifier it needs is inside the string), so masking
  // strings deletes the evidence while masking comments leaves the template standing. So match
  // on RAW and ask whether the match's ANCHOR — the `from`/`import`/`require`/`fetch` keyword —
  // is live program text. Its specifier being a string is expected; a keyword that is itself
  // string or comment content never was an import.
  // MASK LAZILY, AND GATE IT ON A RAW REGEX HIT — not on the `includes` pre-filter above.
  // Masking is MONOTONIC (it can only remove a match, never create one), so a line with no raw
  // match needs no mask. The distinction is worth ~22s of wall clock: 119 tracked files mention
  // `_retired/` SOMEWHERE, and parsing all of them cost 0.26s -> 21.99s of detector time
  // (measured), while only a handful contain a line that actually matches an import shape.
  const rawLines = text.split('\n');
  let maskedLines = null;
  rawLines.forEach((line, i) => {
    const rawRetired = RETIRED_IMPORT.test(line);
    const rawDead = DEAD_SPAWN_FETCH.test(line);
    if (!rawRetired && !rawDead) return;
    maskedLines ??= stripCommentsAndStrings(text, f).split('\n');
    if (rawRetired && firstLiveMatch(line, maskedLines[i], RETIRED_IMPORT)) {
      offenders.push(`${f}:${i + 1}  [imports a _retired/ module]  ${line.trim().slice(0, 100)}`);
    }
    if (rawDead && firstLiveMatch(line, maskedLines[i], DEAD_SPAWN_FETCH)) {
      offenders.push(`${f}:${i + 1}  [retired /api/plugins/orchestrator/spawn fetch]  ${line.trim().slice(0, 100)}`);
    }
  });
  return offenders;
}

/**
 * Enumerate + scan. Exported so a test can assert the scan actually REACHED the tree
 * — "0 offenders, exit 0" is equally the output of a guard that examined nothing, so
 * the count of files scanned is part of the verdict, not decoration.
 */
export function scanTree() {
  // WI-6730: enumerate via the shared helper, which recurses into submodules. A bare
  // `git ls-files` does not — it emits one gitlink entry per submodule — so this
  // retirement guard never checked inside any of the 39, including libs/papercusp,
  // which is precisely where the legacy orchestrator run-loop it polices lives.
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);
  const offenders = [];
  let scanned = 0;
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!/\.(ts|tsx|mjs|cjs|js)$/.test(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    offenders.push(...findOffendersInText(f, text));
  }
  return { offenders, scanned, unscanned };
}

export function main() {
  const { offenders, unscanned } = scanTree();

  if (offenders.length === 0) {
    console.log(
      `✓ no live imports of _retired/ modules and no retired orchestrator-spawn fetch.${describeUnscanned(unscanned)}`,
    );
    return 0;
  }

  console.error('✗ live code is reaching into RETIRED surfaces:');
  console.error('  - Importing a `_retired/` module: restore it properly (git mv back + re-wire per its RESTORE.md), do not import across the boundary.');
  console.error('  - `POST /api/plugins/orchestrator/spawn` is dead (404); spawn via `fleet:spawn` / spawnAgentInHarness instead.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See plan archive-legacy-orchestrator-deadcode-2026-06-06 (P-013).`);
  return 1;
}

if (isDirectRun()) process.exit(main());
