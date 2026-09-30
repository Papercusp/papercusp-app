/**
 * GET /api/device/qr.svg?payload=<json> — server-rendered pairing QR.
 * Ported from app/api/device/qr.svg/route.ts. `auth: 'public'` — the
 * route keeps its own loopback Host-header gate (the payload carries a
 * one-time 5-min pairToken).
 */
import { toString as qrToString } from 'qrcode';
import { defineTool } from '@papercusp/agent-mcp';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export default defineTool({
  method: 'GET',
  path: '/device/qr.svg',
  auth: 'public',
  async handler(req) {
    const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
      return Response.json({ error: 'loopback_only' }, { status: 403 });
    }
    const payload = new URL(req.url).searchParams.get('payload');
    if (!payload) return Response.json({ error: 'missing_payload' }, { status: 400 });
    if (payload.length > 4096) {
      return Response.json({ error: 'payload_too_large' }, { status: 400 });
    }
    try {
      const svg = await qrToString(payload, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
        color: { dark: '#0a0a0a', light: '#ffffff' },
      });
      return new Response(svg, {
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    } catch (e) {
      return Response.json(
        { error: 'render_failed', detail: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },
});
