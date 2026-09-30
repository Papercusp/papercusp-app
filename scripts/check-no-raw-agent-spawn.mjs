#!/usr/bin/env node
/**
 * check-no-raw-agent-spawn.mjs — fail-loud guard against NEW raw agent-CLI spawns
 * (unify-agent-spawn-chokepoint-2026-06-06, P-008 / D-001).
 *
 * Every agent spawn must go through the ONE chokepoint `spawnInvokeOnce`
 * (dbos/orchestrator-runner.ts) so it gets uniform admission + governor pacing +
 * the option of (class-gated) durability. A file that builds the agent-CLI command
 * itself (`buildInvokeOnce`) AND raw-`child_process.spawn`s it is a BYPASS — it
 * should call `spawnInvokeOnce` instead. This guard fails the build when a NEW such
 * bypass appears, so the unification doesn't silently erode back.
 *
 *   node scripts/check-no-raw-agent-spawn.mjs
 *
 * The bypass-detection predicate (`isRawAgentSpawnBypass`) is exported + unit-tested
 * (packages/operator-core/lib/dbos/no-raw-spawn-guard.test.ts) so the "fails on a new
 * raw spawn" property (P-016) is durably verified, not only green-on-clean-tree.
 *
 * ALLOWLIST — the legitimate sites that build + spawn the agent CLI directly:
 *   • packages/operator-core/lib/dbos/orchestrator-runner.ts — IS the chokepoint
 *     (`spawnInvokeOnce` → `runChild`); everything else funnels through it.
 *
 * (The `/invoke` HTTP route at endpoint-route/routes/harness/spawn.ts WAS the last
 * remaining bypass; it now routes through `spawnInvokeOnce` with a per-call timeout
 * — P-008 — so the only build+spawn site left is the chokepoint itself. Its
 * allowlist entry is gone: the routed file no longer imports node:child_process,
 * so the bypass predicate would flag any regression that re-inlines a raw spawn.)
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

export const ALLOWLIST = new Set([
  // The chokepoint: builds (buildInvokeOnce) + spawns (runChild) the agent CLI.
  'packages/operator-core/lib/dbos/orchestrator-runner.ts',
  // The builder LIBRARY: defines `buildInvokeOnce`. It never spawns — every spawn
  // caller must route through `spawnInvokeOnce` (the chokepoint, which lives in
  // the file above). Allowlisted so its own `function buildInvokeOnce(` declaration
  // doesn't read as a call-site bypass.
  'packages/operator-core/lib/harness-invoke-once.ts',
]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.endsWith('.test.ts') ||
  !/\.ts$/.test(f);

/**
 * Strip block (/* *​/, incl. JSDoc) + line (//) comments so a PROSE mention of
 * `buildInvokeOnce` isn't mistaken for a call.
 *
 * WI-6666: recursing this guard into submodules (below) surfaced 3 false-positive
 * "bypasses" on the FIRST run, all in the superproject (not even a submodule
 * effect) — doc comments like `buildInvokeOnce (via spawnInvokeOnce's extraEnv)`
 * or `(buildInvokeOnce, EI-...)` that put a `(` after the word for parenthetical
 * prose, which is exactly the shape the bare `\(` heuristic below cannot tell
 * apart from a real call. Comments legitimately discuss `buildInvokeOnce(...)` —
 * the sibling guard (check-no-raw-setinterval.mjs) already strips comments for
 * the identical reason; this guard should have from the start.
 */
// Implementation moved to ./lib/strip-comments-and-strings.mjs — ONE shared stripper
// (EI-19991116787260658). It also strips STRING LITERALS, which the local copy did not:
// `buildInvokeOnce(` quoted in prose inside a string read as a real call site.

/**
 * The ONE identifier every bypass must contain. Hoisted so the cheap raw-text
 * pre-filter below and the real detector below that cannot drift apart.
 */
const BYPASS_TOKEN = 'buildInvokeOnce';

