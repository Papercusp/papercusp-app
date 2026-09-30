#!/usr/bin/env node
/**
 * check-sql-comment-backtick.mjs — flag a markdown-style backtick-quoted
 * identifier inside a `--` SQL comment, which ENDS the enclosing template
 * literal (EI-7661, widened EI-19317789732905891, re-homed EI-19415157731625374).
 *
 * ⚠ This script is now a THIN SHIM. The detection logic lives in ONE importable
 * place — `packages/operator-core/lib/content-lint/sql-comment-backtick.ts` —
 * which is the same predicate the git-sync content guard runs on the COMMIT path
 * (registry.ts, `sql-comment-backtick`, ordered before `ts-parse`) and the same
 * one the unit suite covers. Do not reimplement the heuristic here: two sources
 * of truth for "is this file broken" is exactly what D-003 exists to prevent.
 *
 * Run via `tsx` (package.json `lint:no-sql-comment-backtick`) so this .mjs can
 * import the TypeScript detector directly — same arrangement as
 * check-smart-quotes.mjs.
 *
 * WHY THE SHIM STILL EXISTS, given the guard now runs on the commit path: the
 * guard only ever inspects the handful of files DIRTY on a given tick, so it
 * cannot see a pre-existing offender that is already committed. This gives the
 * tree-wide sweep. The two are complementary, not redundant.
 *
 * HISTORY worth keeping: for its whole life before this rewrite, nothing invoked
 * this script — no gate, no hook, no test, only its own package.json entry. It
 * was therefore RED, undetected, on a FALSE POSITIVE in
 * `content-lint/registry.ts` (a file containing no SQL at all — it was pulled
 * into scope because a doc comment mentions the word sql in backticks, then
 * flagged on a line whose only backtick legitimately closed a template). Both
 * mechanisms are fixed in the shared predicate. A guard on no blocking path does
 * not merely fail to catch things; it rots, and its rot is invisible.
 *
 *   npm run lint:no-sql-comment-backtick
 *
 * Fix a hit by rephrasing the comment without backticks — straight quotes read
 * just as well: a comment saying the 'closed_ts' column, not a backtick-quoted one.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// D-003 (git-sync-content-guard): the pure detector lives in ONE importable
// module, shared by this script, the git-sync content guard, and the unit suite,
// so the three can never disagree about what "broken" means.
import {
  findSqlCommentBacktick,
  sqlCommentBacktickScopeMatches,
} from '../packages/operator-core/lib/content-lint/sql-comment-backtick';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

function main() {
  // WI-6730: enumerate via the shared helper, which recurses into submodules. A
  // bare `git ls-files` does not — it emits one gitlink entry per submodule — so
  // this guard never scanned a single file inside any of them and printed ✓
  // regardless. `unscanned` is reported on success rather than silently dropped.
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (!sqlCommentBacktickScopeMatches(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    const hit = findSqlCommentBacktick(f, text);
    if (hit) offenders.push(`${f}:${hit.line}:${hit.col}  ${hit.text}`);
  }

  if (offenders.length === 0) {
    console.log(
      `✓ no backtick-quoted identifier inside a SQL comment (EI-7661).${describeUnscanned(unscanned)}`,
    );
    process.exit(0);
  }

  console.error('✗ backtick-quoted identifier inside a SQL comment — ends the enclosing template literal (EI-7661):');
  console.error('  Inside a postgres-js tagged template the trailing text can still parse as valid TS, so the');
  console.error('  file compiles and RUNS with the query truncated mid-comment (a WHERE clause vanishing is');
  console.error('  exactly how the mig-504 LWW apply-guard silently regressed on 2026-07-05). In a plain DDL');
  console.error("  template it is a TS1005 cascade anchored tens of lines from the cause.\n");
  console.error("  Fix: rephrase without backticks — use straight quotes, e.g. the 'closed_ts' column.\n");
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s).`);
  process.exit(1);
}

// Run only as the entry point — importing for reuse has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
