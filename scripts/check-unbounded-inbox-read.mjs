#!/usr/bin/env node
/**
 * check-unbounded-inbox-read.mjs — fail-loud guard against a NEW `readInbox`/
 * `readOutbox` call site that carries no stopping rule (EI-19325897270823423).
 *
 * WHY THIS IS A BUILD GUARD AND NOT JUST A CODE REVIEW NOTE. `readInbox` /
 * `readOutbox` are the dominant `coord_event_log` callers — fired on every agent
 * turn (orient, coord:inbox, inbox-wake, loop checkpoints, scout cycles, mug
 * briefs, …), so their per-call cost is MULTIPLIED by live fleet size. Both now
 * carry a hard-backstop row cap (`INBOX_FAST_PATH_ROW_CAP` /
 * `OUTBOX_FAST_PATH_ROW_CAP`, packages/operator-core/lib/agent-tools/coordination/
 * messages.ts) so no call can be truly unbounded at the SQL level — but a call
 * that supplies neither a `since_ts` bound nor a `window` stopping rule still
 * falls through to that generous cap (25k rows), transferred + JSON-parsed on the
 * operator's single event loop, every time. That is precisely what
 * EI-19323414462286091 / EI-19325897270823423 measured as the #1 per-agent-turn
 * DB-load driver (~35% of live DB time) before `operator-hindsight.ts` was
 * converted to a targeted SQL predicate (migration 736).
 *
 * The existing readInbox/readOutbox unit tests cover the BEHAVIOUR of the
 * bounded-read machinery (`since_ts`, `window`) thoroughly. What they cannot
 * cover is a NEW call site that never reaches for either — a behaviour test
 * cannot observe code that doesn't call it. That gap is exactly how this class
 * of bug recurs, so it is closed here at build time (the architectural guard
 * EI-19325897270823423 asks for, generalized from its own root cause).
 *
 *   node scripts/check-unbounded-inbox-read.mjs
 *
 * THE TELL — a call to `readInbox(` or `readOutbox(` (never their `*Window`
 * siblings, which are the bounded primitive itself) that supplies neither:
 *   (a) a THIRD argument (the `window`/`enough` stopping rule), nor
 *   (b) a `since_ts` key inside its second (`opts`) argument.
 * Either is a real bound: `since_ts` lets the PG fast path push a selective
 * `ts >=` predicate; `window` pages via `readInboxWindow`/`readOutboxWindow`
 * until the caller's `enough()` is satisfied. A call with neither relies solely
 * on the generic 25k-row cap — fine for a one-shot/admin path, a per-turn
 * multiplier surface for anything else.
 *
 * ALLOWLIST: the coordination/messages.ts definition file itself (it legitimately
 * calls the unbounded form as the documented fallback inside `readInboxWindow` /
 * `readOutboxWindow` — on a non-PG seam or a query error, both already pass the
 * caller's own `opts` through unchanged, so any bound the caller supplied is
 * preserved); and `operator-hindsight.ts`, whose two unbounded calls are the
 * PG-fast-path-unavailable / query-error fallback branches of
 * `readHindsightNotifyEnvelopes` — documented in detail in that file (the block
 * comment above the function cites EI-19325897270823423 by name), never the
 * production hot path (which now pushes `notify_kind` into SQL directly).
 *
 * BASELINE: EMPTY. Verified 2026-08-02 across every tracked call site outside the
 * two allowlisted files: all pass either `since_ts` or a `window`/`enough` third
 * argument. A hit anywhere else is a genuine new unbounded call, not grandfathered
 * debt.
 *
 * The predicate (`isUnboundedInboxCall`) is exported + unit-tested
 * (packages/operator-core/lib/agent-tools/coordination/unbounded-inbox-read-guard.test.ts)
 * so "fails on a NEW unbounded call" is a durably verified property, not merely
 * green-on-a-clean-tree.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Permanently-allowed files — see the header comment for why each is exempt.
 * Both are the DEFINITION / documented-fallback sites, never a fresh per-turn
 * hot path; a new call site elsewhere should pass `since_ts`/`window`, not be
 * added here.
 */
