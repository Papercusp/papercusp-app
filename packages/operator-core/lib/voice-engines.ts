/**
 * Voice engine shared types.
 *
 * The `detectEngines()` client-side adapter framework that used to live here was
 * removed 2026-07-09 (WI-3448, voice-consolidation). It was a parallel, second
 * implementation of per-provider TTS/STT synthesis that duplicated the live
 * server-side registry — and, because it read server-only API keys
 * (readElevenLabsKey etc.), it was never viable client-side; its only caller was
 * its own test. The live voice path is now single-sourced:
 *
 *   - TTS synthesis:  endpoint-route/routes/agent-mcp/tts-synth.ts  (`synthesize`)
 *                     — one registry used by operator-tts + operator-tts-preview.
 *   - STT transcribe: voice-engines/whisper.ts  (`transcribeChunk`).
 *   - Provider key connection-tests: voice-engines/{elevenlabs,openai,cartesia}.ts.
 *   - Full-agent (WebRTC) + wake-word engines: the other voice-engines/* files.
 *
 * To switch a provider (e.g. local kokoro ↔ ElevenLabs) the user changes ONE
 * pref (`ttsEngine`, or `fullAgentEngine` for the conversational transport) —
 * see docs/voice-engine-swap.md.
 */

/** Announcement priority for the aria-live bus / TTS speak queue. */
export type Priority = 'polite' | 'assertive';
