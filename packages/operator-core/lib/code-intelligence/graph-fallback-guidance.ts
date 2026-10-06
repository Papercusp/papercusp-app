/**
 * P-006: what an agent does when selective graph assistance does NOT answer.
 *
 * Dependency-free on purpose: the routing advisory (bash-substitution
 * definition lookup, loaded by the PreToolUse hook) and `selective-assist.ts`
 * both import it, so "graph failure preserves the existing work route" is worded
 * once. It lives beside — not inside — `contracts.ts` so adding it does not
 * re-stale the measured proofs bound to that file.
 *
 * A not-found / ambiguous / error / behind-HEAD graph answer means "graph
 * unavailable" — never "no such symbol" — and a returned site is a lead to
 * confirm against current source, not a verdict.
 */
export const GRAPH_FAILURE_FALLBACK_GUIDANCE =
  'If it answers not-found, ambiguous, an error, or a freshness note says the index is behind HEAD, that means "graph unavailable", NOT "no such symbol": keep the grep/`lsp:query` you were about to run, and confirm any returned site against the current source before editing.';
