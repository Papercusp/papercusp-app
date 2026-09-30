/**
 * Curated kickoff-kind allowlist + validator — the single source for which
 * kickoff briefs a launch may request.
 *
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` D-003: the brief body
 * lives in-repo at `apps/operator/prompts/kickoffs/<kind>.md` and is never a
 * free-text payload. Add a kind here only after the brief MD file + the
 * renderer in `prompt-file.ts` both exist.
 *
 * Was a private helper inside the console-launch route; lifted here in P-032
 * (which retired that route's omp branch) so the launch-su path — now the one
 * launcher for every backend — and its test share one allowlist.
 */
export type KickoffKind = 'new-plan';

const KICKOFF_KIND_ALLOW = new Set<string>(['new-plan']);

export type KickoffValidation =
  | { kind: 'ok'; value: { kind: KickoffKind } | null }
  | { kind: 'error'; error: string };

/**
 * Validate a caller-supplied `{ kind }`. Lenient on absence (null/empty →
 * "no kickoff"); strict on unknown non-empty kinds (rejects with a helpful
 * allowlist message).
 */
export function validateKickoffKind(
  raw: { kind?: string } | null | undefined,
): KickoffValidation {
  if (!raw) return { kind: 'ok', value: null };
  const k = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!k) return { kind: 'ok', value: null };
  if (!KICKOFF_KIND_ALLOW.has(k)) {
    return {
      kind: 'error',
      error: `kickoff.kind '${k.slice(0, 32)}' is not in the allowlist (${[...KICKOFF_KIND_ALLOW].join(', ')})`,
    };
  }
  return { kind: 'ok', value: { kind: k as KickoffKind } };
}
