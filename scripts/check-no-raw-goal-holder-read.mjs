#!/usr/bin/env node
/**
 * check-no-raw-goal-holder-read.mjs — fail-loud guard against a NEW raw read of
 * "who holds this goal" that skips the liveness fold
 * (goal-live-holder-guarantee-2026-08-18 P-001 / D-003).
 *
 * ── WHY THIS IS A BUILD GUARD AND NOT A TEST ────────────────────────────────
 *
 * A goal's holder is a row in `harness_shared.agent_modes` (mode='goal',
 * subject=<goal id>). That row is ORDINARY DURABLE STATE: it outlives the
 * session that wrote it, and nothing clears it when that session dies. So
 * `WHERE mode='goal' AND subject=$1` keeps returning a holder forever, and every
 * surface built on it reports a goal nobody has touched in days as staffed.
 *
 * Measured 2026-08-16: 4 of 6 active goals had been dark 2–5 days while every
 * count-based surface called them held. Measured 2026-08-18: the Blender's
 * steward had been gone SIX DAYS and `agent_modes` still named it the holder.
 *
 * The remedy (packages/operator-core/lib/goals/holder.ts) is to compute the
 * answer fresh on every read by folding the shared presence oracle over the
 * rows, so there is no stored answer left to go stale. That module is not hard
 * to call — the join it performs was never hard to WRITE either. It was easy to
 * FORGET, and forgetting it is silent in the only direction that matters:
 * nothing fails, no test goes red, and the board just quietly lies. Before
 * P-001 the fold existed in exactly two system-health sweeps and was absent
 * from the goals board, the goal popup and stop-fanout.
 *
 * A behaviour test cannot observe a call site that never calls the thing under
 * test. That is the gap this closes, at build time.
 *
 *   node scripts/check-no-raw-goal-holder-read.mjs
 *
 * ── THE TELL ────────────────────────────────────────────────────────────────
 *
 * A file whose SQL touches `harness_shared.agent_modes` AND constrains BOTH the
 * goal mode AND `subject` — which together is the shape of "resolve the holders
 * OF A GOAL", as opposed to "what modes does this session carry" (owner-keyed,
 * a different and legitimate question this guard deliberately ignores).
 *
 * A file is CLEARED when it references any entry point of the holder module,
 * because that means the liveness fold is present. That is deliberately the
 * property enforced, rather than "no raw SQL anywhere": two call sites
 * legitimately need columns the shared read does not project (the popup wants
 * set_by; the owner-report sweep LATERAL-joins report timestamps) and both are
 * correct as long as the classification still goes through the one module.
 *
 * Comments are stripped first, so prose about goal holders never trips it.
 *
 * EXCLUDED (never scanned): vendored / build output / _retired / tests / SQL
 *   migrations / non-source.
 *
 * BASELINE: EMPTY, and must stay empty. Verified against the live tree when this
 *   guard landed: every remaining raw read is either allowlisted below with a
 *   stated reason or already routes through the module. There is no
 *   grandfathered debt here, so a hit is always a genuine NEW bypass — fix it at
 *   the call site, never by adding a BASELINE entry.
 *
 * The predicate (`readsRawGoalHolder`) is exported + unit-tested
 * (packages/operator-core/lib/goals/no-raw-goal-holder-read-guard.test.ts) so
 * "fails on a NEW bypass" is durably verified rather than merely green-on-a-
 * clean-tree — a guard nobody has ever seen FAIL is not a guard.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Permanently-allowed files, each because liveness is genuinely IRRELEVANT to
 * the question it is asking — not because the fold is inconvenient there. A new
 * entry needs that same argument written down; "it was easier" is the reasoning
 * this guard exists to refuse.
 */
