/**
 * The per-workspace Remote access switch (external-app-access-to-workspaces-2026-09-29 P-010,
 * decision D-025; migration 1263, harness_shared.connected_app_access_settings).
 *
 * On (the default — a workspace with no row is on): connected-app keys work as their own state
 * allows. Off: the instant kill switch — every app key, service key and client-credentials access
 * token of the workspace is refused on its next request with `remote_access_off` (R-24, R-41).
 *
 * This module only reads and writes the switch. ENFORCEMENT is in ./store.ts: `verifyAppKey` and
 * the token endpoint's `loadClientKeyRow` read the switch in the same query as the key, and
 * `appKeyVerdictOf` / `accessTokenVerdictOf` refuse on it. Nothing caches it, so turning it off
 * takes effect on the very next call.
 *
 * Both functions run inside `withWorkspace()`, so the table's RLS policy bounds them to the
 * caller's workspace.
 */

import { withWorkspace } from '@papercusp/db-org';

export interface RemoteAccessSetting {
  workspaceId: string;
  enabled: boolean;
  /** When the switch last changed. Null = never touched (on by default). */
  changedAt: Date | null;
  /** Who changed it last. Null = never touched. */
  changedBy: string | null;
}

interface SettingRow {
  workspace_id: string;
  enabled: boolean;
  changed_at: Date;
  changed_by: string | null;
}

function settingOf(workspaceId: string, row: SettingRow | undefined): RemoteAccessSetting {
  if (!row) return { workspaceId, enabled: true, changedAt: null, changedBy: null };
  return { workspaceId, enabled: row.enabled, changedAt: row.changed_at, changedBy: row.changed_by };
}

/**
 * One entry of the Remote access screen's list (R-26, D-007): a paired phone ('mobile'), an app key
 * ('app') or a service key ('service'). Revoked entries are not listed — revoke is permanent and
 * the screen manages what can still act.
 */
export interface RemoteAccessEntry {
  id: string;
  kind: 'mobile' | 'app' | 'service';
  label: string | null;
  /** Who created it (display only: a service key keeps working after its creator leaves, D-007). */
  creator: string;
  scopes: { capabilities?: string[]; tools?: string[]; harnesses?: string[] };
  pairedAt: Date;
  lastSeen: Date | null;
  lastIp: string | null;
  expiresAt: Date | null;
  pausedAt: Date | null;
  spendCapCents: number | null;
  spendCapWindowSec: number | null;
  rotatedAt: Date | null;
  previousKeyValidUntil: Date | null;
  /** 'client_secret' | 'private_key_jwt' when the service key is an OAuth client (P-016). */
  clientAuth: string | null;
}

interface EntryRow {
  id: string;
  kind: RemoteAccessEntry['kind'];
  label: string | null;
  user_email: string;
  scopes: RemoteAccessEntry['scopes'] | null;
  paired_at: Date;
  last_seen: Date | null;
  last_ip: string | null;
  expires_at: Date | null;
  paused_at: Date | null;
  spend_cap_cents: number | null;
  spend_cap_window_sec: number | null;
  rotated_at: Date | null;
  previous_token_valid_until: Date | null;
  client_auth: string | null;
}

/** Every phone, app key and service key of the workspace that is not revoked, newest first. */
export async function listRemoteAccessEntries(workspaceId: string): Promise<RemoteAccessEntry[]> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<EntryRow[]>`
    SELECT id, kind, label, user_email, scopes, paired_at, last_seen, last_ip, expires_at, paused_at,
           spend_cap_cents::float8 AS spend_cap_cents, spend_cap_window_sec, rotated_at,
           previous_token_valid_until, client_auth
      FROM harness_shared.connected_apps
     WHERE workspace_id = ${workspaceId}
       AND kind IN ('mobile', 'app', 'service')
       AND revoked_at IS NULL
     ORDER BY paired_at DESC
  `);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    creator: r.user_email,
    scopes: r.scopes ?? {},
    pairedAt: r.paired_at,
    lastSeen: r.last_seen,
    lastIp: r.last_ip,
    expiresAt: r.expires_at,
    pausedAt: r.paused_at,
    spendCapCents: r.spend_cap_cents,
    spendCapWindowSec: r.spend_cap_window_sec,
    rotatedAt: r.rotated_at,
    previousKeyValidUntil: r.previous_token_valid_until,
    clientAuth: r.client_auth,
  }));
}

/** The workspace's switch. A workspace that never set it is on. */
export async function getRemoteAccess(workspaceId: string): Promise<RemoteAccessSetting> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<SettingRow[]>`
    SELECT workspace_id, enabled, changed_at, changed_by
      FROM harness_shared.connected_app_access_settings
     WHERE workspace_id = ${workspaceId}
  `);
  return settingOf(workspaceId, rows[0]);
}

/**
 * Turn the workspace's Remote access on or off. Takes effect on the next request of every
 * connected-app credential of the workspace. Returns the stored setting.
 */
export async function setRemoteAccess(
  workspaceId: string,
  enabled: boolean,
  changedBy: string | null,
): Promise<RemoteAccessSetting> {
  const rows = await withWorkspace(workspaceId, async (tx) => tx<SettingRow[]>`
    INSERT INTO harness_shared.connected_app_access_settings (workspace_id, enabled, changed_at, changed_by)
    VALUES (${workspaceId}, ${enabled}, now(), ${changedBy})
    ON CONFLICT (workspace_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at, changed_by = EXCLUDED.changed_by
    RETURNING workspace_id, enabled, changed_at, changed_by
  `);
  return settingOf(workspaceId, rows[0]);
}
