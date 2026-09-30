/**
 * startWebObserver — the in-page browser variant of the `live` domain
 * (P-002 of testing-shell-platform-variants-2026-06-01).
 *
 * Mirrors the desktop vitals-recorder, but for a normal browser session: it
 * hooks console.error/warn, window 'error' + 'unhandledrejection', and (where
 * available) a PerformanceObserver for layout-shift (CLS) and long-tasks,
 * buffering everything into `events`. `stop()` fully unhooks/restores.
 *
 * Import-safe anywhere: NO browser global is touched at module load — all
 * access is deferred inside startWebObserver(), so the client barrel can be
 * imported server-side without exploding.
 */

export type WebObserverEventKind =
  | 'console-error'
  | 'console-warn'
  | 'window-error'
  | 'unhandledrejection'
  | 'cls'
  | 'longtask';

export interface WebObserverEvent {
  kind: WebObserverEventKind;
  message: string;
  ts: number;
  /** Optional structured detail (e.g. CLS value, stack). */
  detail?: unknown;
}

export interface WebObserver {
  /** Captured events, newest last. */
  readonly events: WebObserverEvent[];
  /** Unhook everything + restore the patched console methods. */
  stop(): void;
}

/** Pure: render console args to a single string (objects JSON-stringified). */
export function consoleArgsToMessage(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface WebObserverOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export function startWebObserver(opts: WebObserverOptions = {}): WebObserver {
  const now = opts.now ?? (() => Date.now());
  const events: WebObserverEvent[] = [];
  const push = (kind: WebObserverEventKind, message: string, detail?: unknown) =>
    events.push({ kind, message, ts: now(), detail });

  // — console.error / console.warn —
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => {
    push('console-error', consoleArgsToMessage(args));
    origError.apply(console, args as []);
  };
  console.warn = (...args: unknown[]) => {
    push('console-warn', consoleArgsToMessage(args));
    origWarn.apply(console, args as []);
  };

  // — window error / unhandledrejection —
  const onError = (e: ErrorEvent) => push('window-error', e.message || String(e.error ?? 'error'), e.error);
  const onRejection = (e: PromiseRejectionEvent) =>
    push('unhandledrejection', String((e.reason as { message?: string })?.message ?? e.reason), e.reason);
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) {
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
  }

  // — PerformanceObserver: CLS + long-tasks (best-effort; absent in jsdom) —
  let perfObs: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      perfObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'layout-shift') {
            const v = (entry as unknown as { value: number }).value;
            push('cls', `layout-shift ${v.toFixed(4)}`, v);
          } else if (entry.entryType === 'longtask') {
            push('longtask', `long task ${Math.round(entry.duration)}ms`, entry.duration);
          }
        }
      });
      // Each type guarded — a browser may not support both.
      try { perfObs.observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit); } catch { /* unsupported */ }
      try { perfObs.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit); } catch { /* unsupported */ }
    } catch {
      perfObs = null;
    }
  }

  return {
    events,
    stop() {
      console.error = origError;
      console.warn = origWarn;
      if (hasWindow) {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
      }
      perfObs?.disconnect();
      perfObs = null;
    },
  };
}
