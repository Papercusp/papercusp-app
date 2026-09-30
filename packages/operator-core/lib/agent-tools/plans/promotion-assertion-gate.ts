/**
 * Promotion-time fail-closed gate for inline VAL-* validation assertions (P-002).
 *
 * WHY THIS EXISTS — the fail-open it closes
 * ----------------------------------------
 * `promote.ts` is the production consumer of a plan's inline VAL-* blocks: it
 * extracts them and stores the survivors as `feature.claims` +
 * `harness_shared.harness_plan_assertions`. It did that through
 * `extractAssertions()`, which FILTERS OUT every candidate lacking `verifyText`
 * (val-assertions.ts). So a MALFORMED VAL block promoted as "no assertions" —
 * byte-identical, at the call site, to an item that never declared one.
 *
 * That is the defect: absence of evidence rendered as evidence of absence. An
 * item whose assertion was garbled shipped with the same empty `claims` array
 * as an item with nothing to prove, and nothing anywhere said so.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * This is a PURE VALIDATION layer. It deliberately does not change what
 * promotion stores: well-formed assertions travel the same path they always
 * did. The only behavior that changes is the case that was previously silent —
 * a malformed or missing assertion now refuses instead of vanishing.
 *
 * It also does NOT mint `plan_spec_clauses`. Auto-minting clauses at promotion
 * would flip every existing plan from report-only to enforced at SHIP time
 * (plan-spec-coverage-gate exempts zero-clause plans today), which is an
 * unbounded blast radius for a bounded defect. Adoption stays opt-in via
 * `specs:set`; this gate only polices the assertions promotion already reads.
 *
 * REUSE, NOT A FORK (plan decision D-018)
 * ---------------------------------------
 * Every structural check here comes from `compileSpecClauses`, which already
 * implements VAL id canonicality, duplicate detection, behavior presence and
 * falsifiability, and legacy-exemption justification as typed diagnostics. This
 * module adds exactly ONE check the compiler cannot make — that a promoted item
 * declared any assertion at all — because only the caller knows which items are
 * being promoted.
 *
 * STAGING — measured, not guessed
 * -------------------------------
 * Enforcement is staged by the EXISTING reconciliation lanes rather than a new
 * flag: `historical` (shipped/superseded) and `pre-enforcement` (draft) report
 * findings as warnings; everything else enforces. That vocabulary is already the
 * designed ramp — spec-enforcement-eligibility.ts describes draft plans as
 * "reported, but never enforceable until promotion".
 *
 * Within the enforcing lane the two finding families are staged DIFFERENTLY,
 * because their blast radii differ by two orders of magnitude. Measured against
 * `harness_shared.harness_plans` on 2026-08-26 (harness `papercusp`):
 *
 *     enforceable lane:  482 plans,   3 contain any [VAL- block  (~0.6%)
 *     historical lane:   821 plans,   2 contain any [VAL- block
 *     pre-enforcement:    94 plans,   0 contain any [VAL- block
 *
 * So:
 *
 *   - MALFORMED assertions (compiler errors) enforce unconditionally on the
 *     enforcing lane. These can only fire on a plan that HAS assertions, so the
 *     radius is the ~3-plan adopted population — and this is the actual silent
 *     drop the gate exists to close.
 *
 *   - A MISSING assertion (`assertion-missing`) enforces only on a plan that has
 *     ALREADY ADOPTED assertions. Enforcing it everywhere would refuse promotion
 *     for 479 of 482 enforceable plans — a fleet-wide promotion outage, not a
 *     gate. On an adopted plan the same finding is a real defect: the author
 *     declared assertions for some items and silently left others uncovered,
 *     which is precisely the asymmetry P-002 is about.
 *
 * This ramp is SELF-STAGING and needs no flag: a plan turns the missing-assertion
 * check on for itself the moment it declares its first VAL block. Adoption grows,
 * coverage follows, and no dark default-OFF flag has to be remembered and flipped.
 *
 * Note the deliberate asymmetry with `enforcementEligibility()`: that helper keys
 * adoption off persisted CLAUSE count (`plan_spec_clauses`). This gate keys off
 * INLINE assertion presence instead, because inline VALs are what promotion
 * actually reads. Conditioning the whole gate on clause adoption would exempt
 * exactly the plans that adopted nothing — relocating the zero-clause exemption
 * rather than closing it.
 */

import {
  compileSpecClauses,
  type SpecCompilerDiagnosticCode,
} from './spec-clause-compiler';
import { laneOf, type ReconciliationLane } from './spec-enforcement-eligibility';

/** A single reason promotion should refuse (or, off the enforcing lane, warn). */
export interface PromotionAssertionFinding {
  /**
   * `assertion-missing` is this module's own check. Every other code is a
   * compiler diagnostic, passed through unchanged so the vocabulary stays
   * single-sourced.
   */
  code: SpecCompilerDiagnosticCode | 'assertion-missing';
  /** The plan item the finding is about; null when the compiler could not attribute one. */
  planItemId: string | null;
  /** The offending VAL id, when the finding is about a specific assertion. */
  sourceValId: string | null;
  message: string;
}

