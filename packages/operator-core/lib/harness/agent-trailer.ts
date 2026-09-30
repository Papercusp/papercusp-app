/**
 * agent-trailer — mark an AGENT-authored PR body
 * (PLAN-pr-system-completion-dogfood Phase PR-4 / Brief PR-4 (c)5).
 *
 * Owner decision (c): agent-authored PRs are opened AS the authenticated human
 * operator (the `gh` account stays the human — that's the rate bucket + the
 * accountability anchor). Only the AGENCY is marked: a `Co-authored-by:
 * papercusp-bee` git trailer (so GitHub attributes the Bee as a co-author) plus a
 * one-line body marker (so a human reading the PR sees it was agent-driven, not
 * hand-authored). The fork→PR-on-feature-pass path is always Bee-driven (the
 * pipeline shipped the feature), so it always carries the trailer; a hand-authored
 * contribution does not.
 *
 * Pure string transform — no I/O. Idempotent: re-appending to a body that already
 * carries the trailer is a no-op (guards against a re-open double-stamping).
 */

/** The Bee's display name in the Co-authored-by trailer. */
export const PAPERCUSP_BEE_NAME = 'papercusp-bee';
/** A noreply identity for the trailer — the ACCOUNT is the human; this only marks agency. */
export const PAPERCUSP_BEE_EMAIL = 'bee@papercusp.dev';

/** The git Co-authored-by trailer GitHub parses for co-author attribution. */
export const AGENT_COAUTHOR_TRAILER = `Co-authored-by: ${PAPERCUSP_BEE_NAME} <${PAPERCUSP_BEE_EMAIL}>`;

/** Human-visible one-liner: this PR was opened by an agent on the operator's behalf. */
export const AGENT_BODY_MARKER =
  '☕ Agent-authored by a Papercusp Bee — opened as the human operator; only the agency is marked.';

/** True when `body` already carries the agent co-author trailer. */
export function hasAgentTrailer(body: string): boolean {
  return body.includes(AGENT_COAUTHOR_TRAILER);
}

/**
 * Append the agent body-marker + Co-authored-by trailer to a PR body. Idempotent
 * (returns the body unchanged when the trailer is already present). The trailer is
 * separated from the body by a blank line so GitHub recognizes it as a trailer.
 */
export function appendAgentTrailer(body: string): string {
  if (hasAgentTrailer(body)) return body;
  const base = body.trimEnd();
  const parts = base.length > 0 ? [base, AGENT_BODY_MARKER, AGENT_COAUTHOR_TRAILER] : [AGENT_BODY_MARKER, AGENT_COAUTHOR_TRAILER];
  return parts.join('\n\n');
}
