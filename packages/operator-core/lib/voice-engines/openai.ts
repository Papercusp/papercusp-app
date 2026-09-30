/**
 * OpenAI — settings connection-test helper.
 *
 * Server-side TTS synthesis for OpenAI lives in the shared registry
 * (endpoint-route/routes/agent-mcp/tts-synth.ts). This file keeps only the
 * key-validation probe used by /settings/voice. (The client `createOpenAiTts`
 * adapter was part of the dead `detectEngines` framework — removed 2026-07-09,
 * WI-3448.)
 */

const BASE = 'https://api.openai.com/v1';

/** Connection-test helper. Returns the available tts-* models + raw key validity. */
export async function testOpenAiConnection(apiKey: string): Promise<
  | { ok: true; models: string[] }
  | { ok: false; error: string }
> {
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json();
    const ids: string[] = (body?.data ?? []).map((m: any) => m.id).filter(Boolean);
    return { ok: true, models: ids.filter((id) => id.startsWith('tts-')) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
