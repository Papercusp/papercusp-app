/**
 * Harness membership operations — add / remove / move a harness across
 * workspaces. (Phase 3 of harnesses-across-workspaces, plan 2026-05-31.)
 *
 * A harness's registry entry (`ProjectEntry` = slug + absolute path) is
 * per-workspace: `harness_shared.harness_registry` holds one JSONB row per
 * workspace. "Membership" is therefore the set of workspace registries that
 * carry a given slug. These ops are pure registry edits and deliberately do
 * NOT:
 *   - touch the harness folder on disk — the path is a *link*; adding/removing
 *     a membership never moves or deletes the folder;
 *   - migrate run data — per decision D-1 the `harness_<slug>` schema is shared
 *     by slug across workspaces, so a move/copy carries no feature/run data.
 *
 * Multi-workspace membership is unblocked by migration 091 (composite
 * `(workspace_id, slug)` uniqueness). Note: until the runtime addressing work
 * (Phase 2) lands, `resolveProject(slug)` still resolves against the *active*
 * workspace only — so a harness present in a non-active workspace is registered
 * but not yet addressable from that workspace's routes. These ops are the
 * registry layer that Phase 2 builds on.
 */
import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type ProjectEntry,
} from './harness-registry';
import { readRegistry } from './workspace-registry';

export interface MembershipResult {
  workspaceId: string;
  slug: string;
  /** false when the op was a no-op (already present / already absent). */
  changed: boolean;
}

/** Every workspace id whose registry currently carries `slug`. */
export async function workspacesForHarness(slug: string): Promise<string[]> {
  const out: string[] = [];
  for (const ws of readRegistry().workspaces) {
    const reg = await loadHarnessRegistry(ws.id);
    if (reg.projects.some((p) => p.slug === slug)) out.push(ws.id);
  }
  return out;
}

/**
 * Add `entry` to `workspaceId`'s registry. No-op (changed:false) when a harness
 * with that slug is already registered there. Never touches the folder.
 */
export async function addHarnessToWorkspace(
  workspaceId: string,
  entry: ProjectEntry,
): Promise<MembershipResult> {
  const reg = await loadHarnessRegistry(workspaceId);
  if (reg.projects.some((p) => p.slug === entry.slug)) {
    return { workspaceId, slug: entry.slug, changed: false };
  }
  reg.projects.push(entry);
  await saveHarnessRegistry(reg, workspaceId);
  return { workspaceId, slug: entry.slug, changed: true };
}

/**
 * Remove `slug` from `workspaceId`'s registry. No-op when absent. Passes
 * `allowEmpty` so removing the workspace's last harness is permitted — this is
 * an intentional-removal path (like project-delete), not the accidental wipe
 * the guard protects against. Never deletes the folder.
 */
export async function removeHarnessFromWorkspace(
  workspaceId: string,
  slug: string,
): Promise<MembershipResult> {
  const reg = await loadHarnessRegistry(workspaceId);
  const next = reg.projects.filter((p) => p.slug !== slug);
  if (next.length === reg.projects.length) {
    return { workspaceId, slug, changed: false };
  }
  await saveHarnessRegistry({ projects: next }, workspaceId, { allowEmpty: true });
  return { workspaceId, slug, changed: true };
}

/**
 * Move `slug` from `fromWs` to `toWs`, carrying its existing `ProjectEntry`
 * (same path — the link is preserved). Adds to the destination FIRST, then
 * removes from the source, so an interruption leaves the harness in BOTH
 * workspaces (recoverable) rather than neither (lost). Throws if the harness
 * isn't in `fromWs`.
 */
export async function moveHarness(
  slug: string,
  fromWs: string,
  toWs: string,
): Promise<{ from: MembershipResult; to: MembershipResult }> {
  if (fromWs === toWs) {
    throw new Error(`moveHarness: source and destination workspace are the same ('${fromWs}')`);
  }
  const fromReg = await loadHarnessRegistry(fromWs);
  const entry = fromReg.projects.find((p) => p.slug === slug);
  if (!entry) {
    throw new Error(`moveHarness: harness '${slug}' is not registered in workspace '${fromWs}'`);
  }
  const to = await addHarnessToWorkspace(toWs, entry);
  const from = await removeHarnessFromWorkspace(fromWs, slug);
  return { from, to };
}
