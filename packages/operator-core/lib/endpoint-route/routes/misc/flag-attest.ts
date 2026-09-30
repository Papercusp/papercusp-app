/**
 * GET /api/internal/flags-attest?key=<flag>&distinctId=<id>
 *
 * A same-box process probe for the value THIS operator-shaped process resolves
 * through its own live flag resolver. The agent-facing flags:attest tool fans
 * out to this route through the existing endpoint-ipc discovery registry.
 *
 * Loopback-only: the payload exposes no secrets, but it does disclose runtime
 * configuration and process/build identity and has no reason to leave the box.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { assertKnownFlagKey, buildProcessFlagAttestation } from '../../../flag-attestation';
import { describeProcessRole, ownHonoPort } from '../../../schedule-federation';

export default defineTool({
  method: 'GET',
  path: '/internal/flags-attest',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const key = url.searchParams.get('key')?.trim() ?? '';
    if (!key) {
      return Response.json({ ok: false, error: 'missing key' }, { status: 400 });
    }
    try {
      assertKnownFlagKey(key);
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }

    const port = ownHonoPort();
    const role = describeProcessRole();
    try {
      return Response.json(
        await buildProcessFlagAttestation(key, url.searchParams.get('distinctId')?.trim() || 'flags-attest', {
          role,
          label: `${role}:${port}`,
          port,
        }),
      );
    } catch (error) {
      // Diagnostics fail as data, not as an unlabelled process 5xx. The caller
      // keeps this host in its coverage table with an actionable error.
      return Response.json({
        ok: false,
        process: { role, label: `${role}:${port}`, port, pid: process.pid },
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
