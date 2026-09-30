// Server-side flag evaluation. Uses posthog-node with local evaluation —
// no per-call network round trip after initial flag-definition fetch.
// Event capture is explicitly disabled; this client only reads flag state.
//
// If PostHog is unreachable, evaluations fall back to FLAG_DEFAULTS
// (fail-safe-closed — V1 ship state is "everything off").

import { pinModuleState } from "@papercusp/module-singleton";
import { PostHog } from "posthog-node";
import { resolveTestOverrides } from "./test";
import {
  ALL_FLAG_KEYS,
  FLAG_DEFAULTS,
  FLAGS,
  type FlagKey,
  type FlagPayload,
  type FlagValues,
  resolveWithDefaults,
} from "./types";

export type PostHogConfig = {
  host: string;
  projectKey: string;
  personalApiKey: string;
};

type ChangeHandler = (key: FlagKey | null) => void;

let client: PostHog | null = null;
let config: PostHogConfig | null = null;
const changeHandlers = new Set<ChangeHandler>();

/**
 * Persistent runtime overrides (audit P-070, EI-76). The host injects a
 * store (Papercusp wires a PG-backed one in operator-core's flag-bus) so
 * /api/flags/set can flip flags at runtime WITHOUT PostHog — previously a
 * dev box needed a process restart per PAPERCUSP_FLAG_* env flip.
 *
 * Precedence: env var > in-process test overrides > stored override >
 * PostHog > FLAG_DEFAULTS. The store is read through a short TTL cache so
 * per-call flag checks don't each pay a PG round trip; setFlagOverride
 * invalidates the cache immediately.
 */
export type FlagOverrideStore = {
  /** Current override map; missing keys = no override. */
  load(): Promise<Partial<Record<FlagKey, boolean>>>;
  /** Persist one override; `null` clears it. */
  set(key: FlagKey, enabled: boolean | null): Promise<void>;
  /**
   * Optional scope key for the read cache (e.g. the active workspace id).
   * `load()` resolves the overrides for whatever scope is active *at call
   * time* — Papercusp's PG store reads `WHERE workspace_id = activeWorkspaceId()`.
   * Without partitioning, a single process serving multiple workspaces would
   * cache the FIRST-loaded workspace's overrides and serve them to every other
   * workspace for the TTL window (a cross-workspace flag bleed). Returning the
   * scope here keys the cache per scope. Omit for a single-scope store
   * (one shared cache, the historical behavior).
   */
  cacheKey?(): string;
};

// PROCESS-GLOBAL store slot (WI-4275): module-local state here proved fragile —
// tsx/ESM can evaluate a second instance of this module in the same process
// (symlinked workspace paths give distinct module URLs), and then the installer's
// instance held the store while the reader's instance saw null: every runtime
// `flags:set` was silently invisible ("No override store installed" on a process
// that HAD installed one). Keying the slot on globalThis makes every instance of
// this module share the one store, whatever the resolver did.
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair: hand-rolling still fixes correctness, but
// the key is invisible to listModuleDuplications(), which then reports a
// confident `[]` while this module is split (EI-19479108855357092).
//
// The STORE and the CACHE are pinned together, under one key, on purpose. The
// original WI-4275 fix pinned only the store and left `overrideCache`
// module-local — which half-closed the bug: on a split, an
// invalidateFlagOverrideCache() reaching record A clears A's map while record B
// keeps serving the stale override map for the rest of its TTL. Same failure
// shape as the one the store pin exists to prevent, one level down. One
// pinModuleState call per module body also keeps `evaluations` an honest count
// of module RECORDS.
const STATE_KEY = "@papercusp/flags.server";
interface OverrideCacheEntry {
  flags: Partial<Record<FlagKey, boolean>>;
  ts: number;
  /** Monotonic only within this process. Useful for proving a cache refill occurred. */
  generation: number;
}

interface FlagsServerState {
  /** The installed override store (null until installOverrideStore runs). */
  store: FlagOverrideStore | null;
  /**
   * Keyed by the store's cacheKey() (e.g. workspace id) so one process serving
   * many workspaces never bleeds one workspace's overrides into another's reads.
   */
  overrideCache: Map<string, OverrideCacheEntry>;
  /** Incremented whenever this process installs a fresh override-map cache entry. */
  cacheGeneration: number;
}
const state = pinModuleState<FlagsServerState>(STATE_KEY, () => ({
  store: null,
  overrideCache: new Map(),
  cacheGeneration: 0,
}));
type StoreSlot = Pick<FlagsServerState, "store">;
function storeSlot(): StoreSlot {
  return state;
}
const overrideCache = state.overrideCache;
const DEFAULT_OVERRIDE_CACHE_TTL_MS = 5_000;
const DEFAULT_FLAG_BACKEND_TIMEOUT_MS = 2_000;

