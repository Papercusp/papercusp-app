#!/usr/bin/env node
/**
 * check-no-module-scope-flag-subscribe.mjs — fail-loud guard against a NEW
 * MODULE-SCOPE touch of a `@papercusp/flags` named export (WI-6650, residual of
 * EI-18825928993608425).
 *
 * The landmine: a test file that narrowly factory-mocks the flags surface for its
 * OWN assertions — `vi.mock('@papercusp/flags/server', () => ({ getFlag }))`, or
 * `vi.mock('@papercusp/flags', () => ({ FLAGS }))` — can be reached, via an
 * arbitrarily long transitive import chain, by a module that touches
 * `onFlagChange` / `FLAG_DEFAULTS` at the TOP LEVEL. Vitest's mock proxy throws on
 * the missing export:
 *
 *   Error: [vitest] No "onFlagChange" export is defined on the
 *          "@papercusp/flags/server" mock.
 *
 * That throw lands at COLLECTION time, so it fails the WHOLE test file (zero tests
 * run) — and the error names the MOCK, not the importer, so it reads as unrelated
 * to whoever's change actually grew the import edge. It reds the fleet's green
 * gate, not one suite.
 *
 * This is the same class as `lint:no-eager-execfile-promisify` (EI-10161), with
 * the flags surface in place of node:child_process.
 *
 * CONFIRMED LIVE TWICE, both on the same file
 * (packages/operator-core/lib/agent-tools/coordination/log.ts):
 *   - WI-6449  — `onFlagChange` at module scope, via scheduler/idle-loop-recipe-pin.
 *   - WI-6588  — a `FLAG_DEFAULTS` deref added at module scope; 2 suites went red at
 *                collection (scout/cycle-deps, scheduler/idle-loop-recipe-pin).
 * That file was root-fixed under EI-18825928993608425 and is NOT in the BASELINE.
 *
 * FIX: give the module ZERO flag side effects at load — move the subscribe + any
 * defaults deref into an idempotent init reached on FIRST USE, exactly as
 * coordination/log.ts now does (see its `ensureCoordFlagInit()`):
 *
 *   let inited = false;
 *   let cached;
 *   function ensureFlagInit() {
 *     if (inited) return;
 *     inited = true;                       // set FIRST — terminates re-entrancy
 *     cached ??= DEFAULT_FOR(FLAGS.X);     // see the ??= warning below
 *     onFlagChange((key) => { if (key === null || key === FLAGS.X) refresh(); });
 *   }
 *
 * ⚠ SEED A LAZY CACHE WITH `??=`, NEVER `=`. Several of these modules export their
 * own `refreshX()` which tests (and real callers) invoke BEFORE the first read that
 * triggers init — a plain assign in the later init clobbers the resolved value back
 * to the default. That exact bug red coordination/log.test.ts's "flag OFF" case and
 * was caught only because a test pinned both flag directions.
 *
 * Detection is deliberately narrow — a column-0 (module-scope) occurrence, since a
 * call inside a function/block is always indented in this codebase's style:
 *   1. `onFlagChange(` / `void onFlagChange(` starting at column 0.
 *   2. `const`/`let` at column 0 whose RHS EAGERLY derefs `FLAG_DEFAULTS[...]`.
 *      The lazy form `const X = (): boolean => FLAG_DEFAULTS[FLAGS.Y]` is CORRECT
 *      (the deref happens on call) and is deliberately NOT flagged.
 *
 *   node scripts/check-no-module-scope-flag-subscribe.mjs
 *
 * BASELINE (TEMPORARY — must shrink to EMPTY): the 14 pre-existing subscribers this
 * guard was seeded with (WI-6650). They were left alone deliberately — their import
 * graphs are far narrower than the coord graph's, and rewriting 14 load-bearing
 * modules at once carries more regression risk than the latent trap does. NEW files
 * may NOT be added here — a fresh module-scope flag touch is a hard guard failure,
 * not a BASELINE addition. Removing one (lazy-wrap it, per the pattern above)
 * shrinks the set.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings, stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/dist-sidecar/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/spa/assets/') ||
  f.includes('/env-sidecars/') ||
  /\.(test|spec)\.[cm]?[tj]sx?$/.test(f) ||
  !/\.(ts|mjs|cjs)$/.test(f);

// Comment + string-literal stripping lives in ./lib/strip-comments-and-strings.mjs — ONE
// shared implementation (EI-19991116787260658). The local comments-only copy left string
// literals intact, so `onFlagChange(` quoted in prose read as a module-scope subscription.

/**
 * The tell: a column-0 (module-scope) `onFlagChange(...)` subscription, or a
 * column-0 `const`/`let` that EAGERLY derefs `FLAG_DEFAULTS[...]`. Both crash a
 * partial-mock importer at collection time; a lazy (function-body / arrow-RHS)
 * form of either is fine and is not flagged.
 */
