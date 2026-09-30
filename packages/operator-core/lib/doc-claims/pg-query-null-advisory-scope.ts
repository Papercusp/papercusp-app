/**
 * Pins the corpus's present-tense claims about the SCOPE of `dev:pg_query`'s
 * always-NULL advisory to the trap table that actually implements it.
 *
 * ── Why this guard exists (plan silent-wrong-answers-2026-08-01, P-013) ──
 *
 * P-013 was instance #8 of that plan's target class: documentation asserting a
 * capability that was NOT LIVE. CLAUDE.md said `dev:pg_query` "now emits an
 * always-NULL-accessor advisory" while the advisory was absent from staging, main
 * AND deployed — and the live operator silently returned 0 criticals against a true
 * 25. The corpus is spliced into EVERY su launch context, so an agent who believes a
 * safety net exists is LESS likely to double-check: the doc actively REDUCED
 * vigilance against the very bug it had not yet shipped.
 *
 * P-013 was then closed at DOCUMENTATION tier — the prose was softened to match
 * reality — even though its own item text named the stronger tier: "Consider a check
 * that flags a doc asserting a capability whose marker is not yet deployed." That
 * omission is what the plan's acceptance grading failed on (C1 clause 1: "closed at
 * DOCUMENTATION tier while a stronger tier was demonstrably available and not
 * attempted"). Sixty-eight sibling guards in this directory are the proof it was
 * available. This file is that stronger tier, applied to the same claim.
 *
 * ── What is pinned, and why THESE properties ──
 *
 * Softening prose fixes the instance and leaves the CLASS armed: the next edit to
 * either side can re-open the gap silently, because nothing relates them. The corpus
 * makes two checkable present-tense claims about the advisory's scope:
 *
 *   1. it NO LONGER covers `harness_shared.engineer_issues` (the trap was retired
 *      with migration 1096, once the view stopped subtracting the `_ei` blob and the
 *      path began resolving — an advisory firing on a path that now resolves is
 *      itself the confidently-wrong answer it exists to prevent);
 *   2. it STILL fires for the `work_items` shapes it knows.
 *
 * Both are claims about code, so both are checkable against code. They are anchored
 * to the PROPERTY — which relations `SILENT_NULL_PATH_TRAPS` covers — rather than to
 * a spelling, so renaming a trap, reordering the table, or rewording an advisory
 * string does not fire, while re-adding an `engineer_issues` trap (or deleting the
 * last `work_items` one) does.
 *
 * This is a DIVERGENCE check, not a correctness check: it does not assert that the
 * current scope is the right scope. It asserts that the DOC and the TABLE cannot
 * drift apart unnoticed. If someone legitimately re-adds an engineer_issues trap,
 * this fails and the corpus must be updated in the same change. That is the point.
 *
 * ⚠ WHY NOT the fully general "flag any doc claim whose marker is not deployed":
 * that needs deploy position at judgement time, and this tier is the UNIT lane the
 * green gate actually runs (`npm run test:affected`, no `--integration`). A guard
 * reaching for deploy state would either not run in the gate or answer from an
 * unreliable position read — `dev:pipeline_position` reports deployed:false for a
 * file whose behaviour the live tool demonstrably serves when a later peer commit
 * touched it (WI-2142488). Pinning doc-to-code at unit tier is the part that is
 * sound here; the deployment-position half is tracked separately rather than faked.
 *
 * ⚠ STATED BOUND: the trap table is located and sliced TEXTUALLY, not by a TS parse.
 * That is sufficient because the judged property is the literal `relation:` field of
 * an array-of-object-literals declaration, and it fails LOUDLY rather than open — a
 * table that cannot be located yields zero relations, which trips the non-vacuity
 * floor below instead of silently passing.
 */

/** Stable substring of the corpus's "no longer covers engineer_issues" claim. */
export const CLAIM_RETIRED_MARKER = 'always-NULL advisory **no longer covers this view**';

/** Stable substring of the corpus's "still fires for work_items" claim. */
export const CLAIM_STILL_FIRES_MARKER = 'It still fires for the `work_items` shapes it knows';

/** The declaration whose `relation:` fields are the judged scope. */
export const TRAP_TABLE_DECL = 'const SILENT_NULL_PATH_TRAPS';

