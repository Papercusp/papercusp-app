import { resolve } from 'node:path';

/** A checkout candidate together with the provenance callers must surface. */
export interface EvidenceRootCandidate<Source extends string> {
  root: string;
  source: Source;
}

/**
 * Select one tree for evidence that must resolve as a complete set.
 *
 * The preferred tree remains authoritative while it resolves everything. When it
 * does not, exactly one discovered tree may win. More than one discovered match is
 * an ambiguity refusal: the final fallback must never break that tie. Only when no
 * discovered tree matches may the final fallback be considered.
 *
 * WI-41400 extracts this lattice from the plan/rubric/test-path implementations so
 * every ambient-root consumer shares the same precedence and tie behavior.
 */
export function selectUnambiguousEvidenceRoot<Source extends string>(opts: {
  preferred: EvidenceRootCandidate<Source>;
  candidates?: ReadonlyArray<EvidenceRootCandidate<Source>>;
  fallback?: EvidenceRootCandidate<Source>;
  resolvesEvery: (root: string) => boolean;
}): EvidenceRootCandidate<Source> | null {
  const resolvesSafely = (root: string): boolean => {
    try {
      return opts.resolvesEvery(root);
    } catch {
      return false;
    }
  };

  if (resolvesSafely(opts.preferred.root)) return opts.preferred;

  const preferredKey = resolve(opts.preferred.root);
  const fallbackKey = opts.fallback ? resolve(opts.fallback.root) : null;
  const seen = new Set<string>([preferredKey]);
  if (fallbackKey) seen.add(fallbackKey);

  const candidates = (opts.candidates ?? []).filter((candidate) => {
    const key = resolve(candidate.root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const matches = candidates.filter((candidate) => resolvesSafely(candidate.root));
  if (matches.length > 1) return null;
  if (matches.length === 1) return matches[0]!;

  if (
    opts.fallback &&
    fallbackKey !== preferredKey &&
    resolvesSafely(opts.fallback.root)
  ) {
    return opts.fallback;
  }
  return null;
}
