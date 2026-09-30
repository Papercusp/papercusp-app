/** Dependency-free claim-spec workspace partition resolver (WI-1564). */
export function resolveClaimSpecWorkspace(
  identWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identWorkspaceId?.trim();
  return ws && ws !== '*' ? ws : undefined;
}

/**
 * Resolve the concrete hive/harness scope for claim-spec tools.
 *
 * The HTTP projection uses `'*'` for an operator-scoped context. It is not a
 * real harness slug and must never reach a claimability query as one. An
 * explicit concrete argument wins; otherwise a concrete ambient scope is
 * inherited. A wildcard means "no concrete scope", so callers can reject or
 * deliberately choose their workspace-wide behavior instead of silently
 * measuring an empty literal-harness lane.
 */
export function resolveClaimSpecPotSlug(
  explicitHarness: string | undefined,
  ambientHarness: unknown,
): string | undefined {
  const explicit = explicitHarness?.trim();
  if (explicit && explicit !== '*') return explicit;
  if (typeof ambientHarness !== 'string') return undefined;
  const ambient = ambientHarness.trim();
  return ambient && ambient !== '*' ? ambient : undefined;
}
