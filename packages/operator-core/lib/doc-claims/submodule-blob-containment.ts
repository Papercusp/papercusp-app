/**
 * CLAUDE.md's gate-triage caveat — "equal blobs prove that PATH is current, NOT that
 * the CANDIDATE is, because a test's runtime SUBJECT can live in a submodule whose
 * gitlink moved" — is curated prose whose PREMISES are code facts (WI-1255988,
 * follow-up to EI-20881147405154343).
 *
 * The repo's own ladder says code-describing prose must be DERIVED, PINNED or
 * ATTESTED, and that curated prose is the last rung. This caveat is pinnable, so
 * leaving it unpinned was the wrong rung: if its premises stop holding the doc goes
 * silently wrong in the one place it is read — gate-red triage.
 *
 * WHAT IS PINNED, AND WHY EACH FAILURE MEANS SOMETHING DIFFERENT
 *
 *   1. At least one declared submodule is a REAL gitlink at HEAD. If this fails the
 *      caveat is moot — there is no boundary to be blind across.
 *   2. The class it warns about is NON-EMPTY: at least one superproject test reads a
 *      path under a submodule at runtime. If this fails the caveat should be DELETED,
 *      not repaired — nothing can hit the trap any more.
 *   3. Both projected docs still carry the claim AND its remedy command. A doc that
 *      keeps the warning but loses `git diff --raw … | grep '^:160000'` leaves a reader
 *      correctly alarmed and unable to act.
 *
 * Deliberately pinned as a NON-EMPTY CLASS rather than one exemplar file. An earlier
 * draft would have pinned `lint-migrations.test.ts`; that is fragile — a legitimate
 * refactor of one test would red this guard for no reason. The claim that matters is
 * "this class exists", and its falsification is exactly the condition under which the
 * caveat should be removed.
 *
 * Pure + exported so the guarantee is directly testable against fixtures, the shape
 * `gate-candidate-ref.ts` chose and for the same reason: once the live assertion goes
 * green it stops being evidence that the detector works at all.
 */

/** A projected doc that must carry the caveat. */
export interface CaveatDoc {
  readonly path: string;
  readonly text: string;
}

export interface SubmoduleCaveatInputs {
  /** Paths declared in `.gitmodules`. */
  readonly declaredSubmodules: readonly string[];
  /** Of those, the ones that are genuinely mode 160000 at HEAD. */
  readonly gitlinkSubmodules: readonly string[];
  /** Superproject `*.test.ts` files that read a path under a submodule at runtime. */
  readonly boundaryReadingTests: readonly string[];
  /** The distinct submodules those tests actually reach across. */
  readonly reachedSubmodules: readonly string[];
  /** Docs that must carry the caveat (CLAUDE.md and its AGENTS.md twin). */
  readonly docs: readonly CaveatDoc[];
}

export interface SubmoduleCaveatVerdict {
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly gitlinkCount: number;
  readonly classSize: number;
  readonly reachedCount: number;
  readonly docsMissingClaim: readonly string[];
  readonly docsMissingRemedy: readonly string[];
}

/**
 * The caveat's claim. Pinned as TEXT, never by line number: it has already moved once
 * (364 -> 374) without changing meaning, and a line pin would have failed on that.
 */
export const CAVEAT_CLAIM_MARKER = 'Equal blobs prove that PATH is current';

/**
 * The remedy the caveat hands the reader. `^:160000` is the gitlink mode in
 * `git diff --raw` output — distinctive enough that no unrelated prose collides.
 */
export const CAVEAT_REMEDY_MARKER = '^:160000';

/**
 * A doc shorter than this cannot be the real CLAUDE.md/AGENTS.md. Refusing beats
 * reporting a missing marker as a violation, because a failed read and a genuinely
 * deleted caveat demand opposite responses.
 */
const MIN_DOC_CHARS = 2000;

export function judgeSubmoduleBlobContainmentCaveat(
  inputs: SubmoduleCaveatInputs,
): SubmoduleCaveatVerdict {
  if (inputs.docs.length === 0) {
    throw new Error(
      'Refusing to judge the submodule blob-containment caveat: no docs supplied. ' +
        'An empty doc set would report every marker present and pass vacuously.',
    );
  }
  for (const doc of inputs.docs) {
    if (doc.text.length < MIN_DOC_CHARS) {
      throw new Error(
        `Refusing to judge '${doc.path}': ${doc.text.length} chars is too short to be the ` +
          'real projected doc. A failed read must never be reported as a clean pass.',
      );
    }
  }

  const violations: string[] = [];

  if (inputs.gitlinkSubmodules.length === 0) {
    violations.push(
      inputs.declaredSubmodules.length === 0
        ? 'No submodules are declared in .gitmodules, so the caveat has no subject. ' +
          'DELETE the caveat rather than repair it.'
        : `${inputs.declaredSubmodules.length} submodule(s) are declared but NONE is a real ` +
          'gitlink (mode 160000) at HEAD, so blob containment can no longer be blind across ' +
          'a boundary. DELETE the caveat rather than repair it.',
    );
  }

  if (inputs.boundaryReadingTests.length === 0) {
    violations.push(
      'No superproject test reads a path under a submodule at runtime, so nothing can hit ' +
        'the trap the caveat describes. DELETE the caveat rather than repair it — this is ' +
        'the condition under which it becomes obsolete, not wrong.',
    );
  }

  const docsMissingClaim = inputs.docs
    .filter((d) => !d.text.includes(CAVEAT_CLAIM_MARKER))
    .map((d) => d.path);
  const docsMissingRemedy = inputs.docs
    .filter((d) => !d.text.includes(CAVEAT_REMEDY_MARKER))
    .map((d) => d.path);

  if (docsMissingClaim.length > 0) {
    violations.push(
      `The caveat's claim ("${CAVEAT_CLAIM_MARKER}…") is absent from: ` +
        `${docsMissingClaim.join(', ')}. Its premises still hold, so the text was lost rather ` +
        'than retired — restore it via the doc PART + re-projection, not by hand-editing.',
    );
  }
  if (docsMissingRemedy.length > 0) {
    violations.push(
      `The caveat's remedy ("${CAVEAT_REMEDY_MARKER}") is absent from: ` +
        `${docsMissingRemedy.join(', ')}. A reader left correctly alarmed but with no command ` +
        'to run is worse off than one who never read the warning.',
    );
  }

  return {
    ok: violations.length === 0,
    violations,
    gitlinkCount: inputs.gitlinkSubmodules.length,
    classSize: inputs.boundaryReadingTests.length,
    reachedCount: inputs.reachedSubmodules.length,
    docsMissingClaim,
    docsMissingRemedy,
  };
}