/** The relation the corpus claims is NO LONGER covered. */
export const RETIRED_RELATION = 'engineer_issues';

/** The relation the corpus claims is STILL covered. */
export const COVERED_RELATION = 'work_items';

export interface AdvisoryScopeVerdict {
  /** Relations named by the trap table, in declaration order (may repeat). */
  trapRelations: string[];
  /** Did the corpus assert the retirement claim? */
  claimsRetired: boolean;
  /** Did the corpus assert the still-fires claim? */
  claimsStillFires: boolean;
  /** Human-readable violations; empty when doc and code agree. */
  violations: string[];
  ok: boolean;
}

/**
 * Slice the trap table and return every `relation:` value it declares.
 *
 * Returns [] when the declaration cannot be located — a vacuous read the caller must
 * treat as a failure, never as "no traps".
 */
export function extractTrapRelations(source: string): string[] {
  const start = source.indexOf(TRAP_TABLE_DECL);
  if (start === -1) return [];
  // The table is an array literal terminated by a line-initial `];`.
  const end = source.indexOf('\n];', start);
  if (end === -1) return [];
  const table = source.slice(start, end);

  const relations: string[] = [];
  const scan = /\brelation:\s*'([^']+)'|\brelation:\s*"([^"]+)"/g;
  for (let m = scan.exec(table); m; m = scan.exec(table)) {
    relations.push(m[1] ?? m[2] ?? '');
  }
  return relations.filter(Boolean);
}

/**
 * Judge the corpus's advisory-scope claims against the trap table.
 *
 * Both inputs are passed in rather than read here, so the test can drive fixtures
 * through the same code path the live assertion uses.
 */
export function judgePgQueryAdvisoryScope(args: {
  corpus: string;
  pgReadQuerySource: string;
}): AdvisoryScopeVerdict {
  const { corpus, pgReadQuerySource } = args;
  const trapRelations = extractTrapRelations(pgReadQuerySource);
  const claimsRetired = corpus.includes(CLAIM_RETIRED_MARKER);
  const claimsStillFires = corpus.includes(CLAIM_STILL_FIRES_MARKER);
  const violations: string[] = [];

  // ── Non-vacuity floors ────────────────────────────────────────────────────
  // Each of these is a way for the guard to measure NOTHING and look green, which
  // is the exact failure mode the plan this guard belongs to exists to prevent.
  if (trapRelations.length === 0) {
    violations.push(
      `could not locate \`${TRAP_TABLE_DECL}\` (or it declares no \`relation:\`) in ` +
        'pg-read-query.ts — the scope claims were judged against NOTHING. Re-point this ' +
        'guard at the trap table rather than deleting it.',
    );
  }
  if (!claimsRetired && !claimsStillFires) {
    violations.push(
      'neither advisory-scope claim was found in the corpus — the prose this guard ' +
        `pins is gone or reworded. Update CLAIM_RETIRED_MARKER / CLAIM_STILL_FIRES_MARKER ` +
        'to the new wording (and re-check it is still true), rather than leaving a guard ' +
        'that silently judges nothing.',
    );
  }

  // ── The divergence assertions ─────────────────────────────────────────────
  if (claimsRetired && trapRelations.includes(RETIRED_RELATION)) {
    violations.push(
      `the corpus says the always-NULL advisory "no longer covers" ${RETIRED_RELATION}, ` +
        `but SILENT_NULL_PATH_TRAPS still declares a trap with relation '${RETIRED_RELATION}'. ` +
        'One of the two is now wrong: either the trap was re-added (update the corpus in ' +
        'this same change) or the doc claim is stale.',
    );
  }
  if (claimsStillFires && !trapRelations.includes(COVERED_RELATION)) {
    violations.push(
      `the corpus says the advisory "still fires for the ${COVERED_RELATION} shapes it ` +
        `knows", but SILENT_NULL_PATH_TRAPS declares no trap with relation ` +
        `'${COVERED_RELATION}'. The documented safety net no longer exists — this is the ` +
        'P-013 shape exactly: a doc promising a capability the code does not provide.',
    );
  }

  return {
    trapRelations,
    claimsRetired,
    claimsStillFires,
    violations,
    ok: violations.length === 0,
  };
}
