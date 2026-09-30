/**
 * Persistence for paired mobile devices and their push tokens.
 *
 * A paired phone is a `kind = 'mobile'` row of harness_shared.connected_apps
 * (migration 1244 generalized the old mobile_devices table so app keys can
 * live beside phones — see ./connected-apps/store.ts). Every query here is
 * pinned to kind = 'mobile', so an app key is never visible as a device and a
 * device JWT can never name an app row. `DeviceRow` keeps the device-shaped
 * column names the phone contract uses, aliased from the generalized ones.
 *
 * Goes through `withWorkspace()` so RLS on harness_shared.connected_apps
 * actually enforces the workspace boundary; app-role connections without
 * the GUC bypass it (canonical Drizzle/Knex RLS regression — see
 * spec/workspace-scoping).
 */
import { withWorkspace, getOrgPg } from '@papercusp/db-org';

export interface DeviceRow {
  device_id: string;
  user_email: string;
  workspace_id: string;
  device_kind: 'mobile';
  device_label: string | null;
  paired_at: Date;
  last_seen: Date | null;
  revoked_at: Date | null;
}

export interface PushTokenRow {
  device_id: string;
  platform: 'apns' | 'fcm';
  token: string;
  registered_at: Date;
}

export async function insertDevice(opts: {
  deviceId: string;
  userEmail: string;
  workspaceId: string;
  deviceLabel?: string;
}): Promise<void> {
  await withWorkspace(opts.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.connected_apps
        (id, user_email, workspace_id, kind, label, paired_at)
      VALUES (${opts.deviceId}, ${opts.userEmail}, ${opts.workspaceId}, 'mobile', ${opts.deviceLabel ?? null}, now())
      ON CONFLICT (id) DO NOTHING
    `;
  });
}

export async function listDevices(workspaceId: string): Promise<DeviceRow[]> {
  return withWorkspace(workspaceId, async (tx) => {
    return tx<DeviceRow[]>`
      SELECT id AS device_id, user_email, workspace_id, kind AS device_kind,
             label AS device_label, paired_at, last_seen, revoked_at
      FROM harness_shared.connected_apps
      WHERE kind = 'mobile' AND revoked_at IS NULL
      ORDER BY paired_at DESC
    `;
  });
}

export async function touchLastSeen(deviceId: string, workspaceId: string): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.connected_apps
      SET last_seen = now()
      WHERE id = ${deviceId} AND kind = 'mobile'
    `;
  });
}

export async function revokeDevice(deviceId: string, workspaceId: string): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`
      UPDATE harness_shared.connected_apps
      SET revoked_at = now()
      WHERE id = ${deviceId} AND kind = 'mobile'
    `;
  });
}

export async function isRevoked(deviceId: string): Promise<boolean> {
  // Read without workspace context — the auth middleware needs to check
  // before knowing which workspace the device belongs to. Uses admin role.
  const { sql } = getOrgPg();
  const rows = await sql<{ revoked_at: Date | null }[]>`
    SELECT revoked_at FROM harness_shared.connected_apps
     WHERE id = ${deviceId} AND kind = 'mobile' LIMIT 1
  `;
  if (rows.length === 0) return true; // unknown device → treat as revoked
  return rows[0].revoked_at != null;
}

/**
 * Every paired device across all workspaces — for the desktop "Manage
 * paired devices" panel. Admin role, no workspace GUC (same pattern as
 * `isRevoked`): a local Papercup install is single-user, so the desktop
 * legitimately sees every paired phone, and it has no device JWT to
 * scope by.
 */
export async function listAllDevices(): Promise<DeviceRow[]> {
  const { sql } = getOrgPg();
  return sql<DeviceRow[]>`
    SELECT id AS device_id, user_email, workspace_id, kind AS device_kind,
           label AS device_label, paired_at, last_seen, revoked_at
    FROM harness_shared.connected_apps
    WHERE kind = 'mobile' AND revoked_at IS NULL
    ORDER BY paired_at DESC
  `;
}

/**
 * Revoke a device by id alone — for the desktop revoke flow, which holds
 * the device id but no workspace context. A device id is globally unique
 * (the connected_apps PK — see the `ON CONFLICT (id)` in `insertDevice`); the
 * workspace-scoped `revokeDevice` is the phone-facing path.
 */
