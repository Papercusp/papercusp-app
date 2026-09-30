'use client';

/**
 * Browser-side PostHog initialization.
 *
 * Telemetry is OFF by default. This provider does:
 *   1. On mount, GET /api/desktop/telemetry-config.
 *   2. If `enabled === false` → DO NOTHING (no posthog-js import, no
 *      cookies set, no network requests to PostHog).
 *   3. If `enabled === true` AND host + project_key are present →
 *      dynamic-import posthog-js, init it with autocapture +
 *      pageview tracking, alias the workspace id as distinct id.
 *
 * The dynamic import is deliberate — when telemetry is off, the
 * posthog-js bundle never even ships to the user.
 *
 * This is mounted from the root layout but only contributes JS when
 * the wizard's telemetry toggle is on.
 */
import { useEffect } from 'react';

interface TelemetryConfig {
  enabled: boolean;
  host?: string;
  project_key?: string;
  /** Stable per-install UUID — preferred PostHog distinct id. */
  distinct_id?: string;
  workspace_id?: string;
}

let initialized = false;

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (initialized) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/desktop/telemetry-config', { cache: 'no-store' });
        if (!res.ok) return;
        const cfg = (await res.json()) as TelemetryConfig;
        if (cancelled || !cfg.enabled || !cfg.host || !cfg.project_key) return;
        // Only now do we even load posthog-js into the bundle.
        const mod = await import('posthog-js');
        const posthog = (mod as { default: typeof mod }).default ?? mod;
        posthog.init(cfg.project_key, {
          api_host: cfg.host,
          person_profiles: 'identified_only',
          capture_pageview: true,
          capture_pageleave: true,
          autocapture: true,
          disable_session_recording: true, // session-replay is a separate consent we don't have
          // Per-install UUID = distinct id keeps reports anonymous (no email/user
          // id) AND stable across workspace creation/deletion. Falls back to
          // workspace id then 'default' if telemetry-config didn't surface one.
          loaded: (ph) => {
            ph.identify(cfg.distinct_id ?? cfg.workspace_id ?? 'default');
          },
        });
        initialized = true;
      } catch {
        // Telemetry being unreachable should never break the app.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return <>{children}</>;
}
