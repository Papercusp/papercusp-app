/**
 * GET /api/agent-mcp/operator-elevenlabs-bootstrap — mint EL conv token.
 * Ported from app/api/agent-mcp/operator-elevenlabs-bootstrap/route.ts. `auth: 'public'`.
 */
import { readElevenLabsKey } from '../../../voice-credentials';
import { loadVoicePrefs } from '../../../voice-prefs';
import { readCooldownMark, writeCooldownMark } from '../../../cooldown-marks';
import { defineTool } from '@papercusp/agent-mcp';

const inFlight = new Map<string, Promise<{ token: string } | { error: string; status: number; detail: string }>>();
const COOLDOWN_MS = 8_000;
const cooldownKey = (agentId: string) => `el-mint:${agentId}`;

async function mintFromEL(
  agentId: string,
  apiKey: string,
): Promise<{ token: string } | { error: string; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}&source=js_sdk&version=1.4.0`,
      {
        method: 'GET',
        headers: { 'xi-api-key': apiKey, 'accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      },
    );
  } catch (err: unknown) {
    return { error: 'mint-failed', status: 502, detail: (err as Error)?.message ?? String(err) };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    if (res.status === 429 && /concurrent_limit_exceeded|workspace_concurrency_limit/i.test(detail)) {
      return { error: 'concurrent-limit', status: res.status, detail };
    }
    return { error: 'mint-rejected', status: res.status, detail };
  }
  const rawText = await res.text();
  let data: { token?: string; conversation_token?: string } = {};
  try { data = JSON.parse(rawText); } catch { /* leave empty */ }
  const token = data.token ?? data.conversation_token;
  if (typeof token !== 'string' || !token) {
    return { error: 'mint-shape', status: 502, detail: `no token in response; raw: ${rawText.slice(0, 200)}` };
  }
  return { token };
}

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-elevenlabs-bootstrap',
  auth: 'public',
  async handler() {
    const prefs = await loadVoicePrefs();
    if (prefs.fullAgentEngine !== 'elevenlabs-conv' &&
        prefs.fullAgentEngine !== 'elevenlabs-conversational') {
      return Response.json({ error: 'not-enabled' }, { status: 404 });
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

    const lastMintMs = (await readCooldownMark(cooldownKey(agentId))) ?? 0;
    const since = Date.now() - lastMintMs;
    if (since < COOLDOWN_MS) {
      const retryInMs = COOLDOWN_MS - since;
      return Response.json(
        {
          error: 'mint-cooldown',
          hint: `Slow down — minted a fresh EL token ${(since / 1000).toFixed(1)}s ago. Retry in ${(retryInMs / 1000).toFixed(1)}s.`,
          retryAfterMs: retryInMs,
        },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(retryInMs / 1000)) } },
      );
    }

    let pending = inFlight.get(agentId);
    if (!pending) {
      pending = mintFromEL(agentId, apiKey).finally(() => {
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
            hint: 'Another tab or browser still has an active EL session. Close other operator tabs and retry. (EL Conv AI workspace concurrency limit.)',
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
    return Response.json({
      conversationToken: result.token,
      agentId,
    });
  },
});