export function usesModuleScopeFlagSubscribe(text, fileName) {
  const src = stripCommentsAndStrings(text, fileName);
  if (/^(void\s+)?onFlagChange\s*\(/m.test(src)) return true;
  if (/^(export\s+)?(const|let)\s+\w+\s*=\s*FLAG_DEFAULTS\s*\[/m.test(src)) return true;
  return false;
}

/**
 * Files that MENTION `lazyFlagRefresh(` without calling it, so the declaration cross-check must skip
 * them: the module that DEFINES the helper, and THIS guard, whose own matcher holds the literal in a
 * string constant (`stripComments` removes comments, not string literals — the guard reported itself
 * twice on first run).
 */
const LAZY_SELF_REFERENTIAL = new Set([
  'packages/operator-core/lib/lazy-flag-refresh.ts',
  'scripts/check-no-module-scope-flag-subscribe.mjs',
]);

const VALID_KINDS = new Set([
  'gates-an-override-store',
  'seeded-from-flag-default',
  'not-flag-gated',
  'selects-behaviour',
]);

/** Floor on a `safeBecause`, so the required field cannot be satisfied with a token. */
const MIN_JUSTIFICATION_CHARS = 60;

/**
 * Extract the argument text of every `lazyFlagRefresh(...)` INVOCATION in a file.
 *
 * Brace-matched rather than regexed, because every real call spans many lines (the declarations are
 * deliberately prose-heavy). Comments are stripped first, so the helper's own doc-comment example is
 * not scanned as a call site.
 */
export function extractLazyFlagRefreshCalls(text, fileName) {
  // COMMENTS ONLY here, deliberately — NOT stripCommentsAndStrings. The extracted call text is
  // handed to checkUnpopulatedDeclaration, which reads string VALUES out of it
  // (/kind\s*:\s*['"]([a-z-]+)['"]/ and the `keys: [...]` list). Emptying string contents turns
  // every correct `kind: 'seeded-from-flag-default'` into `kind: ''`, so the guard would report
  // "no `unpopulated.kind` declared" against perfectly correct code. Measured, not theorised
  // (EI-19991116787260658). The detector above is the opposite case and DOES strip strings:
  // the A/B split is per CALL SITE, not per guard.
  const src = stripCommentsOnly(text, fileName);
  const needle = 'lazyFlagRefresh(';
  const calls = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(needle, i);
    if (at === -1) break;
    i = at + needle.length;
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, at - 20), at))) continue; // the definition
    let depth = 1;
    let j = i;
    for (; j < src.length && depth > 0; j++) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    calls.push(src.slice(i, j - 1));
  }
  return calls;
}

/**
 * Cross-check ONE call's `unpopulated` declaration against its own arguments (EI-19448574704459898).
 *
 * ⚠ WHAT THIS CANNOT DO, deliberately: decide whether a `selects-behaviour` justification is TRUE.
 * That is a semantic question about what the flag's off-branch points at — the exact judgement that
 * `tsc`, the unit suites and this lint's own importability check are all structurally blind to, and
 * the reason issues-engineer.ts went all-green while being wrong. The declaration exists to FORCE
 * that judgement and make it greppable and reviewable; enforcing consistency is all a source lint
 * can honestly add on top.
 *
 * @returns a problem string, or null when the declaration is self-consistent.
 */
