/**
 * GET /api/agent-mcp/operator-realtime-bootstrap — mint OpenAI Realtime ephemeral token.
 * Ported from app/api/agent-mcp/operator-realtime-bootstrap/route.ts. `auth: 'public'`.
 */
import { readOpenAiKey } from '../../../voice-credentials';
import { loadVoicePrefs } from '../../../voice-prefs';
import { defineTool } from '@papercusp/agent-mcp';

const REALTIME_MODEL = 'gpt-realtime-1.5';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-realtime-bootstrap',
  auth: 'public',
  async handler() {
    const prefs = await loadVoicePrefs();
    if (prefs.fullAgentEngine !== 'openai-realtime') {
      return Response.json({ error: 'not-enabled' }, { status: 404 });
    }
    const apiKey = await readOpenAiKey();
    if (!apiKey) return Response.json({ error: 'no-openai-key' }, { status: 404 });

    let mintRes: Response;
    try {
      mintRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: { type: 'realtime', model: REALTIME_MODEL },
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err: any) {
      return Response.json(
        { error: 'client-secret-mint-failed', detail: err?.message ?? String(err) },
        { status: 502 },
      );
    }

    if (!mintRes.ok) {
      const detail = await mintRes.text().catch(() => '');
      return Response.json(
        { error: 'client-secret-mint-rejected', status: mintRes.status, detail: detail.slice(0, 400) },
        { status: 502 },
      );
    }

    const data = await mintRes.json().catch(() => ({} as any));
    const ephemeral = data?.value;
    const expiresAt = data?.expires_at ?? null;
    if (typeof ephemeral !== 'string' || !ephemeral.startsWith('ek_')) {
      return Response.json(
        { error: 'client-secret-mint-shape', detail: 'no top-level value in response' },
        { status: 502 },
      );
    }

    return Response.json({
      apiKey: ephemeral,
      expiresAt,
      model: REALTIME_MODEL,
    });
  },
});
