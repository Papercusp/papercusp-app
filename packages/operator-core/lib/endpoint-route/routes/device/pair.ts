/**
 * Device pairing + lifecycle routes — Phase E4 batch M1
 * (endpoint-unification-2026-05-21). Ported off `_hono/mobile.ts`;
 * URLs renamed `/api/mobile/*` → `/api/device/*` (P2b).
 *
 *   POST   /device/desktop/mint-pair-token   loopback-only
 *   GET    /device/desktop/devices           loopback-only
 *   DELETE /device/desktop/devices/:deviceId loopback-only
 *   POST   /device/pair                      unauthenticated (one-time token)
 *   POST   /device/workspace/switch          device JWT
 *   GET    /device/devices                   device JWT
 *   DELETE /device/devices/:deviceId         device JWT
 *   GET    /device/runtime-config            device JWT
 *   GET    /device/workspaces                device JWT
 *   POST   /device/heartbeat                 device JWT
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal, isLoopbackHost } from './_shared';
import { signDeviceToken } from '../../../device-jwt';
import { getMobileVoicePort } from '../../../device-voice-ws';
import { advertisedBaseUrls, lanAddress } from '../../../device-base-urls';
import { mintPairToken, consumePairToken, newDeviceId } from '../../../device-pair-store';
import { readRegistry, workspaceById } from '../../../workspace-registry';
import {
  insertDevice,
  listAllDevices,
  listDevices,
  revokeDevice,
  revokeDeviceById,
  touchLastSeen,
} from '../../../device-store';

/** `host:port` → the port, else null (tunnel hosts carry no explicit port). */
function portOf(host: string | undefined): string | null {
  const m = host?.match(/:(\d+)$/);
  return m ? m[1] : null;
}

/**
 * POST /device/desktop/mint-pair-token — loopback-only. Launched from
 * the desktop settings UI; the response carries the QR payload the
 * phone scans. Host-header loopback gate (spoofable by a determined
 * LAN attacker — see the legacy comment; real exposure needs a 127.0.0.1
 * bind or a proper auth check).
 */
const mintPairTokenRoute = defineTool({
  method: 'POST',
  path: '/device/desktop/mint-pair-token',
  auth: 'public',
  // No `cors` — loopback-only (Host-gated), called same-origin by the
  // desktop operator UI; nothing reaches it cross-origin.
  input: z.object({ workspaceId: z.string().min(1) }),
  async handler(req, ctx) {
    if (!isLoopbackHost(req)) {
      return Response.json({ error: 'loopback_only' }, { status: 403 });
    }
    const { workspaceId } = ctx.input;
    if (!workspaceById(workspaceId)) {
      return Response.json({ error: 'workspace_not_found' }, { status: 400 });
    }
    // The legacy `desktopAuth` middleware set a fixed sessionUser.
    const sessionUserEmail = 'local@desktop';

    // Phone needs to reach the desktop. Override hierarchy:
    //   1. MOBILE_DESKTOP_PUBLIC_URL — full URL (phone may not be on LAN)
    //   2. MOBILE_DESKTOP_HOST       — host:port (mesh DNS)
    //   3. detected LAN IP + the incoming request's port
    //   4. request Host (desktop-local browser only)
    const reqHost = req.headers.get('host') ?? 'localhost:3055';
    const port = reqHost.includes(':') ? reqHost.split(':')[1] : '3055';
    const lan = lanAddress();
    const publicUrl = process.env.MOBILE_DESKTOP_PUBLIC_URL;
    const desktopHost = publicUrl
      ? publicUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
      : (process.env.MOBILE_DESKTOP_HOST ?? (lan ? `${lan}:${port}` : reqHost));
    const serverUrl = publicUrl
      ? publicUrl.replace(/\/$/, '')
      : `http://${desktopHost}`;

    const { pairToken, expiresAt } = await mintPairToken({
      workspaceId,
      desktopHost,
      userEmail: sessionUserEmail,
    });
    return Response.json({
      qrPayload: { server: serverUrl, pairToken, workspaceId },
      expiresAt,
    });
  },
});

/**
 * GET /device/desktop/devices — loopback-only. Backs the desktop
 * "Manage paired devices" panel. Lists every paired device across all
 * workspaces — a local Papercup install is single-user, and the desktop
 * holds no device JWT to scope by. The phone-facing equivalent is the
 * workspace-scoped `GET /device/devices`.
 */
const desktopDevicesListRoute = defineTool({
  method: 'GET',
  path: '/device/desktop/devices',
  auth: 'public',
  // No `cors` — loopback-only, same-origin desktop UI call (like mint-pair-token).
  async handler(req) {
    if (!isLoopbackHost(req)) {
      return Response.json({ error: 'loopback_only' }, { status: 403 });
    }
    const rows = await listAllDevices();
    return Response.json({
      devices: rows.map((d) => ({
        device_id: d.device_id,
        device_label: d.device_label,
        paired_at: d.paired_at,
        last_seen: d.last_seen,
        workspace_id: d.workspace_id,
      })),
    });
  },
});

/**
 * DELETE /device/desktop/devices/:deviceId — loopback-only. Desktop-side
 * revoke from the "Manage paired devices" panel; revokes by device id
 * alone (globally unique). The phone-facing equivalent is the
 * workspace-scoped `DELETE /device/devices/:deviceId`.
 */
