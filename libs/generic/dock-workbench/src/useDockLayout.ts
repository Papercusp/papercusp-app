import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockLayoutRow, DockLayoutStore } from './store';

export type DockLayoutState =
  | { status: 'loading'; row: null; error: null }
  | { status: 'ready'; row: DockLayoutRow; error: null }
  | { status: 'error'; row: DockLayoutRow | null; error: Error };

export interface UseDockLayoutOptions {
  /**
   * Backoff delays (ms) before each RETRY of the initial load. The first load
   * is attempt 0; a failure waits `retryDelaysMs[0]` then retries, etc. Only
   * after the final retry fails does the hook surface the `error` state.
   *
   * This exists because the layout `load` is a network fetch, and in a desktop
   * webview a transient blip (operator restart / HMR reload / a momentary
   * connection drop) rejects it with a bare "Load failed" — which, without
   * retry, blanked the entire dock behind an error wall for what was really a
   * sub-second hiccup. A short bounded backoff lets those self-heal while still
   * surfacing a genuine, persistent failure. Default: `[150, 400, 900]`.
   */
  retryDelaysMs?: number[];
}

const DEFAULT_LOAD_RETRY_DELAYS_MS = [150, 400, 900];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a failed layout load should be retried. Transport-style failures
 * (a bare `TypeError`, "Failed to fetch", "Load failed", "NetworkError") are
 * the transient desktop-webview blip this backoff exists for → retry. An
 * explicit HTTP response from `createFetchDockLayoutStore` (its messages embed
 * "→ <status>") is an actionable server result, not a blip → surface it now.
 * Exported for testing.
 */
export function shouldRetryLoad(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/→\s*\d{3}\b/.test(msg)) return false;
  return /failed to fetch|load failed|networkerror|network request failed/i.test(msg);
}

/**
 * Run `load`, retrying transient (transport-style) failures with the given
 * backoff delays before giving up. Attempt 0 is the initial load; on a
 * retryable failure it waits `delays[i]` then retries, up to `delays.length`
 * retries. A non-retryable failure (or the last attempt) rejects with the last
 * error. Pure aside from the injected `sleep`; never swallows the final error.
 * Exported for testing.
 */
export async function attemptLayoutLoad<T>(
  load: () => Promise<T>,
  delays: readonly number[],
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await load();
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length && shouldRetryLoad(err)) {
        await sleep(delays[attempt]);
      } else {
        break;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('layout load failed');
}

export interface UseDockLayoutResult {
  state: DockLayoutState;
  save: (layout: DockLayoutRow['layoutJson'], opts?: { force?: boolean }) => Promise<DockLayoutRow>;
  reset: () => Promise<DockLayoutRow>;
  refresh: () => Promise<DockLayoutRow>;
}

export function useDockLayout(
  name: string,
  store: DockLayoutStore,
  opts?: UseDockLayoutOptions,
): UseDockLayoutResult {
  const [state, setState] = useState<DockLayoutState>({ status: 'loading', row: null, error: null });
  const rowRef = useRef<DockLayoutRow | null>(null);
  const retryDelaysMs = opts?.retryDelaysMs ?? DEFAULT_LOAD_RETRY_DELAYS_MS;
  // Snapshot the delays into a ref so the load effect doesn't re-run when a
  // caller passes a fresh array literal each render.
  const retryRef = useRef(retryDelaysMs);
  retryRef.current = retryDelaysMs;

  const fetchOnce = useCallback(async (): Promise<DockLayoutRow> => {
    const row = await store.load(name);
    rowRef.current = row;
    return row;
  }, [name, store]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', row: null, error: null });

    attemptLayoutLoad(fetchOnce, retryRef.current)
      .then((row) => {
        if (!cancelled) setState({ status: 'ready', row, error: null });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ status: 'error', row: null, error: err });
      });

    return () => {
      cancelled = true;
    };
  }, [fetchOnce]);

  const refresh = useCallback(async (): Promise<DockLayoutRow> => {
    const row = await fetchOnce();
    setState({ status: 'ready', row, error: null });
    return row;
  }, [fetchOnce]);

  const save = useCallback(
    async (layout: DockLayoutRow['layoutJson'], opts: { force?: boolean } = {}): Promise<DockLayoutRow> => {
      const row = await store.save(name, layout, {
        force: opts.force,
        expectedUpdatedTs: rowRef.current?.updatedTs,
      });
      rowRef.current = row;
      setState({ status: 'ready', row, error: null });
      return row;
    },
    [name, store],
  );

  const reset = useCallback(async (): Promise<DockLayoutRow> => {
    const row = await store.reset(name);
    rowRef.current = row;
    setState({ status: 'ready', row, error: null });
    return row;
  }, [name, store]);

  return { state, save, reset, refresh };
}
