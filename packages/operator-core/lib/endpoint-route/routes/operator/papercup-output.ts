/**
 * /api/operator/papercup-output — local-mode drain for the Sentinel's shared
 * voice-out FIFO. The PRIMARY emitter is the `voice:say` MCP tool
 * (`pushSentinelSay`); this GET path is only the fallback local-webview
 * consumer when no full-agent voice session is live.
 *
 * LOCAL APP USER ONLY (owner constraint): the local STT/TTS pipeline ↔ the
 * Claude-TUI pane, NOT the P2P voice-channel system. `auth: 'loopback'`.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { drainSentinelSays } from '../../../sentinel-output-buffer';

const get = defineTool({
  method: 'GET',
  path: '/operator/papercup-output',
  auth: 'loopback',
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    return Response.json({ says: await drainSentinelSays() });
  },
});

export default [get];
