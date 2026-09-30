/**
 * POST /api/agent-mcp/operator-stt — one-shot speech-to-text for non-browser
 * clients (the TUI's PTT path — voice-mode-tui-port-2026-06-05 D-006).
 *
 * Body: `{ audioBase64: string, format?: 'wav' | 'webm' }` → `{ ok, text }`.
 * The audio crosses the wire as base64 JSON because the TUI's IPC `sys:http`
 * bridge reassembles bodies as UTF-8 strings (binary-unsafe), and a remote
 * TUI can't reach this box's localhost voicemode service directly — the
 * operator proxies. Same upstream the browser PTT path POSTs WAV blobs to:
 * voicemode Whisper's OpenAI-compatible `/v1/audio/transcriptions`.
 * `auth: 'loopback'` (auth-tier Wave 1) like the sibling operator voice routes.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { decodeAudioBase64, normalizeAudioFormat } from './operator-voice-proxy-helpers';
import { fetchWhisperWithRecovery } from '../../../voice-node/local-whisper-service';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-stt',
  auth: 'loopback',
  async handler(req) {
    let body: { audioBase64?: unknown; format?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const decoded = decodeAudioBase64(body.audioBase64);
    if (!decoded.ok) {
      return Response.json({ ok: false, error: decoded.error }, { status: decoded.status });
    }
    const audio = decoded.audio;
    const format = normalizeAudioFormat(body.format);

    let r: Response;
    try {
      // External whisper (VOICEMODE_URL) when reachable; else the operator-managed
      // provisioned whisper-server child. A transport/5xx failure gets one lifecycle warm +
      // retry; successful and client-error requests stay single-fetch (P-003).
      r = await fetchWhisperWithRecovery((sttBase) => {
        const fd = new FormData();
        fd.append(
          'file',
          // A Node Buffer isn't a BlobPart; wrap as a plain Uint8Array view.
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
      return Response.json(
        { ok: false, error: `whisper unreachable: ${(e as Error).message}` },
        { status: 502 },
      );
    }
    if (!r.ok) {
      return Response.json({ ok: false, error: `whisper ${r.status}` }, { status: 502 });
    }
    const out = (await r.json().catch(() => null)) as { text?: string } | null;
    return Response.json({ ok: true, text: (out?.text ?? '').trim() });
  },
});
