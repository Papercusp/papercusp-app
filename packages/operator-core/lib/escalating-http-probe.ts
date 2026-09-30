/**
 * Shared escalating-timeout HTTP reachability probe.
 *
 * The "single 2500ms probe false-negatives under box load" bug (EI-1693) was
 * fixed in TWO places independently (learning-infra-health + system-health
 * compute), and the second had DRIFTED out of sync (WI-266) precisely because
 * there was no shared helper. This is that helper — both gateway probes delegate
 * here, so the fix can't drift again, and any future HTTP health probe reuses it
 * (per agent-insights/transient-signal-over-reaction recipe #2).
 *
 * Semantics: ANY HTTP answer (incl. a 503 pacing pause) = reachable (the process
 * is alive); only a transport failure (timeout / connection refused) on EVERY
 * attempt is unreachable. Retries with an escalating, load-aware timeout so one
 * transient timeout under load is not mistaken for an outage.
 */

export interface HttpProbeResult {
  reachable: boolean;
  /** Evidence: `HTTP <status>` (with `(after N retries)` if it took one) when
   *  reachable; the last transport error (+ attempt summary) otherwise. */
  detail: string;
}

/** Escalating per-attempt timeouts: a fast first probe, then a load-tolerant retry. */
export const DEFAULT_PROBE_TIMEOUTS_MS = [2500, 6000] as const;
/** Brief gap between attempts so a momentary scheduling stall can clear. */
export const DEFAULT_PROBE_GAP_MS = 250;

export async function probeHttpReachable(
  url: string,
  opts: { timeouts?: readonly number[]; gapMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HttpProbeResult> {
  const timeouts = opts.timeouts && opts.timeouts.length > 0 ? opts.timeouts : DEFAULT_PROBE_TIMEOUTS_MS;
  const gapMs = opts.gapMs ?? DEFAULT_PROBE_GAP_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  let last: HttpProbeResult = { reachable: false, detail: 'no attempt' };
  for (let i = 0; i < timeouts.length; i++) {
    const timeoutMs = timeouts[i];
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const retried = i > 0 ? ` (after ${i} retr${i === 1 ? 'y' : 'ies'})` : '';
      return { reachable: true, detail: `HTTP ${res.status}${retried}` };
    } catch (e) {
      const why =
        e instanceof Error ? (e.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : e.message) : String(e);
      const lastAttempt = i + 1 >= timeouts.length;
      last = {
        reachable: false,
        detail: lastAttempt ? `${why} (${timeouts.length} attempts, escalating to ${timeouts[timeouts.length - 1]}ms)` : why,
      };
      if (!lastAttempt && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  return last;
}