export type FlagResolutionSource =
  | "env-override"
  | "platform-mode-override"
  | "test-override"
  | "override-store"
  | "process-cache"
  | "posthog"
  | "compiled-default";

export type FlagOverrideReadKind =
  | "not-read"
  | "unconfigured"
  | "cache-hit"
  | "store-load"
  | "stale-cache-fallback"
  | "store-error";

/** Process-local evidence for the override layer consulted by one flag read. */
export interface FlagOverrideReadAttestation {
  kind: FlagOverrideReadKind;
  storeConfigured: boolean;
  cacheKey: string;
  /** Monotonic only within this process; compare repeated reads of the SAME process. */
  cacheGeneration: number | null;
  cacheLoadedAtMs: number | null;
  cacheAgeMs: number | null;
  ttlMs: number;
  ttlRemainingMs: number;
}

/** What this exact process resolved, through the same precedence path as getFlag(). */
export interface FlagAttestation {
  key: FlagKey;
  resolvedValue: boolean;
  compiledDefault: boolean;
  source: FlagResolutionSource;
  overrideRead: FlagOverrideReadAttestation;
  backendConfigured: boolean;
  observedAtMs: number;
}

// How long a loaded override map is served from the per-cacheKey cache before a
// re-read. The default 5s is the cross-process propagation fallback for a
// `flags:set` (processes on the SSE change bus also get pushed invalidation, so
// for them this is purely a churn knob). Env-overridable so a high-throughput
// process — e.g. the bg-host, where the override read was a top pgbouncer
// transaction-churn driver (~225K calls, WI-3800) — can trade a few extra
// seconds of flag-flip latency for far fewer catalog round-trips. 0 disables
// the cache (always re-read). Mirrors PAPERCUSP_FLAG_BACKEND_TIMEOUT_MS.
function overrideCacheTtlMs(): number {
  const raw = Number(process.env.PAPERCUSP_FLAG_OVERRIDE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_OVERRIDE_CACHE_TTL_MS;
}

function currentCacheKey(): string {
  return storeSlot().store?.cacheKey?.() ?? "";
}

function flagBackendTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_FLAG_BACKEND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_FLAG_BACKEND_TIMEOUT_MS;
}

async function withFlagBackendTimeout<T>(op: Promise<T>): Promise<T> {
  const ms = flagBackendTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`flag backend timed out after ${ms}ms`)),
      ms,
    );
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function initFlagOverrideStore(store: FlagOverrideStore | null): void {
  storeSlot().store = store;
  overrideCache.clear();
  // Re-arm the missing-store warning: a process that installs a store LATE (after some
  // early getFlag()) must not be permanently muted, and each test gets a clean latch.
  warnedNoOverrideStore = false;
}

export function isOverrideStoreConfigured(): boolean {
  return storeSlot().store !== null;
}

/**
 * Drop the override read-cache (one scope, or every scope) so the next
 * `getFlag()` re-reads the store. The cross-process invalidation hook: a
 * process that learns of a peer's `setFlagOverride()` (e.g. via PG NOTIFY)
 * must bust this cache BEFORE re-emitting `emitFlagChange`, or sticky
 * subscribers re-resolving on the change event can re-read the ≤TTL-stale
 * map and re-latch the OLD value.
 */
export function bustOverrideReadCache(scope?: string): void {
  if (scope !== undefined) overrideCache.delete(scope);
  else overrideCache.clear();
}

let warnedNoOverrideStore = false;

/** Test seam: re-arm the one-time latch without swapping the store. */
export function resetOverrideStoreWarningForTest(): void {
  warnedNoOverrideStore = false;
}

