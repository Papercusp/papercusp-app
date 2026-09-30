/**
 * CLAUDE.md's gate-triage section tells agents how to decide whether the gate is
 * judging THEIR change. Every one of those recipes is a containment test against
 * "the candidate" — but until EI-20022093720663793 the section never stated the one
 * fact the whole procedure rests on: WHICH REF the candidate is cut from.
 *
 * It is the LOCAL integration branch (`staging`), never a remote-tracking ref.
 *
 * ── Why an unstated premise cost more than a wrong one ──
 *
 * Measured 2026-08-09/10 during the live gate-red streak (WI-37590): TWO agents
 * independently assumed `origin/staging`, converged, and one (su-434d5 — the author
 * of this guard) broadcast gating advice built on it to three peers mid-incident.
 * The convergence is the trap: independent agreement FELT like corroboration when
 * both had merely inherited the same convention from a doc that never said either
 * way. Corroboration requires independent EVIDENCE, not independent recall.
 *
 * The failure mode is specific and expensive. If you believe the gate reads
 * `origin/staging`, then an unpushed commit reads as "not in the candidate", so the
 * push leg looks like a gate precondition — and the natural next move is to wait for
 * a push that was never blocking, or to fire a manual `release:checkpoint-run` that
 * DISCARDS a live auto-refire rescue and costs a ~55min suite.
 *
 * ── What this module pins ──
 *
 * The doc claim is a claim about CODE, so it is checkable against code. Three
 * properties, each anchored to the PROPERTY rather than to a spelling (the
 * form-blind-detector mistake this repo has now made four times — see CLAUDE.md
 * § shared-lib singletons):
 *
 *   1. the candidate IS resolved from the configured integration BRANCH
 *   2. no remote-tracking ref participates in resolving it
 *   3. the gate never fetches — so a remote ref could not be fresh even if used
 *
 * If someone legitimately changes the gate to read a remote ref, (1)-(3) fail here
 * and the doc must be updated in the same change. That is the point: the guard fails
 * on DRIFT, not on the current answer being wrong.
 *
 * ⚠ STATED BOUND: comment stripping is textual, not a TS parse. It is sufficient
 * because the properties above are about `git` argv and identifier use, but a
 * `//`-bearing string literal could in principle survive it. The bound is stated
 * rather than papered over — and it fails OPEN (a surviving comment can only ADD a
 * candidate finding, which the fixtures below would catch as an over-fire).
 */

/** A source line implicated in one of the three properties. */
export interface GateRefFinding {
  /** 1-based line in the source. */
  line: number;
  text: string;
}

export interface GateCandidateRefVerdict {
  /** Sites resolving the candidate from the configured integration branch. */
  candidateSites: GateRefFinding[];
  /** CODE lines tying a remote-tracking ref to candidate resolution. */
  remoteRefSites: GateRefFinding[];
  /** CODE lines invoking a git fetch. */
  fetchSites: GateRefFinding[];
  /** Human-readable violations; empty when the doc claim holds. */
  violations: string[];
  ok: boolean;
}

/**
 * Strip block and line comments so a prose mention of `origin/main` (this file's
 * subject has three, all in comments about GitHub Actions' test.yml default) cannot
 * be mistaken for the code doing it.
 */
export function stripComments(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return withoutBlocks.split('\n').map((line) => line.replace(/\/\/.*$/, ''));
}

const RESOLVES_REF = /revParse\s*\(|['"]rev-parse['"]/;
const INTEGRATION_BRANCH = /integrationBranch/;
const REMOTE_REF = /origin\//;
const GIT_FETCH = /git\s+fetch|(['"])fetch\1/;

/**
 * Rejoin a multi-line ref-resolution call without losing the source line that opened it.
 *
 * The detector is deliberately textual, but TypeScript formatting is not line-stable: Prettier
 * moves `cfg.integrationBranch` onto a continuation line as soon as the call grows. Scanning only
 * the opener then manufactures a false absence. Bound the join to one call expression (or twelve
 * lines) so an unrelated later integration-branch mention cannot satisfy an earlier `revParse`.
 */
function refResolutionWindow(lines: readonly string[], start: number): string {
  const out = [lines[start] ?? ''];
  for (let i = start + 1; i < Math.min(lines.length, start + 12); i += 1) {
    const line = lines[i] ?? '';
    out.push(line);
    if (/\)\s*[,;]?\s*$/.test(line)) break;
  }
  return out.join(' ');
}

/**
 * Judge a green-checkpoint-shaped source against CLAUDE.md's stated claim.
 *
 * THROWS on a source too small to be the real file. A read that silently returned
 * empty would otherwise produce `ok: true` with zero findings — indistinguishable
 * from a clean pass, which is the false-absence shape this repo keeps paying for.
 */
export function judgeGateCandidateRef(source: string, minLines = 100): GateCandidateRefVerdict {
  const rawLineCount = source.split('\n').length;
  if (rawLineCount < minLines) {
    throw new Error(
      `judgeGateCandidateRef: source has ${rawLineCount} lines (< ${minLines}). ` +
        'Refusing to judge — an empty/short read must not be reported as a clean pass.',
    );
  }

  const codeLines = stripComments(source);
  const at = (i: number, text: string): GateRefFinding => ({ line: i + 1, text: text.trim() });

  const candidateSites: GateRefFinding[] = [];
  const remoteRefSites: GateRefFinding[] = [];
  const fetchSites: GateRefFinding[] = [];

  codeLines.forEach((line, i) => {
    const resolvesRef = RESOLVES_REF.test(line);
    const resolution = resolvesRef ? refResolutionWindow(codeLines, i) : line;
    if (resolvesRef && INTEGRATION_BRANCH.test(resolution)) candidateSites.push(at(i, resolution));
    if ((resolvesRef && REMOTE_REF.test(resolution)) || (REMOTE_REF.test(line) && /candidate/i.test(line))) {
      remoteRefSites.push(at(i, resolution));
    }
    if (GIT_FETCH.test(line)) fetchSites.push(at(i, line));
  });

  const violations: string[] = [];
  if (candidateSites.length === 0) {
    violations.push(
      'No site resolves the candidate from `integrationBranch`. CLAUDE.md claims the gate ' +
        'cuts its candidate from the LOCAL integration branch — that claim no longer holds.',
    );
  }
  for (const site of remoteRefSites) {
    violations.push(`Line ${site.line} ties a remote-tracking ref to candidate resolution: ${site.text}`);
  }
  for (const site of fetchSites) {
    violations.push(`Line ${site.line} invokes a git fetch: ${site.text}`);
  }

  return { candidateSites, remoteRefSites, fetchSites, violations, ok: violations.length === 0 };
}
