/**
 * loopback-fetch — fetch() for in-process calls to the operator's own :3070
 * host, with a bounded retry on transient network errors.
 *
 * The host has no hot-reload, so picking up a lib/** edit means a RESTART;
 * during that few-second boot the port REFUSES connections and an in-flight
 * loopback call (plans:promote → /features/import, the wave-advance sweep,
 * agents-list, …) would fail. Retry transient network errors (connection-refused,
 * connection-reset, DNS failures, timeouts) a few times (~2.4s) to ride over
 * a short restart or transient network hiccup — the same philosophy as the
 * PreToolUse lock hook (EI-390: agent spawn network failures).
 *
 * Only network errors are retried: HTTP responses (incl. 4xx/5xx) are
 * returned/thrown to the caller unchanged — a 500 won't get better by waiting,
 * and the caller owns status handling.
 *
 * ## Verifying this fix in the LIVE system (EI-489)
 *
 * `isTransientNetworkError` + `describeFetchError`'s unit tests
 * (loopback-fetch.test.ts) prove the retry/classification LOGIC in isolation,
 * but they cannot prove the live watchdog signal this was built to resolve
 * (EI-446 / F-FIX-006: `failed-spawns:network`, harness/improvements/watchdog.ts
 * `classifySpawnError` + `collectFailedSpawnSignals`) has actually gone quiet —
 * that needs a real operator restart under real spawn traffic. A live-restart
 * integration test would be flaky-by-construction (timing-dependent on the
 * host's actual boot window) and not worth the maintenance cost; the concrete,
 * cheap verification path instead is a DB query, since every classified spawn
 * failure is persisted with its class-determining message:
 *
 * ```sql
 * -- Any 'network'-classified spawn failures since <the fix's deploy timestamp>?
 * -- (mirrors classifySpawnError's /econnrefused|econnreset|enotfound|socket|
 * --  network|fetch failed/i match against harness_shared.spawned_agents.error_message)
 * SELECT started_at, harness_slug, error_message
 *   FROM harness_shared.spawned_agents
 *  WHERE status = 'failed'
 *    AND started_at > '<deploy timestamp>'
 *    AND error_message ~* 'econnrefused|econnreset|enotfound|socket|network|fetch failed'
 *  ORDER BY started_at DESC;
 * ```
 *
 * Zero rows (or only isolated, non-clustering ones — `collectFailedSpawnSignals`
 * fires a signal only once ≥5 land in a 6h window) = the fix is holding. Any row
 * whose `error_message` does NOT carry a `(UND_ERR_*: ...)` / `(ECONNRESET: ...)`
 * suffix predates this fix (describeFetchError started appending it) or bypassed
 * loopback-fetch entirely — worth tracing which caller. `dev:pg_query` (su) or
 * the operator's own `getOrgPg().sql` (in-process) both work; see
 * storage-policy's "reading PG-canonical state" note before hand-rolling a
 * fetch-and-jq over `failed-spawns` signals instead.
 */
const DEFAULT_BACKOFFS_MS = [400, 800, 1200];

/**
 * A long-lived launch dispatcher for the in-process loopback calls that hold the
 * connection open for a WHOLE worker run (P-033). undici's `fetch` defaults
 * `headersTimeout`/`bodyTimeout` to 5 min — but a kind:'hive' Queen wake (or an
 * overwatch loop) can run up to the invoke route's 2700s (45 min) ceiling before its
 * FIRST response headers arrive, especially on a slow opus:xhigh turn paced behind the
 * inference gateway. The 5-min headers cap severed those still-running launches with
 * `UND_ERR_HEADERS_TIMEOUT` (the EI-390 / P-033 "fetch failed" queen-launch death,
 * observed killing the bench Queen at ~5–20 min before she placed a bee). A dedicated
 * dispatcher with the header/body timeouts raised to the route ceiling lets a legitimately
 * long launch run to completion instead of being timed out by the CALLER. Lazily built
 * (only when a launch asks for it) so the normal short loopback calls keep the default
 * global dispatcher. `0` disables the per-request timer; we use the route ceiling so a
 * genuinely hung launch still eventually frees the connection.
 */