export const ALLOWLIST = new Set([
  // THE MODULE ITSELF. It necessarily contains the raw read — it IS the thing
  // every other site routes through.
  //
  // DEFENSIVE, not currently load-bearing: measured against the live tree, this
  // file is already cleared by SANCTIONED (it defines those very entry points).
  // Kept so that renaming the exports cannot silently turn the module into its
  // own first offender.
  'packages/operator-core/lib/goals/holder.ts',
  // Dependency-light authority half of the same canonical holder subsystem.
  // control-anchor imports this without pulling the liveness/agent-MCP graph.
  'packages/operator-core/lib/goals/holder-authority.ts',

  // Tool-invocation telemetry attributes the CURRENTLY EXECUTING caller. Its
  // INSERT owns the agent_modes/session_briefs join that derives goal_id and
  // goal_actor_class at settle time; the caller is live by construction because
  // it is completing this very dispatch. This is not a board/supervisor answer
  // to "who holds goal X now", so routing the hot-path batch INSERT through the
  // asynchronous presence oracle would turn best-effort telemetry into a
  // dispatch dependency. Keep this one owner-keyed self-read explicit.
  'packages/operator-core/lib/projected-tool-deps.ts',

  // The generic mode store: CRUD over agent_modes across every mode axis, of
  // which 'goal' is one. It is the layer the holder module is built ON, so
  // routing it through the holder module would be circular.
  //
  // DEFENSIVE, not currently load-bearing: its queries take `mode` as a
  // parameter rather than pinning it to 'goal', so the predicate does not fire
  // today. Kept because a goal-specific query added here would be correct and
  // must not need an allowlist edit to land.
  'packages/operator-core/lib/modes/store.ts',

  // Cost attribution over a goal's lifetime. A holder that has since died still
  // SPENT what it spent, so filtering the membership set by present-tense
  // liveness would silently under-report the goal's bill — the opposite of the
  // error this guard exists to prevent, and a worse one (money).
  'packages/operator-core/lib/goals/spend-rollup.ts',

  // Attribution of a PAST edit: an `edit_attribution_ledger` row joined to the
  // goal-mode row that owned it. The edit happened, so the editor was alive at
  // the time by construction; resolving its liveness NOW would make a recorded
  // violation disappear once the offender's session ended, which is exactly
  // backwards for an audit trail.
  'packages/operator-core/lib/system-health/goal-edit-claim-watchdog.ts',

  // Evidence record for a PAST agent-run window (scorecards `agent-run` subjects):
  // findGoal asks "which goal was THIS holder pursuing during the graded window"
  // (owner-keyed reverse lookup, newest goal-mode row for that owner). The run is
  // over, so its holder is usually gone by design; folding present-tense liveness
  // would erase the goal link from exactly the records it exists to label.
  // Not a board/supervisor answer to "who holds goal X now" (WI-10003582).
  'packages/operator-core/lib/agent-tools/scorecards/agent-run-evidence-record.ts',

  // goals:create asks "is the CALLER in goal mode" (owner-keyed, self-scoped)
  // and stamps `subject` on its own row. Both are writes/self-reads about the
  // caller's own session, which is trivially live — it is executing the call.
  'packages/agent-mcp/src/tools/goals/create.ts',
]);

/**
 * Grandfathered offenders. EMPTY on purpose and must remain so — the tree was
 * clean when this guard landed, so any hit is a genuine new bypass.
 */
export const BASELINE = new Set([]);

/**
 * Vendored / generated / non-source / test files are never scanned.
 *
 * Segment-matched via a leading `/` on the normalised path rather than
 * `f.includes('/dir/')`: the sibling guards' `includes` form silently MISSES a
 * top-level `node_modules/x.ts` (no leading slash to match), which the unit test
 * for this guard caught. Paths here are repo-relative, so the root case is the
 * realistic one.
 */
const EXCLUDED_SEGMENTS = [
  '_retired',
  'node_modules',
  'dist',
  '.next',
  'build',
  'storybook-static',
  'code-server',
  'env-sidecars',
  'db-sql',
  'holepunch-spike',
  // packages/operator-core/lib/db-schema-reference/index-manifest.ts is a GENERATED index
  // census (regenerated from a real Postgres by schema-object-drift.integration.test.ts). It
  // quotes every index DEFINITION verbatim, so a partial index on agent_modes with a
  // `mode = 'goal'` predicate (agent_modes_goal_election_idx, 2026-09-04) reads to the
  // predicates below exactly like a raw holder read. A DDL string is not a read.
  'db-schema-reference',
];

