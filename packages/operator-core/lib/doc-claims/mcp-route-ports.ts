/**
 * Doc claim: CLAUDE.md documents the MCP proxy's default listen/upstream ports and
 * directs agents to use per-invocation serving-host telemetry before attributing a
 * loaded build to a specific host.
 *
 * The default proxy route is not proof of which operator host served a particular MCP
 * invocation: telemetry has recorded the same owner on both `port-3070` and `port-3170`.
 * The default ports are PINNED here rather than hand-maintained: they live in the proxy
 * entrypoint and shipped systemd unit. This judge checks those defaults; the companion
 * test separately guards the per-invocation telemetry guidance.
 *
 * Subjects:
 *   apps/operator/bin/mcp-proxy.ts                          listen + target defaults
 *   apps/operator/scripts/systemd/papercup-mcp-proxy.service shipped listen port
 */

export const PROXY_ENTRYPOINT = 'apps/operator/bin/mcp-proxy.ts';
export const PROXY_UNIT = 'apps/operator/scripts/systemd/papercup-mcp-proxy.service';

export interface McpRoutePortsVerdict {
  ok: boolean;
  /** Default listen port parsed from the entrypoint (the `:9071` an agent's client hits). */
  listenPort: number | null;
  /** Default upstream port parsed from the entrypoint (the `:3070` that executes the call). */
  targetPort: number | null;
  /** Listen port the shipped systemd unit pins via Environment=. */
  unitListenPort: number | null;
  problems: string[];
}

/**
 * Strip `/* … *\/` blocks and `//` line comments.
 *
 * Load-bearing, for the same reason as the attribution-arming claim: this entrypoint
 * carries a long header comment that spells out "default 9071" and "3070" in prose. A
 * scan that did not strip comments would keep passing after the real assignments were
 * deleted or changed — the header alone would satisfy it.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function lastNumericFallback(expr: string): number | null {
  const parts = expr.split('??');
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1].trim();
  return /^\d+$/.test(tail) ? Number(tail) : null;
}

export function judgeMcpRoutePorts(input: {
  proxySource: string;
  unitSource: string;
  /** The rendered doc text whose claim is being pinned (CLAUDE.md, or the part body). */
  docSource: string;
}): McpRoutePortsVerdict {
  const problems: string[] = [];
  const code = stripComments(input.proxySource);

  const listenMatch = code.match(
    /listenPort\s*:\s*Number\(\s*process\.env\.PAPERCUSP_MCP_PROXY_PORT\s*\?\?\s*(\d+)\s*\)/,
  );
  const listenPort = listenMatch ? Number(listenMatch[1]) : null;
  if (listenPort === null) {
    problems.push(
      `${PROXY_ENTRYPOINT}: could not read a default listen port from a live ` +
        `listenPort: Number(process.env.PAPERCUSP_MCP_PROXY_PORT ?? <n>) assignment.`,
    );
  }

  const targetMatch = code.match(/targetPort\s*=\s*Number\(([^)]*)\)/);
  const targetPort = targetMatch ? lastNumericFallback(targetMatch[1]) : null;
  if (targetPort === null) {
    problems.push(
      `${PROXY_ENTRYPOINT}: could not read a default upstream port from a live ` +
        `targetPort = Number(… ?? <n>) assignment.`,
    );
  }

  const unitMatch = stripUnitComments(input.unitSource).match(
    /^Environment=PAPERCUSP_MCP_PROXY_PORT=(\d+)\s*$/m,
  );
  const unitListenPort = unitMatch ? Number(unitMatch[1]) : null;
  if (unitListenPort === null) {
    problems.push(`${PROXY_UNIT}: no Environment=PAPERCUSP_MCP_PROXY_PORT=<n> line.`);
  }

  if (listenPort !== null && unitListenPort !== null && listenPort !== unitListenPort) {
    problems.push(
      `the shipped unit pins :${unitListenPort} but the entrypoint defaults to ` +
        `:${listenPort} — the doc cannot describe both.`,
    );
  }

  // The doc must name the SAME two DEFAULT ports the code resolves. This does not assert
  // which host served any particular call; the companion test pins that distinction.
  if (listenPort !== null && !input.docSource.includes(`:${listenPort}`)) {
    problems.push(`doc does not mention the proxy listen port :${listenPort}.`);
  }
  if (targetPort !== null && !input.docSource.includes(`:${targetPort}`)) {
    problems.push(`doc does not mention the upstream execution port :${targetPort}.`);
  }

  return { ok: problems.length === 0, listenPort, targetPort, unitListenPort, problems };
}

/** systemd unit files comment with a leading `#`. */
function stripUnitComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}
