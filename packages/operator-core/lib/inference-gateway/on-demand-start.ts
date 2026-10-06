/**
 * inference-gateway/on-demand-start — the idle-watermark discipline around an on-demand cold start
 * (WI-10006360).
 *
 * The idle-reaper (idle-backend-reaper.ts) decides from ONE durable watermark, `last_busy_at`. A
 * stopped backend's watermark is by definition older than its idle TTL, so the moment a cold-started
 * backend's slots first read `idle` the reaper's sweep sees "idle past TTL" and stops it — unless the
 * watermark already moved. Stamping only AFTER readiness leaves exactly that window open: the backend
 * becomes ready, the reaper sweeps before the gateway's readiness poll notices, and the backend is
 * stopped before it serves the request that started it (measured 2026-10-06T04:26:46Z: ornith reached
 * readiness after 3m42s and `[idle-backend-reaper] stopped ornith-llamaserver` fired ~2s later).
 *
 * So the watermark is stamped BEFORE the start (closing the window: idle age is now measured from the
 * moment a request needed the backend) and again AFTER a successful start (so the TTL is measured from
 * readiness, not from the beginning of a multi-minute load). A failed stamp never fails the start — a
 * backend that cannot record its watermark still serves; it is only at risk of an early reap, which
 * the warning names.
 */

export interface OnDemandStartResult {
  ok: boolean;
  error?: string;
}

export interface OnDemandStartDeps {
  /** Move the backend's `last_busy_at` watermark to now (its resolved value is ignored). */
  markBusy: () => Promise<unknown>;
  /** Start the backend and wait for readiness. */
  start: () => Promise<OnDemandStartResult>;
  log: (level: 'info' | 'warn', msg: string) => void;
  /** The ready budget the start was given, named in the failure line so a timeout is legible. */
  budgetMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export async function startOnDemandBackendWithWatermark(
  backendId: string,
  deps: OnDemandStartDeps,
): Promise<OnDemandStartResult> {
  try {
    await deps.markBusy();
  } catch (e) {
    deps.log(
      'warn',
      `inference-gateway: could not pre-stamp last_busy_at before starting '${backendId}' — the idle-reaper may stop it as soon as it is ready: ${(e as Error).message}`,
    );
  }
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const result = await deps.start();
  if (result.ok) {
    try {
      await deps.markBusy();
    } catch (e) {
      deps.log('warn', `inference-gateway: started '${backendId}' but could not stamp last_busy_at: ${(e as Error).message}`);
    }
  } else {
    // WI-10006503: a failed on-demand start becomes a 502 for the request that triggered it. Before
    // this line existed that path left NOTHING in the journal, so a ready budget set below the real
    // cold-load time (300s vs a measured 304s) failed intermittently and invisibly.
    const budget = deps.budgetMs === undefined ? 'unstated' : `${deps.budgetMs}ms`;
    deps.log(
      'warn',
      `inference-gateway: on-demand start of '${backendId}' FAILED after ${now() - startedAt}ms (ready budget ${budget}): ${result.error ?? 'no error reported'} — the request that triggered it gets a 502; the unit is left running, so a retry may find it warm`,
    );
  }
  return result;
}
