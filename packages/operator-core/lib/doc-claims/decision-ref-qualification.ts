/**
 * decision-ref-qualification — the judge behind the claim that `plans:add-decision`
 * hands its caller a RESOLVABLE decision reference, not a bare per-plan number.
 *
 * WHY a guard and not prose. `D-NNN` is allocated per-plan, so the number alone
 * is not a reference. Measured 2026-09-05 on harness `papercusp`: 9,088
 * decisions across 927 plans collapse onto 298 distinct numbers — `D-001` is
 * defined by 904 different plans, `D-002` by 792, `D-003` by 705. An agent that
 * is handed `decisionId: "D-001"` and quotes it into a carry-note has written
 * something with ~904 candidate referents, and no reader can recover which.
 * (The counts are dated documentation of a moving population, deliberately NOT
 * asserted anywhere — a test pinned to 904 would rot on the next plan written.
 * What IS asserted is the structural property that makes the count irrelevant.)
 *
 * The property this module decides: every success return of the decision
 * emitter that carries `decisionId` must also carry `ref`. That is stronger
 * than testing the helper, because the realistic regression is not "the helper
 * broke" — it is "someone added a THIRD return path and only wired the field
 * they were thinking about". A source-shape audit catches that; a unit test on
 * the helper cannot.
 */

/** The qualified form: `<planSlug>#D-NNN`. */
const QUALIFIED_DECISION_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*#D-\d+$/;

/** A bare, per-plan-allocated decision number — NOT a reference on its own. */
const BARE_DECISION_ID = /^D-\d+$/;

export function isQualifiedDecisionRef(value: unknown): boolean {
  return typeof value === 'string' && QUALIFIED_DECISION_REF.test(value.trim());
}

export function isBareDecisionId(value: unknown): boolean {
  return typeof value === 'string' && BARE_DECISION_ID.test(value.trim());
}

export type EmitterReturnAudit = {
  /** Balanced `return { … }` literals that mention `decisionId`. */
  returnsCarryingDecisionId: number;
  /** Of those, the ones that do NOT also expose `ref` — the defect. */
  offenders: string[];
};

/**
 * Extract balanced `return { … }` object literals from TypeScript source.
 *
 * Brace-matched rather than regex-matched on purpose: a `return {` block here
 * routinely contains nested objects, spreads and template literals, and a
 * non-greedy regex silently stops at the first `}` — which would make the audit
 * read a compliant multi-line return as an offender, and (worse) an offending
 * one as compliant when its `ref` sits past the false end.
 */
export function extractReturnObjectLiterals(source: string): string[] {
  const out: string[] = [];
  const needle = 'return {';
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    let depth = 0;
    let i = start + needle.length - 1; // sit on the '{'
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break; // unbalanced tail; stop rather than emit a partial
    out.push(source.slice(start, i + 1));
    from = i + 1;
  }
  return out;
}

/** Strip line and block comments so prose ABOUT `decisionId` is never read as code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * An INTERNAL lock-callback envelope, not a caller-facing return.
 *
 * `withPlanLock` requires its callback to hand back `{ newBody, value }`; that
 * `value` legitimately carries a bare `decisionId`, because the qualified `ref`
 * is derived once at the outer boundary where the plan slug is in scope. This
 * is a structural discriminator (the lock protocol's own field), NOT an
 * allowlist of blessed line numbers — a new envelope is excluded automatically,
 * and an envelope that stops being one stops being excluded.
 */
function isLockEnvelope(literal: string): boolean {
  return /\bnewBody\b\s*:/.test(literal);
}

/** Decide the property over a decision-emitter source file. */
export function auditDecisionEmitterSource(source: string): EmitterReturnAudit {
  const literals = extractReturnObjectLiterals(stripComments(source));
  const carrying = literals.filter(
    (lit) =>
      !isLockEnvelope(lit) &&
      // Either it names the id outright, or it SPREADS the lock result that
      // carries it. The spread case is the one a token match would miss, and it
      // is exactly how the caller-facing success return is written.
      (/\bdecisionId\b/.test(lit) || /\.\.\.\s*result\.value\b/.test(lit)),
  );
  const offenders = carrying.filter((lit) => !/\bref\b\s*:/.test(lit));
  return {
    returnsCarryingDecisionId: carrying.length,
    offenders: offenders.map((lit) => lit.replace(/\s+/g, ' ').slice(0, 160)),
  };
}
