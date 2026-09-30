/**
 * The ONE fallback rule for the operator's free-form prompt + preferences.
 *
 * Two readers render the same editor: the REST route
 * `GET /api/agent-mcp/operator-config` (endpoint-route/routes/agent-mcp/
 * operator-config.ts) and the sync resolver `operatorConfig.byWorkspace`
 * (sync-resolver/index.ts). They read the same two `operator_state` tables, so
 * they must agree on what an UNSET table renders as — and they did not: the
 * route fell back to the templates below while the resolver returned ''. The
 * Settings › Papercup form seeds from the sync read, so a fresh install showed
 * an empty editor next to a Save button that would have written '' over the
 * template the REST readers still reported (EI-22439758558949990, found by the
 * independent portal-parity grader on :3081, reproducible on the operator
 * itself). Both readers now go through `operatorConfigContent`.
 *
 * Deliberately dependency-free (no defineTool, no PG): the resolver imports it
 * lazily beside operator-state-pg, and the route imports it at module scope.
 */

export const DEFAULT_PROMPT_USER = `# Operator voice + free-form preferences

(Edit this to shape Operator's tone and any free-form preferences that
don't belong in the structured \`preferences.md\` notebook. The
substrate-owned prompt — schema, tier rules, anti-patterns — is shown
read-only below.)
`;

export const DEFAULT_PREFS = `# Operator preferences (workspace-scoped)

(empty)
`;

/** A stored string wins (including ''); anything else renders the default. */
export function operatorConfigContent(
  raw: { content?: unknown } | null | undefined,
  fallback: string,
): string {
  return typeof raw?.content === 'string' ? raw.content : fallback;
}