export const isExcluded = (f) => {
  const p = `/${f}`;
  if (EXCLUDED_SEGMENTS.some((seg) => p.includes(`/${seg}/`))) return true;
  if (p.includes('/spa/assets/')) return true;
  if (/\.(test|spec)\.[cm]?tsx?$/.test(f)) return true;
  return !/\.(ts|mjs|cjs)$/.test(f);
};

// Comment stripping is the shared, string-aware stripCommentsOnly (imported
// above) — a hand-rolled regex stripper here is exactly the phantom-offender
// class guard-string-literal-blindness.test.ts exists to prevent
// (EI-19991116787260658). stripCommentsOnly (not stripCommentsAndStrings)
// because the predicates below must still see SQL text inside template
// literals — string contents are live evidence for this guard.

/** The table. Schema-qualified: the bare word `agent_modes` appears in prose. */
const HOLDER_TABLE = /harness_shared\.agent_modes/;
/**
 * The goal mode, as a SQL literal or via the shared constant. Both spellings are
 * live in the tree today (`mode = 'goal'` and `mode = ${GOAL_MODE}`), and a
 * guard that saw only one would be trivially, invisibly evadable.
 */
const GOAL_MODE_FILTER = /mode\s*=\s*(?:'goal'|"goal"|\$\{\s*GOAL_MODE\s*\}|GOAL_MODE\b)/i;
/** The goal id lives in `subject` — its presence is what makes this a HOLDER read. */
const SUBJECT_FILTER = /\bsubject\b/;
/**
 * Any entry point of the holder module. Referencing one means the liveness fold
 * is being applied, which is the property actually being enforced.
 */
const SANCTIONED =
  /resolveGoalHolders|resolveGoalHoldersFromRows|resolveGoalHoldersBatch|resolveGoalHoldersBatchFromRows|readGoalHolderRows|resolveHolderLiveness|holderCountsAsAlive/;

/**
 * Does this source read goal HOLDERS raw, without the shared liveness fold?
 * Pure (text → boolean) so it is unit-testable in isolation.
 *
 * FILE-LEVEL rather than statement-level, matching the sibling guards. The
 * tighter form was considered and rejected for the same reason
 * check-no-raw-block-edge documents: the realistic bypass splits the predicate
 * across an interpolated fragment or a helper, so a statement-scoped matcher
 * would look more precise while catching less. The measured cost of the coarse
 * form on the live tree is the six ALLOWLIST entries above, each with a
 * written reason.
 */
export function readsRawGoalHolder(text) {
  const t = stripCommentsOnly(text);
  return (
    HOLDER_TABLE.test(t) &&
    GOAL_MODE_FILTER.test(t) &&
    SUBJECT_FILTER.test(t) &&
    !SANCTIONED.test(t)
  );
}

/**
 * Scan the tracked tree for offenders. Enumerates via `listTrackedFiles`, which
 * recurses into submodules — a bare `git ls-files` emits one gitlink entry per
 * submodule and would silently report ✓ for all of them (the WI-6730 failure the
 * sibling guards already learned). Returns coverage alongside offenders so
 * `main` can state what it could not check rather than implying a clean tree.
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
    if (readsRawGoalHolder(text)) offenders.push(f);
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    console.log(
      '✓ no raw goal-holder read bypasses the liveness fold.' + describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ raw goal-holder read(s) that skip the liveness fold:');
  console.error('  A goal-mode row OUTLIVES the session that wrote it and nothing clears it on');
  console.error('  death, so counting rows reports a goal dark for days as staffed. Resolve');
  console.error('  holders through packages/operator-core/lib/goals/holder.ts:');
  console.error('    resolveGoalHolders(sql, { workspaceId, goalId })   — one goal');
  console.error('    resolveGoalHoldersBatch(sql, goals)                — many, one oracle call');
  console.error('    readGoalHolderRows(sql, ...) + resolveHolderLiveness(ids)');
  console.error('                                                      — when you need extra columns\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(
    `\n  ${offenders.length} offender(s). See plan goal-live-holder-guarantee-2026-08-18 (P-001 / D-003).`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
