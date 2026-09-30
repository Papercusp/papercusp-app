#!/usr/bin/env node
/**
 * check-constant-conditional.mjs — fail on a COMMITTED constant-forced `if`
 * (EI-19446174755157221).
 *
 * On 2026-08-03 `packages/operator-core/lib/harness/routines/stalled-loops-guard.ts:273`
 * was committed as `if (false && wall && wall.resumesInMs != null && …)`. An agent
 * had flipped the branch off for ~90 seconds to prove a new exemption had teeth,
 * and git-sync's whole-tree sweep committed the experiment mid-flight. Two costs,
 * and the second is the one nothing else would have surfaced:
 *
 *   1. A leading literal `false` suppresses the narrowing the later `&&` operands
 *      perform, so every `wall` dereference inside the (provably unreachable)
 *      block became "possibly null" — 7 fresh TS18047 errors on a file whose
 *      baseline was 0, i.e. a committed standing red for the entire fleet.
 *   2. It silently reverted a load-bearing behaviour: that veto is what stops
 *      `stalled-loops-guard` disarming a loop that is merely backed off behind a
 *      provider wall, which would turn a self-healing backoff into a permanent
 *      disarm. Nothing in the tree indicated the behaviour had changed.
 *
 * The PRIMARY firing point for this class is the git-sync content guard
 * (packages/operator-core/lib/content-lint/registry.ts → constantConditionalDetector),
 * which quarantines the file BEFORE it reaches `staging` — the only point that can
 * actually help, since the author's own lesson generalises past the typo: *on an
 * auto-committing tree there is no safe temporary source mutation*. This CI script
 * is the tree-wide sweep for anything already committed, and shares the one pure
 * detector with the guard (D-003) so the two can never disagree.
 *
 *   node scripts/check-constant-conditional.mjs   # via tsx — see package.json lint:constant-conditional
 *
 * SCOPE is deliberately narrow (see constant-conditional.ts): `IfStatement` only,
 * so `while (true)` / `for (;;)` are never inspected; only a literal `true`/`false`
 * TOKEN, so a named gate (`if (ENABLED && …)`) — the recommended way to disable a
 * branch — stays clean. AST-based, so `false` inside a comment or string literal
 * can never false-fire, and no file (including this one and the detector's own
 * tests, which quote the pattern in prose and in strings) needs allowlisting.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// D-003 (git-sync-content-guard): the pure detector lives in ONE importable module
// shared with the git-sync content guard, so the commit-path check and this
// tree-wide check are the same code. Run via `tsx` so this .mjs can import the TS.
import { findConstantConditional } from '../packages/operator-core/lib/content-lint/constant-conditional';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors registry.ts `isExcludedPath` so the guard and this script share scope (D-003).
const isExcluded = (f) =>
  f.startsWith('_retired/') || f.includes('/_retired/') || f.includes('/node_modules/') || f.includes('/dist/');

function main() {
  // Enumerate via the shared helper, which recurses into submodules — a bare
  // `git ls-files` emits one gitlink per submodule and would silently scan none
  // of the .ts/.tsx inside them while still printing ✓ (WI-6730).
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  let scanned = 0;
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!/\.(ts|tsx)$/.test(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    // Sound fast path: a file containing no boolean literal at all cannot contain
    // a constant-forced condition. Deliberately loose — it must never skip a file
    // the AST would flag, so it does NOT try to match the `if (` shape (a comment
    // or newline between `if (` and the literal would defeat that).
    if (!/\b(true|false)\b/.test(text)) continue;
    scanned++;
    const hit = findConstantConditional(f, text);
    if (hit) {
      const forced = hit.operator ? `${hit.constant} ${hit.operator} …` : hit.constant;
      offenders.push(`${f}:${hit.line}:${hit.col}  if (${forced})   ${hit.text}`);
    }
  }

  if (offenders.length === 0) {
    console.log(
      `✓ no constant-forced \`if\` in .ts/.tsx (${scanned} file(s) parsed).${describeUnscanned(unscanned)}`,
    );
    process.exit(0);
  }

  console.error('✗ constant-forced `if` condition(s) committed to the tree —');
  console.error('  `if (false && …)` can never run; `if (true || …)` ignores its real condition.');
  console.error('  These are almost always a temporary local disable that git-sync swept into a');
  console.error('  commit. A LEADING literal also suppresses `&&` narrowing, so it turns a clean');
  console.error('  file into a committed tsc red (EI-19446174755157221: 0 → 7 TS18047).\n');
  console.error('  Delete the branch if it is dead, or gate it on a NAMED constant/flag if it is');
  console.error('  temporary — a named gate is greppable and survives a sweep honestly.');
  console.error('  Running a DIFFERENTIAL ("does this still misbehave with the guard off?")? The');
  console.error('  source edit is avoidable: lift the logic into a pure function and drive both');
  console.error('  arms from a test — the only version of that experiment a sweep cannot commit');
  console.error('  half-finished.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s).`);
  process.exit(1);
}

// Run only as the entry point — importing for reuse has no side effects.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
