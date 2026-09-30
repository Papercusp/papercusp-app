/**
 * The canary IDENTITY contract: the immutable labels that bind a provisioned host to the canary
 * run that owns it.
 *
 * These three labels are the provenance the destroy gate demands before it will delete anything.
 * They live here — not in the test harness that first wrote them — because the whole defect this
 * module exists to close was that the ONLY writer of these keys was the fake provider harness, so
 * the unit suite was green precisely BECAUSE the harness satisfied the gate on the product's
 * behalf. Every writer and every reader now shares one definition:
 *
 *   - the provision route SYNTHESIZES them from a declared canary run (never from caller-supplied
 *     labels, which is why hand-writing one is refused there),
 *   - the canary route REFUSES to bind a run to a host whose stored spec does not already carry
 *     them, so the failure lands before a VM does work rather than at teardown when it is billing,
 *   - the destroy runner REQUIRES them, unchanged.
 *
 * Because all three call the same functions, provision and destroy cannot disagree about what a
 * canary host looks like.
 */

export const WORKSPACE_HOST_CANARY_TAG_KEYS = {
  canary: "papercusp_canary",
  runId: "papercusp_run_id",
  workspaceId: "papercusp_workspace_id",
} as const;

/** The run/workspace pair a canary host is bound to. */
export interface WorkspaceHostCanaryIdentity {
  readonly runId: string;
  readonly workspaceId: string;
}

/** Split of an identity audit, so a caller can keep contradiction and absence distinguishable. */
export interface WorkspaceHostCanaryIdentityAudit {
  /** Labels present but bound to a DIFFERENT run/workspace — never waivable. */
  readonly mismatched: readonly string[];
  /** Labels absent entirely — the pre-tagging case the audited manual path may waive. */
  readonly missing: readonly string[];
}

/**
 * The exact label set a host provisioned for `identity` must carry.
 *
 * This is the single synthesizer. A caller never supplies these values; the product derives them
 * from the run it is provisioning for, which is what makes them evidence rather than assertion.
 */
export function workspaceHostCanaryIdentityLabels(
  identity: WorkspaceHostCanaryIdentity,
): Readonly<Record<string, string>> {
  return {
    [WORKSPACE_HOST_CANARY_TAG_KEYS.canary]: "true",
    [WORKSPACE_HOST_CANARY_TAG_KEYS.runId]: identity.runId,
    [WORKSPACE_HOST_CANARY_TAG_KEYS.workspaceId]: identity.workspaceId,
  };
}

/** True when `key` is one of the three product-written canary identity labels. */
export function isWorkspaceHostCanaryIdentityLabelKey(key: string): boolean {
  return (Object.values(WORKSPACE_HOST_CANARY_TAG_KEYS) as readonly string[]).includes(key);
}

/**
 * Audit stored labels against the identity that claims them, keeping contradiction separate from
 * absence. The message wording deliberately names `desired.labels` on every surface so a refusal
 * read at provision, at canary bind, or at teardown points at the same stored field.
 */
export function workspaceHostCanaryIdentityAudit(
  labels: Readonly<Record<string, string>> | undefined,
  identity: WorkspaceHostCanaryIdentity,
): WorkspaceHostCanaryIdentityAudit {
  const present = labels ?? {};
  const required = workspaceHostCanaryIdentityLabels(identity);
  const problem = (key: string, value: string) => `stored desired.labels must contain '${key}=${value}'`;
  return {
    mismatched: Object.entries(required)
      .filter(([key, value]) => present[key] !== undefined && present[key] !== value)
      .map(([key, value]) => problem(key, value)),
    missing: Object.entries(required)
      .filter(([key]) => present[key] === undefined)
      .map(([key, value]) => problem(key, value)),
  };
}

/** Flat problem list — contradiction first, then absence. Empty means the host is bound to `identity`. */
export function workspaceHostCanaryIdentityProblems(
  labels: Readonly<Record<string, string>> | undefined,
  identity: WorkspaceHostCanaryIdentity,
): readonly string[] {
  const audit = workspaceHostCanaryIdentityAudit(labels, identity);
  return [...audit.mismatched, ...audit.missing];
}
