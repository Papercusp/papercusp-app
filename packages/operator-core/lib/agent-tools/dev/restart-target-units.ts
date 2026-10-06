/**
 * restart-target-units — the systemd `--user` unit behind each `dev:restart`
 * target. THE one definition of these unit names.
 *
 * Why its own module rather than living next to the probe or in dev/restart.ts:
 *
 * - `dev/restart.ts` is the restart TOOL: zod + agent-mcp + db-org + the whole
 *   locks stack. A read-only caller that merely wants to know "which unit runs
 *   this?" must not drag that in (git-pipeline-agent-state-2026-07-26 P-003's
 *   `serving` stage is exactly such a caller).
 * - `systemd-service-probe.ts` looks like the natural home, but it is a module
 *   tests MOCK for its side-effecting probe. A `vi.mock` of it that does not
 *   spread `importOriginal` silently blanks any constant parked there — which
 *   is precisely how restart.test.ts broke when this map first landed beside
 *   `probeServiceStart`. Pure data belongs somewhere nobody needs to mock.
 */

/** A `dev:restart { target }` value. */
export type RestartTargetName =
  | 'dev'
  | 'staging'
  | 'gateway'
  | 'bg-host'
  | 'embed-sidecar'
  | 'mcp-proxy'
  | 'mcp-proxy-staging'
  | 'email-sidecar'
  | 'calendar-sidecar';

export const RESTART_TARGET_UNITS: Record<RestartTargetName, string> = {
  dev: 'papercusp-dev-api.service',
  staging: 'papercusp-staging-api.service',
  gateway: 'papercup-inference-gateway.service',
  'bg-host': 'papercusp-bg-host.service',
  'embed-sidecar': 'papercup-embed-sidecar.service',
  'mcp-proxy': 'papercup-mcp-proxy.service',
  'mcp-proxy-staging': 'papercup-mcp-proxy-staging.service',
  // App sidecars (WI-10001633): `npx tsx apps/sidecar/src/index.ts` straight
  // from ~/papercupai-workspace/<app> — no build, no restart-on-change, so a
  // restart is the ONLY thing that loads a tree edit into them.
  'email-sidecar': 'papercusp-email-sidecar.service',
  'calendar-sidecar': 'papercusp-calendar-sidecar.service',
};