/**
 * ONE-TIME, per-process warning that this process cannot see runtime flag overrides.
 *
 * WHY (EI-8867): the WRITE path is honest — `setFlagOverride()` returns
 * `{ ok:false, reason:'override-store-not-configured' }` when no store is installed. The READ
 * path was SILENT: `loadStoredOverrides()` returned `{}` and `getFlag()` fell through to
 * `FLAG_DEFAULTS`. Because the write happens in the operator process (which HAS a store) and
 * the read happens in a standalone process (which may not), NO single process ever observed
 * the discrepancy: `flags:set` reported success while the consumer never saw the flip. That is
 * how the inference gateway silently ignored every override — a dark flag that simply "would
 * not turn on", with nothing logged and nothing failing.
 *
 * Making the read path as loud as the write path turns that whole class from silent-wrong into
 * one obvious line in the process's own log.
 */
function warnOverrideStoreMissingOnce(): void {
  // Suppression is checked BEFORE the latch so a suppressed call never consumes the one shot
  // (otherwise a single early test import would mute the warning for the real process).
  if (process.env.PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN === "1") return;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  if (warnedNoOverrideStore) return;
  warnedNoOverrideStore = true;
  console.warn(
    "[flags] No override store installed in this process: runtime overrides (flags:set / " +
      "POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. " +
      "If this process is expected to observe runtime flag flips, call initFlagOverrideStore() " +
      "during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). " +
      "Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.",
  );
}

interface StoredOverrideRead {
  flags: Partial<Record<FlagKey, boolean>>;
  attestation: FlagOverrideReadAttestation;
}

function nextCacheGeneration(): number {
  // A hot-reloaded process can retain a state object created by an older build
  // without this field. Coerce that shape forward instead of reporting NaN.
  state.cacheGeneration = Number.isFinite(state.cacheGeneration)
    ? state.cacheGeneration + 1
    : 1;
  return state.cacheGeneration;
}

function overrideReadAttestation(
  kind: FlagOverrideReadKind,
  cacheKey: string,
  entry: OverrideCacheEntry | undefined,
  now: number,
): FlagOverrideReadAttestation {
  const ttlMs = overrideCacheTtlMs();
  const ageMs = entry ? Math.max(0, now - entry.ts) : null;
  return {
    kind,
    storeConfigured: storeSlot().store !== null,
    cacheKey,
    cacheGeneration: entry?.generation ?? null,
    cacheLoadedAtMs: entry?.ts ?? null,
    cacheAgeMs: ageMs,
    ttlMs,
    ttlRemainingMs: ageMs === null ? 0 : Math.max(0, ttlMs - ageMs),
  };
}

function inspectOverrideReadWithoutLoading(
  now: number = Date.now(),
): FlagOverrideReadAttestation {
  const ck = currentCacheKey();
  const entry = overrideCache.get(ck);
  return overrideReadAttestation(
    storeSlot().store ? "not-read" : "unconfigured",
    ck,
    entry,
    now,
  );
}

async function loadStoredOverridesWithAttestation(): Promise<StoredOverrideRead> {
  const overrideStore = storeSlot().store;
  if (!overrideStore) {
    warnOverrideStoreMissingOnce();
    return {
      flags: {},
      attestation: inspectOverrideReadWithoutLoading(),
    };
  }
  const ck = currentCacheKey();
  const t = Date.now();
  const hit = overrideCache.get(ck);
  if (hit && t - hit.ts < overrideCacheTtlMs()) {
    return {
      flags: hit.flags,
      attestation: overrideReadAttestation("cache-hit", ck, hit, t),
    };
  }
  try {
    // Bounded like every other flag-backend call in this file. The override store
    // is a DATABASE read, so it can HANG, not merely reject — and the catch below
    // only ever covered rejection. An unsettled load() therefore parked getFlag()
    // FOREVER, and because getFlag awaits this BEFORE its own try/catch, every
    // caller in the process inherited that hang: no CPU, no libuv request, no PG
    // session and no log line to attribute it to. Same helper, same fallback, so a
    // hung store now degrades exactly like an unreachable one (EI-21733487918833986).
    const flags = await withFlagBackendTimeout(overrideStore.load());
    const entry: OverrideCacheEntry = {
      flags,
      ts: t,
      generation: nextCacheGeneration(),
    };
    overrideCache.set(ck, entry);
    return {
      flags,
      attestation: overrideReadAttestation("store-load", ck, entry, Date.now()),
    };
  } catch {
    // Store unreachable OR too slow — serve the last good map for THIS scope (or
    // none); never block flag evaluation on the override layer.
    const stale = overrideCache.get(ck);
    return {
      flags: stale?.flags ?? {},
      attestation: overrideReadAttestation(
        stale ? "stale-cache-fallback" : "store-error",
        ck,
        stale,
        Date.now(),
      ),
    };
  }
}

