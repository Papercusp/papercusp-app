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
let client: typeof import('posthog-js').default | null = null;
let initializing: Promise<typeof import('posthog-js').default> | null = null;

async function consentedClient(cancelled: () => boolean = () => false) {
  const res = await fetch('/api/desktop/telemetry-config', { cache: 'no-store' });
  if (!res.ok) return null;
  const cfg = (await res.json()) as TelemetryConfig;
  if (cancelled() || cfg.enabled !== true || !cfg.host || !cfg.project_key) return null;
  if (client) return client;
  initializing ??= import('posthog-js').then(mod => {
    const posthog = mod.default;
    posthog.init(cfg.project_key!, {
      api_host: cfg.host, person_profiles: 'identified_only',
      capture_pageview: true, capture_pageleave: true, autocapture: true,
      disable_session_recording: true,
      loaded: ph => { ph.identify(cfg.distinct_id ?? cfg.workspace_id ?? 'default'); },
    });
    initialized = true; client = posthog;
    return posthog;
  }).finally(() => { initializing = null; });
  return initializing;
}

/** Recheck the existing consent boundary for each explicit event. Events are
 * dropped on opt-out or failure, never queued for a later opt-in. */
export async function captureBrowserTelemetry(event: string, properties: Record<string, string | number | boolean>): Promise<void> {
  try {
    const posthog = await consentedClient();
    if (posthog) posthog.capture(event, properties);
  } catch { /* Telemetry must not interrupt the product. */ }
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (initialized) return;
    let cancelled = false;
    (async () => {
      try {
        await consentedClient(() => cancelled);
      } catch {
        // Telemetry being unreachable should never break the app.
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return <>{children}</>;
}
