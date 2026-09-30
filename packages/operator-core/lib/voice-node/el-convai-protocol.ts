/**
 * ElevenLabs Conv-AI raw-WebSocket protocol — the Node-side port of the pui's
 * `apps/tui/src/voice_convai.rs` codec (plan universal-voice-interface-2026-06-05,
 * P-002). The voice service host owns ONE EL session and speaks this protocol;
 * the per-client surfaces no longer touch EL directly.
 *
 * Server→client events we act on (everything else → `unknown`):
 *   conversation_initiation_metadata · audio · ping · user_transcript ·
 *   agent_response · interruption · client_tool_call
 * Client→server messages:
 *   conversation_initiation_client_data · user_audio_chunk · pong ·
 *   client_tool_result
 *
 * Pure + tolerant: a parse never throws (unknown/garbage → `unknown`) so an
 * EL-side protocol addition can't wedge the session.
 */

export type ElServerEvent =
  | { type: 'init'; conversationId: string; agentOutputAudioFormat: string }
  | { type: 'audio'; audioB64: string }
  | { type: 'ping'; eventId: number }
  | { type: 'user_transcript'; text: string }
  | { type: 'agent_response'; text: string }
  | { type: 'interruption' }
  | { type: 'client_tool_call'; toolName: string; toolCallId: string; parameters: Record<string, unknown> }
  | { type: 'unknown' };

function str(o: unknown, k: string): string {
  if (o && typeof o === 'object' && typeof (o as Record<string, unknown>)[k] === 'string') {
    return (o as Record<string, string>)[k];
  }
  return '';
}

/** Tolerant parse of one inbound EL text frame. Never throws. */
export function parseElServerEvent(raw: string): ElServerEvent {
  let v: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { type: 'unknown' };
    v = parsed as Record<string, unknown>;
  } catch {
    return { type: 'unknown' };
  }
  switch (v.type) {
    case 'conversation_initiation_metadata': {
      const e = v.conversation_initiation_metadata_event as Record<string, unknown> | undefined;
      return {
        type: 'init',
        conversationId: str(e, 'conversation_id'),
        agentOutputAudioFormat: str(e, 'agent_output_audio_format') || 'pcm_16000',
      };
    }
    case 'audio': {
      const audioB64 = str(v.audio_event, 'audio_base_64');
      return audioB64 ? { type: 'audio', audioB64 } : { type: 'unknown' };
    }
    case 'ping': {
      const e = v.ping_event as Record<string, unknown> | undefined;
      const eventId = e && typeof e.event_id === 'number' ? e.event_id : 0;
      return { type: 'ping', eventId };
    }
    case 'user_transcript':
      return { type: 'user_transcript', text: str(v.user_transcription_event, 'user_transcript') };
    case 'agent_response':
      return { type: 'agent_response', text: str(v.agent_response_event, 'agent_response') };
    case 'interruption':
      return { type: 'interruption' };
    case 'client_tool_call': {
      const e = (v.client_tool_call as Record<string, unknown>) ?? {};
      const parameters =
        e.parameters && typeof e.parameters === 'object' ? (e.parameters as Record<string, unknown>) : {};
      return {
        type: 'client_tool_call',
        toolName: str(e, 'tool_name'),
        toolCallId: str(e, 'tool_call_id'),
        parameters,
      };
    }
    default:
      return { type: 'unknown' };
  }
}

// ── Outbound message builders ──────────────────────────────────────────────

/** The session-opening message. Shell mode: overrides = language pin or absent. */
export function elInitiationMessage(overrides: unknown, dynamicVariables: unknown): string {
  const m: Record<string, unknown> = { type: 'conversation_initiation_client_data' };
  if (overrides && typeof overrides === 'object') m.conversation_config_override = overrides;
  if (dynamicVariables && typeof dynamicVariables === 'object') m.dynamic_variables = dynamicVariables;
  return JSON.stringify(m);
}

/** One outbound mic chunk: 16 kHz mono PCM16 LE bytes → base64. */
export function elUserAudioChunkMessage(pcm16le: Uint8Array): string {
  return JSON.stringify({ user_audio_chunk: Buffer.from(pcm16le).toString('base64') });
}

export function elPongMessage(eventId: number): string {
  return JSON.stringify({ type: 'pong', event_id: eventId });
}

export function elClientToolResultMessage(toolCallId: string, result: string, isError: boolean): string {
  return JSON.stringify({ type: 'client_tool_result', tool_call_id: toolCallId, result, is_error: isError });
}

/** `"pcm_16000"` → 16000; non-PCM (mp3_…) → null (decode via a decoder). */
export function pcmRateFromFormat(fmt: string): number | null {
  if (!fmt.startsWith('pcm_')) return null;
  const r = Number.parseInt(fmt.slice(4), 10);
  return Number.isFinite(r) && r > 0 ? r : null;
}

/** Decode one `audio` event's base64 payload to raw PCM16 LE bytes. */
export function decodeAudioB64(audioB64: string): Uint8Array {
  return new Uint8Array(Buffer.from(audioB64, 'base64'));
}
