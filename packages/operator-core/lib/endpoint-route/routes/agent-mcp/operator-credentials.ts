/**
 * GET/PUT /api/agent-mcp/operator-credentials — masked voice-credential read/write.
 * Ported from app/api/agent-mcp/operator-credentials/route.ts. `auth: 'public'`.
 */
import {
  readElevenLabsKey,
  writeElevenLabsKey,
  readOpenAiKey,
  writeOpenAiKey,
  readCartesiaKey,
  writeCartesiaKey,
  readDeepgramKey,
  writeDeepgramKey,
  readPicovoiceKey,
  writePicovoiceKey,
  maskKey,
  inspectElevenLabsApiKey,
} from '../../../voice-credentials';
import { defineTool } from '@papercusp/agent-mcp';

async function snapshot() {
  // Status must expose (masked) legacy-invalid values so the UI can explain
  // and replace them. Outbound callers use readElevenLabsKey()'s safe default.
  const e = await readElevenLabsKey({ allowInvalid: true });
  const o = await readOpenAiKey();
  const c = await readCartesiaKey();
  const d = await readDeepgramKey();
  const p = await readPicovoiceKey();
  const eStatus = inspectElevenLabsApiKey(e);
  return {
    elevenlabs: {
      apiKey: maskKey(e),
      configured: eStatus.healthy,
      healthy: eStatus.healthy,
      error: eStatus.error,
    },
    openai: { apiKey: maskKey(o), configured: !!o },
    cartesia: { apiKey: maskKey(c), configured: !!c },
    deepgram: { apiKey: maskKey(d), configured: !!d },
    picovoice: { apiKey: maskKey(p), configured: !!p },
  };
}

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-credentials',
  auth: 'public',
  async handler() {
    return Response.json(await snapshot());
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/agent-mcp/operator-credentials',
  auth: 'loopback',
  async handler(req) {
    let body: {
      elevenlabsApiKey?: unknown;
      openaiApiKey?: unknown;
      cartesiaApiKey?: unknown;
      deepgramApiKey?: unknown;
      picovoiceApiKey?: unknown;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return new Response('invalid JSON', { status: 400 });
    }
    const setKey = async (
      field: keyof typeof body,
      write: (v: string | null) => Promise<void>,
    ): Promise<Response | null> => {
      if (!(field in body)) return null;
      const v = body[field];
      if (v === null) {
        await write(null);
        return null;
      }
      if (typeof v === 'string' && v.length > 0) {
        if (field === 'elevenlabsApiKey') {
          const status = inspectElevenLabsApiKey(v);
          if (!status.healthy) {
            return Response.json(
              { ok: false, error: 'invalid_elevenlabs_api_key', detail: status.error },
              { status: 400 },
            );
          }
        }
        await write(v);
        return null;
      }
      return new Response(`${field} must be string or null`, { status: 400 });
    };
    for (const [field, writer] of [
      ['elevenlabsApiKey', writeElevenLabsKey],
      ['openaiApiKey', writeOpenAiKey],
      ['cartesiaApiKey', writeCartesiaKey],
      ['deepgramApiKey', writeDeepgramKey],
      ['picovoiceApiKey', writePicovoiceKey],
    ] as const) {
      const err = await setKey(field, writer);
      if (err) return err;
    }
    return Response.json(await snapshot());
  },
});

export default [get, put];
