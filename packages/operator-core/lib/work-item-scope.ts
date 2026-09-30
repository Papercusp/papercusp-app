/**
 * Work-item scope guards (unified-work-item-ledger-2026-06-21 P-001).
 *
 * A work-item's scope is either the global `operator` scope or a
 * `harness:<slug>` scope. The bug this guards against: a harness-ATTRIBUTABLE
 * item (e.g. a `red-test` watchdog signal for a specific harness's test file)
 * being silently filed as operator-global — because a caller/collector omitted
 * the harness and the create path defaulted scope to `operator`, or passed a
 * blank `harness:` with no slug. Such rows map to a NULL harness in the
 * work_items union view and DISAPPEAR from the (correctly) harness-scoped
 * Working pane.
 *
 * The guard makes a MALFORMED harness scope impossible to persist. `operator`
 * stays valid only as an EXPLICIT global choice — never as the accidental
 * result of a missing/blank harness. The behavioural other half (collectors
 * actually SETTING the owning harness) lives in the watchdog collectors.
 */

export const OPERATOR_SCOPE = 'operator';
const HARNESS_PREFIX = 'harness:';
const WILDCARD_HARNESS = '*';

function assertConcreteHarnessSlug(slug: string, original: string): void {
  if (slug === WILDCARD_HARNESS) {
    throw new Error(
      `work-item harness scope must name a concrete harness slug (got wildcard ${JSON.stringify(original)})`,
    );
  }
}

/** Throw if `scope` is not a well-formed work-item scope. */
export function assertScopeWellFormed(scope: string): void {
  if (typeof scope !== 'string' || scope.trim() === '') {
    throw new Error(`work-item scope must be a non-empty string (got ${JSON.stringify(scope)})`);
  }
  if (scope.startsWith(HARNESS_PREFIX) && scope.slice(HARNESS_PREFIX.length).trim() === '') {
    throw new Error(
      `work-item scope '${HARNESS_PREFIX}' requires a non-empty harness slug (got ${JSON.stringify(scope)})`,
    );
  }
  if (scope.startsWith(HARNESS_PREFIX)) {
    assertConcreteHarnessSlug(scope.slice(HARNESS_PREFIX.length).trim(), scope);
  }
}

/**
 * Build the canonical scope for an (optional) harness. A null/undefined harness
 * is the EXPLICIT global (`operator`) scope; a present-but-blank harness is a
 * caller bug and throws (rather than silently collapsing to operator).
 */
export function harnessScope(harness: string | null | undefined): string {
  if (harness == null) return OPERATOR_SCOPE;
  if (harness.trim() === '') {
    throw new Error(
      `harnessScope() given a blank harness — pass a non-empty slug, or null for the explicit operator scope`,
    );
  }
  const slug = harness.trim();
  assertConcreteHarnessSlug(slug, harness);
  return `${HARNESS_PREFIX}${slug}`;
}

/** The harness slug a scope names, or null for the global operator scope. */
export function harnessOfScope(scope: string): string | null {
  return scope.startsWith(HARNESS_PREFIX) ? scope.slice(HARNESS_PREFIX.length) : null;
}
