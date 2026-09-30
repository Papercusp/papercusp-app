/**
 * hive-directory-meta.ts — persistence for a workspace's OWNED hive directory
 * metadata (p2p-hive-directory-2026-06-06 P-004).
 *
 * The hive create/edit surface carries title + description + visibility; this is
 * where those land. Stored in the `harness_registry` blob (workspace PG, no
 * migration) keyed by potId, alongside the deployment frames. The boot-join
 * (hive-directory-boot.ts) reads `listOwnedHiveMeta()` to register + announce a
 * workspace's public/invite hives; `saveOwnedHiveMeta` is the create/edit write.
 *
 * Pure persistence — the directory register/announce is done by
 * `publishHiveToDirectory` (hive-publish.ts), which the create/edit TOOL calls
 * after saving so a metadata change converges promptly.
 */

import { loadHarnessRegistry, mutateHarnessRegistry } from './harness-registry';
import type { HiveDirectoryMeta } from './hive-publish';

/** A joined remote_hive is a VIEW, never an owned directory publisher. A
 * release seed can contain stale owner metadata copied from the source box;
 * treat the registry's explicit role as authoritative so legacy installs do
 * not announce someone else's hive or ask for its private key. */
function isRemoteHiveView(
  reg: Awaited<ReturnType<typeof loadHarnessRegistry>>,
  potId: string,
): boolean {
  return reg.projects.some(
    (project) =>
      project.slug === potId &&
      project.harness_kind === 'hive' &&
      project.remote_hive === true,
  );
}

/** All owned hive metadata for a workspace, newest-created first. */
export async function listOwnedHiveMeta(workspaceId?: string): Promise<HiveDirectoryMeta[]> {
  const reg = await loadHarnessRegistry(workspaceId);
  return Object.values(reg.hiveDirectoryMeta ?? {})
    .filter((meta) => !isRemoteHiveView(reg, meta.potId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** One hive's metadata, or null. */
export async function getOwnedHiveMeta(potId: string, workspaceId?: string): Promise<HiveDirectoryMeta | null> {
  const reg = await loadHarnessRegistry(workspaceId);
  if (isRemoteHiveView(reg, potId)) return null;
  return reg.hiveDirectoryMeta?.[potId] ?? null;
}

/** Create or update a hive's directory metadata (the create/edit write). */
export async function saveOwnedHiveMeta(meta: HiveDirectoryMeta, workspaceId?: string): Promise<void> {
  if (!meta.potId || typeof meta.potId !== 'string') {
    // A missing potId stores the entry under the literal key "undefined"; every
    // boot then tries to wire hive "undefined" and fires the owner-key-missing
    // alarm forever (observed live 2026-07-16, cross-hive-boot).
    throw new Error(`saveOwnedHiveMeta: meta.potId is required (got ${JSON.stringify(meta.potId)})`);
  }
  if (meta.visibility === 'invite' && !meta.inviteSecret) {
    throw new Error(`saveOwnedHiveMeta: hive ${meta.potId} is invite-visibility but has no inviteSecret`);
  }
  // Atomic RMW (audit P-006 class) — and saveHarnessRegistry historically
  // DROPPED hiveDirectoryMeta on write, so this module's saves never stuck.
  await mutateHarnessRegistry(
    (reg) => ({
      ...reg,
      hiveDirectoryMeta: { ...(reg.hiveDirectoryMeta ?? {}), [meta.potId]: meta },
    }),
    workspaceId,
  );
}

/** Remove a hive's directory metadata (delete / stop publishing). */
export async function deleteOwnedHiveMeta(potId: string, workspaceId?: string): Promise<void> {
  await mutateHarnessRegistry((reg) => {
    if (!reg.hiveDirectoryMeta?.[potId]) return reg;
    const { [potId]: _gone, ...rest } = reg.hiveDirectoryMeta;
    return { ...reg, hiveDirectoryMeta: rest };
  }, workspaceId);
}
