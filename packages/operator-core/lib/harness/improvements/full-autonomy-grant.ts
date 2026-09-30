/**
 * full-autonomy-grant.ts — the ONE reader of the owner FULL-AUTONOMY grant for the
 * self-improvement loop (queen-autonomy-and-selffeed-fix-2026-06-15 Phase 2).
 *
 * The grant (`FLAGS.MUG_FULL_AUTONOMY`) is read at the `autonomy:<ws>` scope — the
 * SAME key the autonomy decider reads (lib/autonomy/decider.ts `isFullAutonomy`) — so a
 * single owner flip covers BOTH the decision gate (the Queen auto-deciding the residue)
 * AND this implement lane (lifting the protected-path/keyword TCB bars in
 * `classifyImprovement`). Centralised here so the scope key can't drift across the three
 * call sites (the implement-dispatch action + the improvements:digest / :triage tools).
 *
 * Fail-DARK: a flag-IO error returns `false` — a hiccup must never grant the residue.
 * The pure tier logic stays in {@link ./policy} (no IO); this is the thin IO seam.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

/** Is the owner FULL-AUTONOMY grant active for this workspace? Fail-dark to false. */
export async function readOwnerFullAutonomyGrant(workspaceId: string): Promise<boolean> {
  try {
    return await getFlag(FLAGS.MUG_FULL_AUTONOMY, `autonomy:${workspaceId}`);
  } catch {
    return false; // fail-DARK: a flag hiccup must never grant full autonomy
  }
}
