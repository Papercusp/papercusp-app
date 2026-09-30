'use client';

import { backgroundRequest } from './transport-adapters/origin-scheduler-fetch';

/**
 * Shared persistence plumbing for browser-presentation preferences that live
 * in the operator user profile (PG: `harness_shared.operator_user_profile`,
 * via GET/POST `/api/profile`).
 *
 * Why this exists: the desktop WebKitGTK webview's localStorage is NOT a
 * reliable durable store. The operator origin churns (the desktop picks a
 * random free sidecar port per launch, and localStorage is partitioned by
 * scheme+host+port) and in-session writes don't reliably flush across a
 * reload. So a preference kept only in localStorage silently resets. PG is the
 * source of truth; localStorage stays as a per-device write-through CACHE so
 * the synchronous first paint (useSyncExternalStore snapshots + the pre-paint
 * boot scripts) has an instant value. The pre-paint prefs (theme,
 * visual-effects) are additionally injected into `index.html` by the host (see
 * `bin/host-spa.ts`), so they're correct before React even mounts.
 *
 * The flow for every pref built on this module:
 *   1. First paint — read the localStorage cache synchronously (instant).
 *   2. On mount   — GET /api/profile (async); if PG differs, adopt it
 *                   (overwrite cache + apply + notify subscribers).
 *   3. On change  — write the cache + apply + notify, and POST the new value
 *                   to PG (fire-and-forget).
 *
 * This mirrors the pattern `auto_accept` (operator-shared-state.ts) and
 * `toast_last_seen_ms` (NotificationCenter.tsx) already use.
 */

type ProfilePayload = Record<string, unknown>;

let inflight: Promise<ProfilePayload> | null = null;

/**
 * GET /api/profile, memoized so N prefs reconciling on the same mount share a
 * single round-trip. Pass `force` to bypass + refresh the memo (used after a
 * write so a later read observes the new value). Resolves to `{}` on any
 * failure (no session / offline / pre-migration operator) — callers then keep
 * their cache value untouched.
 */
export function fetchProfileOnce(force = false): Promise<ProfilePayload> {
  if (force) inflight = null;
  if (!inflight) {
    inflight =
      typeof fetch === 'undefined'
        ? Promise.resolve({})
        : fetch(
            '/api/profile',
            backgroundRequest({ headers: { accept: 'application/json' } }),
          )
            .then((r) => (r.ok ? (r.json() as Promise<ProfilePayload>) : {}))
            .catch(() => ({}));
  }
  return inflight;
}

/**
 * POST a single profile field (the server merges `{...existing, ...body}`).
 * Fire-and-forget: the local cache already holds the value for instant paint,
 * and a failed write just means the value stays on this device until the next
 * successful write. Invalidates the memo so a subsequent reconcile re-reads.
 */
export function writeProfileField(field: string, value: unknown): void {
  inflight = null; // next fetchProfileOnce() re-reads with this write applied
  if (typeof fetch === 'undefined') return;
  void fetch('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [field]: value }),
  }).catch(() => {
    /* best effort — cache already holds the value */
  });
}

/**
 * Read-modify-write a single key inside an object-valued profile field
 * (e.g. `pi_dock_layouts[slug] = layout`) without clobbering sibling keys.
 * The /api/profile POST does a shallow merge, so a nested map must be merged
 * client-side: read the current map (PG, refreshed), merge, write back. Pass
 * `value === undefined` to delete the entry.
 */
export async function writeProfileMapEntry(
  field: string,
  key: string,
  value: unknown,
): Promise<void> {
  const profile = await fetchProfileOnce(true);
  const raw = profile[field];
  const cur: Record<string, unknown> =
    raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  if (value === undefined) delete cur[key];
  else cur[key] = value;
  writeProfileField(field, cur);
}

/**
 * Adopt a PG value into a local pref iff it is present, valid, and differs
 * from the current cache — and the user has NOT changed the value locally
 * while the GET was in flight (which would otherwise clobber a fresh local
 * edit with a stale server read).
 *
 * `adopt(value)` is the pref's own "write cache + apply + dispatch change
 * event" routine. Returns the adopted value, or null if nothing was adopted.
 */
export async function reconcileProfilePref<T>(opts: {
  /** Profile field to read. */
  field: string;
  /** Validate + normalize the raw PG value to T (or null to ignore). */
  parse: (raw: unknown) => T | null;
  /** The current local value (read from the cache) to compare against. */
  current: () => T;
  /** Equality test (default `===`). Pass a deep compare for object values. */
  equals?: (a: T, b: T) => boolean;
  /** Adopt the PG value locally: write cache + apply + dispatch change event. */
  adopt: (value: T) => void;
}): Promise<T | null> {
  const eq = opts.equals ?? ((a: T, b: T) => a === b);
  const baseline = opts.current();
  const profile = await fetchProfileOnce();
  const parsed = opts.parse(profile[opts.field]);
  if (parsed == null) return null;
  // User edited it locally while we were fetching → don't clobber their change.
  if (!eq(opts.current(), baseline)) return null;
  if (eq(parsed, baseline)) return null;
  opts.adopt(parsed);
  return parsed;
}

/**
 * Read a host-injected pre-paint preference from `window.__PAPERCUSP_PREFS__`
 * (set by bin/host-spa.ts from PG, before React mounts). This is the
 * synchronous fallback for `read*()` snapshots when the localStorage cache is
 * cold — e.g. right after a reload on the desktop, where the webview's
 * localStorage doesn't survive. The injected value IS the PG value at page
 * load, so it's the correct synchronous source when the cache is empty.
 * Returns undefined when absent (SSR, non-injecting dev origin, or pre-this-build).
 */
export function injectedPref(field: string): unknown {
  if (typeof window === 'undefined') return undefined;
  try {
    const prefs = (window as unknown as { __PAPERCUSP_PREFS__?: Record<string, unknown> })
      .__PAPERCUSP_PREFS__;
    return prefs ? prefs[field] : undefined;
  } catch {
    return undefined;
  }
}

/** Stable JSON-shape equality for object-valued prefs (key order independent
 *  enough for our small maps; good enough to avoid redundant adopts). */
export function shallowJsonEquals(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}