async function loadStoredOverrides(): Promise<
  Partial<Record<FlagKey, boolean>>
> {
  return (await loadStoredOverridesWithAttestation()).flags;
}

export async function setFlagOverride(
  key: FlagKey,
  enabled: boolean | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const overrideStore = storeSlot().store;
  if (!overrideStore)
    return { ok: false, reason: "override-store-not-configured" };
  try {
    await overrideStore.set(key, enabled);
    // A store write may affect a layer shared by EVERY scope (Papercusp's
    // operator store has a global override row plus legacy workspace-local
    // fallback rows). Clear every cached scope so a write in workspace A is
    // immediately observable from workspace B in this same process. Runtime
    // flag writes are rare; correctness here is worth the tiny refill cost.
    overrideCache.clear();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "unknown",
    };
  }
}

/**
 * Clear EVERY stored runtime override (the PG-backed layer). Called when a
 * deployment LEAVES testing mode — the `testingFeatures` master-switch turning
 * OFF and the "V1 Production" preset — so flags return to their bundled
 * defaults, the "all flags off" state that surface's UI promises.
 *
 * Without this, an override set while testing was on (e.g. papercusp-testing)
 * keeps shadowing the defaults after testing is turned off, so the gated
 * surfaces never disappear. Best-effort + idempotent; returns the cleared keys.
 */
export async function clearAllFlagOverrides(): Promise<FlagKey[]> {
  const overrideStore = storeSlot().store;
  if (!overrideStore) return [];
  try {
    const current = await overrideStore.load();
    const keys = Object.keys(current) as FlagKey[];
    for (const key of keys) {
      await overrideStore.set(key, null);
    }
    overrideCache.clear();
    return keys;
  } catch {
    // Never block the leave-testing path on the override layer.
    overrideCache.clear();
    return [];
  }
}

export function initFlagBackend(cfg: PostHogConfig | null): void {
  if (client) {
    void client.shutdown();
    client = null;
  }
  config = cfg;
  if (!cfg) return;
  client = new PostHog(cfg.projectKey, {
    host: cfg.host,
    personalApiKey: cfg.personalApiKey,
    flushAt: 1_000_000,
    flushInterval: 24 * 60 * 60 * 1000,
    featureFlagsPollingInterval: 10_000,
    disableGeoip: true,
  });
}

export function isBackendConfigured(): boolean {
  return client !== null;
}

export function getBackendConfig(): PostHogConfig | null {
  return config;
}

/**
 * Env-var override: `PAPERCUSP_FLAG_<KEY>=1` flips a single flag on
 * without needing PostHog or in-process test overrides. Useful in dev
 * when PostHog isn't configured but you want to exercise a gated
 * feature (e.g. the llm-testing framework running oracle scenarios).
 * The key is uppercased and `-` is converted to `_`.
 */
