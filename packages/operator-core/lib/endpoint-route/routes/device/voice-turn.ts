/**
 * Device desktop-local voice — on-desktop-direct-lan-voice-2026-07-14
 * (P-001 turn, P-003 warmup). The EL-free mobile voice pipeline: the phone
 * is a thin audio client and the DESKTOP does STT + brain + TTS, all local
 * and free. ElevenLabs stays fully supported alongside this (D-010) — the
 * phone picks its pipeline from /device/voice-session-init's `mode`.
 *
 *   POST /device/voice/turn     device JWT   (SSE)
 *   POST /device/voice/warmup   device JWT
 *
 * Turn flow (one utterance → one spoken reply, streamed — D-005):
 *   1. body `{audioBase64, format?, sessionId?}` (16kHz mono WAV preferred,
 *      D-007; same 15MB cap as operator-stt)
 *   2. STT via the local whisper service (voicemode/managed child — the
 *      same upstream operator-stt proxies)            → SSE `transcript`
 *   3. the SAME brain leg as /device/operator/converse: fast `papercup`
 *      persona when the humanFacingRole pref says so, shared operator
 *      conversation persistence (phone/desktop/TUI in lock-step, D-006)
 *                              → SSE `delta`s (clean per-sentence text —
 *                                the raw tag-protocol stream never hits
 *                                the wire, EI-13172)
 *   4. per-sentence kokoro TTS while the brain is STILL streaming
 *      (voice-turn-sentences extractor; tags are never spoken)
 *                                                     → SSE `audio` events
 *   5. `done {costUsd, conversationId}`
 *
 * Playback starts on the FIRST audio event — perceived latency is
 * time-to-first-sentence, not the sum of stages.
 *
 * auth: DEVICE_AUTH (a paired phone's JWT). The loopback-only
 * operator-stt/operator-tts stay untouched; this is their composed,
 * device-authed sibling. Flag-gated MOBILE_DESKTOP_VOICE (default ON).
 */
import { defineTool, dispatchProjectedToolStream, emitToSseSink, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { sseResponse } from '@papercusp/sse';
import { FLAGS } from '@papercusp/flags';
import '../../../agent-tools/index';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { gateApiRoute } from '../../../require-flag';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  getOrCreateActiveConversation,
  appendTurn,
  listTurnsRecent,
  type TurnRole,
} from '../../../operator-conversations';
import { parseOperatorTurn } from '../../../operator-converse-tags';
import { notifySyncInvalidate } from '../../../sync-sse';
import {
  decodeAudioBase64,
  normalizeAudioFormat,
  resolveTtsEngine,
  MAX_TEXT_CHARS,
} from '../agent-mcp/operator-voice-proxy-helpers';
import { synthesize } from '../agent-mcp/tts-synth';
import { fetchWhisperWithRecovery, warmLocalWhisper } from '../../../voice-node/local-whisper-service';
import { kokoroTtsAvailable } from '../../../voice-node/kokoro-local';
import { loadVoicePrefs } from '../../../voice-prefs';
import { createSentenceExtractor } from '../../../voice-turn-sentences';
import { stripNonSpeechAnnotations } from './voice-transcript-normalize';
import {
  createVoiceBrainFirstEventDeadline,
  VOICE_BRAIN_TIMEOUT_MESSAGE,
  VOICE_BRAIN_NO_REPLY_MESSAGE,
  voiceTurnProducedNoReply,
} from '../../../voice-turn-deadline';

/** How many recent turns feed the brain — same as the device text path. */
const HISTORY_CONTEXT_TURNS = 24;

interface TurnBody {
  audioBase64?: unknown;
  format?: unknown;
  sessionId?: unknown;
}

/** One-shot whisper transcription — the operator-stt upstream, inlined. */
async function transcribe(
  audio: Buffer,
  format: 'wav' | 'webm',
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let r: Response;
  try {
    r = await fetchWhisperWithRecovery((sttBase) => {
      const fd = new FormData();
      fd.append(
        'file',
        new Blob([new Uint8Array(audio)], { type: format === 'wav' ? 'audio/wav' : 'audio/webm' }),
        `audio.${format}`,
      );
      fd.append('model', 'whisper-1');
      return fetch(`${sttBase}/v1/audio/transcriptions`, {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(60_000),
      });
    });
  } catch (e) {
    return { ok: false, error: `whisper unreachable: ${(e as Error).message}` };
  }
  if (!r.ok) return { ok: false, error: `whisper ${r.status}` };
  const out = (await r.json().catch(() => null)) as { text?: string } | null;
  return { ok: true, text: (out?.text ?? '').trim() };
}

