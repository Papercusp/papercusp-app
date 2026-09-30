/**
 * host-benign-errors — classification of process-level errors that are
 * CLIENT-caused and request-scoped, so the operator Hono host's
 * `unhandledRejection` / `uncaughtException` guards (hono-host.ts) can SWALLOW
 * them (log, don't exit) instead of crash-looping :3070 for the whole fleet.
 *
 * The host is multi-tenant: one bad inbound frame must cost at most its own
 * request, never the process. Everything NOT classified benign here stays
 * FAIL-FAST (the guards exit) so genuine host bugs still surface loudly.
 *
 * Both current classes originate inside the third-party `mcp-handler` lib's
 * detached write/parse pump — they reach the process as unhandled rejections we
 * cannot try/catch at our call site, so the process-level guard is the only
 * place to neutralize them.
 */

/**
 * EI-12: an MCP/SSE client disconnects mid-stream → `mcp-handler`'s response
 * adapter enqueues onto an already-closed ReadableStream controller →
 * `ERR_INVALID_STATE: Controller is already closed`. The client is already
 * gone; the only casualty should be its one request.
 */
export function isBenignStreamClose(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null;
  return (
    !!x &&
    (x.code === 'ERR_INVALID_STATE' || /Controller is already closed/i.test(x.message ?? ''))
  );
}

/**
 * EI-714: a malformed JSON-RPC body POSTed to `/api/mcp` (e.g. a stray brace).
 * `mcp-handler` parses the raw body in a detached pump, so a `JSON.parse`
 * `SyntaxError` surfaces as an unhandled rejection rather than a catchable throw
 * at our `await handler(req)`. A bad request body is client input, never a host
 * bug, so it must not down the host — answer the request with a failure, keep
 * serving everyone else.
 *
 * Scoped to JSON-parse SyntaxErrors specifically (not any SyntaxError): a
 * genuine code SyntaxError fails at module load / build, not as a runtime
 * unhandled rejection, so this can't mask a real bug. Node's `JSON.parse`
 * messages all name JSON ("… is not valid JSON", "… after JSON at position N",
 * "Unexpected end of JSON input"); the `Unexpected `-prefix fallback covers any
 * older-V8 phrasing that omits the word.
 */
export function isBenignRequestParse(e: unknown): boolean {
  if (!(e instanceof SyntaxError)) return false;
  const m = e.message ?? '';
  return /JSON/i.test(m) || m.startsWith('Unexpected ');
}

/**
 * A TRANSIENT postgres-js connection failure that escaped to the process level.
 * Under sustained event-loop saturation the main thread can block long enough
 * (observed: p99 ~103s on a CPU-bound box) that Postgres/the OS tears down the
 * operator's backend; postgres-js's DETACHED `nextWrite()` flush then fires
 * against the now-null socket and throws
 * `TypeError: Cannot read properties of null (reading 'write')` from
 * `postgres/src/connection.js` — an UNCAUGHT exception that crash-looped :3070
 * for the whole fleet (2026-06-18). The pool reconnects on the next query, so
 * this is recoverable + must not down the multi-tenant host.
 *
 * Scoped tightly: the null-`write` TypeError is matched ONLY when the stack is
 * inside postgres-js's connection module — by module PATH (dev / node_modules
 * installs) OR by the `nextWrite` FRAME NAME. The frame-name leg exists because
 * the release build BUNDLES postgres-js into `dist-host/hono-host.mjs`: the
 * stack then reads `at Immediate.nextWrite (file:///…/dist-host/hono-host.mjs:N)`
 * and the path regex can never match — which is exactly how this
 * documented-benign transient fatally killed :3070 cluster workers 26×/day on
 * 2026-07-10 (mcp-reliability-hardening-2026-07-11 P-001). esbuild preserves
 * function names, so `nextWrite` (postgres-js's detached flush fn) + the exact
 * null-`write` TypeError message stays a postgres-js-specific signature; a
 * genuine null-deref elsewhere (different frame name) still fails fast.
 * `CONNECTION_CLOSED` (postgres-js's closed-mid-write code) is also
 * treated as recoverable — if one ever escapes as an unhandled rejection, keep
 * serving rather than crash-loop. (backend-connection-scaling-2026-06-17.)
 *
 * `CONNECT_TIMEOUT` is the same class: postgres-js's DETACHED connection-timeout
 * timer (connectTimedOut → Timeout.done, connection.js:262) rejects with code
 * 'CONNECT_TIMEOUT' when a pool connect() exceeds connect_timeout — e.g. PgBouncer
 * (:6432) or PG momentarily saturated/unreachable. There is no awaitable call site
 * to try/catch (the timer fires outside any query promise), so it escaped to the
 * process guard and HARD-CRASHED the bg-host (DBOS routines / git-sync / substrate
 * primary) for the whole fleet on a transient ~5s pooler blip (2026-07-04). The
 * pool reconnects on the next query, and a GENUINE sustained DB outage is caught by
 * the dedicated liveness / lag watchdogs (startInfraLivenessAlarm,
 * lag-self-restart, cluster-lag-watchdog) — NOT by this random-which-query-times-
 * out-first guard — so a transient connect timeout must not down the host. Both
 * `CONNECT_TIMEOUT` and `CONNECTION_CLOSED` are postgres-js-invented codes (not
 * standard Node errno strings), so matching on `code` is inherently postgres-js-
 * scoped and cannot mask an unrelated error.
 */
