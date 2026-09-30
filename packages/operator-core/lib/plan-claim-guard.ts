/**
 * plan-claim-guard — the PURE core of the "shipped-but-vaporware" plan-item guard
 * (EI-479 class; proposal-plan-claim-guard.md, pr5-impl 2026-06-20).
 *
 * The bug it catches: a plan item flipped to shipped/done that names a repo file path
 * which DOESN'T EXIST. The canonical case — `papercusp-dogfood-phase7-pr-lifecycle`
 * marked **P-042** "✅ DONE — `apps/operator/lib/pr-host/poll-daemon.ts` + 6 tests"
 * while the file never existed (EI-479). That false status hid the biggest inbound-PR
 * gap for weeks; the entire PR-1..5 effort exists to undo it. A cheap existence check
 * at the claim would have caught it.
 *
 * This module is the home-AGNOSTIC core only: a pure function over plan text + an
 * injected `fileExists`. WHERE it runs (a vitest/CI lint scoped to active plans, and/or
 * a `plans:set-status` preflight) is the deferred wiring decision under peer consensus
 * (see the proposal). Keeping the core pure means it's reusable by either home and
 * unit-testable with zero FS.
 *
 * CONSERVATIVE BY DESIGN (the plan corpus is full of historical/moved-path prose that
 * is NOT vaporware): a path is only treated as a live claim when it is
 *   - backticked,
 *   - root-anchored (`packages|apps|libs|scripts/…`) with a real source/doc extension,
 *   - on a line that POSITIVELY marks shipped/done,
 *   - and NOT on a correction/superseded line (which documents a known-gone path).
 * This bounds false positives toward zero at the cost of missing exotic phrasings —
 * the right trade for a guard whose whole value is being trusted, not noisy.
 */

/** A shipped/done claim whose named file path does not exist. */
export interface PlanClaimViolation {
  /** The trimmed claim line (bounded) for the report. */
  context: string;
  /** The claimed repo-relative file path that does not exist. */
  path: string;
  /** 1-based line number within the plan text. */
  line: number;
}

export interface VerifyPlanClaimsResult {
  ok: boolean;
  violations: PlanClaimViolation[];
  /** Number of (live, non-correction) path claims actually checked. */
  checked: number;
}

/** A line POSITIVELY marks shipped/done. */
const SHIPPED_MARK = /✅|\bDONE\b|\bshipped\b|\bSHIPPED\b|\bLANDED\b/;

/**
 * A line is a CORRECTION/superseded note — it cites a path to say it's gone/false, so
 * the path is NOT a live shipped claim. Excludes the EI-479-style "was FALSE — `x` never
 * existed" lines + struck/superseded markers from triggering a violation.
 */
// Refined per pr1-impl's consensus review: a bare `\bNOT\b` was too broad (would suppress a
// legit shipped line like "handles the NOT-found case"). Narrowed to NEGATION-of-shipped
// phrasings — catches real corrections ("NOT built", "was NOT done", "is NOT real") without
// muting an ordinary line that merely contains "NOT".
const CORRECTION_MARK =
  /\bNOT (built|done|shipped|created|implemented|real|present|wired|exist(?:s|ed)?)\b|\b(?:was|is|were|are) NOT\b|never existed|never built|did not exist|doesn't exist|was FALSE|vaporware|superseded|struck|~~/i;

/** Backticked, root-anchored repo path with a source/doc extension. */
const PATH_TOKEN = /`((?:packages|apps|libs|scripts)\/[\w./-]+\.(?:ts|tsx|mjs|cjs|js|md))`/g;

/**
 * Verify that every shipped/done plan claim naming a repo file path points at a file
 * that exists. Pure — `fileExists(path)` is injected (repo-relative path). Returns the
 * violations (empty ⇒ ok).
 */
export function verifyPlanClaims(
  planText: string,
  fileExists: (path: string) => boolean,
): VerifyPlanClaimsResult {
  const lines = planText.split('\n');
  const violations: PlanClaimViolation[] = [];
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SHIPPED_MARK.test(line)) continue;
    if (CORRECTION_MARK.test(line)) continue; // documents a gone path, not a live claim
    PATH_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_TOKEN.exec(line)) !== null) {
      const path = m[1];
      // Skip ELLIPSIS-abbreviated paths (e.g. `libs/agent-chat/.../hook.test.tsx`): plan
      // authors abbreviate long paths with `...`, which is not a literal file claim. (Found
      // by the real-corpus scan — these were the dominant false positives.)
      if (path.includes('...')) continue;
      checked++;
      if (!fileExists(path)) {
        violations.push({ context: line.trim().slice(0, 140), path, line: i + 1 });
      }
    }
  }
  return { ok: violations.length === 0, violations, checked };
}

/** Format violations as a human/CI-friendly message. */
export function formatPlanClaimViolations(
  planLabel: string,
  result: VerifyPlanClaimsResult,
): string {
  if (result.ok) return `${planLabel}: ${result.checked} shipped path-claim(s) verified ✓`;
  const lines = result.violations.map(
    (v) => `  • line ${v.line}: shipped claim names a MISSING file \`${v.path}\`\n    ${v.context}`,
  );
  return `${planLabel}: ${result.violations.length} vaporware claim(s) (file marked shipped but absent):\n${lines.join('\n')}`;
}