/** Resolve the converse brain the device text path uses (papercup-fast when prefs say so). */
async function resolveBrain(): Promise<{
  role: string;
  toolName: string;
  tool: ReturnType<typeof lookupByMcpName>;
}> {
  let role = 'operator';
  try {
    const prefs = await loadVoicePrefs();
    if (prefs.humanFacingRole === 'papercup') role = 'papercup';
  } catch {
    /* best-effort; fall back to operator */
  }
  const toolName = role === 'papercup' ? 'papercup:converse' : `${role}:converse`;
  const tool = lookupByMcpName(toolName) ?? lookupByMcpName('operator:converse');
  return { role, toolName, tool };
}

const voiceTurn = defineTool({
  method: 'POST',
  path: '/device/voice/turn',
  auth: DEVICE_AUTH,
  cors: true,
  // SSE — one long-lived connection per turn; don't sample telemetry.
  sampleRate: 0,
  async handler(req, ctx) {
    const gated = await gateApiRoute(req, FLAGS.MOBILE_DESKTOP_VOICE);
    if (gated) return gated;
    const principal = devicePrincipal(ctx);

    let body: TurnBody = {};
    try {
      body = (await req.json()) as TurnBody;
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const decoded = decodeAudioBase64(body.audioBase64);
    if (!decoded.ok) {
      return Response.json({ ok: false, error: decoded.error }, { status: decoded.status });
    }
    const audio = decoded.audio;
    const format = normalizeAudioFormat(body.format);

    const { role, toolName, tool } = await resolveBrain();
    if (!tool) {
      return Response.json({ ok: false, error: `${toolName} tool not registered` }, { status: 500 });
    }

    const prefs = await loadVoicePrefs();
    // Engine resolution mirrors operator-tts: prefs default, 'browser'
    // (meaningless off-browser) health-gated onto local kokoro.
    const resolvedEngine = await resolveTtsEngine(undefined, prefs, () => kokoroTtsAvailable());

    const workspaceId = activeWorkspaceId();
    const conversation = await getOrCreateActiveConversation();

    const sessionUser = principal.label
      ? {
          id: principal.slug,
          username: principal.label,
          display_name: principal.label,
          has_password: false,
        }
      : null;

    const ctrl = new AbortController();
    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        sink.onClose(() => ctrl.abort());

        // ── 1. STT ────────────────────────────────────────────────────
        const stt = await transcribe(audio, format);
        if (!stt.ok) {
          sink.event('error', { stage: 'stt', message: stt.error });
          sink.close();
          return;
        }
        // whisper emits truthy non-speech markers ([BLANK_AUDIO], [SILENCE], …)
        // for silence; strip them so a silent utterance is recognized as empty
        // instead of burning a brain+TTS round-trip and polluting the shared
        // conversation (voice-transcript-normalize).
        const transcript = stripNonSpeechAnnotations(stt.text);
        sink.event('transcript', { text: transcript });
        if (!transcript) {
          // Silence / noise — never bother the brain with an empty turn.
          sink.done({ emptyTranscript: true, conversationId: conversation.id });
          return;
        }
        if (ctrl.signal.aborted) return;

        // ── 2. context + persist the user turn (shared thread) ───────
        const recent = await listTurnsRecent({
          conversationId: conversation.id,
          limit: HISTORY_CONTEXT_TURNS,
        });
        const messages = recent.turns
          .filter((t) => t.text.trim().length > 0)
          .map((t) => ({ role: t.role as TurnRole, content: t.text }));
        try {
          await appendTurn({
            conversationId: conversation.id,
            role: 'user',
            text: transcript,
            source: 'voice_stt',
          });
          messages.push({ role: 'user', content: transcript });
          void notifySyncInvalidate('operatorTurns.page', {
            conversationId: conversation.id,
          }).catch(() => {});
        } catch (e) {
          console.warn('[device/voice-turn] user turn persist failed:', (e as Error)?.message ?? e);
        }

        // ── 3+4. brain stream + per-sentence TTS pipeline ─────────────
        const ttsOk = resolvedEngine.ok;
        if (!ttsOk) {
          // Text-only degradation: the phone still gets transcript+deltas.
          sink.event('tts_state', { ok: false, error: resolvedEngine.error });
        }
        const extractor = createSentenceExtractor();
        // Raw brain deltas carry the operator tag protocol (<say>, <sleep>, …)
        // and the phone renders delta text verbatim (EI-13172) — so the wire
        // gets the extractor's CLEAN sentences, the same text the audio
        // events speak, never the raw stream.
        let deltaSeq = 0;
        const emitDelta = (sentence: string): void => {
          sink.event('delta', { text: (deltaSeq++ === 0 ? '' : ' ') + sentence });
        };
        let ttsChain: Promise<void> = Promise.resolve();
        let audioSeq = 0;
        const speak = (sentence: string): void => {
          if (!ttsOk || ctrl.signal.aborted) return;
          const seq = audioSeq++;
          ttsChain = ttsChain.then(async () => {
            if (ctrl.signal.aborted) return;
            const synth = await synthesize(
              resolvedEngine.engine,
              sentence.slice(0, MAX_TEXT_CHARS),
              undefined,
              prefs,
              { container: 'wav' },
            );
            if (ctrl.signal.aborted) return;
            if (synth.ok) {
              sink.event('audio', {
                seq,
                text: sentence,
                contentType: synth.contentType,
                audioBase64: Buffer.from(synth.audio).toString('base64'),
              });
            } else {
              sink.event('tts_state', { ok: false, seq, error: synth.error });
            }
          });
        };

        // The shared converse tool supports long, tool-using text turns and
        // therefore carries a 600s ceiling. Mobile voice is different: a
        // silent brain must fail promptly instead of pinning the FAB for ten
        // minutes and eventually leaking the framework timeout string.
        const brainDeadline = createVoiceBrainFirstEventDeadline(ctrl.signal);
        const ctxBase: UnifiedToolContext = {
          log: (msg) => {
            console.log(`[${toolName}][voice-turn] ${msg}`);
          },
          signal: brainDeadline.signal,
          progress: () => {},
          emit: () => {
            /* installed by dispatchProjectedToolStream */
          },
          workspaceId,
          role,
          runId: globalThis.crypto.randomUUID(),
          spawnId: globalThis.crypto.randomUUID(),
          transport: 'in_process',
          uiClientId: null,
        };

        let assembled = '';
        let totalCost = 0;
        let unreportedFrames = 0;
        try {
          for await (const ev of dispatchProjectedToolStream(
            tool,
            toolName,
            {
              messages,
              trigger: 'user_message',
              modality: 'voice',
              sessionUser,
              role,
              conversationId: conversation.id,
            },
            ctxBase,
            {},
          )) {
            brainDeadline.observeEvent();
            if (ctrl.signal.aborted) break;
            if (ev.kind === 'event') {
              if (ev.name === 'delta') {
                const text = (ev.data as { text?: unknown })?.text;
                if (typeof text === 'string' && text) {
                  for (const sentence of extractor.feed(text)) {
                    emitDelta(sentence);
                    speak(sentence);
                  }
                }
              } else {
                emitToSseSink(sink, tool, ev.name, ev.data);
              }
            } else if (ev.kind === 'done') {
              try {
                const t = (ev.result.content[0] as { text?: string })?.text ?? '{}';
                const out = JSON.parse(t) as { totalCost?: number; assembled?: string; unreportedFrames?: number };
                if (typeof out.totalCost === 'number' && Number.isFinite(out.totalCost)) totalCost = out.totalCost;
                if (typeof out.assembled === 'string') assembled = out.assembled;
                if (typeof out.unreportedFrames === 'number' && Number.isSafeInteger(out.unreportedFrames) && out.unreportedFrames > 0) {
                  unreportedFrames += out.unreportedFrames;
                }
              } catch (e) {
                console.warn('[device/voice-turn] tool result parse failed:', e);
              }
            } else if (ev.kind === 'error') {
              if (!ctrl.signal.aborted) {
                sink.event('error', {
                  stage: 'brain',
                  message: brainDeadline.didTimeout()
                    ? VOICE_BRAIN_TIMEOUT_MESSAGE
                    : ev.error.message,
                });
              }
              await ttsChain.catch(() => {});
              sink.close();
              return;
            }
          }

          // Defensive parity for a backend that observes abort but returns an
          // empty successful result instead of a dispatcher error.
          if (brainDeadline.didTimeout()) {
            sink.event('error', { stage: 'brain', message: VOICE_BRAIN_TIMEOUT_MESSAGE });
            await ttsChain.catch(() => {});
            sink.close();
            return;
          }

          for (const sentence of extractor.flush()) {
            emitDelta(sentence);
            speak(sentence);
          }
          await ttsChain.catch(() => {});

          // ── persist the assistant turn (clean say, same as text path) ─
          const parsed = parseOperatorTurn(assembled);

          // EI-13027: the brain stream completed cleanly (no error/timeout/abort)
          // but produced no spoken or persisted reply — an empty completion or a
          // silently-dropped brain call (correlates with pool latency under load).
          // A deliberate <sleep> going-silent turn is NOT a drop. Surface a retry
          // prompt on the existing `error` surface instead of a silent `done` that
          // leaves the phone showing / speaking nothing.
          if (
            voiceTurnProducedNoReply({
              say: parsed.say,
              report: parsed.report,
              audioChunks: audioSeq,
              wentSilent: parsed.sleep != null,
            })
          ) {
            sink.event('error', { stage: 'brain', message: VOICE_BRAIN_NO_REPLY_MESSAGE });
            sink.close();
            return;
          }

          if (parsed.say || parsed.report) {
            try {
              await appendTurn({
                conversationId: conversation.id,
                role: 'assistant',
                text: parsed.say ?? '',
                source: 'voice_tts',
                report: parsed.report,
              });
              void notifySyncInvalidate('operatorTurns.page', {
                conversationId: conversation.id,
              }).catch(() => {});
            } catch (e) {
              console.warn(
                '[device/voice-turn] assistant turn persist failed:',
                (e as Error)?.message ?? e,
              );
            }
          }

          sink.done({ costUsd: totalCost, conversationId: conversation.id, audioChunks: audioSeq, ...(unreportedFrames > 0 ? { unreportedFrames } : {}) });
        } catch (err) {
          if (!ctrl.signal.aborted) {
            sink.event('error', {
              stage: 'brain',
              message: brainDeadline.didTimeout()
                ? VOICE_BRAIN_TIMEOUT_MESSAGE
                : err instanceof Error
                  ? err.message
                  : String(err),
            });
          }
          sink.close();
        } finally {
          brainDeadline.dispose();
        }
      },
    });
  },
});

