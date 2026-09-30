/**
 * Derived rubric versions — a rubric's version is a FUNCTION of its content,
 * never a literal someone has to remember to bump.
 *
 * ## Why this exists
 *
 * A rubric's version is not decoration: it feeds `computeIdentityHash`, which
 * decides which stored runs are COMPARABLE to each other. A hand-maintained
 * literal makes that correctness depend on a human remembering to bump it in
 * the same commit that rewrites an axis description or a bad/ideal anchor.
 *
 * That memory has already failed here. Commit b7c7f2db8d (2026-07-13) rewrote
 * axis descriptions and anchors in two operator-core rubrics while both
 * versions stayed at '1.0.0', so runs either side of it share an identity hash
 * under materially different judging instructions — the trend line looks
 * continuous precisely where it is least trustworthy. Deriving the version
 * from the content makes the bump structural: an anchor edit moves the version
 * by construction, with nothing to remember.
 *
 * ## The circularity to avoid
 *
 * The version must NOT be part of the content it labels — hashing a rubric
 * that already carries a `version` field either feeds a stale value back into
 * its own successor or, worse, produces a value that changes on every edit for
 * reasons the reader cannot reconstruct. Callers therefore pass CONTENT
 * (everything but the version) and compose the rubric afterwards:
 *
 *     const X_RUBRIC_CONTENT: Omit<JudgeRubric, 'version'> = { axes: [...] };
 *     export const X_RUBRIC_VERSION = deriveRubricVersion('x', X_RUBRIC_CONTENT);
 *     export const X_RUBRIC: JudgeRubric = { version: X_RUBRIC_VERSION, ...X_RUBRIC_CONTENT };
 *
 * `assertVersionFreeContent` below enforces that ordering at runtime rather
 * than trusting the convention, because passing the composed rubric by mistake
 * is the one error this whole mechanism cannot survive silently.
 *
 * ## Deliberately NOT canonicalized
 *
 * The hash is over plain `JSON.stringify`, so reordering keys moves the
 * version even when the meaning is unchanged. That asymmetry is chosen, not
 * overlooked: a spurious move only SPLITS a trend line (two comparable runs
 * stop being compared — visible, recoverable), while a missed move MERGES
 * incomparable runs (invisible, and it makes a broken comparison look sound).
 * Failing toward the visible direction is the whole point of the mechanism.
 */

import { createHash } from 'node:crypto';

/** Length of the hex digest kept in a derived version. */
const VERSION_HASH_CHARS = 12;

/**
 * A label may not contain `.` — the derived format is `<label>.<sha12>`, and a
 * dotted label makes that boundary ambiguous to anything (or anyone) reading a
 * stored version back.
 */
const VALID_LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Reject content that still carries its own `version`.
 *
 * Checked at the TOP level only, which is where the mistake lives: passing the
 * composed rubric instead of the content it was composed from. A nested object
 * legitimately may carry a version (e.g. a scaffold identity folded in as one
 * input among several), so recursing would refuse correct callers.
 */
function assertVersionFreeContent(label: string, content: unknown): void {
  if (content === null || typeof content !== 'object') {
    throw new TypeError(
      `deriveRubricVersion(${JSON.stringify(label)}): content must be a non-null object, got ${
        content === null ? 'null' : typeof content
      }`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(content, 'version')) {
    throw new TypeError(
      `deriveRubricVersion(${JSON.stringify(label)}): content must not carry its own \`version\` — ` +
        'pass the version-free CONTENT and compose the rubric afterwards, or the version is ' +
        'derived from a value that includes a previous version of itself.',
    );
  }
}

/**
 * Derive `<label>.<sha12>` from a rubric's version-free content.
 *
 * `label` keeps the value human-recognizable in stored rows and guarantees two
 * rubrics that happen to share content still get distinct versions.
 *
 * Throws on a malformed label or on content that carries its own `version`;
 * both are programming errors that would otherwise produce a plausible-looking
 * string, which is the failure mode this function exists to remove.
 */
export function deriveRubricVersion(label: string, content: unknown): string {
  if (!VALID_LABEL.test(label)) {
    throw new TypeError(
      `deriveRubricVersion: label must match ${String(VALID_LABEL)} (no dots — the derived ` +
        `format is \`<label>.<sha12>\`), got ${JSON.stringify(label)}`,
    );
  }
  assertVersionFreeContent(label, content);

  const digest = createHash('sha256')
    .update(JSON.stringify(content), 'utf8')
    .digest('hex')
    .slice(0, VERSION_HASH_CHARS);

  return `${label}.${digest}`;
}
