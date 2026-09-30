/**
 * ElevenLabs — settings connection-test helper.
 *
 * Server-side TTS synthesis for ElevenLabs lives in the shared registry
 * (endpoint-route/routes/agent-mcp/tts-synth.ts). This file keeps only the
 * key-validation probe used by /settings/voice. (The client `createElevenLabsTts`
 * MSE adapter was part of the dead `detectEngines` framework — removed
 * 2026-07-09, WI-3448.)
 *
 * The test hits `/v1/user` (not `/v1/voices`) — the canonical key-validation
 * endpoint, which also returns subscription tier + character usage for display.
 */

import { inspectElevenLabsApiKey } from '../voice-credentials';

const BASE = 'https://api.elevenlabs.io/v1';

/** Connection-test helper used by /settings/voice. Returns subscription tier on success. */
export async function testElevenLabsConnection(apiKey: string): Promise<
  | { ok: true; tier: string; characterCount: number; characterLimit: number; email: string | null }
  | { ok: false; error: string }
> {
  const keyStatus = inspectElevenLabsApiKey(apiKey);
  if (!keyStatus.healthy) {
    return { ok: false, error: keyStatus.error ?? 'ElevenLabs API key is not configured.' };
  }
  try {
    const r = await fetch(`${BASE}/user`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json();
    const sub = body?.subscription ?? {};
    return {
      ok: true,
      tier: sub.tier ?? 'unknown',
      characterCount: sub.character_count ?? 0,
      characterLimit: sub.character_limit ?? 0,
      email: body?.email ?? null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ElevenLabsVoiceSummary { id: string; name: string; lang?: string }

/**
 * Fetch the account's voice library server-side (the API key never reaches the
 * browser — the settings page used to fetch `/v1/voices` DIRECTLY from the
 * client with a MASKED key, so it always 401'd and the picker was stuck on the
 * single hardcoded default; WI-3662). Returns [] on any error so the caller can
 * fall back to its default list without a hard failure.
 */
export async function fetchElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoiceSummary[]> {
  if (!inspectElevenLabsApiKey(apiKey).healthy) return [];
  try {
    const r = await fetch(`${BASE}/voices`, {
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return [];
    const body = await r.json();
    const list = (body?.voices ?? []) as Array<{ voice_id?: string; name?: string; labels?: { language?: string }; fine_tuning?: { language?: string } }>;
    return list
      .filter((v): v is { voice_id: string; name: string } => typeof v?.voice_id === 'string' && typeof v?.name === 'string')
      .map((v) => {
        const lang = (v as { labels?: { language?: string } }).labels?.language;
        return lang ? { id: v.voice_id, name: v.name, lang } : { id: v.voice_id, name: v.name };
      });
  } catch {
    return [];
  }
}