export function isTransientPgConnectionError(e: unknown): boolean {
  const x = e as { code?: string; message?: string; stack?: string } | null;
  if (!x) return false;
  const msg = x.message ?? '';
  const stack = x.stack ?? '';
  if (
    e instanceof TypeError &&
    /Cannot read properties of null \(reading 'write'\)/.test(msg) &&
    (/postgres[\\/](?:cjs[\\/])?src[\\/]connection\.js/.test(stack) ||
      // Bundled build: the path is the bundle file, but the frame NAME survives
      // (`at Immediate.nextWrite (…/dist-host/hono-host.mjs:…)` — the live
      // 2026-07-10 26-crashes/day stack). P-001, mcp-reliability-hardening.
      /\bat (?:\w+\.)?nextWrite\b/.test(stack))
  ) {
    return true;
  }
  return (
    x.code === 'CONNECTION_CLOSED' ||
    /\bCONNECTION_CLOSED\b/.test(msg) ||
    x.code === 'CONNECT_TIMEOUT' ||
    /\bCONNECT_TIMEOUT\b/.test(msg)
  );
}

/**
 * EI-3385: a file watcher (chokidar / fs.watch — the harness-fs-watcher over
 * per-harness lockfiles + enabled-plugins, the session-claude config watcher, …)
 * hits the kernel inotify ceiling and throws
 * `ENOSPC: System limit for number of file watchers reached, watch '<path>'`. A high
 * cluster-worker count multiplied the per-process watchers past the system budget and
 * the session-claude watcher's ENOSPC surfaced as an UNCAUGHT exception →
 * crash-looped :3070 for the whole fleet (2026-06-24). A missing file watcher only
 * degrades a background convenience (a watched file just isn't auto-reloaded); it must
 * NEVER down the multi-tenant host.
 *
 * Scoped TIGHTLY to the inotify WATCH ENOSPC so a genuine disk-full ENOSPC (which is
 * a real fatal condition) still fails fast: matched only when `syscall === 'watch'`
 * OR the message names the watcher limit. A disk-full ENOSPC carries syscall
 * 'write'/'open' and the message "no space left on device", so it is NOT swallowed.
 */
export function isBenignFileWatcherError(e: unknown): boolean {
  const x = e as { code?: string; syscall?: string; message?: string } | null;
  if (!x || x.code !== 'ENOSPC') return false;
  return x.syscall === 'watch' || /number of file watchers|inotify/i.test(x.message ?? '');
}

/**
 * A plan-scope resolution that cannot resolve its workspace — `resolvePlanScope` throws
 * "resolvePlanScope: harness '<x>' is not registered in the harness registry …" or
 * "resolvePlanScope: plans are Hive-scoped, but '<x>' is not a Hive home …" (WI-148: it refuses to
 * silently default to a wrong workspace). Some callers resolve the scope in a FIRE-AND-FORGET
 * (a plan-event projection / best-effort emit / audit) whose promise we can't try/catch at our
 * `await handler(req)` call site, so a request naming an unresolvable harness (e.g. `'operator'`, or a
 * non-Hive harness) surfaced the throw as an UNHANDLED REJECTION that crash-looped a :3070 cluster
 * worker — killing all of that worker's in-flight requests + churning a respawn (the owner-reported
 * "~10 worker crashes / 3 days"). It is request-scoped (only that one operation can't resolve), so
 * SWALLOW it (keep the multi-tenant host alive) rather than down the whole worker.
 *
 * Scoped TIGHTLY to the `resolvePlanScope:` signature + its two distinctive WI-148 phrases, so a
 * genuine unrelated error still fails fast. The underlying "why was an unresolvable harness passed"
 * is a separate caller-quality issue; this only stops it from CRASHING the host.
 */
export function isUnresolvablePlanScopeError(e: unknown): boolean {
  const m = (e as { message?: string } | null)?.message ?? '';
  return (
    /resolvePlanScope:/.test(m) &&
    (/is not registered in the harness registry/.test(m) || /is not a Hive home/.test(m))
  );
}

/**
 * A broken-pipe write (`write EPIPE` from libuv's WriteWrap): the READER end of
 * a pipe/socket closed before a pending write completed — a disconnected
 * SSE/HTTP client, a dead child process's stdin, a torn-down IPC socket. EPIPE
 * is by construction peer-caused and connection-scoped (the errno only exists
 * for writes against a peer-closed pipe; a read can't raise it), so the only
 * casualty should be that one stream — never the process.
 *
 * The incident that mandates this (2026-07-07 12:36–12:51): sustained
 * event-loop saturation (the WI-3333 neologism-miner slot) starved a pipe peer
 * until it died; the pending write's EPIPE reached the process guard and
 * HARD-CRASHED the bg-host (DBOS routines / git-sync / substrate primary) —
 * then each reboot's catchup re-fired the same slot → SIX crash cycles in 16
 * minutes, with every in-flight routine + git-sync killed each time. The
 * saturation trigger is fixed separately; this closes the amplifier: a peer
 * death mid-write must cost one stream, not the multi-tenant host.
 */
export function isBenignBrokenPipeError(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'EPIPE';
}

/**
 * Any process-level error that is client-caused + request-scoped, OR a transient
 * recoverable infra blip (a torn-down PG connection, an exhausted file-watcher
 * budget, a peer-closed pipe) → the host guards log it and KEEP RUNNING.
 * Everything else stays fail-fast (exit).
 */
export function isBenignHostError(e: unknown): boolean {
  return (
    isBenignStreamClose(e) ||
    isBenignRequestParse(e) ||
    isTransientPgConnectionError(e) ||
    isBenignFileWatcherError(e) ||
    isUnresolvablePlanScopeError(e) ||
    isBenignBrokenPipeError(e)
  );
}