/**
 * CALLER-SIDE PRE-FILTER — why this exists, and why it is SOUND rather than a heuristic.
 *
 * `stripCommentsAndStrings` became an AST parse (EI-20064929206355679, correctly — it
 * removed a regex-literal blind spot). That cost ~0.12ms/file -> ~2.65ms/file, and this
 * guard parses the WHOLE tracked tree, so it went to ~11.8-12.1s (measured 2026-08-10,
 * 3 runs). That matters here specifically: this guard is now registered in
 * REPO_WIDE_INVARIANT_GUARDS, so a 12s scan would be charged to every agent's
 * `test:affected` run touching any .ts file, fleet-wide.
 *
 * The pre-filter is the option-1 remedy prescribed by EI-20068047132832988 and already
 * the pattern at check-green-checkpoint-tag.mjs:101. It CANNOT produce a false negative:
 * stripping only ever BLANKS text, so a stripped hit implies the raw text contained the
 * token. Skipping files whose RAW text lacks it therefore removes only files the
 * detector could never have flagged — the skip is provably result-preserving, not a
 * sampling trade-off. Equivalence was also verified empirically over the real tree:
 * identical offender sets across 5,855 scanned files, of which only 16 (0.27%) bear
 * the token and so still reach the parse. Measured effect: ~11.8s -> ~0.95s.
 *
 * ⚠ If a SECOND detection token is ever added, it must join `BYPASS_TOKEN` here or the
 * pre-filter silently becomes unsound — that is the one way this optimisation can rot.
 */

/**
 * The tell of an agent-CLI spawn bypass: a CALL to `buildInvokeOnce(...)` outside
 * the allowlist. Building the invoke-once command is the chokepoint's exclusive
 * right — every other caller must go through `spawnInvokeOnce`. Keying on the
 * *call* (not "build + raw-spawn in the same file") is what makes this robust to
 * the CROSS-file shape: build the command in file A and hand it to a spawner in
 * file B (the scoper bypass — `harness-scoper.ts` → the old `governed-background-
 * spawn.ts` — that the original same-file `&&` rule silently missed; D-013
 * residual 2). The `(` distinguishes a real call from a bare mention in a comment
 * (e.g. "uses buildInvokeOnce + raw spawn"); the file that DEFINES it
 * (`function buildInvokeOnce(`) is allowlisted, so it never reaches here. Comments
 * are stripped first (see `stripComments`) so a parenthetical prose aside can't
 * masquerade as a call. Pure (text → boolean) so it's unit-testable.
 */
export function isRawAgentSpawnBypass(text, fileName) {
  if (!text.includes(BYPASS_TOKEN)) return false;
  return /\bbuildInvokeOnce\s*\(/.test(stripCommentsAndStrings(text, fileName));
}

/**
 * Scan the tracked tree for bypass offenders (excludes allowlist + _retired + tests).
 *
 * WI-6666: enumerates via the shared `listTrackedFiles` helper, which recurses into
 * submodules. A bare `git ls-files` does NOT — it emits one gitlink entry per
 * submodule — so this guard previously printed a clean verdict having never opened
 * libs/generic/**, libs/papercusp/**, or papercusp-desktop/**. Returns the coverage
 * report alongside the offenders so `main` can state what it could not check.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (ALLOWLIST.has(f) || isExcluded(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (isRawAgentSpawnBypass(text, f)) offenders.push(f);
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    console.log(
      '✓ no new raw agent-CLI spawns — every agent spawn goes through spawnInvokeOnce (the chokepoint).' +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ NEW raw agent-CLI spawn(s) bypassing the spawnInvokeOnce chokepoint:');
  console.error('  Call `spawnInvokeOnce(projectDir, role, extras, extraEnv)` instead of');
  console.error('  `buildInvokeOnce(...)` + `child_process.spawn(...)` — the chokepoint applies admission');
  console.error('  + governor pacing + (class-gated) durability uniformly.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} bypass(es). See plan unify-agent-spawn-chokepoint-2026-06-06 (P-008 / D-001).`);
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit test)
// must NOT exec git / exit the process. Symlink-robust (WI-1443): node realpaths
// import.meta.url while argv[1] keeps the invoked path, so also compare realpaths.
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