const LAUNCH_LOOPBACK_TIMEOUT_MS = Number(process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS ?? 2_700_000) + 60_000;
let launchDispatcher: unknown;
async function getLaunchDispatcher(): Promise<unknown> {
  if (launchDispatcher) return launchDispatcher;
  const { Agent } = await import('undici');
  launchDispatcher = new Agent({
    headersTimeout: LAUNCH_LOOPBACK_TIMEOUT_MS,
    bodyTimeout: LAUNCH_LOOPBACK_TIMEOUT_MS,
  });
  return launchDispatcher;
}

/** True if error is a transient network error worth retrying. */
export function isTransientNetworkError(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code;
  if (code) {
    // Transient OS-level errors: connection refused/reset, DNS failures, timeouts.
    if (/^E(CONNREFUSED|CONNRESET|NOTFOUND|TIMEDOUT|NETWORK)$/.test(code)) return true;
    // undici surfaces a mid-request server shutdown as `TypeError: fetch failed`
    // whose cause is a SocketError/timeout with a UND_ERR_* code — NOT an E-code.
    // The operator restarts on every deploy (no hot-reload), so a loopback call
    // that was connecting/in-flight gets "other side closed" (UND_ERR_SOCKET) or a
    // connect/headers timeout. These are exactly the EI-390 queen-launch failures —
    // the old early `return` on `code` swallowed them as non-transient (no retry).
    if (/^UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)$/.test(code)) return true;
    // Unknown code: don't assume non-transient — fall through to the message heuristic.
  }
  const msg = err instanceof Error ? err.message : String(err);
  // `fetch()` REJECTS only on transport failure — an HTTP error status RESOLVES to a Response —
  // so the bare `TypeError: fetch failed` wrapper is transport-class by construction and can
  // never be evidence that the CALLER's request was malformed. undici hides the real reason in
  // `.cause`, and when that cause code is absent or outside the two sets above (EAI_AGAIN,
  // ENETUNREACH, a TLS error, …) NOTHING else here matches: the literal string "fetch failed"
  // hits none of the patterns below. That hole is not theoretical — it made a workspace-host
  // provision PERMANENTLY non-retryable off one blip, because the caller's transient-vs-caller-
  // fault branch asked this function and was told "not transient" (EI-23498781044665167). The
  // second copy of this classifier (harness/routines/hetzner-orphan-frame-reaper) has always
  // had this case; the two diverged, and the provisioning runner imports THIS one.
  if (/fetch failed/i.test(msg)) return true;
  // Catch error message patterns for transient network issues
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETWORK|Connection (refused|reset)|other side closed|timeout/i.test(msg);
}

/**
 * Render a fetch error with its underlying cause code so a persisted failure is
 * self-diagnosing. undici's `fetch()` throws a generic `TypeError: fetch failed`
 * and hides the real reason in `.cause` — recording only `.message` (as the
 * spawn-launch path does) yields a blind "fetch failed" the watchdog can't act on
 * (EI-390 was undiagnosable for exactly this reason). Keeps the original message as
 * a prefix so existing classifiers/matchers (classifySpawnError → 'network') still
 * fire; appends `(CODE: detail)` when a cause code is present and not already shown.
 */
export function describeFetchError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: FetchErrorCause } | null)?.cause;
  const code = cause?.code;
  if (!code || base.includes(code)) return base;
  const detail = describeCauseDetail(cause, base);
  return `${base} (${code}${detail ? `: ${detail}` : ''})`;
}

interface FetchErrorCause {
  code?: string;
  message?: string;
  syscall?: string;
  address?: string;
  port?: number;
  errors?: unknown;
}

