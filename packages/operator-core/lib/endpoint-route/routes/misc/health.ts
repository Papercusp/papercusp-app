/**
 * GET /api/health — operator liveness probe.
 *
 * A zero-dependency 200. The OMP coordination extension hits this at
 * session start to decide attached vs detached mode (plan
 * agent-coordination-architecture-v2 §10 / Q-5). No DB, no auth — a
 * liveness probe must answer even when the workspace is half-init, and
 * the prober (the bundled extension) may hold no token yet.
 *
 * Resolves Q-5: the plan's earlier draft probed `/api/health`, which
 * did not exist. It exists now.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getBuildInfo } from '../../../build-info';
import { getBundleStaleness } from '../../../bundle-staleness';

export default defineTool({
  method: 'GET',
  path: '/health',
  auth: 'public',
  handler() {
    // WI-265: expose the running checkout's sha + version so launcher↔server
    // deploy-skew is DIAGNOSABLE (the psu-launcher runs the staging tree but
    // calls :3070 = the green-release checkout). Cached after the first resolve,
    // so the zero-dependency liveness contract holds; sha is null if unresolved.
    const { sha, version } = getBuildInfo();
    // EI-20093985382484201: when ExecStartPre's bundle FAILS, bundle-host.sh now
    // starts the service on the last-known-good bundle instead of refusing to
    // start (one agent's mid-edit syntax error used to take :3170 down
    // fleet-wide). That is only a safe trade if the staleness is impossible to
    // miss — otherwise an agent verifies a fix against pre-fix code and believes
    // it. Absent on a healthy process; also read once, so /api/health stays
    // zero-dependency and non-throwing.
    const bundleStale = getBundleStaleness();
    return Response.json({
      ok: true,
      service: 'papercusp-operator',
      sha,
      version,
      // Present ONLY when this process is serving code that is not the tree it
      // was built from. `sha` above cannot express this: it reports the
      // CHECKOUT, which has already moved on to the code that failed to build.
      ...(bundleStale ? { bundleStale } : {}),
      ts: new Date().toISOString(),
    });
  },
});
