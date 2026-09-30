/**
 * Workspace-global scope labels — the PG-FREE half of `pot-membership`.
 *
 * ## Why this is its own module
 *
 * Extracted for exactly the reason `platform-pot-slug` was (see that module's header,
 * and EI-19370922358009801): `pot-membership` imports `@papercusp/db-org` and
 * `hive-federation`, so a lean or pure consumer that needs only the CLASSIFIER cannot
 * import it without dragging a PG client in. The previous time that bit, the fix was a
 * hardcoded copy of the literal in `improvements/triage.ts`, which then drifted.
 * `scout/ungraded-scope` is the current such consumer: a near-pure module whose only
 * other imports are `type { Sql }` and one string constant.
 *
 * Everything here is re-exported from `pot-membership`, so every existing import of
 * `isWorkspaceGlobalLabel` keeps working unchanged.
 *
 * ## What a "workspace-global label" is
 *
 * A slug a row might carry INSTEAD of a real Pot/harness: the workspace-brain grain.
 * `operator:<ws>` matches by prefix; the bare workspace id (`papercusp-workspace`) is
 * a partition, not a Pot, and is caught by the `=== workspaceId` check.
 */

/**
 * The enumerable workspace-global labels — the recurring drift sources migration 649
 * re-homed. Deliberately private: consumers go through {@link isWorkspaceGlobalLabel}
 * or {@link enumerableWorkspaceGlobalLabels} so the set has exactly one reader.
 */
const WORKSPACE_GLOBAL_LABELS: ReadonlySet<string> = new Set([
  'operator',
  '*',
  '@singleton',
  'all',
  'hive-canary',
]);

/**
 * The `operator:<ws>` label family — open-ended, so it is matched by PREFIX rather
 * than enumerated. Exported so a non-TypeScript expression of this predicate (a SQL
 * `LIKE`, say) cites the same constant instead of re-typing the literal.
 */
export const WORKSPACE_GLOBAL_LABEL_PREFIX = 'operator:';

/**
 * The ENUMERABLE workspace-global labels for `workspaceId`.
 *
 * For callers that must express {@link isWorkspaceGlobalLabel} somewhere TypeScript
 * cannot run — a SQL `= ANY(...)`, a generated config.
 *
 * ⚠ Pair it with {@link WORKSPACE_GLOBAL_LABEL_PREFIX}: the `operator:<ws>` family
 * cannot be enumerated, so a caller that uses this list ALONE silently misses it —
 * and misses it as a FALSE NEGATIVE (rows quietly excluded), which is the failure
 * shape that does not announce itself.
 *
 * Derived from the same Set the predicate reads, so the two cannot drift: a label
 * added above reaches every consumer without a second edit.
 */
export function enumerableWorkspaceGlobalLabels(workspaceId?: string | null): string[] {
  const ws = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  return ws ? [...WORKSPACE_GLOBAL_LABELS, ws] : [...WORKSPACE_GLOBAL_LABELS];
}

/**
 * Is `slug` a workspace-global / non-Pot scope label rather than a concrete Pot?
 * A null/blank slug is the operator (workspace-global) scope. The workspace id
 * itself (`papercusp-workspace`) is a partition, not a Pot.
 */
export function isWorkspaceGlobalLabel(
  slug: string | null | undefined,
  workspaceId?: string | null,
): boolean {
  if (slug == null) return true;
  const s = slug.trim();
  if (s === '') return true;
  if (s.startsWith(WORKSPACE_GLOBAL_LABEL_PREFIX)) return true;
  if (workspaceId && s === workspaceId.trim()) return true;
  return WORKSPACE_GLOBAL_LABELS.has(s);
}