export const ALLOWLIST = new Set([
  'packages/operator-core/lib/agent-tools/coordination/messages.ts',
  'packages/operator-core/lib/operator-hindsight.ts',
]);

/** Grandfathered offenders. EMPTY on purpose — see BASELINE note above. */
export const BASELINE = new Set([]);

/** Vendored / generated / non-source / test files are never scanned. */
export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  f.includes('/env-sidecars/') ||
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.(ts|tsx|mjs|cjs)$/.test(f);

/** Strip block + line comments so prose mentioning readInbox isn't flagged. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * From `text`, starting at the `(` index `openIdx`, return the substring between
 * the matching balanced parens (exclusive of the outer parens), respecting
 * nested (), {}, [] and both quote styles / template literals. Returns null if
 * unbalanced (never expected in valid TS, but fail-safe rather than throw).
 */
function matchBalancedParens(text, openIdx) {
  let depth = 0;
  let inString = null; // one of `'`, `"`, `` ` `` while inside a string/template
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inString = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Split an argument-list string on TOP-LEVEL commas only (depth 0 across
 * (), {}, [] and strings/templates) — so `{ since_ts: x, foo: y }` counts as
 * ONE argument, not two.
 */
function splitTopLevelArgs(argText) {
  const args = [];
  let depth = 0;
  let inString = null;
  let start = 0;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inString = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(argText.slice(start, i));
      start = i + 1;
    }
  }
  const last = argText.slice(start);
  if (last.trim().length > 0) args.push(last);
  return args;
}

/** Match a `readInbox(` / `readOutbox(` CALL — never the `*Window` siblings
 *  (those are the bounded primitive) and never a function declaration. */
const CALL_RE = /\breadInbox\s*\(|\breadOutbox\s*\(/g;
const DECL_RE = /\bfunction\s+(readInbox|readOutbox)\s*\(/;

/**
 * Does `text` contain a `readInbox(...)` / `readOutbox(...)` call that supplies
 * neither a `since_ts` bound nor a third (window/enough) argument? Pure
 * (text → boolean) so it is unit-testable in isolation.
 */
export function isUnboundedInboxCall(text) {
  const t = stripComments(text);
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(t))) {
    const openIdx = m.index + m[0].length - 1; // index of the '('
    // Skip the function DECLARATION itself (its params aren't a call).
    const precedingLine = t.slice(Math.max(0, m.index - 12), m.index + m[0].length);
    if (DECL_RE.test(precedingLine)) continue;
    const argText = matchBalancedParens(t, openIdx);
    if (argText === null) continue; // unbalanced — don't flag what we can't parse
    const args = splitTopLevelArgs(argText);
    if (args.length >= 3) continue; // window/enough argument supplied — bounded
    const optsArg = args[1] ?? '';
    if (/since_ts/.test(optsArg)) continue; // since_ts bound supplied
    return true;
  }
  return false;
}

/**
 * Scan the tracked tree for offenders. Enumerates via `listTrackedFiles`, which
 * recurses into submodules (a bare `git ls-files` would emit one gitlink entry
 * per submodule and silently report ✓ for all of them — WI-6730).
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (ALLOWLIST.has(f) || BASELINE.has(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (isUnboundedInboxCall(text)) offenders.push(f);
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    console.log(
      '✓ no unbounded readInbox/readOutbox call site (every call passes since_ts or a window).' +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ unbounded readInbox/readOutbox call site(s):');
  console.error('  readInbox/readOutbox fire on every agent turn — their cost multiplies with fleet');
  console.error('  size. A call with neither a bound relies solely on the generic 25k-row cap. Add:');
  console.error('    { since_ts: <iso> }                      — a selective PG-pushed-down lower bound, or');
  console.error('    readInbox(owner, opts, { enough: (rows) => … })  — a paged window that stops early');
  console.error('  See packages/operator-core/lib/operator-hindsight.ts (lines above readHindsightNotifyEnvelopes)');
  console.error('  for a worked example of converting a hot unbounded call to a targeted SQL predicate.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See work-item EI-19325897270823423.`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
