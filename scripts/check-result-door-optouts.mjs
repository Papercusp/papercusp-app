#!/usr/bin/env node
/**
 * lint:no-new-result-door-optout — the result door is the universal model-facing
 * choke point, and opting a tool OUT of it must stay a reviewed, bounded decision.
 *
 * ## Why this guard exists
 *
 * `result-door.ts` projects every oversized tool response STRUCTURALLY: it walks
 * the value, collapses the largest fields with cap-and-metadata, and writes a
 * durable spill so the caller always gets schema-valid JSON plus a cursor. That
 * landed under WI-38402 / EI-20244970883634313 / EI-20435986111760474 and it is
 * what stops a large response from being sliced mid-token.
 *
 * A tool that declares `skipResultDoor` opts OUT of all of it. That is sometimes
 * exactly right — see the two reasons below — but it is a hole in a universal
 * property, and a universal property is only worth anything while it is actually
 * universal. Nothing before this guard stopped a twelfth opt-out being added in a
 * routine PR, and nothing made the existing population reviewable, so the honest
 * description of the invariant was "structural, except wherever someone needed it
 * not to be, which is not written down anywhere".
 *
 * EI-20244970883634313 asked for exactly two things: the depth-first budget-aware
 * collapser, AND a mandatory lint on the opt-out path. Only the collapser shipped.
 * This is the other half.
 *
 * ## What it detects
 *
 * An ASSIGNMENT of a reason to `skipResultDoor` — `skipResultDoor: 'reason'` — in
 * non-test source. That is the shape that actually opts a tool out.
 *
 * ⚠ Match the ASSIGNMENT, never the mention. A bare `grep -rn skipResultDoor`
 * over this tree returns ~40 lines, but most are the type declaration in
 * `libs/generic/tooldef/src/types.ts`, its generated `dist/` copy, the
 * `_mcp-handler.ts` / `store-identity-suspect.ts` consumers, and prose. Only 11
 * are real opt-outs. Seeding a baseline from the mention count would make it ~4x
 * too large, and a baseline larger than the population is a guard that can never
 * fire — it would sit in the tree looking like enforcement while permitting every
 * new opt-out silently. That failure is invisible in exactly the way this whole
 * class of bug is: the script exits 0 and nobody re-derives the number.
 *
 * ## What it deliberately does NOT flag
 *
 *  - The `skipResultDoor?: ResultDoorSkipReason` TYPE declarations — a type
 *    annotation is not an opt-out, and it is matched by neither half of the
 *    predicate (no string literal follows the colon).
 *  - The consumers that READ the field to decide whether to run the door.
 *  - Test files, which legitimately construct tool definitions with the field set
 *    in order to exercise both branches (mcp-handler-gating-matrix.test.ts holds
 *    3 such fixtures).
 *  - Generated `dist/` output.
 *
 * ## Comments are stripped, and that is load-bearing here
 *
 * `stripCommentsOnly`, never `stripCommentsAndStrings`: the REASON is a string
 * literal, so masking strings would delete the very thing being detected and turn
 * this guard into a silent pass. Stripping comments is not optional either —
 * `orient-core-result-door-priority.test.ts:102` already documents the banned
 * shape in prose (`it declares \`skipResultDoor: 'oversize-by-design'\``), and this
 * file's own header does the same. A guard that flags its own documentation is a
 * rule reddening its own gate; the model for this script hit exactly that
 * (WI-37717). The mask is length-preserving, so line numbers stay correct.
 *
 * ## The baseline
 *
 * BASELINE is the population measured when this guard landed, and it is
 * SHRINK-ONLY: removing an opt-out removes its entry. Do not add to it. A new
 * opt-out re-opens the hole, so it needs a deliberate decision recorded with it —
 * not a line appended to a list.
 *
 * ⚠ Re-seed it ONLY from `--list`, never from a hand-run grep. That is the same
 * rule the module-pin guard carries, for the same reason: a hand-run grep is a
 * different measurement from the one the guard performs, so seeding from it can
 * encode sites the guard cannot see (permitting real debt) or sites that do not
 * exist (masking a regression).
 *
 * ## Usage
 *
 *   node scripts/check-result-door-optouts.mjs          # gate: exit 0 clean / 1 on a NEW opt-out
 *   node scripts/check-result-door-optouts.mjs --list   # print the measured population + baseline seed
 *   node scripts/check-result-door-optouts.mjs --json   # machine-readable population
 *
 * `RESULT_DOOR_SCAN_ROOT` overrides the scanned root. It exists so falsifiability
 * can be proven against a COPY outside the repo (mutation-probe tier 2) instead of
 * by mutating this shared tree, which git-sync would sweep into a commit mid-probe.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = (
  process.env.RESULT_DOOR_SCAN_ROOT || new URL('..', import.meta.url).pathname
).replace(/\/$/, '');
const ROOTS = ['packages', 'libs', 'apps'];

/** Directories never worth walking. */
const SKIP_DIR = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  'coverage',
  '__snapshots__',
  'target',
]);

/**
 * Tools that opt OUT of the result door, measured when this guard landed.
 * SHRINK-ONLY — see the header. Re-seed only from `--list`.
 *
 * Each entry is a repo-relative path. Two reasons are in use, both legitimate:
 *   'oversize-by-design'  — the response IS the payload; a caller asked for bulk
 *                           and truncating it would defeat the call.
 *   'programmatic-caller' — the near-exclusive consumer is code, not a model
 *                           context, so the door's model-facing budget is the
 *                           wrong constraint.
 */