export interface PromotionAssertionGateResult {
  /** True when this plan's lane refuses on findings. */
  enforcing: boolean;
  lane: ReconciliationLane;
  /**
   * True when the plan declares at least one parseable assertion anywhere in the
   * promoted item set. This is what turns the missing-assertion check from a
   * warning into a violation — see the STAGING note in the module header.
   */
  planHasAdoptedAssertions: boolean;
  /** Blocking findings. Always empty when `enforcing` is false. */
  violations: PromotionAssertionFinding[];
  /**
   * Non-blocking findings — everything observed that did not rise to a
   * violation, so a reporter never has to re-derive them. A finding appears in
   * exactly one of `violations` or `warnings`, never both.
   */
  warnings: PromotionAssertionFinding[];
  /** Items that declared no parseable assertion at all. */
  itemsMissingAssertions: string[];
  /** Item ids that contributed at least one assertion candidate. */
  itemsWithAssertions: string[];
}

export interface PromotionAssertionGateInput {
  /** Raw plan markdown — the same `planFile.parsed.raw` promotion already holds. */
  rawPlan: string;
  /** The PLAN's status, passed as-is; unknown statuses deliberately enforce. */
  planStatus: string;
  /** The plan items being promoted. */
  itemIds: ReadonlySet<string>;
}

/** Deterministic ordering: item, then VAL id, then code. */
function compareFindings(
  a: PromotionAssertionFinding,
  b: PromotionAssertionFinding,
): number {
  const byItem = (a.planItemId ?? '').localeCompare(b.planItemId ?? '');
  if (byItem !== 0) return byItem;
  const byVal = (a.sourceValId ?? '').localeCompare(b.sourceValId ?? '');
  if (byVal !== 0) return byVal;
  return a.code.localeCompare(b.code);
}

/**
 * Evaluate the promotion-time assertion gate.
 *
 * Returns findings already split by lane, so a caller that forgets to check
 * `enforcing` still cannot refuse a historical or draft plan: `violations` is
 * empty off the enforcing lane by construction.
 */
export function evaluatePromotionAssertionGate(
  input: PromotionAssertionGateInput,
): PromotionAssertionGateResult {
  const lane = laneOf(input.planStatus);
  const enforcing = lane === 'enforceable';
  const itemIds = new Set(input.itemIds);

  // Nothing being promoted means nothing to police. Return an explicit
  // satisfied result rather than running the compiler over the whole plan,
  // which would attribute findings to items this promotion never touched.
  if (itemIds.size === 0) {
    return {
      enforcing,
      lane,
      planHasAdoptedAssertions: false,
      violations: [],
      warnings: [],
      itemsMissingAssertions: [],
      itemsWithAssertions: [],
    };
  }

  const compiled = compileSpecClauses(input.rawPlan, { itemIds });

  // Map every VAL id the compiler saw back to its plan item, so a diagnostic
  // (which carries only sourceValId) can be attributed to an item.
  const itemByValId = new Map<string, string>();
  const itemsWithAssertions = new Set<string>();
  for (const candidate of compiled.candidates) {
    itemByValId.set(candidate.sourceValId, candidate.planItemId);
    itemsWithAssertions.add(candidate.planItemId);
  }

  // A plan has "adopted" assertions when the promoted item set declares at least
  // one parseable VAL block. Deliberately computed from compiler CANDIDATES, not
  // from a raw '[VAL-' text scan: a block so malformed it yields no candidate is
  // reported by (1) below, and must not also flip this plan into the stricter
  // coverage tier on the strength of the same broken text.
  const planHasAdoptedAssertions = compiled.candidates.length > 0;

  // (1) MALFORMED — the compiler's structural errors: bad VAL id, duplicate id,
  // missing behavior, non-falsifiable behavior, unjustified legacy exemption.
  // These enforce unconditionally on the enforcing lane; they can only fire on a
  // plan that already has assertions. Compiler WARNINGS are not promoted to
  // findings — they describe enrichment gaps, not malformed assertions.
  const malformed: PromotionAssertionFinding[] = [];
  for (const diagnostic of compiled.diagnostics) {
    if (diagnostic.severity !== 'error') continue;
    malformed.push({
      code: diagnostic.code,
      planItemId: itemByValId.get(diagnostic.sourceValId) ?? null,
      sourceValId: diagnostic.sourceValId,
      message: diagnostic.message,
    });
  }

  // (2) MISSING — the check only the caller can make: a promoted item that
  // declared no assertion at all. This is the half of P-002 the compiler
  // structurally cannot see, because it never learns which items were expected
  // to have one. Enforced only on an already-adopted plan (see STAGING).
  const itemsMissingAssertions = [...itemIds]
    .filter((id) => !itemsWithAssertions.has(id))
    .sort();
  const missing: PromotionAssertionFinding[] = itemsMissingAssertions.map((planItemId) => ({
    code: 'assertion-missing' as const,
    planItemId,
    sourceValId: null,
    message:
      `${planItemId} is being promoted to executable work but declares no ` +
      `validation assertion, while sibling items on this plan do. Add a VAL-* ` +
      `block with a falsifiable **Verify:** line, or drop the item.`,
  }));

  const missingEnforced = enforcing && planHasAdoptedAssertions;
  const violations = [
    ...(enforcing ? malformed : []),
    ...(missingEnforced ? missing : []),
  ].sort(compareFindings);
  const warnings = [
    ...(enforcing ? [] : malformed),
    ...(missingEnforced ? [] : missing),
  ].sort(compareFindings);

  return {
    enforcing,
    lane,
    planHasAdoptedAssertions,
    violations,
    warnings,
    itemsMissingAssertions,
    itemsWithAssertions: [...itemsWithAssertions].sort(),
  };
}
