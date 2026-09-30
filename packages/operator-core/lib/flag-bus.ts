/**
 * In-process feature-flag change bus.
 *
 * The PostHog webhook endpoint (POST /api/flags/webhook) writes to this
 * channel; the SSE stream (GET /api/flags/stream) reads from it. Sub-
 * millisecond fan-out via @papercusp/sse's getChannel.
 *
 * Also handles one-time backend initialization: on first import the
 * module reads ~/.papercusp/posthog.json (or env overrides) and calls
 * initFlagBackend(). If no config is present, the backend stays in
 * fallback mode and every evaluation returns FLAG_DEFAULTS.
 */
import { getChannel } from '@papercusp/sse';

import {
  emitFlagChange,
  initFlagBackend,
  isBackendConfigured,
} from '@papercusp/flags/server';
import { FLAGS_CHANGED_EVENT, type FlagKey } from '@papercusp/flags';

import { installFlagOverrideStore } from './flag-override-store';

import {
  getPosthogConfig,
  isTestingFeaturesEnabled,
  setOnConfigChange,
  watchPosthogConfig,
} from './posthog-config';

// Boot the server-side lexicon brand-pack selector with the flag subsystem:
// it subscribes to flag changes (emitFlagChange, below) to keep its cached
// active pack fresh. Side-effect import — see ./lexicon/configure.
import './lexicon/configure';
import { trackDetached } from './detached-imports';

export type FlagChangeEnvelope = {
  type: 'flag_changed';
  key: FlagKey | null;
  ts: number;
};

const CHANNEL = 'feature-flag-changes';

let booted = false;

function bootIfNeeded(): void {
  if (booted) return;
  booted = true;
  // Privacy-first opt-in: only initialize the PostHog client when the
  // user (or CI) has explicitly enabled live updates. Otherwise we
  // never touch the network and getAllFlags() returns FLAG_DEFAULTS,
  // which IS the V1 ship state.
  if (!isBackendConfigured() && isTestingFeaturesEnabled()) {
    initFlagBackend(getPosthogConfig());
  }
}

/**
 * Re-evaluate backend init state. Call after writing the discovery
 * file (and after `resetPosthogConfigForTest()`) — otherwise the
 * one-shot `booted` latch keeps the original "no backend" state
 * regardless of subsequent testingFeatures toggles.
 *
 * Also called automatically by the discovery-file watcher when
 * ~/.papercusp/posthog.json changes on disk.
 */
export function reinitFlagBackend(): void {
  // Unconditionally tear down + rebuild so callers can use this as
  // a "force resync" primitive — fixes the silent-drift case where
  // the SDK client died (HMR / OOM / network reset) but
  // isBackendConfigured() returns stale state. initFlagBackend(null)
  // safely no-ops when client is already null.
  initFlagBackend(null);
  if (isTestingFeaturesEnabled()) {
    initFlagBackend(getPosthogConfig());
  }
  booted = true;
  // Tell every connected client to refetch so they see the new state.
  publishFlagChange(null);
}

// Install the discovery-file watcher on first import so config edits
// take effect without an operator restart.
setOnConfigChange(() => reinitFlagBackend());
watchPosthogConfig();

// PG-backed runtime overrides (audit P-070, EI-76): registered
// unconditionally — independent of the PostHog opt-in — so a dev box with
// no PostHog can flip flags at runtime via /api/flags/set instead of a
// PAPERCUSP_FLAG_* env var + process restart. The flags lib layers these
// between test overrides and PostHog, behind a short read cache.
//
// The store IMPLEMENTATION lives in ./flag-override-store so the standalone
// inference-gateway process can install the SAME store without importing this
// module (flag-bus pulls in SSE + lexicon config, which a gateway sidecar must
// not boot). Before that extraction the gateway had NO override store, so every
// runtime `flags:set` was silently invisible to it (codex-gateway-chatgpt-live).
installFlagOverrideStore();

export function getFlagBus() {
  bootIfNeeded();
  return getChannel<FlagChangeEnvelope>(CHANNEL, { ringSize: 64 });
}

export function publishFlagChange(key: FlagKey | null = null): void {
  const ch = getFlagBus();
  const env: FlagChangeEnvelope = { type: 'flag_changed', key, ts: Date.now() };
  const sequence = ch.publish(env);
  emitFlagChange(key);

  // The app shell already owns the sync SSE connection. Mirror the flag flip
  // onto that bus so its browser subscriber can refetch without opening a
  // fourth standing EventSource against the same origin. Keep this
  // fire-and-forget: a sync/PG outage must never turn a successful flag write
  // into a failed write. `ts` is part of the args so two real flips of the
  // same key inside the sync bus's dedupe window are not collapsed; the
  // channel sequence closes the same-millisecond case.
  void trackDetached(import('./sync-sse'))
    .then(({ notifySyncInvalidate }) =>
      notifySyncInvalidate(FLAGS_CHANGED_EVENT, { key, ts: env.ts, sequence }),
    )
    .catch((err) => {
      if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
      console.warn('[flags] sync-bus flag notification failed:', err);
    });
}
