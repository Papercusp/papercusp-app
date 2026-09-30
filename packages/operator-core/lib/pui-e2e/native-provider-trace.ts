/** Keep the fixture's real upstream across starts of the same native home. */
export function nativeProviderTraceOrigin(
  configuredOrigin: string,
  traceOrigin: string,
  previousOrigin?: string,
): string {
  const trace = new URL(traceOrigin);
  const tracePath = trace.pathname.replace(/\/$/, '');
  const isSelf = (value: string) => {
    const url = new URL(value);
    return url.origin === trace.origin
      && (url.pathname === tracePath || url.pathname.startsWith(`${tracePath}/`));
  };
  const origin = isSelf(configuredOrigin) ? previousOrigin : configuredOrigin;
  if (!origin || isSelf(origin)) throw new Error('Provider trace has no non-recursive upstream');
  return origin;
}

/** Hono's incoming-close reasons must retain the adapter's stream-cancel code
 * when forwarded through fetch; unrelated failures keep their original cause. */
export function nativeProviderRequestSignal(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    const reason: unknown = signal.reason;
    const clientClosed = reason === 'Client connection prematurely closed.' || reason === 'Error: aborted'
      || reason instanceof Error && reason.message === 'aborted'
        && (reason as NodeJS.ErrnoException).code === 'ECONNRESET';
    controller.abort(clientClosed
      ? Object.assign(new Error('Provider trace client disconnected', { cause: reason }), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
      : reason);
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
