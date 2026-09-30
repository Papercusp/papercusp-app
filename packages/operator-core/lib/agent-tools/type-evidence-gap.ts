import type { CompletionVerificationEvidence } from '../coord-lifecycle/records';

/** Source files whose correctness a test run says nothing about. */
const TYPECHECKED_SOURCE_RE = /\.(?:[cm]?ts|tsx)$/i;
/** Any mention of a real type check, in the caller's OWN evidence prose. */
const TYPECHECK_MENTION_RE = /\b(?:tsc|typecheck|type-check|lint:tsc|build:typecheck|typescript\s+(?:type\s+)?check)\b/i;

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
