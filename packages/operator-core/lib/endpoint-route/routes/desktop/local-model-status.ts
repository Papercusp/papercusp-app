/**
 * GET /api/desktop/local-model-status — the provisioner wizard's Desktop-UI read side
 * (local-concurrent-inference-2026-07-02 P-009, D-006 "detect → recommend → …"). A thin
 * defineTool wrapper over `provisioner/provision.ts`'s planProvision() — the SAME core the
 * headless CLI (`provisioner/cli.ts`) and the `provisioner:*` agent-tools use, so the Desktop
 * step and the CLI can never drift out of sync.
 *
 * Read-only: planProvision() only shells out for read-only hardware probes (nvidia-smi etc.)
 * and stats the local ollama blob store — it never starts a process or writes anything.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { planProvision } from '../../../provisioner/provision';

export default defineTool({
  method: 'GET',
  path: '/desktop/local-model-status',
  auth: {},
  async handler() {
    try {
      const plan = await planProvision();
      return Response.json({ ok: true, plan });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});