export async function revokeDeviceById(deviceId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.connected_apps
    SET revoked_at = now()
    WHERE id = ${deviceId} AND kind = 'mobile'
  `;
}

export async function upsertPushToken(opts: {
  deviceId: string;
  workspaceId: string;
  platform: 'apns' | 'fcm';
  token: string;
}): Promise<void> {
  await withWorkspace(opts.workspaceId, async (tx) => {
    await tx`
      INSERT INTO harness_shared.mobile_push_tokens (device_id, platform, token, registered_at)
      VALUES (${opts.deviceId}, ${opts.platform}, ${opts.token}, now())
      ON CONFLICT (device_id, platform)
      DO UPDATE SET token = EXCLUDED.token, registered_at = EXCLUDED.registered_at
    `;
  });
}

/**
 * Delete ONE push token (used by the dispatcher when the provider reports it permanently
 * invalid — FCM `UNREGISTERED`). Scoped through `withWorkspace` like every other write here,
 * so a token can only ever be reaped from the workspace that dispatched to it.
 *
 * Deleting the TOKEN row and not the DEVICE row is the deliberate choice: an unregistered
 * token means the app can no longer be reached at that address, not that the pairing was
 * revoked. The device keeps its identity (and its JWT) and simply re-registers a fresh token
 * on next launch via `upsertPushToken`, which is the normal recovery path.
 */
export async function deletePushToken(workspaceId: string, token: string): Promise<void> {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`DELETE FROM harness_shared.mobile_push_tokens WHERE token = ${token}`;
  });
}

/** Push targets for everyone in a workspace (used by the dispatcher). */
export async function pushTargetsForWorkspace(
  workspaceId: string,
): Promise<Array<{ platform: 'apns' | 'fcm'; token: string }>> {
  return withWorkspace(workspaceId, async (tx) => {
    return tx<{ platform: 'apns' | 'fcm'; token: string }[]>`
      SELECT t.platform, t.token
      FROM harness_shared.mobile_push_tokens t
      JOIN harness_shared.connected_apps d ON d.id = t.device_id
      WHERE d.kind = 'mobile' AND d.revoked_at IS NULL
    `;
  });
}

/**
 * Connection snapshot for ONE device — the read behind the phone's
 * connection-health tile (mobile-apps-revival-v2 P-010): is this device still
 * paired (row present + not revoked), when was it last seen, and which push
 * platforms has it registered a token for. One round-trip; scoped by workspace
 * GUC so a device only ever reads its own workspace's rows.
 */
export interface DeviceConnectionSnapshot {
  /** The device row exists (it was paired at some point). */
  exists: boolean;
  /** The device has been revoked (or does not exist) — its JWT is dead. */
  revoked: boolean;
  /** last_seen timestamp, if the device has ever been seen. */
  lastSeen: Date | null;
  /** When the device was paired, if it exists. */
  pairedAt: Date | null;
  /** Push platforms this device has a registered token for (fcm / apns). */
  pushPlatforms: Array<'apns' | 'fcm'>;
}

export async function deviceConnectionSnapshot(
  deviceId: string,
  workspaceId: string,
): Promise<DeviceConnectionSnapshot> {
  return withWorkspace(workspaceId, async (tx) => {
    const [device] = await tx<
      { revoked_at: Date | null; last_seen: Date | null; paired_at: Date }[]
    >`
      SELECT revoked_at, last_seen, paired_at
      FROM harness_shared.connected_apps
      WHERE id = ${deviceId} AND kind = 'mobile'
      LIMIT 1
    `;
    const tokens = await tx<{ platform: 'apns' | 'fcm' }[]>`
      SELECT platform
      FROM harness_shared.mobile_push_tokens
      WHERE device_id = ${deviceId}
    `;
    return {
      exists: device != null,
      revoked: device == null || device.revoked_at != null,
      lastSeen: device?.last_seen ?? null,
      pairedAt: device?.paired_at ?? null,
      pushPlatforms: tokens.map((t) => t.platform),
    };
  });
}
