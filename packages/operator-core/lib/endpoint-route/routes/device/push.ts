/**
 * Device push-token registration — mobile-apps-revival-redesign-2026-06-05
 * (D-001 break #2 / D-004 backend half).
 *
 *   POST /device/push/register   device JWT
 *
 * The phone registers its FCM (Android) / APNs (iOS) token here after
 * pairing + on every token rotation. The token lands in
 * harness_shared.mobile_push_tokens (migration 009), keyed by
 * (device_id, platform), and the existing send path
 * (device-push-dispatcher.notifyWorkspace ← attention-notify) fans a
 * push out to every registered token in the workspace when an inbox
 * event fires (escalation / smoke-fail / needs-human).
 *
 * The route that this rebuilds (`POST /api/device/push/register`) went
 * missing in the endpoint-route migration (Phase E4) — the storage
 * helper (`upsertPushToken`) and the whole dispatch path survived, but
 * nothing collected the token, so mobile was a polling viewer. This
 * closes the loop: with it, push is the owner's remote control (D-004).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { upsertPushToken } from '../../../device-store';

/**
 * POST /device/push/register — upsert this device's push token.
 *
 * Body: `{ platform: 'fcm' | 'apns', token: string }`. Idempotent — a
 * re-register (token rotation) overwrites in place via the
 * (device_id, platform) PK. Scoped to the device principal's workspace
 * so a push only reaches the workspace the device is paired to.
 */
const pushRegister = defineTool({
  method: 'POST',
  path: '/device/push/register',
  auth: DEVICE_AUTH,
  cors: true,
  input: z.object({
    platform: z.enum(['fcm', 'apns']),
    token: z.string().min(1),
  }),
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    await upsertPushToken({
      deviceId: principal.slug,
      workspaceId: principal.workspaceId,
      platform: ctx.input.platform,
      token: ctx.input.token,
    });
    return Response.json({ ok: true });
  },
});

export default [pushRegister];
