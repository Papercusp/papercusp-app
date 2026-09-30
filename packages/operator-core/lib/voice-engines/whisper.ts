/**
 * Voicemode Whisper STT — one-shot transcription helper.
 *
 * Voicemode exposes an OpenAI-compatible /v1/audio/transcriptions endpoint.
 * The chrome's voice-mode.ts captures audio frames via the Web Audio API and
 * POSTs each finalized chunk here for transcription. (The old `createVoicemodeWhisper`
 * engine-adapter shell was part of the dead client `detectEngines` framework —
 * removed 2026-07-09, WI-3448; this one-shot helper is the live surface.)
 */

/** One-shot transcription helper. Called by voice-mode.ts on each finalized audio chunk. */
export async function transcribeChunk(baseUrl: string, audio: Blob): Promise<string> {
  const fd = new FormData();
  fd.append('file', audio, 'audio.webm');
  fd.append('model', 'whisper-1');
  const r = await fetch(`${baseUrl}/v1/audio/transcriptions`, { method: 'POST', body: fd });
  if (!r.ok) return '';
  const body = await r.json();
  return body?.text ?? '';
}
