import type { CompletionVerificationEvidence } from '../coord-lifecycle/records';

/** Source files whose correctness a test run says nothing about. */
const TYPECHECKED_SOURCE_RE = /\.(?:[cm]?ts|tsx)$/i;
/** Any mention of a real type check, in the caller's OWN evidence prose. */
// Evidence commonly says "typechecks" (plural); requiring a word boundary immediately
// after "typecheck" silently missed that trailing s and produced a false warning.
// Compact checkpoint prose may attach the measured scope count ("build:typecheck10").
// Accept a following digit while still rejecting unrelated words like "typechecker".
const TYPECHECK_MENTION_RE =
  /\b(?:tsc|typechecks?|type-checks?|lint:tsc|build:typechecks?|typescript\s+(?:type\s+)?checks?)(?=\b|\d)/i;

/**
 * A passing unit/integration run proves behaviour, not TypeScript correctness.
 * Return the changed TypeScript files when the caller's evidence omits a typecheck.
 * This is intentionally pure and warn-only; callers decide how to render the advisory.
 */
export function typeEvidenceGapInCompletion(
  evidence: CompletionVerificationEvidence | undefined,
): { tsFiles: string[] } | undefined {
  if (!evidence) return undefined;
  const how = evidence.verifiedHow;
  if (how !== 'unit' && how !== 'integration' && how !== 'already-passing') return undefined;
  const tsFiles = (evidence.filesChanged ?? []).filter((file) => TYPECHECKED_SOURCE_RE.test(file.trim()));
  if (tsFiles.length === 0) return undefined;

  // The caller's OWN words settle it: if either evidence field mentions a typecheck,
  // they already looked and a nudge would be noise.
  const prose = `${evidence.testsRun ?? ''}\n${evidence.testResult ?? ''}`;
  if (TYPECHECK_MENTION_RE.test(prose)) return undefined;
  return { tsFiles };
}