function resolveEnvOverride(key: FlagKey): boolean | undefined {
  const envKey = `PAPERCUSP_FLAG_${key.toUpperCase().replace(/-/g, "_")}`;
  const raw = process.env[envKey];
  if (raw === undefined) return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

/**
 * Deployment-mode override for the LAYER-3 platform-improvement loops
 * (per-hive-learning-loops P-070 / D-006). The repo has NO dev-vs-release runtime
 * signal yet, so the flag defaults ON (dev / self-host run the full platform loop)
 * and a public RELEASE build switches it off by exporting `PAPERCUSP_PLATFORM_MODE=off`.
 * This is intentionally COARSER than the per-flag `PAPERCUSP_FLAG_*` override (which
 * still wins — an owner opting INTO platform mode on a release build sets
 * `PAPERCUSP_FLAG_PAPERCUSP_PLATFORM_IMPROVEMENT_LOOPS=1`): the build sets ONE var,
 * not a flag-specific one. Returns a forced value only for the platform-improvement
 * flag; `undefined` for every other flag and when the var is unset/`on`.
 *
 * OWNER design point (surfaced in P-070's report): when a real release-build
 * constant lands, gate the default on it instead of this env var.
 */
function resolvePlatformModeOverride(key: FlagKey): boolean | undefined {
  if (key !== FLAGS.PLATFORM_IMPROVEMENT_LOOPS) return undefined;
  const raw = process.env.PAPERCUSP_PLATFORM_MODE;
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  if (v === "on" || v === "1" || v === "true") return true;
  return undefined;
}

/**
 * Resolve one flag and retain enough provenance to explain the answer.
 *
 * This is deliberately the implementation behind BOTH getFlag() and the
 * runtime-attestation surface. A diagnostic that reimplemented precedence in
 * parallel would be able to disagree with the value it claims to explain.
 */
export async function getFlagAttestation(
  key: FlagKey,
  distinctId: string,
): Promise<FlagAttestation> {
  const observedAtMs = Date.now();
  const compiledDefault = FLAG_DEFAULTS[key];
  const done = (
    resolvedValue: boolean,
    source: FlagResolutionSource,
    overrideRead: FlagOverrideReadAttestation,
  ): FlagAttestation => ({
    key,
    resolvedValue,
    compiledDefault,
    source,
    overrideRead,
    backendConfigured: client !== null,
    observedAtMs,
  });

  const envOverride = resolveEnvOverride(key);
  if (envOverride !== undefined) {
    return done(
      envOverride,
      "env-override",
      inspectOverrideReadWithoutLoading(observedAtMs),
    );
  }
  // Coarse deployment-mode lever (P-070): PAPERCUSP_PLATFORM_MODE=off forces the
  // platform-improvement flag off on a release build. The per-flag PAPERCUSP_FLAG_*
  // override above still wins (explicit owner opt-in beats the build-wide var).
  const platformMode = resolvePlatformModeOverride(key);
  if (platformMode !== undefined) {
    return done(
      platformMode,
      "platform-mode-override",
      inspectOverrideReadWithoutLoading(observedAtMs),
    );
  }
  const overrides = resolveTestOverrides();
  if (overrides) {
    return done(
      overrides[key],
      "test-override",
      inspectOverrideReadWithoutLoading(observedAtMs),
    );
  }
  const stored = await loadStoredOverridesWithAttestation();
  if (stored.flags[key] !== undefined) {
    const source: FlagResolutionSource =
      stored.attestation.kind === "cache-hit" ||
      stored.attestation.kind === "stale-cache-fallback"
        ? "process-cache"
        : "override-store";
    return done(stored.flags[key] as boolean, source, stored.attestation);
  }
  if (!client)
    return done(compiledDefault, "compiled-default", stored.attestation);
  try {
    // posthog-node v5 deprecated isFeatureEnabled in favor of evaluateFlags (one /flags request,
    // scoped via flagKeys) — and its deprecation console.warn trips vitest-fail-on-console in ANY
    // test that touches a flag (host-spa gate-red, 2026-07-01). Feature-detect so the v4 range in
    // package.json keeps working.
    const c = client as typeof client & {
      evaluateFlags?: (
        distinctId: string,
        opts?: { flagKeys?: string[] },
      ) => Promise<{ isEnabled: (key: string) => boolean | undefined }>;
    };
    if (typeof c.evaluateFlags === "function") {
      const flags = await withFlagBackendTimeout(
        c.evaluateFlags(distinctId, { flagKeys: [key] }),
      );
      const v = flags.isEnabled(key);
      return typeof v === "boolean"
        ? done(v, "posthog", stored.attestation)
        : done(compiledDefault, "compiled-default", stored.attestation);
    }
    const v = await withFlagBackendTimeout(
      client.isFeatureEnabled(key, distinctId),
    );
    return typeof v === "boolean"
      ? done(v, "posthog", stored.attestation)
      : done(compiledDefault, "compiled-default", stored.attestation);
  } catch {
    return done(compiledDefault, "compiled-default", stored.attestation);
  }
}

export async function getFlag(
  key: FlagKey,
  distinctId: string,
): Promise<boolean> {
  return (await getFlagAttestation(key, distinctId)).resolvedValue;
}

/**
 * Overlay `PAPERCUSP_FLAG_<KEY>` env overrides (and the coarse P-070
 * `PAPERCUSP_PLATFORM_MODE` deployment-mode lever) onto a full flag map — the
 * all-flags counterpart of the env check in getFlag, with the same precedence
 * (env beats test overrides / PostHog / defaults; the per-flag PAPERCUSP_FLAG_*
 * beats the coarse platform-mode var). Without this, the documented dev override
 * flipped server-side single-flag checks but was invisible to the client
 * bootstrap payload (`useFlag`), so UI gates never saw it.
 */
function applyEnvOverrides(flags: FlagValues): FlagValues {
  let out = flags;
  for (const key of ALL_FLAG_KEYS) {
    const v = resolveEnvOverride(key) ?? resolvePlatformModeOverride(key);
    if (v !== undefined) {
      if (out === flags) out = { ...flags };
      out[key] = v;
    }
  }
  return out;
}

export async function getAllFlags(distinctId: string): Promise<FlagPayload> {
  const overrides = resolveTestOverrides();
  if (overrides) {
    return {
      flags: applyEnvOverrides(overrides),
      evaluatedAt: Date.now(),
      source: "override",
    };
  }
  // Filter the stored map through resolveWithDefaults: the PG row can carry
  // keys for RETIRED flags (e.g. papercusp-oracle after the 2026-06-10 fold),
  // and a raw spread would leak them into every client payload forever.
  const stored = await loadStoredOverrides();
  if (!client) {
    return {
      flags: applyEnvOverrides(resolveWithDefaults(stored)),
      evaluatedAt: Date.now(),
      source: "defaults",
    };
  }
  const evaluated: Partial<Record<FlagKey, boolean>> = {};
  // posthog-node v5: ONE evaluateFlags snapshot for all keys (isFeatureEnabled is deprecated and its
  // console.warn trips vitest-fail-on-console — host-spa gate-red 2026-07-01). v4 fallback keeps the
  // declared ">=4 <6" range honest.
  const c5 = client as typeof client & {
    evaluateFlags?: (
      distinctId: string,
      opts?: { flagKeys?: string[] },
    ) => Promise<{ isEnabled: (key: string) => boolean | undefined }>;
  };
  if (typeof c5.evaluateFlags === "function") {
    try {
      const snap = await withFlagBackendTimeout(
        c5.evaluateFlags(distinctId, { flagKeys: [...ALL_FLAG_KEYS] }),
      );
      for (const key of ALL_FLAG_KEYS) {
        const v = snap.isEnabled(key);
        if (typeof v === "boolean") evaluated[key] = v;
      }
    } catch {
      // leave undefined; resolveWithDefaults fills with FLAG_DEFAULTS[key]
    }
  } else {
    await Promise.all(
      ALL_FLAG_KEYS.map(async (key) => {
        try {
          const v = await withFlagBackendTimeout(
            client!.isFeatureEnabled(key, distinctId),
          );
          if (typeof v === "boolean") evaluated[key] = v;
        } catch {
          // leave undefined; resolveWithDefaults fills with FLAG_DEFAULTS[key]
        }
      }),
    );
  }
  // stored beats evaluated; resolveWithDefaults drops retired/unknown keys.
  const flags: FlagValues = applyEnvOverrides(
    resolveWithDefaults({ ...evaluated, ...stored }),
  );
  return { flags, evaluatedAt: Date.now(), source: "posthog" };
}

export async function setFlag(
  key: FlagKey,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!config) return { ok: false, reason: "flag-backend-not-configured" };
  const url = `${config.host}/api/projects/@current/feature_flags/`;
  try {
    const listRes = await fetch(`${url}?search=${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${config.personalApiKey}` },
    });
    if (!listRes.ok) return { ok: false, reason: `list:${listRes.status}` };
    const list = (await listRes.json()) as {
      results?: Array<{ id: number; key: string; active: boolean }>;
    };
    const hit = list.results?.find((f) => f.key === key);
    if (!hit) return { ok: false, reason: "flag-not-found-in-posthog" };
    // PostHog evaluates a flag as true only when both `active` is true
    // AND the rollout matches the user. We want a binary on/off switch
    // for all users, so we set rollout_percentage=100 when enabling and
    // 0 when disabling, in addition to flipping `active`.
    const rollout = enabled ? 100 : 0;
    const patchRes = await fetch(`${url}${hit.id}/`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.personalApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        active: enabled,
        filters: { groups: [{ properties: [], rollout_percentage: rollout }] },
      }),
    });
    if (!patchRes.ok) return { ok: false, reason: `patch:${patchRes.status}` };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "unknown",
    };
  }
}

export function onFlagChange(handler: ChangeHandler): () => void {
  changeHandlers.add(handler);
  return () => changeHandlers.delete(handler);
}

export function emitFlagChange(key: FlagKey | null): void {
  for (const h of changeHandlers) {
    try {
      h(key);
    } catch {
      // swallow handler errors; never block the dispatch loop
    }
  }
}