/**
 * POST /device/voice/warmup — fired when the phone opens its voice screen.
 * Pre-spawns the on-demand whisper child (the first utterance otherwise
 * eats a multi-second cold start), checks kokoro + brain availability, and
 * reports a capability snapshot the client can render (P-003).
 */
const voiceWarmup = defineTool({
  method: 'POST',
  path: '/device/voice/warmup',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const gated = await gateApiRoute(req, FLAGS.MOBILE_DESKTOP_VOICE);
    if (gated) return gated;
    devicePrincipal(ctx); // auth assertion only

    const [whisper, kokoro, brain] = await Promise.all([
      warmLocalWhisper().catch((e) => ({
        ok: false as const,
        reason: 'warm-threw',
        detail: (e as Error)?.message ?? String(e),
      })),
      kokoroTtsAvailable().catch(() => false),
      resolveBrain(),
    ]);

    return Response.json({
      ok: whisper.ok && !!brain.tool,
      stt: whisper.ok
        ? { ok: true, source: (whisper as { source?: string }).source ?? 'managed' }
        : { ok: false, reason: (whisper as { reason?: string }).reason ?? 'unknown' },
      tts: { ok: kokoro, engine: kokoro ? 'kokoro' : null },
      brain: { ok: !!brain.tool, tool: brain.toolName },
    });
  },
});

export default [voiceTurn, voiceWarmup];
