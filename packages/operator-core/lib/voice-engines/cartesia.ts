/**
 * Cartesia — settings connection-test helper.
 *
 * Server-side TTS synthesis for Cartesia lives in the shared registry
 * (endpoint-route/routes/agent-mcp/tts-synth.ts). This file keeps only the
 * key-validation probe used by /settings/voice. (The client `createCartesiaTts`
 * MSE adapter was part of the dead `detectEngines` framework — removed
 * 2026-07-09, WI-3448.)
 */

const BASE = 'https://api.cartesia.ai';

/**
 * WI-3557 (EI/bug from WI-3527 voice test campaign): the SINGLE source of
 * truth for the `Cartesia-Version` header — imported by both the key-test
 * probe (this file) and server-side synthesis (tts-synth.ts). Before this fix
 * the two hardcoded different date literals independently (2024-06-10 vs
 * 2024-11-13): a key could validate green here and then fail at synth, or vice
 * versa, if the API ever treats the two versions differently.
 *
 * Value: per Cartesia's own docs (docs.cartesia.ai/use-the-api/api-conventions
 * + self-hosted deployment docs, checked 2026-07-09), `Cartesia-Version` only
 * selects a testing snapshot for deprecation-notice / backward-compatibility
 * purposes — it does not gate access — and the CURRENT documented default is
 * `2025-04-16`. Converging both call sites on that value removes the drift
 * without weakening either path (no Cartesia key is configured on this box,
 * so this has NOT been re-verified against a live key — flag EI if a real key
 * ever surfaces a mismatch).
 */
export const CARTESIA_API_VERSION = '2025-04-16';

/** Connection-test helper (settings UI). */
export async function testCartesiaConnection(apiKey: string): Promise<
  | { ok: true; voicesAvailable: number }
  | { ok: false; error: string }
> {
  try {
    const r = await fetch(`${BASE}/voices`, {
      headers: { 'X-API-Key': apiKey, 'Cartesia-Version': CARTESIA_API_VERSION },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const list = await r.json();
    return { ok: true, voicesAvailable: Array.isArray(list) ? list.length : 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
