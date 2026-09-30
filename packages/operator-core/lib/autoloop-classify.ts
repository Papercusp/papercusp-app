/**
 * WI-669 (2026-07-02): classify a fire-failure message as INFRA-shaped (transient:
 * gateway stalls, host restarts, rate limits, timeouts, transport) vs a genuine
 * role/turn failure. Infra failures record 'infra-error' — status stamped, the
 * consecutive-errors counter PRESERVED — so a transient outage can't ratchet the
 * exponential backoff to the ~1-fire/hour circuit that made a healthy loop look
 * dead (observed 2026-06-23: consecutive_errors=7 → 3600s cap). Genuine failures
 * still back off + trip the circuit.
 *
 * Dependency-free ON PURPOSE (no db-org import) so any caller/test can use the
 * real classifier without the autoloop module graph.
 */
export function classifyFireError(message: string): 'infra-error' | 'error' {
  return /HTTP 5\d\d|HTTP 404|unknown project|ECONNREFUSED|ECONNRESET|EPIPE|connection (refused|reset|closed)|fetch failed|socket hang up|timed out|timeout|deadline|rate.?limit|429|overloaded|infra_loss|gateway (stall|throttl|unavailable)|reclaimed at operator|dead\/restarting launcher|resume-turn-death:(rate-limit|infra|transport)|no (Kettle |queen )?turn/i.test(
    message,
  )
    ? 'infra-error'
    : 'error';
}
