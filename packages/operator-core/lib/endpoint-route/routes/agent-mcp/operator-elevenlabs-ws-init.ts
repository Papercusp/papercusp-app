/**
 * Raw-WebSocket EL Conv-AI session init for NON-BROWSER clients (the pui —
 * voice-realtime-tui-2026-06-05 P-001/P-002, D-001/D-004/D-009).
 *
 *   GET    /agent-mcp/operator-elevenlabs-ws-init?owner=<id>[&force=1]
 *   POST   /agent-mcp/operator-voice-lease/heartbeat   { owner }
 *   DELETE /agent-mcp/operator-voice-lease?owner=<id>
 *
 * ws-init differs from the sibling `operator-elevenlabs-bootstrap` (the
 * browser's WebRTC `conversationToken`) in three ways:
 *   1. It mints the SIGNED URL (`/v1/convai/conversation/get-signed-url`) —
 *      the auth shape EL's raw-WS protocol wants; the key stays server-side.
 *   2. It claims the voice lease (kind 'tui', D-004) so the fleet keeps ONE
 *      live listener across desktop/mobile/tui; 409 + holder when another
 *      surface is live unless `force=1` (the user explicitly toggled).
 *   3. It returns the SHELL-MODE session payload (D-009): `overrides` carries
 *      at most the `agent.language` pin from voice prefs — the operator brain
 *      answers per-turn via the `ask_operator` client tool, exactly like the
 *      desktop's default shell mode. No persona/delegates composition here.
 *
 * Same gating + 8s mint cooldown + in-flight dedupe as the bootstrap route
 * (EL credit-burn audit fix #4). `auth: 'public'` like the sibling operator
 * voice routes — the host binds loopback; the pui is a loopback/IPC client.
 */
import { readElevenLabsKey } from '../../../voice-credentials';
import { loadVoicePrefs } from '../../../voice-prefs';
import { readCooldownMark, writeCooldownMark } from '../../../cooldown-marks';
import { claimVoiceLease, releaseVoiceLease } from '../../../voice-lease';
import { activeWorkspaceId } from '../../../workspace-registry';
import { isTransientNetworkError } from '../../../loopback-fetch';
import { defineTool } from '@papercusp/agent-mcp';

const inFlight = new Map<
  string,
  Promise<{ signedUrl: string } | { error: string; status: number; detail: string }>
>();
const COOLDOWN_MS = 8_000;
const cooldownKey = (agentId: string) => `el-ws-mint:${agentId}`;

// WI-1461: a lazily-built, isolated undici dispatcher for the ONE-TIME retry
// below. api.elevenlabs.io is hit rarely (only on a mint), so a keep-alive
// socket the GLOBAL fetch dispatcher pooled to it can sit idle far longer
// than either side's idle timeout and get silently dropped by an
// intermediate NAT/firewall without a FIN/RST reaching this process — the
// next mint then hangs on that dead pooled socket until AbortSignal.timeout
// fires (observed: `mint-failed: The operation was aborted due to timeout`,
// reproducibly, until the whole host process was restarted — a fresh global
// dispatcher with no poisoned entry for this rarely-hit origin). A brand-new
// Agent has no pooled connections to reuse, so retrying on it sidesteps a
// stuck socket regardless of what caused it — without touching the shared
// global dispatcher every OTHER outbound call on this process relies on.
let elRetryDispatcher: unknown;
async function getElRetryDispatcher(): Promise<unknown> {
  if (!elRetryDispatcher) {
    const { Agent } = await import('undici');
    elRetryDispatcher = new Agent();
  }
  return elRetryDispatcher;
}

/** Mint the raw-WS signed URL. Exported for unit tests (fetch stubbed). */
export async function mintSignedUrlFromEL(
  agentId: string,
  apiKey: string,
): Promise<{ signedUrl: string } | { error: string; status: number; detail: string }> {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const headers = { 'xi-api-key': apiKey, accept: 'application/json' };
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(8000) });
  } catch (firstErr: unknown) {
    // WI-1461: one retry on a fresh, isolated connection for exactly the
    // transient-network error class (timeout/reset/refused/DNS) — a genuine
    // rejection (bad key, malformed request) never hits this path since EL
    // still returns an HTTP response for those, handled by the !res.ok branch
    // below, not this catch.
    if (!isTransientNetworkError(firstErr)) {
      return { error: 'mint-failed', status: 502, detail: (firstErr as Error)?.message ?? String(firstErr) };
    }
    try {
      const dispatcher = await getElRetryDispatcher();
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(8000),
        dispatcher,
      } as RequestInit);
    } catch (retryErr: unknown) {
      return { error: 'mint-failed', status: 502, detail: (retryErr as Error)?.message ?? String(retryErr) };
    }
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    if (res.status === 429 && /concurrent_limit_exceeded|workspace_concurrency_limit/i.test(detail)) {
      return { error: 'concurrent-limit', status: res.status, detail };
    }
    return { error: 'mint-rejected', status: res.status, detail };
  }
  const rawText = await res.text();
  let data: { signed_url?: string } = {};
  try { data = JSON.parse(rawText); } catch { /* leave empty */ }
  const signedUrl = data.signed_url;
  if (typeof signedUrl !== 'string' || !signedUrl) {
    return { error: 'mint-shape', status: 502, detail: `no signed_url in response; raw: ${rawText.slice(0, 200)}` };
  }
  return { signedUrl };
}

