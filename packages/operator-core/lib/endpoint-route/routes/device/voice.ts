/**
 * Device voice routes — Phase E4 batch M2 (endpoint-unification-2026-05-21).
 * Ported off `_hono/mobile.ts`; URLs renamed to `/api/device/*` (P2b).
 *
 *   GET    /device/voice-lease            device JWT
 *   POST   /device/voice-lease/claim      device JWT
 *   POST   /device/voice-lease/heartbeat  device JWT
 *   DELETE /device/voice-lease            device JWT
 *   GET    /device/voice-session-init     device JWT
 */
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { claimVoiceLease, releaseVoiceLease, readVoiceLease } from '../../../voice-lease';

/* ─── Voice lease — single-listener election across desktop + phone ──── */

const voiceLeaseGet = defineTool({
  method: 'GET',
  path: '/device/voice-lease',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const lease = await readVoiceLease(devicePrincipal(ctx).workspaceId);
    return Response.json({ lease });
  },
});

const voiceLeaseClaim = defineTool({
  method: 'POST',
  path: '/device/voice-lease/claim',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    await claimVoiceLease({
      workspaceId: principal.workspaceId,
      ownerKind: 'mobile',
      ownerId: principal.slug,
    });
    return Response.json({ ok: true });
  },
});

const voiceLeaseHeartbeat = defineTool({
  method: 'POST',
  path: '/device/voice-lease/heartbeat',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    await claimVoiceLease({
      workspaceId: principal.workspaceId,
      ownerKind: 'mobile',
      ownerId: principal.slug,
    });
    return Response.json({ ok: true });
  },
});

const voiceLeaseRelease = defineTool({
  method: 'DELETE',
  path: '/device/voice-lease',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    await releaseVoiceLease({
      workspaceId: principal.workspaceId,
      ownerId: principal.slug,
    });
    return Response.json({ ok: true });
  },
});

/* ─── Voice session init — mints an ElevenLabs Conv AI token ─────────── */

// Token mints don't bill directly, but each consumes the workspace
// concurrency slot for ~30s — spam-pair without protection would DoS
// the user's own voice sessions. EL credit-burn audit, fix #4.
const MOBILE_MINT_COOLDOWN_MS = 8_000;
const mobileMintInFlight = new Map<
  string,
  Promise<{ token: string } | { error: string; status: number; detail: string }>
>();

