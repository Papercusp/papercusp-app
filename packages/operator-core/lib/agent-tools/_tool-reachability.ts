/**
 * _tool-reachability.ts — EI-21655300007082004.
 *
 * A refusal that says "do X first with <other verb>" is only actionable if the
 * caller can REACH that verb. On a trimmed client surface it often cannot: the
 * ~850-tool catalog is exposed to a session as a seed, so a client-side
 * `select:`-style lookup for a perfectly real tool resolves NOTHING, which reads
 * as "that verb does not exist" rather than "it is not on your surface yet".
 * Measured 2026-09-05: `work_items:set_blocker` — named verbatim by the
 * `state:"blocked"` refusal in work_items/set_state.ts — did not resolve through
 * this session's client tool search, while `tools:find` resolved AND activated it
 * in one call.
 *
 * That is a DELIVERY defect, not a contract defect: the gate is right (a
 * reasonless blocked write must be refused), the named verb is right, and the
 * caller is nonetheless stuck. So the refusal names the route as well as the
 * verb — this is the sentence to append wherever a refusal directs a caller to
 * another tool.
 */

/**
 * How to reach `toolName` when the caller's client surface does not expose it.
 * Both routes are stable catalog entrypoints, so this cannot rot into naming a
 * verb that moved: `tools:find` activates the tool on the server surface, and
 * `tools:invoke` dispatches it server-side under its real identity regardless of
 * what the client has materialized.
 */
export function toolReachabilityHint(toolName: string): string {
  return (
    `If your client surface does not expose ${toolName}, that means it is not seeded ` +
    `for this session — not that it is missing: reach it with ` +
    `tools:find { query: "${toolName}" } (which activates it), or call it now with ` +
    `tools:invoke { name: "${toolName}", args: { … } }.`
  );
}