const desktopDeviceRevokeRoute = defineTool({
  method: 'DELETE',
  path: '/device/desktop/devices/:deviceId',
  auth: 'public',
  async handler(req, ctx) {
    if (!isLoopbackHost(req)) {
      return Response.json({ error: 'loopback_only' }, { status: 403 });
    }
    await revokeDeviceById(ctx.params.deviceId);
    return Response.json({ ok: true });
  },
});

/**
 * POST /device/pair — phone redeems a one-time pair token for a
 * long-lived device JWT. Unauthenticated by design.
 */
const pairRoute = defineTool({
  method: 'POST',
  path: '/device/pair',
  auth: 'public',
  cors: true,
  input: z.object({ pairToken: z.string().min(1) }),
  async handler(_req, ctx) {
    const pending = await consumePairToken(ctx.input.pairToken);
    if (!pending) {
      return Response.json({ error: 'invalid_or_expired_token' }, { status: 401 });
    }
    const deviceId = newDeviceId();
    const deviceToken = signDeviceToken({
      sub: deviceId,
      workspace_id: pending.workspaceId,
      device_kind: 'mobile',
      user_email: pending.userEmail,
    });
    await insertDevice({
      deviceId,
      userEmail: pending.userEmail ?? 'unknown@local',
      workspaceId: pending.workspaceId,
    });
    const defguardEnrollmentUrl =
      process.env.DEFGUARD_ENROLLMENT_URL ?? 'https://mesh.papercuspai.com/enroll';
    return Response.json({
      deviceToken,
      deviceId,
      desktopHost: pending.desktopHost,
      workspaceId: pending.workspaceId,
      defguardEnrollmentUrl,
      // Additive (on-desktop-direct-lan-voice-2026-07-14 P-005): every route
      // to this desktop, preference order mesh → lan → tunnel. Old clients
      // keep reading `desktopHost`; new clients probe this list (P-006).
      baseUrls: advertisedBaseUrls({ port: portOf(pending.desktopHost) }),
    });
  },
});

/**
 * POST /device/workspace/switch — re-issue the device token bound to a
 * different workspace. The target must exist in the local registry.
 */
const workspaceSwitchRoute = defineTool({
  method: 'POST',
  path: '/device/workspace/switch',
  auth: DEVICE_AUTH,
  cors: true,
  input: z.object({ workspaceId: z.string().min(1) }),
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    if (!workspaceById(ctx.input.workspaceId)) {
      return Response.json({ error: 'workspace_not_found' }, { status: 403 });
    }
    const deviceToken = signDeviceToken({
      sub: principal.slug,
      workspace_id: ctx.input.workspaceId,
      device_kind: 'mobile',
      user_email: principal.label,
    });
    return Response.json({ deviceToken, workspaceId: ctx.input.workspaceId });
  },
});

/** GET /device/devices — paired devices in this device's workspace. */
const devicesListRoute = defineTool({
  method: 'GET',
  path: '/device/devices',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    const rows = await listDevices(principal.workspaceId);
    return Response.json({
      devices: rows.map((d) => ({
        device_id: d.device_id,
        device_label: d.device_label,
        paired_at: d.paired_at,
        last_seen: d.last_seen,
        workspace_id: d.workspace_id,
      })),
    });
  },
});

/** DELETE /device/devices/:deviceId — revoke a paired device. */
const deviceRevokeRoute = defineTool({
  method: 'DELETE',
  path: '/device/devices/:deviceId',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    await revokeDevice(ctx.params.deviceId, principal.workspaceId);
    return Response.json({ ok: true });
  },
});

/** GET /device/runtime-config — config the phone needs after pairing. */
const runtimeConfigRoute = defineTool({
  method: 'GET',
  path: '/device/runtime-config',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    const meshHost =
      process.env.MOBILE_MESH_HOST ??
      process.env.MOBILE_DESKTOP_HOST ??
      'localhost:3055';
    return Response.json({
      meshHost,
      workspaceId: principal.workspaceId,
      deviceKind: 'mobile' as const,
      voiceWs: {
        // null when the voice WS failed to bind — phone shows
        // "voice unavailable" instead of silently failing to connect.
        port: getMobileVoicePort(),
        path: '/api/device/voice',
      },
      // Additive (P-005): the fresh multi-path advertise list — a paired
      // phone re-reads this on app start / network change and re-probes
      // mesh → lan → tunnel (P-006).
      baseUrls: advertisedBaseUrls(),
    });
  },
});

/**
 * GET /device/workspaces — every workspace visible to this device.
 * A paired phone implicitly belongs to the desktop user, so it sees the
 * full local registry. Field name `name` matches the Rust client's
 * `WorkspaceItem` decoder (`label` made the iOS Settings tab fail).
 */
const workspacesRoute = defineTool({
  method: 'GET',
  path: '/device/workspaces',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    const reg = readRegistry();
    return Response.json({
      workspaces: reg.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        current: w.id === principal.workspaceId,
      })),
    });
  },
});

/** POST /device/heartbeat — bump last_seen for the "active 3m ago" badge. */
const heartbeatRoute = defineTool({
  method: 'POST',
  path: '/device/heartbeat',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    await touchLastSeen(principal.slug, principal.workspaceId);
    return Response.json({ ok: true });
  },
});

export default [
  mintPairTokenRoute,
  desktopDevicesListRoute,
  desktopDeviceRevokeRoute,
  pairRoute,
  workspaceSwitchRoute,
  devicesListRoute,
  deviceRevokeRoute,
  runtimeConfigRoute,
  workspacesRoute,
  heartbeatRoute,
];
