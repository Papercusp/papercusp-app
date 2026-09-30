/**
 * workspace-scope-recall.ts — the P-006 (data-scoping-audit-2026-06-22 / D-004 / D-012)
 * workspace-scoped memory RECALL filter for the per-owner USER pool.
 *
 * The memory store recalls over scope keys [user.id, harness:<slug>, hive:<slug>]. The
 * harness/hive pools are already correctly scoped; the per-owner USER pool is recalled in
 * EVERY workspace, so an owner's `project` memories bleed across their workspaces (the
 * isolation leak this brief fixes). D-004: scope the user pool to the active workspace, with
 * a small OWNER-TIER exception — `user`/`feedback`/`reference` facts (the never-evicted
 * personal pool) follow the owner everywhere. Rides migration 398's generated `workspace_id`
 * column, surfaced into the recalled entry's `metadata.workspace_id`.
 *
 * Gated by FLAGS.MEMORY_WORKSPACE_SCOPED_RECALL. Owner-attended flip landed 2026-06-25 — the
 * live recall-hit-rate A/B was the watch, not a pre-gate — and the flag graduated OUT of
 * DARK_FLAGS (`libs/flags/src/types.ts`), so it now defaults ON (`FLAG_DEFAULTS[...] === true`).
 * The filter is CONSERVATIVE / NULL-safe by design: it drops a hit ONLY when it explicitly
 * carries a DIFFERENT workspace AND is not owner-tier — legacy rows with no workspace_id (the
 * bulk, pre-stamping) are always kept, so the flag was never able to silently gut recall. OFF
 * remains available as a reversible kill-switch if hit-rate ever regresses.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from '../flag-distinct-id';

/** Owner-tier kinds (remember.ts KINDS): personal facts that follow the owner across
 *  workspaces. `project` is the workspace-scoped kind. */
const OWNER_TIER_KINDS: ReadonlySet<string> = new Set(['user', 'feedback', 'reference']);

/** Is workspace-scoped memory recall ON? (FLAGS.MEMORY_WORKSPACE_SCOPED_RECALL; graduated,
 *  default ON since the 2026-06-25 owner-attended flip). Fail-closed (false) on a flag-read
 *  error, like the sibling isWorkspaceCoordinationOn — a read failure never widens recall. */
export async function isMemoryWorkspaceScopedRecallOn(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.MEMORY_WORKSPACE_SCOPED_RECALL, systemDistinctId());
  } catch {
    return false;
  }
}

/**
 * Keep a USER-pool recall hit for the active workspace? CONSERVATIVE — keep unless the hit
 * explicitly belongs to a DIFFERENT workspace and is not owner-tier:
 *   - no / empty workspace_id (legacy, pre-stamping)   → KEEP (no recall loss).
 *   - owner-tier kind (user/feedback/reference)         → KEEP (follows the owner).
 *   - no active workspace to compare against            → KEEP (fail-open).
 *   - otherwise (a `project` hit tagged another ws)     → DROP.
 * Apply ONLY to user-pool hits; harness:/hive: pools are already correctly scoped.
 */
export function keepUserPoolHitForWorkspace(
  hit: { kind?: string; metadata?: Record<string, unknown> | null },
  activeWorkspaceId: string | null | undefined,
): boolean {
  const ws = hit.metadata?.workspace_id;
  if (typeof ws !== 'string' || ws.length === 0) return true; // legacy / owner-global
  if (hit.kind && OWNER_TIER_KINDS.has(hit.kind)) return true; // owner-tier follows the owner
  if (!activeWorkspaceId) return true; // no active workspace → fail-open
  return ws === activeWorkspaceId; // project memory: only its own workspace
}
