/**
 * clone-url — pure helpers for cloning a shared-harness repo over HTTPS,
 * optionally authenticated for a PRIVATE upstream the joiner has read on.
 *
 * Part of the non-collaborator code→PR path (non-collaborator-join-fork-pr B4).
 * A non-collaborator joining a shared harness needs no WRITE on the upstream
 * (join is write-free), but a PRIVATE upstream still requires READ to clone —
 * an inherent GitHub gate, not a Papercusp limitation. When the joiner has a
 * gh token with read, we clone via a token-embedded URL.
 *
 * Two safety rules, both enforced by the join step that consumes these:
 *   1. The token must never persist in the cloned repo's `.git/config` remote
 *      → after cloning, reset `origin` to `cleanCloneUrl(...)`.
 *   2. The token must never leak into error messages or logs
 *      → run any git stderr/message through `redactToken(...)`.
 */

/** Strip a single trailing `.git` from a `owner/repo` full name. */
function normalizeFullName(githubFullName: string): string {
  return githubFullName.replace(/\.git$/, '');
}

/**
 * Build the clone URL. With a token, embed it for an authenticated clone of a
 * private (or public) repo; without, return the anonymous public URL.
 *
 * The token form appends `.git` (canonical for an authenticated clone); the
 * anonymous form omits it (matches the prior behavior — GitHub accepts both).
 */
export function buildCloneUrl(githubFullName: string, token?: string): string {
  const full = normalizeFullName(githubFullName);
  return token
    ? `https://x-access-token:${token}@github.com/${full}.git`
    : `https://github.com/${full}`;
}

/**
 * The token-free URL to persist as `origin` after an authenticated clone, so
 * the secret never lands in `.git/config`. Always `.git`-suffixed.
 */
export function cleanCloneUrl(githubFullName: string): string {
  return `https://github.com/${normalizeFullName(githubFullName)}.git`;
}

/**
 * Redact an embedded `x-access-token:<token>@` from any text (error messages,
 * logs) so a leaked clone URL never exposes the token.
 */
export function redactToken(text: string): string {
  return text.replace(/x-access-token:[^@\s]*@/g, 'x-access-token:***@');
}
