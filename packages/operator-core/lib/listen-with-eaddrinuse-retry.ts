/**
 * listen-with-eaddrinuse-retry.ts — EI-18734124566158657.
 *
 * A straggling peer process that recently held a given port (another
 * verify-tauri-headless.sh instance mid-teardown, a dev-restart still
 * draining, an unrelated process on a heavily-loaded shared box, …) can leave
 * it genuinely bound for a few seconds AFTER a caller's port-freedom probe
 * (`ss -tln`, `fed_pick_free_port`, …) reported it free — the classic
 * pick-then-bind TOCTOU race. Node surfaces that as a bare `EADDRINUSE`
 * 'error' event; with no listener attached, Node re-raises it as an uncaught
 * exception, which hono-host.ts's process-level handler treats as fatal and
 * exits immediately — no recovery, even though the straggler is typically
 * gone within a second or two.
 *
 * `listenWithEaddrinuseRetry` retries a BOUNDED number of times with a short
 * fixed delay before giving up: this absorbs a transient squatter without
 * masking a genuine, persistent port conflict (which still reaches
 * `onFatal` — just a few seconds later than an immediate failure would).
 *
 * Deliberately callback-based (`onListening` / `onFatal`) rather than
 * re-throwing from inside the `srv.on('error', …)` handler: relying on an
 * uncaught throw from an async event-emitter callback to propagate to
 * `process.on('uncaughtException')` works, but it is untestable in isolation
 * and couples this module to its caller's global exception handling. An
 * explicit `onFatal` callback lets the caller (hono-host.ts) reproduce its
 * existing fatal-log-and-exit behavior exactly, and lets tests assert the
 * exhausted-retry path without spawning a real process.
 */

export interface ListenWithEaddrinuseRetryOptions {
  port: number;
  host: string;
  reusePort?: boolean;
  /** Total bind attempts before giving up (first attempt counts as 1). Default 8. */
  maxAttempts?: number;
  /** Fixed delay between attempts, ms. Default 1000. */
  retryDelayMs?: number;
  onListening: () => void;
  /** Called once, at most, when retries are exhausted or a non-EADDRINUSE error occurs. */
  onFatal: (err: NodeJS.ErrnoException) => void;
  /** Called before each retry (not on the final failure). Defaults to console.warn. */
  warn?: (message: string) => void;
}

type MinimalListenableServer = {
  once(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown;
  removeListener(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown;
  listen(
    options: { port: number; host: string; reusePort?: boolean } | number,
    hostOrCb?: string | (() => void),
    cb?: () => void,
  ): unknown;
};

export function listenWithEaddrinuseRetry(
  srv: MinimalListenableServer,
  opts: ListenWithEaddrinuseRetryOptions,
  attempt = 1,
): void {
  const maxAttempts = opts.maxAttempts ?? 8;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  const onError = (err: NodeJS.ErrnoException): void => {
    srv.removeListener('error', onError);
    if (err?.code === 'EADDRINUSE' && attempt < maxAttempts) {
      warn(
        `[listen-retry] EADDRINUSE on ${opts.host}:${opts.port} (attempt ${attempt}/${maxAttempts}) ` +
          `— retrying in ${retryDelayMs}ms (transient-straggler recovery, EI-18734124566158657)`,
      );
      setTimeout(() => {
        listenWithEaddrinuseRetry(srv, opts, attempt + 1);
      }, retryDelayMs);
      return;
    }
    opts.onFatal(err);
  };

  srv.once('error', onError);
  if (opts.reusePort) {
    srv.listen({ port: opts.port, host: opts.host, reusePort: true }, opts.onListening);
  } else {
    srv.listen(opts.port, opts.host, opts.onListening);
  }
}