const BASELINE = new Set([
  'packages/operator-core/lib/agent-tools/activity/report.ts',
  'packages/operator-core/lib/agent-tools/coordination/tools/inbox.ts',
  'packages/operator-core/lib/agent-tools/coordination/tools/orient.ts',
  'packages/operator-core/lib/agent-tools/dev/pg_query.ts',
  'packages/operator-core/lib/agent-tools/dev/service_health.ts',
  'packages/operator-core/lib/agent-tools/fleet/assignments.ts',
  'packages/operator-core/lib/agent-tools/fleet_registry/status.ts',
  'packages/operator-core/lib/agent-tools/locks/queue.ts',
  'packages/operator-core/lib/agent-tools/loop/status.ts',
  'packages/operator-core/lib/agent-tools/rubrics/get.ts',
  'packages/operator-core/lib/agent-tools/scheduler/running.ts',
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.(test|spec)\.[cm]?tsx?$/.test(name)) {
      yield full;
    }
  }
}

/**
 * Find result-door opt-outs in one file's source.
 *
 * Exported so the guard test can drive it with synthetic sources — including
 * permanent negative controls — and prove falsifiability without mutating the
 * shared tree (see the header's note on RESULT_DOOR_SCAN_ROOT).
 *
 * @param {string} src source text
 * @param {string} fileName for the comment stripper's diagnostics
 * @returns {Array<{ line: number, reason: string }>}
 */
export function findOptOuts(src, fileName = 'tool.ts') {
  const hits = [];
  // Comments only — the reason is a string literal, so masking strings would
  // delete the subject. See the header.
  const masked = stripCommentsOnly(src, fileName);
  if (!masked.includes('skipResultDoor')) return hits;

  for (const m of masked.matchAll(/skipResultDoor\s*:\s*(['"])([^'"]+)\1/g)) {
    const line = masked.slice(0, m.index).split('\n').length;
    hits.push({ line, reason: m[2] });
  }
  return hits;
}

/**
 * Scan the whole tree and classify against BASELINE.
 *
 * Exported so the guard test can assert REPO-WIDE that there are no new opt-outs
 * by driving this exact scanner, rather than re-deriving a copy of the walk that
 * would drift from it.
 */
export function scanTree() {
  /** @type {Array<{ rel: string, line: number, reason: string }>} */
  const every = [];
  for (const top of ROOTS) {
    for (const file of walk(join(ROOT, top))) {
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(ROOT, file);
      for (const hit of findOptOuts(src, rel)) every.push({ rel, ...hit });
    }
  }

  const seen = new Set(every.map((h) => h.rel));
  const violations = every.filter((h) => !BASELINE.has(h.rel));
  const stale = [...BASELINE].filter((f) => !seen.has(f)).sort();
  return { every, seen, violations, stale };
}

function main() {
  const argv = process.argv.slice(2);
  const { every, seen, violations, stale } = scanTree();

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ population: every, baselineSize: BASELINE.size, violations, stale }, null, 2));
    // The JSON dump is unbounded and gets piped: a process.exit() right after console.log can
    // truncate it mid-write (check-undrained-stdout-exit). Set the code and let the loop drain.
    process.exitCode = violations.length > 0 ? 1 : 0;
    return;
  }

  if (argv.includes('--list')) {
    every.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
    console.log(`${every.length} result-door opt-out(s) across ${seen.size} file(s):\n`);
    for (const h of every) console.log(`  ${h.rel}:${h.line}  ${h.reason}`);
    const byReason = new Map();
    for (const h of every) byReason.set(h.reason, (byReason.get(h.reason) ?? 0) + 1);
    console.log(
      `\n  (${[...byReason].map(([r, n]) => `${n} ${r}`).join(', ')})`,
    );
    console.log('\nBASELINE seed (paste into this script):\n');
    for (const f of [...seen].sort()) console.log(`  '${f}',`);
    process.exit(0);
  }

  if (violations.length > 0) {
    console.error('\n✖ lint:no-new-result-door-optout — new result-door opt-out(s):\n');
    for (const v of violations) console.error(`  ${v.rel}:${v.line}  ${v.reason}`);
    console.error(`
A tool declaring skipResultDoor opts OUT of structural projection entirely: an
oversized response is returned whole, with no collapse, no spill and no cursor.
That is a hole in a UNIVERSAL property, so it needs a decision, not a new line in
a list.

Before adding one, check the cheaper answers first — each removes the pressure
that makes an opt-out look necessary:

  * bound the result AT THE SOURCE (a limit / filter / since argument), or
  * shape it with \`projection: { pick: [...] }\` at the call site, or
  * give the tool a narrower default payload tier.

If the opt-out is genuinely right, say WHY in the same change:
  'oversize-by-design'  the response IS the payload and truncating it defeats the call
  'programmatic-caller' the near-exclusive consumer is code, not a model context

Then add the path to BASELINE in scripts/check-result-door-optouts.mjs, re-seeded
from \`node scripts/check-result-door-optouts.mjs --list\` — never a hand-run grep.

Background: EI-20244970883634313 (this guard is that item's second half).
`);
    process.exit(1);
  }

  if (stale.length > 0) {
    console.log('✔ lint:no-new-result-door-optout — no new opt-outs.');
    console.log(
      `\n  ${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} no longer match — ` +
        'the opt-out was removed or the file moved. Drop it from BASELINE in ' +
        'scripts/check-result-door-optouts.mjs (the list is shrink-only, so a stale ' +
        'entry silently permits a future opt-out at that path):',
    );
    for (const f of stale) console.log(`    ${f}`);
    process.exit(0);
  }

  console.log(
    `✔ lint:no-new-result-door-optout — no new opt-outs ` +
      `(${seen.size} known site${seen.size === 1 ? '' : 's'}, ${every.length} declaration${every.length === 1 ? '' : 's'}).`,
  );
}

if (isCliEntry(import.meta.url)) main();
