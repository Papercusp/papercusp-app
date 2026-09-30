/**
 * Runtime dispatch telemetry-buffer config (live-configurability-audit-2026-06-20 P-020).
 *
 * The deferred-telemetry queue in projected-tool-deps.ts is sized by three baked constants —
 * maxPending (hard cap → drop-oldest on PG stall), debounceMs (flush debounce), maxBatch (rows per
 * batched INSERT). This is the runtime OVERRIDE, read via the ratified D-010 mechanism: a
 * module-level SYNC cache (zero-await on the enqueue/flush hot path), refreshed on (a) the flag's
 * onFlagChange (fires on the kill-switch flip + a key===null reload), (b) local write (same-process
 * immediate), and (c) a ~60s .unref()'d periodic timer for bounded (≤60s) cross-process + restart
 * freshness. The module import is deliberately PURE (no import-time getFlag/PG read).
 *
 * Default-ON kill-switch (FLAGS.TELEMETRY_BUFFER_CONFIG): the override store is empty by default
 * ⇒ telemetryBufferConfig() returns the baked defaults ⇒ byte-identical. Flip the flag OFF to
 * ignore any stored override and force the defaults.
 */
import { getFlag } from '@papercusp/flags/server';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { FLAGS } from '@papercusp/flags';
import { lazyFlagRefresh } from './lazy-flag-refresh';
import { systemDistinctId } from './flag-distinct-id';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface TelemetryBufferConfig {
  /** Hard cap on the pending-telemetry queue; drop-oldest beyond it (never OOM). */
  maxPending: number;
  /** Flush debounce in ms. */
  debounceMs: number;
  /** Max rows per batched INSERT. */
  maxBatch: number;
}

/** The baked defaults — the canonical source (projected-tool-deps imports these). */
export const TELEMETRY_BUFFER_DEFAULTS: TelemetryBufferConfig = {
  maxPending: 5000,
  debounceMs: 10,
  maxBatch: 200,
};

/** A partial override of the defaults (only the keys the operator set). */
export type TelemetryBufferOverride = Partial<TelemetryBufferConfig>;

// ── D-010 sync cache ────────────────────────────────────────────────────────
let cachedEnabled = false;
let cachedOverride: TelemetryBufferOverride = {};

/** The effective telemetry-buffer config for the hot path. SYNC, zero-await. */
export function telemetryBufferConfig(): TelemetryBufferConfig {
  armFlagRefresh(); // first use installs the flag subscription — see ./lazy-flag-refresh
  if (!cachedEnabled) return TELEMETRY_BUFFER_DEFAULTS;
  return {
    maxPending: cachedOverride.maxPending ?? TELEMETRY_BUFFER_DEFAULTS.maxPending,
    debounceMs: cachedOverride.debounceMs ?? TELEMETRY_BUFFER_DEFAULTS.debounceMs,
    maxBatch: cachedOverride.maxBatch ?? TELEMETRY_BUFFER_DEFAULTS.maxBatch,
  };
}

export async function refreshTelemetryBufferConfig(): Promise<void> {
  try {
    cachedEnabled = await getFlag(FLAGS.TELEMETRY_BUFFER_CONFIG, systemDistinctId());
    cachedOverride = cachedEnabled
      ? (await readOperatorState<TelemetryBufferOverride>('operator_telemetry_buffer_config')) ?? {}
      : {};
  } catch {
    // Fail-safe to the baked defaults — never let a config read break telemetry.
    cachedEnabled = false;
    cachedOverride = {};
  }
}
// D-010 (a): event-driven refresh — fires on the kill-switch flip + a key===null reload. Armed on
// FIRST USE, not at import (EI-19416650993725684): the import touches no flag binding at all, so a
// test that partially mocks `@papercusp/flags/server` can still collect. projected-tool-deps imports
// this on the hot path, so its reach is wide. See ./lazy-flag-refresh for the mechanism + guards.
const armFlagRefresh = lazyFlagRefresh(refreshTelemetryBufferConfig, {
  keys: [FLAGS.TELEMETRY_BUFFER_CONFIG],
  unpopulated: {
    kind: 'gates-an-override-store',
    serves:
      'TELEMETRY_BUFFER_DEFAULTS (maxPending 5000 / debounceMs 10 / maxBatch 200) — cachedEnabled ' +
      'is false, so telemetryBufferConfig() returns the baked constants. The flag is DEFAULT ON, ' +
      'but it gates only whether a STORED override is honoured, and the store is empty by default ' +
      '⇒ the window serves exactly what production serves in the normal case.',
  },
});
// D-010 (c): bounded cross-process + restart freshness. .unref() so it never holds the process open.
// P-008: visible in schedule:inventory as a 'cache' timer (per-process config memo refresh).
managedSetInterval('config-refresh:telemetry-buffer', 60_000, () => refreshTelemetryBufferConfig(), {
  category: 'cache',
});

// ── async read/write (the tool) ──────────────────────────────────────────────
export async function readTelemetryBufferOverride(): Promise<TelemetryBufferOverride> {
  return (await readOperatorState<TelemetryBufferOverride>('operator_telemetry_buffer_config')) ?? {};
}

async function persist(next: TelemetryBufferOverride): Promise<TelemetryBufferOverride> {
  await writeOperatorState<TelemetryBufferOverride>('operator_telemetry_buffer_config', next);
  await refreshTelemetryBufferConfig(); // same-process immediacy
  return next;
}

/** Merge a partial override over the current one (only the 3 known keys; undefined = leave). */
export async function setTelemetryBufferOverride(patch: TelemetryBufferOverride): Promise<TelemetryBufferOverride> {
  const cur = await readTelemetryBufferOverride();
  const next: TelemetryBufferOverride = { ...cur };
  if (patch.maxPending !== undefined) next.maxPending = patch.maxPending;
  if (patch.debounceMs !== undefined) next.debounceMs = patch.debounceMs;
  if (patch.maxBatch !== undefined) next.maxBatch = patch.maxBatch;
  return persist(next);
}

export async function setTelemetryBufferOverrideFull(o: TelemetryBufferOverride): Promise<void> {
  await persist(o ?? {});
}

export async function resetTelemetryBufferOverride(): Promise<void> {
  await persist({});
}

registerOverrideConcern({
  name: 'telemetry-buffer-config',
  description:
    'runtime dispatch telemetry-buffer overrides (maxPending / debounceMs / maxBatch) over the baked defaults (kill-switch: papercusp-telemetry-buffer-config)',
  auditAction: 'telemetry:set_buffer',
  diff: async () => {
    const o = await readTelemetryBufferOverride();
    const entries: OverrideEntry[] = [];
    for (const key of ['maxPending', 'debounceMs', 'maxBatch'] as const) {
      if (o[key] !== undefined) {
        entries.push({ key, effective: o[key], default: TELEMETRY_BUFFER_DEFAULTS[key], layer: 'pg-settings' });
      }
    }
    return entries;
  },
  capture: () => readTelemetryBufferOverride(),
  reset: () => resetTelemetryBufferOverride(),
  restore: (snap) => setTelemetryBufferOverrideFull((snap as TelemetryBufferOverride) ?? {}),
});