const wsInit = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-elevenlabs-ws-init',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const owner = url.searchParams.get('owner')?.trim();
    const force = url.searchParams.get('force') === '1';
    if (!owner) {
      return Response.json(
        { error: 'owner-required', hint: 'Pass ?owner=<pui owner id> — the voice-lease identity.' },
        { status: 400 },
      );
    }

    const prefs = await loadVoicePrefs();
    if (prefs.fullAgentEngine !== 'elevenlabs-conv' &&
        prefs.fullAgentEngine !== 'elevenlabs-conversational') {
      return Response.json(
        { error: 'not-enabled', hint: 'Set fullAgentEngine to elevenlabs-conv in /settings/voice.' },
        { status: 404 },
      );
    }
    const agentId = prefs.elevenLabsAgentId?.trim();
    if (!agentId) {
      return Response.json(
        { error: 'no-agent-id', hint: 'Set the ElevenLabs agent ID in /settings/voice.' },
        { status: 404 },
      );
    }
    const apiKey = await readElevenLabsKey();
    if (!apiKey) {
      return Response.json(
        { error: 'no-api-key', hint: 'Add your ElevenLabs API key in /settings/api-keys.' },
        { status: 404 },
      );
    }

    // One live listener fleet-wide (D-004): claim BEFORE minting so a refused
    // lease never burns an EL concurrency slot.
    const workspaceId = activeWorkspaceId();
    const claim = await claimVoiceLease({ workspaceId, ownerId: owner, ownerKind: 'tui', force });
    if (!claim.granted) {
      return Response.json(
        {
          error: 'lease-held',
          hint: 'Another surface holds the live voice session. Pass force=1 to pre-empt (user-initiated toggles only).',
          holder: claim.lease,
        },
        { status: 409 },
      );
    }

    const lastMintMs = (await readCooldownMark(cooldownKey(agentId))) ?? 0;
    const since = Date.now() - lastMintMs;
    if (since < COOLDOWN_MS) {
      const retryInMs = COOLDOWN_MS - since;
      return Response.json(
        {
          error: 'mint-cooldown',
          hint: `Slow down — minted a fresh EL signed URL ${(since / 1000).toFixed(1)}s ago. Retry in ${(retryInMs / 1000).toFixed(1)}s.`,
          retryAfterMs: retryInMs,
        },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryInMs / 1000)) } },
      );
    }

    let pending = inFlight.get(agentId);
    if (!pending) {
      pending = mintSignedUrlFromEL(agentId, apiKey).finally(() => {
        inFlight.delete(agentId);
      });
      inFlight.set(agentId, pending);
    }
    const result = await pending;

    if ('error' in result) {
      if (result.error === 'concurrent-limit') {
        return Response.json(
          {
            error: 'concurrent-limit',
            hint: 'Another surface still has an active EL session. Close it and retry. (EL Conv AI workspace concurrency limit.)',
            status: result.status,
            detail: result.detail,
          },
          { status: 503 },
        );
      }
      return Response.json(
        { error: result.error, status: result.status, detail: result.detail },
        { status: result.status >= 500 ? 502 : result.status },
      );
    }
    await writeCooldownMark(cooldownKey(agentId));

    // Shell mode (D-009): the only override is the language pin (stops EL's
    // STT auto-detect flipping on ambient noise — same rationale as desktop).
    const agentLanguage = prefs.agentLanguage?.trim() ?? '';
    const overrides = agentLanguage ? { agent: { language: agentLanguage } } : undefined;

    return Response.json({
      signedUrl: result.signedUrl,
      agentId,
      overrides: overrides ?? null,
      // Mirrors the dynamic_variables shape the EL tool webhook already
      // receives from browser sessions ({ workspace_id, surface, … }).
      dynamicVariables: { workspace_id: workspaceId, surface: 'tui' },
    });
  },
});

/* ─── TUI voice-lease heartbeat / release (P-002) ─────────────────────────
 * ws-init claims; the session task heartbeats (claim-refresh — same-owner
 * claims refresh expiry by contract) and releases on teardown. Separate from
 * ws-init so a heartbeat never trips the mint cooldown. */

const leaseHeartbeat = defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-voice-lease/heartbeat',
  auth: 'loopback',
  async handler(req) {
    let owner = '';
    try {
      const body = (await req.json()) as { owner?: string };
      owner = body.owner?.trim() ?? '';
    } catch { /* fall through to the 400 */ }
    if (!owner) {
      return Response.json({ error: 'owner-required' }, { status: 400 });
    }
    const out = await claimVoiceLease({
      workspaceId: activeWorkspaceId(),
      ownerId: owner,
      ownerKind: 'tui',
    });
    // A heartbeat that finds another holder means we LOST the lease (e.g. a
    // forced mobile claim) — surface it so the session tears down promptly.
    return Response.json({ ok: out.granted, holder: out.granted ? undefined : out.lease });
  },
});

const leaseRelease = defineTool({
  method: 'DELETE',
  path: '/agent-mcp/operator-voice-lease',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const owner = url.searchParams.get('owner')?.trim();
    if (!owner) {
      return Response.json({ error: 'owner-required' }, { status: 400 });
    }
    await releaseVoiceLease({ workspaceId: activeWorkspaceId(), ownerId: owner });
    return Response.json({ ok: true });
  },
});

export default [wsInit, leaseHeartbeat, leaseRelease];
