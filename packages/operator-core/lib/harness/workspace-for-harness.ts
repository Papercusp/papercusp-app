/**
 * resolveWorkspaceForHarness — the WI-148-aware "which workspace does THIS harness's
 * data live in" derive-or-throw, shared by the per-harness data surfaces (docs records,
 * plan attribution) that used to silently default an omitted workspace to 'default'
 * (workspace-data-isolation-leaks-2026-06-17 P-002 docs sub-part / P-005 / D-003).
 *
 * A harness's per-harness rows (harness_docs, harness_plan_parts, …) are keyed
 * (workspace_id, harness_slug); the workspace is a PROPERTY OF THE HARNESS, never a
 * caller default. Deriving it from the slug is the same SAFE forward half the plans
 * read/write path converged on (resolvePlanScope / fill_workspace_id_from_projects,
 * P-001): operator-home / '*' / 'all' / empty → PAPERCUSP_WORKSPACE_ID (the WI-148
 * part-B flip, in lockstep with migration 295's data move); a concrete slug → the
 * projects projection, then the authoritative harness registry; UNRESOLVABLE → THROW
 * (never a silent cross-workspace 'default').
 *
 * This is the thin, neutral wrapper so docs/* (and any future per-harness surface) can
 * derive a workspace WITHOUT importing the plans tooling wholesale or re-implementing
 * the operator-home short-circuit. It lives in its own module (not harness-core) because
 * the underlying fill_workspace_id_from_projects is defined in agent-tools/plans/source,
 * which itself imports harness-core — putting this there would be a cycle.
 */
import { fill_workspace_id_from_projects } from '../agent-tools/plans/source';

/**
 * Resolve `harnessSlug` → the workspace_id its data lives in, or THROW when the harness
 * is not registered in any workspace (refusing to silently default — WI-148 / D-003).
 *
 * Pass an explicit `workspaceId` (e.g. a test seam or a caller that already resolved
 * scope) to short-circuit the lookup — it is honored verbatim.
 */
export async function resolveWorkspaceForHarness(
  harnessSlug: string | undefined,
  workspaceId?: string,
): Promise<string> {
  if (workspaceId && workspaceId.trim()) return workspaceId.trim();
  const resolved = await fill_workspace_id_from_projects(harnessSlug);
  if (resolved === null) {
    throw new Error(
      `resolveWorkspaceForHarness: harness '${harnessSlug ?? ''}' is not registered in ` +
        `harness_shared.projects or the harness registry in any workspace, so the workspace ` +
        `its data lives in cannot be resolved. Register the harness, or pass an explicit ` +
        `workspaceId. (Refusing to silently default the workspace — workspace-data-isolation-leaks ` +
        `P-002/P-005, D-003.)`,
    );
  }
  return resolved;
}
