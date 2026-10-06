/**
 * First-import guard for the Hono host's main listener.
 *
 * Keep this module tiny and synchronous: `hono-host.ts` imports it before the
 * bootstrap/handler graph, so a persistent port holder is rejected before
 * native addons, Postgres, routines, or cluster workers initialize.
 */
import { portAvailableSync } from '@papercusp/operator-core/lib/port-availability';
import { resolveBindHost } from '@papercusp/operator-core/lib/resolve-bind-host';
import cluster from 'node:cluster';

const sidecarMode =
  process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MODE === '1' ||
  process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE === '1' ||
  process.env.PAPERCUSP_GATEWAY_SIDECAR_MODE === '1' ||
  process.env.PAPERCUSP_EMBED_SIDECAR_MODE === '1' ||
  process.env.PAPERCUSP_RESOURCE_GOVERNOR_MONITOR_MODE === '1' ||
  process.env.PAPERCUSP_LSP_DAEMON_MODE === '1';
const port = Number(process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT ?? 3070);
const hostname = resolveBindHost();

// The primary checks for an unrelated port holder before it forks. Workers
// intentionally join an existing SO_REUSEPORT listener; an exclusive probe in
// each replacement worker would mistake a healthy sibling for a conflict.
if (cluster.isPrimary && !sidecarMode && !portAvailableSync(port, hostname)) {
  console.error(
    `[hono-host] fatal EADDRINUSE during pre-bootstrap port check: ${hostname}:${port} is already in use`,
  );
  process.exit(1);
}
