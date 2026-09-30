'use client';

/**
 * Shared friendly error state for the Cupboard surfaces (EI-215).
 *
 * The listings slot, the tools view, and the detail page all used to render
 * the raw caught exception (`String(err)` → "TypeError: Load failed",
 * "Error: HTTP 404") with no retry affordance. This component owns the
 * raw→friendly copy mapping and always offers an inline Retry; the raw text
 * stays visible muted for debugging, never as the headline.
 */

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { FONTS, RADIUS, SIZES } from './cupboard-theme';

export function friendlyCupboardError(raw: string, what: string): string {
  const httpMatch = /HTTP (\d{3})/.exec(raw);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 404) {
      return what === 'this listing'
        ? "This listing doesn't exist — it may have been unpublished or removed."
        : `Couldn't find ${what} — the Cupboard server returned 404.`;
    }
    if (status === 503) {
      // The operator proxy collapses EVERY upstream failure (fetch timeout, DNS
      // failure, connection refused) into a 503 — it is NOT specifically a
      // configuration problem, and resolveCupboardBaseUrl() has a working
      // default, so we must never blame PAPERCUSP_CUPBOARD_URL here (that copy
      // sent real debugging down the wrong path). Surface the actual upstream
      // cause when the proxy forwarded it in the error body via cupboardHttpError().
      const detail = /HTTP 503:\s*(.+)$/.exec(raw)?.[1]?.trim();
      return detail
        ? `Couldn't reach the Cupboard server while loading ${what} (${detail}).`
        : `Couldn't reach the Cupboard server while loading ${what} — it may be briefly unavailable.`;
    }
    if (status >= 500) return `The Cupboard server hit an error (HTTP ${status}) while loading ${what}.`;
    return `Couldn't load ${what} (HTTP ${status}).`;
  }
  // No HTTP status → a network-level failure: WebKit "TypeError: Load failed",
  // Chromium "TypeError: Failed to fetch", Firefox "NetworkError…".
  return `Couldn't reach the Cupboard server while loading ${what} — it may be briefly unavailable.`;
}

/**
 * Build an Error from a failed Cupboard-proxy Response, folding in the upstream
 * error the operator proxy forwards in its JSON body (`{ error }`). The proxy
 * collapses every upstream failure into a 503, so the body is the ONLY place the
 * real cause ("TimeoutError: The operation was aborted due to timeout",
 * "ENOTFOUND", …) survives — without this the caller throws a bare `HTTP 503`
 * and the UI can only guess. Falls back to status-only for a non-JSON body.
 */
export async function cupboardHttpError(res: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await res.clone().json()) as { error?: unknown } | null;
    if (body && typeof body.error === 'string' && body.error.trim()) {
      detail = `: ${body.error.trim()}`;
    }
  } catch {
    // non-JSON body — the status code is all we have
  }
  return new Error(`HTTP ${res.status}${detail}`);
}

export function CupboardErrorState({
  raw,
  what,
  onRetry,
}: {
  /** The raw caught error string — rendered muted, for debugging. */
  raw: string;
  /** What failed to load, woven into the copy: 'listings' | 'tools' | 'this listing'. */
  what: string;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="cupboard-error-state"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        color: 'var(--bad)',
        fontFamily: FONTS.ui,
        fontSize: 12,
        marginBottom: SIZES.md,
        padding: 12,
        border: '1px solid color-mix(in srgb, var(--bad), transparent 70%)',
        borderRadius: RADIUS.lg,
        background: 'var(--bad-bg)',
      }}
    >
      <AlertTriangle size={14} style={{ flexShrink: 0 }} />
      <span>{friendlyCupboardError(raw, what)}</span>
      <span style={{ color: 'var(--fg-mute)', opacity: 0.75 }}>({raw})</span>
      <button
        onClick={onRetry}
        data-testid="cupboard-error-retry"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginLeft: 'auto',
          padding: '5px 12px',
          border: '1px solid color-mix(in srgb, var(--bad), transparent 55%)',
          borderRadius: RADIUS.sm,
          background: 'transparent',
          color: 'var(--bad)',
          fontFamily: FONTS.ui,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <RefreshCw size={12} />
        Retry
      </button>
    </div>
  );
}