/**
 * Return the source text of a `seed:` property's VALUE, or null when there is no readable one.
 *
 * Handles both shapes a seed is written in — a block body (`seed: () => { on = X; }`) and a concise
 * expression (`seed: () => (on = X)`) — by consuming from just after the colon with bracket-depth
 * tracking and stopping at the first depth-0 comma or the end of the object. That is why this is a
 * scanner rather than a regex: the terminator of a property value is positional, and a regex that
 * stops at the next `,` or `}` cuts a block body in half at its first internal one.
 */
function extractSeedValue(callText) {
  const m = /\bseed\s*:/.exec(callText);
  if (!m) return null;
  let depth = 0;
  const start = m.index + m[0].length;
  for (let i = start; i < callText.length; i++) {
    const c = callText[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      if (depth === 0) return callText.slice(start, i); // closed the enclosing options object
      depth--;
    } else if (c === ',' && depth === 0) return callText.slice(start, i);
  }
  return callText.slice(start) || null;
}

export function checkUnpopulatedDeclaration(callText) {
  const kindM = /kind\s*:\s*['"]([a-z-]+)['"]/.exec(callText);
  if (!kindM) return 'no `unpopulated.kind` declared';
  const kind = kindM[1];
  if (!VALID_KINDS.has(kind)) return `unknown \`unpopulated.kind\` '${kind}'`;

  const keysM = /keys\s*:\s*\[([\s\S]*?)\]/.exec(callText);
  const hasKeys = !!keysM && keysM[1].trim().length > 0;
  if (kind === 'not-flag-gated' && hasKeys) {
    return "kind 'not-flag-gated' contradicts the flag keys passed in the same call";
  }
  if (kind !== 'not-flag-gated' && !hasKeys) {
    return `kind '${kind}' requires at least one flag key (got none)`;
  }

  // A claim to be seeded is checkable: the same call has to actually pass a `seed`.
  if (kind === 'seeded-from-flag-default' && !/\bseed\s*:/.test(callText)) {
    return "kind 'seeded-from-flag-default' but the call passes no `seed`";
  }
  if (kind !== 'seeded-from-flag-default' && /\bseed\s*:/.test(callText)) {
    return `kind '${kind}' passes a \`seed\` — declare 'seeded-from-flag-default' instead`;
  }
  // ...and the seed has to seed from the flag REGISTRY, which is the whole content of the claim.
  // A seed that assigns a LITERAL (`seed: () => { on = true; }`) satisfies every other check here
  // while quietly meaning something different: the kind promises the window serves the flag's
  // DECLARED default, and a literal serves whatever was true on the day it was typed. The two
  // agree exactly until the flag graduates — i.e. it fails silently, later, in a file nobody is
  // looking at, which is the same shape as the stale "DEFAULT OFF" comments that made a
  // default-ON flag read as dark for six weeks. lazy-flag-refresh.ts already tells authors to
  // deref FLAG_DEFAULTS rather than a literal; this is what makes that instruction enforceable.
  //
  // Scoped to the SEED BODY on purpose: a whole-call substring test would be satisfied by the
  // prose in `serves`, which routinely names FLAG_DEFAULTS[...] when explaining what the window
  // serves — so the naive form passes a literal seed sitting beside an honest-sounding comment.
  if (kind === 'seeded-from-flag-default') {
    const seedBody = extractSeedValue(callText);
    if (seedBody === null) return 'kind `seeded-from-flag-default` but the `seed` value is unreadable';
    if (!/\bFLAG_DEFAULTS\s*\[/.test(seedBody)) {
      return "kind 'seeded-from-flag-default' but the `seed` does not read FLAG_DEFAULTS[...] — seed from the registry, not a literal, or the seed drifts when the flag graduates";
    }
  }

  if (kind === 'selects-behaviour') {
    const sbAt = callText.indexOf('safeBecause');
    if (sbAt === -1) return "kind 'selects-behaviour' requires a `safeBecause`";
    const chars = callText
      .slice(sbAt + 'safeBecause'.length)
      .replace(/[^A-Za-z0-9 ]/g, '')
      .trim().length;
    if (chars < MIN_JUSTIFICATION_CHARS) {
      return `kind 'selects-behaviour' needs a substantive \`safeBecause\` (got ~${chars} chars, floor ${MIN_JUSTIFICATION_CHARS})`;
    }
  }
  return null;
}

// BASELINE seeded 2026-07-28 (WI-6650) with 14 files; now 1. Do NOT add new
// entries; each removal (lazy-init the site, per coordination/log.ts's
// ensureCoordFlagInit) shrinks this set.
//
// ⚠⚠ THIS LINT IS HALF-BLIND TO THE FILES IT LISTS — VERIFY THE PROPERTY BEFORE YOU
// DE-LIST, NEVER THIS LINT'S OWN VERDICT. It detects a column-0 `onFlagChange(`. It
// CANNOT see an eager `void refreshX()` whose body reaches `getFlag` — an async body
// runs synchronously to its first await, so that call touches the flags/server binding
// at module scope just as hard, and the file stays unimportable under a partial mock.
// Migrate only the visible half and this guard goes GREEN on a file that is still
// broken — a false green indistinguishable from a real one, made worse by the fact
// that the BASELINE would then positively certify the file as fixed.
// Both files migrated 2026-08-03 had BOTH accesses (work-item-redundancy.ts,
// work-item-claim-lease-wiring.ts), so treat the pair as the expected shape, not an
// oddity. Per-file checklist before de-listing:
//   grep -n '^void \|^onFlagChange(\|^const .* = .*(' <file>   # both module-scope forms
//   then add the file to lib/flags-partial-mock-importable.test.ts, which tests the
//   actual PROPERTY (does this import under an empty mock?) rather than this lint's
//   syntactic proxy for it.
//
// Removed 2026-08-03 (EI-19416650993725684), both migrated to a lazy arm called
// from their own readers: txn-timeouts-config.ts (ensureLiveRefreshArmed) and
// task-manager/enabled.ts (ensureFlagSubscriptionArmed). A stale entry here is
// not cosmetic — it is a standing EXEMPTION, so leaving a fixed file listed would
// silently re-permit the very regression the fix removed. De-list in the SAME
// change as the fix.
// Also removed 2026-08-03 (EI-19416650993725684), migrated onto the shared
// `lazy-flag-refresh.ts` helper: quota-overrides, capability-envelope-overrides,
// telemetry-buffer-config, capability-tier-overrides. Migrating a file means ALSO
// adding it to lib/flags-partial-mock-importable.test.ts, which tests the actual
// mechanism (importability under a partial mock) that this source lint only
// approximates.
// Also removed 2026-08-03 (EI-19416650993725684): work-item-claim-lease-wiring.ts,
// onto the same helper. It had FOUR readers of its cached boolean (the exported
// getter plus three internal `if (!claimLeaseOn)` guards) and no periodic refresh
// timer to bound a missed arm, so every one of the four arms.
// And events/cache-eca-rule.ts, same helper — ONE reader (cacheTagEcaEnabled, the rules
// engine's sync `when` predicate). Note the arm is on the READER, deliberately NOT in
// registerCacheTagEcaRule(): rules.ts calls that registrar at MODULE SCOPE, so arming
// there would touch the flag binding during rules.ts's import and just move the
// unimportability one file over. Safe to lazy-arm because the unpopulated `false` is the
// module's OWN documented fail-CLOSED state (no tag bump), costing at most one skipped
// invalidation per process — a briefly stale cache entry, never a wrong value.
//
// issues-engineer.ts was migrated the same way in that session and REVERTED — then
// re-migrated SEEDED and kept (WI-8887, 2026-08-03). Recorded because the reverted
// verdict is the memorable one: the revert was correct for an UNSEEDED migration (the
// unpopulated `false` resolved issue scope to the near-dead 'default' partition) and is
// void once `seed` puts FLAG_DEFAULTS[ISSUES_PER_WORKSPACE] (true) in front of the first
// reader — which is what every live-writing process resolves anyway. Full reasoning, and
// the read-site check that also had to clear, at the arm site in issues-engineer.ts.
// Landing it also unblocked work-item-redundancy.ts and events/cache-eca-rule.ts for
// flags-partial-mock-importable.test.ts: both reach issues-engineer via work-items.ts, so
// the graph guard had been surfacing the blockers one hop at a time.
//
// Removed 2026-09-05 (WI-6650): lexicon/configure.ts, onto the same helper, SEEDED.
// It is the worked example of this header's own half-blindness warning — it had BOTH
// module-scope forms (`void refreshLexiconPack()` at :43, whose body reaches getFlag,
// and `onFlagChange(` at :44), so migrating only the visible one would have gone green
// on a still-unimportable file with the BASELINE then certifying it fixed.
//   It also had a HIDDEN reader, the shape that kept auth-config-overrides.ts deferred:
// `configureLexicon({ activePackId: () => cachedPackId })` — and `term()` calls
// `host.activePackId()` LIVE on every call, so that closure, not the exported getter,
// is the hot read path. Fixed by pointing the seam at `activeServerPackId` itself, so
// there is exactly ONE arm site and `term()` arms through it.
//   Seeded from FLAG_DEFAULTS[THE_HIVE] (false — THE_HIVE is DARK_FLAGS/'parked'), which
// resolves to the same `classic` literal the cache already initialised with, so the
// pre-refresh window is unchanged. The seed is guarded on a `packIdResolved` flag
// because `refreshLexiconPack` is EXPORTED: an arm occurring after an explicit refresh
// must not reset a resolved value back to the flag default.
//
// Removed 2026-09-29 (WI-6650 residual): auth-config-overrides.ts, onto the same helper,
// SEEDED, forced by a gate red — a new `capability/bash` import edge reached it through
// exec-sandbox.ts and killed collection of ~20 files on frozen candidate 5ec99902. It was
// the deferred entry that used to sit here, and both reasons it was deferred are handled:
// (1) the HIDDEN reader `resolveTestingFullAccess` (installed into agent-mcp's gate-bypass,
// reading the module vars directly) arms along with the three exported getters; (2) the
// PERMISSIVE unpopulated state is closed on hosts by an explicit boot warm,
// `armAuthConfigRefresh()` in apps/operator/bin/host-bootstrap.ts, which restores the
// boot-time subscription the module-scope form gave them. The seed is guarded on
// `resolved`, as in lexicon/configure.ts, because `refreshAuthConfigOverrides` is exported.
export const BASELINE = new Set([
  // ⚠ EXAMINED AND DEFERRED, NOT MISSED — and the reason is NOT the usual one, so do not
  // reach for `seed` here on the strength of it having unblocked issues-engineer. This is
  // not a flag-mirror CACHE at all: the module has no exports and no reader, and exists
  // only to PUSH the flag across a layer boundary into @papercusp/db-org via
  // `setRoutinesPerWorkspaceConflict`. There is therefore no "first use" to arm on, which
  // is the precondition the whole lazy-arm pattern assumes.
  //   The trap is where you'd put the arm. The module header names only the ticker, which
  // invites arming at routinesTickImpl — but the boot import wires the value PROCESS-WIDE,
  // and `upsertRoutine` has many callers outside the tick in that same process
  // (harness/routines/loop.ts — the loop:arm verb — git-sync/git-sync-routine.ts,
  // foreign-git-sync-action.ts, sweep-orphaned-foreign-harnesses-action.ts,
  // foreign-supervision-action.ts, loop-dead-man.ts). A tick-scoped arm leaves every one of
  // them unarmed while LOOKING like a faithful migration.
  //   And it would look green, which is the dangerous part: per upsertRoutine's
  // conflict-target comment in routines-runtime.ts the two branches are currently
  // EQUIVALENT — `(id)` vs `(install_slug, name)`, since id ↔ (install_slug, name) while the
  // global unique still stands — so arming late is behaviourally inert TODAY and every test
  // passes. Phase 2 (drop the global unique, fold workspace_id into the id) is exactly what
  // removes that equivalence, so a naive migration now plants a trap that detonates then.
  //   For whoever does migrate it: FLAG_DEFAULTS[ROUTINES_PER_WORKSPACE] is `true` (measured,
  // not in DARK_FLAGS) while BOTH fallbacks in the seam are `false` (the lib's
  // `let routinesPerWorkspaceConflict = false` and this module's `catch`), so a `seed` from
  // FLAG_DEFAULTS is the right first move — AFTER the arm-site problem above is solved, not
  // instead of solving it.
  'packages/operator-core/lib/harness/routines/configure-per-workspace.ts',
]);

/**
 * Scan the tracked tree for offenders (excludes vendored/tests/non-source + BASELINE).
 *
 * WI-6666: enumerates via the shared `listTrackedFiles` helper, which recurses into
 * submodules. A bare `git ls-files` does NOT — it emits one gitlink entry per
 * submodule — so this guard previously never opened libs/generic/**, libs/papercusp/**,
 * or papercusp-desktop/**. Returns the coverage report so `main` can state what it
 * could not check.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  const declarationProblems = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    // The unpopulated-state cross-check applies to every caller, INCLUDING a BASELINE file (a
    // BASELINE entry exempts a module-scope subscribe, not a malformed declaration).
    if (!LAZY_SELF_REFERENTIAL.has(f) && text.includes('lazyFlagRefresh(')) {
      for (const call of extractLazyFlagRefreshCalls(text, f)) {
        const problem = checkUnpopulatedDeclaration(call);
        if (problem) declarationProblems.push({ file: f, problem });
      }
    }
    if (BASELINE.has(f)) continue;
    if (usesModuleScopeFlagSubscribe(text, f)) offenders.push(f);
  }
  return { offenders, declarationProblems, unscanned };
}

function main() {
  const { offenders, declarationProblems, unscanned } = findOffenders();

  if (declarationProblems.length > 0) {
    console.error('✗ malformed `lazyFlagRefresh` unpopulated-state declaration:');
    console.error('  Every call must declare what its SYNC readers serve BEFORE the first async refresh');
    console.error('  lands — the one property no routine signal in this repo measures (the source lint,');
    console.error('  the partial-mock test, tsc and the unit suites all check importability and types, and');
    console.error('  emit an identical green for a safe migration and an unsafe one). See the header of');
    console.error('  packages/operator-core/lib/lazy-flag-refresh.ts for the override-store vs');
    console.error('  behaviour-selector discriminator.\n');
    for (const d of declarationProblems) console.error(`    ${d.file}: ${d.problem}`);
    console.error(`\n  ${declarationProblems.length} problem(s). See EI-19448574704459898.`);
    process.exit(1);
  }

  if (offenders.length === 0) {
    const note =
      BASELINE.size > 0 ? ` (${BASELINE.size} file(s) still in the shrink-to-empty BASELINE — WI-6650)` : '';
    console.log(`✓ no NEW module-scope @papercusp/flags subscribe/defaults touch${note}.` + describeUnscanned(unscanned));
    process.exit(0);
  }
  console.error('✗ NEW module-scope @papercusp/flags touch (onFlagChange / FLAG_DEFAULTS):');
  console.error('  A test that factory-mocks the flags surface without this export, and reaches this');
  console.error('  module transitively, throws at COLLECTION — failing the WHOLE test file (0 tests run)');
  console.error('  and reding the fleet gate. The error names the MOCK, not this file, so it reads as');
  console.error('  someone else\'s bug. Move the subscribe + any FLAG_DEFAULTS deref into an idempotent');
  console.error('  first-use init — see packages/operator-core/lib/agent-tools/coordination/log.ts\'s');
  console.error('  ensureCoordFlagInit(). Seed the cache with `??=`, never `=`.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(`\n  ${offenders.length} offender(s). See WI-6650 / EI-18825928993608425.`);
  process.exit(1);
}

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
