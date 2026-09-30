/**
 * `fetchWithTimeout` — a `fetch` for TanStack Router `beforeLoad` / `loader`
 * data that CANNOT hang forever.
 *
 * WI-2817 root cause: the app-shell route loaders (`routes/index.tsx`'s entry
 * `beforeLoad`, `routes/harness/$slug`'s `loader`) issued a BARE `fetch('/api/…')`
 * with no timeout and no abort signal. On the desktop those `/api/desktop/*`
 * calls go native HTTP to the content-origin operator/sidecar. When that backend
 * is WEDGED mid-restart (the substrate primary / bg-host bounced) it *accepts the
 * socket but never sends a response* — so the bare `fetch` never settles. It
 * neither resolves nor rejects, so the surrounding `try/catch` (and even a
 * retry loop, which only re-runs on a REJECTION) never fires. TanStack Router
 * therefore stays `status:'pending'` forever: with `defaultPendingMs:0` +
 * `defaultPendingComponent:() => null`, that renders BLANK content under a stuck
 * `bprogress-busy` bar — the "desktop isn't launching, it's stalling; needs a
 * manual relaunch" symptom the owner reported.
 *
 * The fix is a TIMEOUT (an `AbortController` armed with `setTimeout`, not the
 * newer `AbortSignal.timeout` — this composes with a caller signal and is
 * trivially fake-timer testable across WebKitGTK versions). A hung attempt is
 * aborted after `timeoutMs`, which turns the hang into a normal rejection the
 * caller (or the retry below) can act on — so the route always resolves to a
 * real landing / error / retry instead of an infinite stall.
 *
 * Retry semantics: only a TIMEOUT or a NETWORK error is retried (the backend
 * never answered — riding out a transient restart lets a returning user's app
 * auto-recover WITHOUT a manual relaunch). A received HTTP `Response` — even a
 * non-2xx one — is returned immediately; the caller decides what a 4xx/5xx
 * means. A caller-initiated abort is propagated at once and never retried.
 */

export interface FetchWithTimeoutOptions {
  /** Abort (and reject) a single attempt after this many ms. Default 4000. */
  timeoutMs?: number;
  /** Additional attempts after the first, on timeout/network failure for GET/HEAD only. Default 0. */
  retries?: number;
  /**
   * Backoff before each retry; the attempt index is clamped to the last entry.
   * Default `[400, 1200]` — spans a quick sidecar bounce without a long blank.
   */
  retryBackoffMs?: number[];
  /** Standard fetch init. A caller `signal` is composed with the timeout. */
  init?: RequestInit;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable delay (tests pass a no-op). Default: real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RETRY_BACKOFF_MS = [400, 1200];

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when `err` is the caller's own abort (propagate) vs our timeout (retry). */
function callerAborted(signal: AbortSignal | null | undefined): boolean {
  return Boolean(signal?.aborted);
}

export async function fetchWithTimeout(
  url: string,
  opts: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 0,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
    init,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = opts;

  const callerSignal = init?.signal ?? null;
  // A rejected mutation may have reached the server before the transport
  // reported its failure. Keep this helper aligned with ipcFetch's existing
  // safe-retry boundary: only GET and HEAD may be replayed automatically.
  const method = String(init?.method ?? 'GET').toUpperCase();
  const retryableMethod = method === 'GET' || method === 'HEAD';
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Fresh controller per attempt so a prior timeout's abort doesn't poison
    // the retry. Composed with the caller's signal so a real cancel still wins.
    const controller = new AbortController();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      // Any HTTP response — including non-2xx — is a real answer; hand it back.
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // A genuine caller cancel propagates immediately; never burn a retry on it.
      if (callerAborted(callerSignal) && !timedOut) throw err;
      if (!retryableMethod || attempt >= retries) throw err;
      await sleep(retryBackoffMs[Math.min(attempt, retryBackoffMs.length - 1)]);
    }
  }

  // Unreachable (the loop either returns or throws), but satisfies the compiler.
  throw lastErr;
}