async function mintMobileElToken(
  agentId: string,
  apiKey: string,
  elSource: string,
): Promise<{ token: string } | { error: string; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}&source=${elSource}`,
      {
        method: 'GET',
        headers: { 'xi-api-key': apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    );
  } catch (err) {
    return { error: 'mint_failed', status: 502, detail: (err as Error)?.message ?? String(err) };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    if (res.status === 429 && /concurrent_limit_exceeded|workspace_concurrency_limit/i.test(detail)) {
      return { error: 'concurrent_limit', status: res.status, detail };
    }
    return { error: 'mint_rejected', status: res.status, detail };
  }
  const raw = await res.text();
  let parsed: { token?: string; conversation_token?: string } = {};
  try { parsed = JSON.parse(raw); } catch { /* keep empty */ }
  const token = parsed.token ?? parsed.conversation_token;
  if (typeof token !== 'string' || !token) {
    return { error: 'mint_shape', status: 502, detail: `no token in EL response; raw: ${raw.slice(0, 200)}` };
  }
  return { token };
}

const voiceSessionInit = defineTool({
  method: 'GET',
  path: '/device/voice-session-init',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const url = new URL(req.url);
    const q = (k: string) => url.searchParams.get(k) ?? undefined;

    // Reuse the desktop's voice prefs + EL credentials — same agent.
    const { loadVoicePrefs } = await import('../../../voice-prefs');
    const { readElevenLabsKey } = await import('../../../voice-credentials');
    const { readCooldownMark, writeCooldownMark } = await import('../../../cooldown-marks');
    const prefs = await loadVoicePrefs();

    // ── Mode resolution (on-desktop-direct-lan-voice-2026-07-14 P-002) ──
    // 'auto' (default): EL when the EL conv engine is selected AND fully
    // configured; otherwise the free desktop-local pipeline. EL support is
    // RETAINED (D-010) — an EL-configured workspace gets the EXACT legacy
    // response shape (plus an additive `mode` field).
    const mobileMode = prefs.mobileVoiceMode ?? 'auto';
    if (mobileMode === 'off') {
      return Response.json(
        { error: 'voice_not_enabled', hint: 'mobileVoiceMode is off — set it to auto or desktop-local in /settings/voice.' },
        { status: 404 },
      );
    }
    const elSelected =
      prefs.fullAgentEngine === 'elevenlabs-conv' ||
      prefs.fullAgentEngine === 'elevenlabs-conversational';
    const agentId = prefs.elevenLabsAgentId?.trim();
    const apiKey = elSelected && agentId ? await readElevenLabsKey() : null;
    const useEl = mobileMode === 'auto' && elSelected && !!agentId && !!apiKey;

    if (!useEl) {
      // Desktop-local pipeline: phone audio → local whisper STT → papercup
      // brain → kokoro TTS, streamed over SSE (routes/device/voice-turn.ts).
      const { gateApiRoute } = await import('../../../require-flag');
      const { FLAGS } = await import('@papercusp/flags');
      const gated = await gateApiRoute(req, FLAGS.MOBILE_DESKTOP_VOICE);
      if (gated) {
        // Flag dark AND EL unavailable — the legacy 404, so old clients keep
        // their existing "voice not enabled" behavior.
        return Response.json(
          { error: 'voice_not_enabled', hint: 'Set fullAgentEngine to elevenlabs-conv in /settings/voice.' },
          { status: 404 },
        );
      }
      const { resolveVoiceInit } = await import('../../../device-voice-init-prefs');
      const { advertisedBaseUrls } = await import('../../../device-base-urls');
      const resolved = resolveVoiceInit(
        { mode: q('mode'), idleMin: q('idleMin'), sessionMaxMin: q('sessionMaxMin') },
        prefs,
      );
      return Response.json({
        mode: 'desktop-local',
        turnPath: '/api/device/voice/turn',
        warmupPath: '/api/device/voice/warmup',
        idleTimeoutMin: resolved.idleTimeoutMin,
        sessionMaxMin: resolved.sessionMaxMin,
        voiceMode: resolved.voiceMode,
        audienceMode: prefs.audienceMode ?? 'engineer',
        deviceId: principal.slug,
        workspaceId: principal.workspaceId,
        // Fresh multi-path advertise (P-005/P-006): the phone probes
        // mesh → lan → tunnel and streams the heavy turn traffic over the
        // first reachable path.
        baseUrls: advertisedBaseUrls(),
      });
    }
    // ── ElevenLabs pipeline (legacy shape, D-010) ────────────────────────
    if (!agentId || !apiKey) {
      // Unreachable (useEl implies both) — narrows the types + a safe fallback.
      return Response.json(
        { error: !agentId ? 'no_agent_id' : 'no_api_key', hint: 'Configure ElevenLabs in /settings/voice.' },
        { status: 404 },
      );
    }

    // Cooldown gate — refuse if a mint for this agent fired in the last 8s.
    const cooldownKey = `el-mint:${agentId}`;
    const lastMintMs = (await readCooldownMark(cooldownKey)) ?? 0;
    const sinceLast = Date.now() - lastMintMs;
    if (sinceLast < MOBILE_MINT_COOLDOWN_MS) {
      const retryInMs = MOBILE_MINT_COOLDOWN_MS - sinceLast;
      return Response.json(
        {
          error: 'mint_cooldown',
          hint: `Slow down — minted a fresh EL token ${(sinceLast / 1000).toFixed(1)}s ago. Retry in ${(retryInMs / 1000).toFixed(1)}s.`,
          retryAfterMs: retryInMs,
        },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryInMs / 1000)) } },
      );
    }

    // Detect platform — EL's `source` enum needs a valid value.
    const { detectSurface, surfaceToElSource } = await import('../../../device-surface');
    const surface = detectSurface({
      query: q('surface'),
      userAgent: req.headers.get('user-agent') ?? undefined,
    });
    const elSource = surfaceToElSource(surface);

    // In-flight dedupe: parallel pair-retries on the same agentId share
    // one outstanding mint promise.
    let pending = mobileMintInFlight.get(agentId);
    if (!pending) {
      pending = mintMobileElToken(agentId, apiKey, elSource).finally(() => {
        mobileMintInFlight.delete(agentId);
      });
      mobileMintInFlight.set(agentId, pending);
    }
    const result = await pending;

    if ('error' in result) {
      if (result.error === 'concurrent_limit') {
        return Response.json(
          {
            error: 'concurrent_limit',
            hint: 'Another tab or device still has an active EL session. Close other operator sessions and retry. (EL Conv AI workspace concurrency limit.)',
            status: result.status,
            detail: result.detail,
          },
          { status: 503 },
        );
      }
      return Response.json(
        { error: result.error, detail: result.detail },
        { status: result.status === 429 ? 503 : 502 },
      );
    }

    // Successful mint — record so subsequent calls are throttled.
    await writeCooldownMark(cooldownKey);

    const { resolveVoiceInit } = await import('../../../device-voice-init-prefs');
    const resolved = resolveVoiceInit(
      { mode: q('mode'), idleMin: q('idleMin'), sessionMaxMin: q('sessionMaxMin') },
      prefs,
    );

    return Response.json({
      // Additive (D-010): lets updated phone clients dispatch on `mode`
      // while pre-existing EL consumers keep reading the same fields.
      mode: 'elevenlabs-conv',
      conversationToken: result.token,
      agentId,
      idleTimeoutMin: resolved.idleTimeoutMin,
      sessionMaxMin: resolved.sessionMaxMin,
      voiceMode: resolved.voiceMode,
      dynamicVariables: {
        device_id: principal.slug,
        workspace_id: principal.workspaceId,
        surface,
        desktop_host: process.env.MOBILE_DESKTOP_HOST ?? '',
        voice_mode: resolved.voiceMode,
        audience_mode: prefs.audienceMode ?? 'engineer',
      },
    });
  },
});

export default [
  voiceLeaseGet,
  voiceLeaseClaim,
  voiceLeaseHeartbeat,
  voiceLeaseRelease,
  voiceSessionInit,
];
