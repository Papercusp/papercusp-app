/**
 * Ports owned by long-lived core services. An opportunistic port-walk (the
 * voice WS servers' EADDRINUSE fallback) must NEVER squat one: 2026-06-10 the
 * staging host's mobile-voice walk (base 3068) stepped onto :3070 during the
 * release deploy's stop window, so the GREEN operator crash-looped on
 * EADDRINUSE and the fleet's MCP surface answered 426 (a WS server speaking
 * to plain-HTTP clients) until the squatter was found (EI-294).
 *
 * Walkers SKIP these instead of binding them — a reserved port that happens
 * to be free right now belongs to a service that may start (or restart)
 * later; squatting it converts that service's boot into a crash-loop.
 * Over-reserving is harmless (the walk just steps past), so list every
 * canonical port, not only the ones a walk has already hit.
 */
export const RESERVED_SERVICE_PORTS: ReadonlySet<number> = new Set([
  3055, // Vite SPA dev server
  3056, // green operator PTY WS (papercup-dev-api 20-pty-ws.conf)
  3057, // marketplace-api.service
  3060, // staging operator PTY WS (papercup-staging-api 20-pty-ws.conf)
  3070, // GREEN operator (release checkout)
  3170, // staging operator (integration tree)
  3270, // desktop session's own working-tree operator (dev-operator-ifneeded.sh)
  3274, // desktop session operator PTY WS (3270 + 4)
]);

export function isReservedServicePort(port: number): boolean {
  return RESERVED_SERVICE_PORTS.has(port);
}
