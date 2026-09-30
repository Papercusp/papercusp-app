/**
 * Browser-side client for the operator conversation log.
 *
 * Used by voice-mode.ts (module-scope, not React) to write voice STT/TTS
 * turns into the same conversation_id that the React provider hydrated
 * from on mount. The text path uses persistTurn() inside the provider
 * directly; this helper exists for the contexts that don't have access
 * to React state.
 *
 * Cached conversation ID is invalidated lazily — if a POST 404s we
 * refetch and retry once.
 */

let cachedConversationId: string | null = null;
let inflight: Promise<string | null> | null = null;

export async function getActiveOperatorConversationId(): Promise<string | null> {
  if (cachedConversationId) return cachedConversationId;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/operator/conversations');
      if (!res.ok) return null;
      const json = (await res.json()) as { conversation: { id: string } };
      cachedConversationId = json.conversation.id;
      return cachedConversationId;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function clearOperatorConversationCache(): void {
  cachedConversationId = null;
}

export async function persistOperatorVoiceTurn(input: {
  role: 'user' | 'assistant';
  text: string;
  source: 'voice_stt' | 'voice_tts';
  elConvId?: string | null;
}): Promise<void> {
  const text = input.text?.trim();
  if (!text) return;
  let id = await getActiveOperatorConversationId();
  if (!id) return;
  const body = JSON.stringify({
    role: input.role,
    text,
    source: input.source,
    elConvId: input.elConvId ?? null,
  });
  let res = await fetch(`/api/operator/conversations/${id}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => null);
  if (res && res.status === 404) {
    // conversation was archived under us — refetch + retry once
    clearOperatorConversationCache();
    id = await getActiveOperatorConversationId();
    if (!id) return;
    res = await fetch(`/api/operator/conversations/${id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => null);
  }
}
