/**
 * Retired canonical BRAIN session pointer
 * (native-terminal-desktop-2026-06-06 D-013), scoped per workspace (EI-908).
 *
 * `psu --brain` was retired 2026-06-21. These helpers remain only so old
 * pinned rows can be read/migrated/cleaned without reintroducing the launch
 * path.
 *
 * EI-908 (root fix): the pin was ONE global unscoped `brain_session_id` row.
 * A `.papercusp-hive-demo` instance brain launch overwrote it (last-write-wins),
 * so `wake-brain` and the desktop dock both resolved the WRONG (demo) session —
 * the real desktop Queen was never woken and the dock resumed a dead/foreign
 * session (blank panes). The fix scopes the pin per workspace
 * (`brain_session_id:<workspaceId>`), so a demo instance (its own workspace)
 * can never clobber the main desktop's pin. The desktop's main Queen lives in
 * the ACTIVE workspace; a demo hive instance launches against a different
 * workspace, landing under a different key.
 *
 * Historical behavior: POST bootstrap-su with `brain: true` wrote the pin,
 * GET bootstrap-su/brain read it, and the wake-brain routine woke it.
 */
import { getOrgPg } from '@papercusp/db-org';

/**
 * Pre-EI-908 GLOBAL key. Kept only so the one legacy unscoped row can be
 * migrated into the active workspace's scoped key (and then deleted). Never
 * written or read as a live pin again — a scoped read NEVER falls back to it
 * (that fallback is exactly how a demo value clobbered the desktop brain).
 */
export const LEGACY_BRAIN_SESSION_KEY = 'brain_session_id';

/** The workspace-scoped operator_settings key for a workspace's pinned brain. */
export function brainSessionKey(workspaceId: string): string {
  return `${LEGACY_BRAIN_SESSION_KEY}:${workspaceId}`;
}

/**
 * Pin `nativeSessionId` as the canonical brain for `workspaceId` (upsert — one
 * row per workspace, last write wins within a workspace). Different workspaces
 * never collide (EI-908).
 */
export async function setBrainSession(workspaceId: string, nativeSessionId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (
      ${brainSessionKey(workspaceId)},
      ${nativeSessionId},
      'The canonical brain session (native uuid) the desktop chat dock resumes for this workspace (native-terminal-desktop D-013; workspace-scoped EI-908).',
      ${Date.now()},
      ${workspaceId}
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

/**
 * The pinned brain's native session uuid for `workspaceId`, or null when no
 * brain is pinned yet for that workspace.
 *
 * Best-effort migration of the single pre-EI-908 unscoped row: if this
 * workspace has no scoped pin but a legacy global row exists, adopt it INTO
 * this workspace's scoped key and delete the legacy row, then return it. The
 * legacy row is workspace-ambiguous, so it is adopted by whichever workspace
 * reads first — in practice the desktop's active workspace (the dock + the
 * active-workspace `wake-brain` tick), which is the intended owner. Once
 * migrated the legacy row is gone, so a stale demo value can never resurface.
 */
export async function getBrainSession(workspaceId: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT value FROM harness_shared.operator_settings WHERE key = ${brainSessionKey(workspaceId)} LIMIT 1
  `;
  const scoped = (rows[0] as { value?: string } | undefined)?.value?.trim() || null;
  if (scoped) return scoped;
  return migrateLegacyPin(workspaceId);
}

/**
 * Adopt the legacy unscoped `brain_session_id` row into `workspaceId`'s scoped
 * key and delete it (one-time). Returns the adopted value, or null when there
 * is no legacy row. Done atomically so two concurrent readers can't double-adopt.
 */
async function migrateLegacyPin(workspaceId: string): Promise<string | null> {
  const { sql } = getOrgPg();
  // Move the legacy value into the scoped key and remove the legacy row in one
  // statement; RETURNING gives us the adopted value. If the legacy row is gone
  // (already migrated, or never existed) this is a no-op returning nothing.
  const moved = await sql`
    WITH legacy AS (
      DELETE FROM harness_shared.operator_settings
      WHERE key = ${LEGACY_BRAIN_SESSION_KEY}
      RETURNING value, updated_at
    )
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    SELECT
      ${brainSessionKey(workspaceId)},
      legacy.value,
      'Migrated from the pre-EI-908 unscoped brain pin (workspace-scoped).',
      legacy.updated_at,
      ${workspaceId}
    FROM legacy
    ON CONFLICT (key) DO NOTHING
    RETURNING value
  `;
  return (moved[0] as { value?: string } | undefined)?.value?.trim() || null;
}
