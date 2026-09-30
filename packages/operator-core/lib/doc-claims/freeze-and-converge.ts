/**
 * The judge behind `freeze-and-converge.test.ts` (frozen-candidate-compliance-enforcement
 * -2026-08-30 P-009).
 *
 * CLAUDE.md's freeze-and-converge section makes two claims that are load-bearing for every
 * gate-red triage in this repo, and both are claims about MECHANISM:
 *
 *   1. "fix the frozen candidate's reds so the fixes land ON TOP of it (advancing
 *      `repairHead`)" — i.e. `repairHead` is the movable head.
 *   2. the frozen `candidate` itself does not move.
 *
 * Prose that describes a mechanism drifts from it silently, and this pair drifts in the
 * most expensive possible direction: an agent who believes the candidate can be advanced
 * reaches for a fast-forward that discards the queue's identity — a design that WAS
 * proposed on this very plan and retracted. So the rule is pinned here rather than trusted.
 *
 * WHAT IT ACTUALLY CHECKS. Not the presence of words: whether any assignment in the queue's
 * own module writes a NEW value into `candidate` on an existing queue. `repairHead` writes
 * are expected and required; a `candidate` write is the violation.
 */

/** Strip line and block comments so a doc comment cannot satisfy — or trip — the rule. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export interface FreezeAndConvergeVerdict {
  ok: boolean;
  /** Sites that assign a new value to `candidate` on a spread-copied queue. */
  candidateWriteSites: string[];
  /** Sites that advance `repairHead` — required to exist, or the mechanism is gone. */
  repairHeadWriteSites: string[];
  violations: string[];
}

/**
 * `{ ...queue, candidate: X }` is the shape that moves a frozen candidate. It is matched
 * specifically (rather than any `candidate:` key) because constructing a NEW queue with a
 * candidate is exactly how a first freeze is supposed to work.
 */
// `...identity` is excluded: the queue module's report/projection objects spread a queue
// IDENTITY (workspace/install/worktree — no candidate) and then COPY `candidate` through
// unchanged. That is not a queue being fast-forwarded; flagging it reddened the gate on
// candidate 27961812 (2026-09-02) with a false "retracted design returning" verdict.
const CANDIDATE_MUTATION_RE = /\.\.\.\s*(?!identity\b)(?:\w+)\s*,\s*(?:[^}]*?,\s*)?candidate\s*:/g;
const REPAIR_HEAD_MUTATION_RE = /\.\.\.\s*(?:\w+)\s*,\s*(?:[^}]*?,\s*)?repairHead\s*:/g;

export function judgeFreezeAndConverge(source: string): FreezeAndConvergeVerdict {
  const code = stripComments(source);
  const candidateWriteSites = [...code.matchAll(CANDIDATE_MUTATION_RE)].map((m) => m[0].trim());
  const repairHeadWriteSites = [...code.matchAll(REPAIR_HEAD_MUTATION_RE)].map((m) => m[0].trim());

  const violations: string[] = [];
  if (candidateWriteSites.length > 0) {
    violations.push(
      `CLAUDE.md states the frozen candidate does not move, but ${candidateWriteSites.length} site(s) ` +
        `spread an existing queue and overwrite \`candidate\`. Either the doc is now wrong or this is ` +
        `the retracted fast-forward-the-candidate design returning: ${candidateWriteSites.join(' | ')}`,
    );
  }
  if (repairHeadWriteSites.length === 0) {
    violations.push(
      'CLAUDE.md states a repair advances `repairHead`, but no site spreads a queue and writes ' +
        '`repairHead` — the mechanism the prose describes is absent.',
    );
  }
  return {
    ok: violations.length === 0,
    candidateWriteSites,
    repairHeadWriteSites,
    violations,
  };
}