/**
 * The human half of a cause. Node's happy-eyeballs connect (`autoSelectFamily`) fails with an
 * `AggregateError` whose OWN message is EMPTY and whose code is copied from its first attempt, so
 * rendering only `.message` produced a bare `fetch failed (ETIMEDOUT)` that named neither the
 * address nor the address family (WI-10003516: four GCP census failures nobody could attribute).
 * The per-attempt errors (`connect ETIMEDOUT <ip>:443`, `connect ENETUNREACH <ipv6>:443`) are the
 * diagnosis, so render them; fall back to syscall/address/port for a message-less socket error.
 */
function describeCauseDetail(cause: FetchErrorCause, base: string): string {
  const parts: string[] = [];
  if (cause.message && cause.message !== base) parts.push(cause.message);
  if (Array.isArray(cause.errors)) {
    for (const attempt of cause.errors) {
      const text =
        (attempt as { message?: unknown } | null)?.message || (attempt as { code?: unknown } | null)?.code;
      if (typeof text === 'string' && text) parts.push(text);
    }
  }
  if (parts.length === 0 && cause.syscall) {
    const where = cause.address ? ` ${cause.address}${cause.port === undefined ? '' : `:${cause.port}`}` : '';
    parts.push(`${cause.syscall}${where}`);
  }
  return parts.join('; ');
}

/** @deprecated Use isTransientNetworkError instead. */
export function isConnRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  if (cause && cause.code === 'ECONNREFUSED') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|Connection refused/i.test(msg);
}

export async function loopbackFetch(
  input: string | URL,
  init?: RequestInit,
  opts: { backoffsMs?: number[]; launch?: boolean } = {},
): Promise<Response> {
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  // P-033: a long-running launch call (kind:'hive' Queen / overwatch) opts into the
  // raised-timeout dispatcher so its connection isn't severed by the caller's 5-min
  // undici headers/body cap while the worker runs up to the route's 45-min ceiling.
  let fetchInit = init;
  if (opts.launch) {
    const dispatcher = await getLaunchDispatcher();
    fetchInit = { ...(init ?? {}), dispatcher } as RequestInit;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fetch(input, fetchInit);
    } catch (err) {
      lastErr = err;
      if (isTransientNetworkError(err) && attempt < backoffs.length) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
        continue;
      }
      throw err;
    }
  }
  throw lastErr; // unreachable (loop returns or throws)
}

/**
 * Parse a Response body as JSON with an ATTRIBUTABLE error (EI-20).
 *
 * A bare `await res.json()` on an empty or truncated body rejects with a
 * frame-less `SyntaxError: Unexpected end of JSON input` whose stack is only
 * `at parse (<anonymous>)` + `processTicksAndRejections` — ZERO user frames.
 * On the fleet-shared :3070 host the (deliberate, fail-fast) unhandledRejection
 * guard in bin/hono-host.ts then exits the WHOLE process on an unattributable
 * crash — the same two-frame stack recurs unfixably (EI-20: :3070 died at
 * 03:46:57 under the agent-briefs wave, a loopback self-fetch rejecting on an
 * empty body during a host restart). This reads the body as text FIRST and, on
 * a parse failure, rethrows an Error naming the URL, HTTP status, and body
 * length so the crash is traceable to a route. The empty-body case is the
 * common one: a 200 with a zero-byte body (host restarting mid-stream) still
 * passes a `res.ok` check, so guarding on status alone does not prevent it.
 */
export async function readJsonBody<T = unknown>(
  res: Response,
  context?: string,
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const where = context || res.url || '<unknown url>';
    const detail = (err as Error)?.message ?? String(err);
    const body = text.length
      ? `; body starts: ${JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)}`
      : ' (empty body)';
    throw new Error(
      `JSON parse failed for ${where} (HTTP ${res.status}, ${text.length} byte body): ${detail}${body}`,
      { cause: err },
    );
  }
}
