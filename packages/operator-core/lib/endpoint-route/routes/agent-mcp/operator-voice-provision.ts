/**
 * POST /api/agent-mcp/operator-voice-provision — kick off the local-voice install
 * (voice-public-release-readiness-2026-07-12 P-009 hop 4, plan D-009).
 *
 * The settings "Install local voice" button posts here; the download/verify work
 * (whisper-server binary + ggml model + kokoro ONNX model, several hundred MB total) runs
 * async in the operator, single-flight. Progress/completion is polled via the existing
 * GET operator-voice-engine-health route (its `localVoice.installer` block) — no new poll
 * surface, no long-held request. `auth: 'loopback'` like the sibling voice routes.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { startLocalVoiceProvision, getLocalVoiceProvisionStatus } from '../../../voice-node/local-voice-provision';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-voice-provision',
  auth: 'loopback',
  async handler() {
    const kick = startLocalVoiceProvision();
    const status = await getLocalVoiceProvisionStatus();
    return Response.json({ ok: true, ...kick, status });
  },
});
