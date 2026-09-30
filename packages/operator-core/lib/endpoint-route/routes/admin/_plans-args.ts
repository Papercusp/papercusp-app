/**
 * Pure argument-coercion helper for the /api/admin/plans/* routes.
 *
 * Lives in its own module (no agent-mcp / tool-registry imports) so it
 * can be unit-tested without dragging in the whole projected-tool
 * catalog. `plans.ts` is the only production importer.
 */

/**
 * The plans:* argument names whose values are `z.boolean()` (NOT
 * `z.coerce.boolean()`) in the tool schemas. Only these get
 * 'true'/'false' → boolean coercion when projected from a query
 * string; every other arg is forwarded verbatim as a string.
 *
 * Keeping this an explicit allowlist — rather than coercing any
 * 'true'/'false'-looking value — is load-bearing: `plans:search`
 * takes a free-text `query`, and a user searching for the literal
 * word "true" must not have their query rewritten to the boolean
 * `true` (which Zod then rejects against `z.string().min(1)`).
 */
export const PLANS_BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'includeArchived',
  'includeLegacy',
  'includeHistory',
  'includeEnrichments',
  'actionable',
  'needsHuman',
]);

/**
 * The plans:* argument names whose values are `z.number()` and need
 * URL-string → number coercion when projected from a query string.
 * Like PLANS_BOOLEAN_KEYS this is an explicit allowlist so we don't
 * accidentally coerce a free-text query that happens to look numeric.
 */
export const PLANS_NUMBER_KEYS: ReadonlySet<string> = new Set([
  'limit',
  'files_back',
  'audit_rows',
  'notes_max_chars',
  'debug_max_chars',
]);

/**
 * Convert URL searchParams to a JSON body for an internal POST
 * dispatch into a plans:* tool.
 *
 *   - repeated key            → string[]   (`?paths=a&paths=b`)
 *   - boolean-keyed 'true'    → true
 *   - boolean-keyed 'false'   → false
 *   - boolean-keyed garbage   → dropped    (caller passed nonsense)
 *   - everything else         → string
 */
export function bodyFromSearchParams(p: URLSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const key of p.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const all = p.getAll(key);
    if (all.length > 1) {
      body[key] = all;
      continue;
    }
    const v = all[0] ?? '';
    if (PLANS_BOOLEAN_KEYS.has(key)) {
      if (v === 'true') body[key] = true;
      else if (v === 'false') body[key] = false;
      // anything else for a boolean key: drop (caller passed garbage)
    } else if (PLANS_NUMBER_KEYS.has(key)) {
      const n = Number(v);
      if (Number.isFinite(n)) body[key] = n;
      // garbage numeric: drop (let the tool's default kick in)
    } else {
      body[key] = v;
    }
  }
  return body;
}
