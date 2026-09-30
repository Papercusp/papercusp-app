/**
 * The composite release-profile evaluator. Pure orchestration over injected
 * `ComponentSpec.check()` functions (see ./types.ts) — no I/O of its own, so it
 * unit-tests exhaustively with fabricated checkers and stays correct however the
 * backing components are wired (a rubric store today, anything else tomorrow).
 */
import type {
  ComponentEvaluation,
  ComponentSpec,
  LineageStamp,
  ReleaseProfileSpec,
  ReleaseProfileVerdict,
} from './types';

/**
 * PURE: field-by-field lineage compare. A field present (non-null/undefined) on BOTH
 * `actual` and `expected` must match exactly; a field missing on EITHER side is never
 * judged (an evaluator with no opinion about a field must not manufacture a mismatch
 * from its absence — e.g. a component that doesn't stamp `generation` is judged on
 * `sha` alone). Returns the mismatching keys (empty = no disagreement found on any
 * field both sides declared).
 */
export function lineageMismatches(actual: LineageStamp, expected: LineageStamp): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(expected)) {
    const exp = expected[key];
    if (exp === null || exp === undefined) continue;
    const act = actual[key];
    if (act === null || act === undefined) continue;
    if (exp !== act) mismatches.push(key);
  }
  return mismatches;
}

async function evaluateComponent(
  spec: ComponentSpec,
  expectedLineage: LineageStamp | undefined,
  nowMs: number,
): Promise<ComponentEvaluation> {
  const base = { key: spec.key, title: spec.title, mandatory: spec.mandatory };

  let result;
  try {
    result = await spec.check();
  } catch (err) {
    return {
      ...base,
      verdict: 'unknown',
      reason: `checker threw: ${err instanceof Error ? err.message : String(err)}`,
      measuredAt: new Date(nowMs).toISOString(),
      evidence: [],
      lineage: null,
    };
  }

  // Staleness — evaluated first: evidence too old to trust is never rescued by an
  // otherwise-matching lineage or a green raw verdict.
  if (spec.maxAgeMs !== undefined) {
    const measuredMs = Date.parse(result.measuredAt);
    if (!Number.isFinite(measuredMs)) {
      return {
        ...base,
        verdict: 'stale',
        reason: `measuredAt '${result.measuredAt}' is not a parseable timestamp — cannot prove the evidence is current`,
        measuredAt: result.measuredAt,
        evidence: result.evidence,
        lineage: result.lineage ?? null,
      };
    }
    const ageMs = nowMs - measuredMs;
    if (ageMs > spec.maxAgeMs) {
      return {
        ...base,
        verdict: 'stale',
        reason:
          `evidence is ${Math.round(ageMs / 60_000)}min old, past the ${Math.round(spec.maxAgeMs / 60_000)}min ` +
          `freshness window (measured ${result.measuredAt})`,
        measuredAt: result.measuredAt,
        evidence: result.evidence,
        lineage: result.lineage ?? null,
      };
    }
  }

  // Lineage — only judged when BOTH the profile expects one AND this component
  // stamped one; a component that carries no lineage identity is simply not checked.
  if (expectedLineage && result.lineage) {
    const mismatches = lineageMismatches(result.lineage, expectedLineage);
    if (mismatches.length > 0) {
      return {
        ...base,
        verdict: 'lineage-mismatch',
        reason:
          `evidence lineage disagrees with the expected candidate on: ${mismatches.join(', ')} ` +
          `(evidence ${JSON.stringify(result.lineage)}, expected ${JSON.stringify(expectedLineage)})`,
        measuredAt: result.measuredAt,
        evidence: result.evidence,
        lineage: result.lineage,
      };
    }
  }

  return {
    ...base,
    verdict: result.verdict,
    reason: result.reason,
    measuredAt: result.measuredAt,
    evidence: result.evidence,
    lineage: result.lineage ?? null,
  };
}

export interface EvaluateReleaseProfileOpts {
  /** Injectable clock (epoch-ms) for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Evaluate every component (concurrently — each is an independent measurement) and
 * compose the overall GO/NO-GO. GO requires ALL of:
 *   1. at least one component declared at all;
 *   2. at least one of them is MANDATORY (a profile with nothing that actually gates
 *      it can never authorize GO by construction — an empty or all-advisory profile
 *      is a misconfiguration, not a free pass);
 *   3. every mandatory component's policy-applied verdict is 'pass'.
 * Any mandatory component that reads 'fail', 'unknown', 'stale', or
 * 'lineage-mismatch' refuses GO — the exact refusal contract this evaluator exists
 * to enforce.
 */
export async function evaluateReleaseProfile(
  spec: ReleaseProfileSpec,
  opts: EvaluateReleaseProfileOpts = {},
): Promise<ReleaseProfileVerdict> {
  const nowMs = opts.now ?? Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();

  if (spec.components.length === 0) {
    return {
      profileRef: spec.profileRef,
      evaluatedAt,
      go: false,
      reason: 'refusing GO — the profile declares zero components; nothing was checked',
      components: [],
    };
  }

  const components = await Promise.all(
    spec.components.map((c) => evaluateComponent(c, spec.expectedLineage, nowMs)),
  );

  const mandatory = components.filter((c) => c.mandatory);
  if (mandatory.length === 0) {
    return {
      profileRef: spec.profileRef,
      evaluatedAt,
      go: false,
      reason: 'refusing GO — the profile has zero MANDATORY components; nothing actually gates it',
      components,
    };
  }

  const blocking = mandatory.filter((c) => c.verdict !== 'pass');
  const go = blocking.length === 0;
  const reason = go
    ? `all ${mandatory.length} mandatory component(s) pass`
    : `refusing GO — ${blocking.length}/${mandatory.length} mandatory component(s) not pass: ${blocking
        .map((c) => `${c.key} (${c.verdict}: ${c.reason})`)
        .join('; ')}`;

  return { profileRef: spec.profileRef, evaluatedAt, go, reason, components };
}
