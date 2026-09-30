/**
 * Live-editable fleet rate-limit configuration (rate-limit-layer-v2 D-004).
 *
 * The user's `maxSimultaneousAgents` — the fleet-wide cap on concurrently-running agent spawns —
 * plus the AIMD `concurrencyFloor` (D-005). Stored as a single-row-per-workspace JSONB
 * (`harness_shared.operator_rate_limit_config`, migration 161) and propagated LIVE (no restart)
 * via an in-process bus that mirrors `flag-bus.ts`:
 *
 *   PUT → writeRateLimitConfig() → persist PG → applyCached() (push the cap into the governor's
 *   global gate immediately) → publish() (so any other in-process subscriber re-applies) →
 *   pg_notify() (so every OTHER operator process re-reads PG and re-applies too, EI-18106936190883400).
 *
 * The governor (libs/papercusp-shared) reads the cap through the `setGlobalConcurrencyCap` host
 * seam — it never imports this module (lower lib). The orchestrator dispatch ceiling +
 * pty-bridge read `getCachedRateLimitConfig()` directly (same process). On the dev box the Hono
 * host, the DBOS orchestrator loop, and the agent spawns for ONE port all live in ONE operator
 * process — but :3070 (release) and :3170 (staging) are TWO SEPARATE processes sharing the same
 * PG, so an in-process bus alone silently let their `cached` copies diverge; every process now
 * also LISTENs on NOTIFY_CHANNEL and resyncs from PG on any peer's write.
 */
import { getChannel } from '@papercusp/sse';
import { getOrgPg } from '@papercusp/db-org';
import {
  setGlobalConcurrencyCap,
  setGlobalConcurrencyFloor,
  setGlobalConcurrencySeed,
  setProviderFloorOverride,
  setAimdTuning,
  AIMD_CLEAN_TURNS_PER_STEP,
} from '@papercusp/papercusp-shared/agent';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { getResourceProfile } from './resource-profile';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { createNotifyBus } from './pg-notify-bus';

/** P-021: a provider's runtime cold-start floor override (subscription buckets get no header headroom,
    so this static floor is their only rpm gate). Absent fields keep the baked DEFAULT_FLOORS value. */
export interface ProviderFloorConfig {
  maxConcurrent?: number;
  rpm?: number;
}

/** P-021: the AIMD response-curve tuning. */
export interface AimdTuningConfig {
  /** Additive-increase cadence: +1 effective concurrency per N consecutive clean turns. */
  cleanTurnsPerStep?: number;
  /** Multiplicative-decrease factor ∈ (0,1) applied to effective concurrency on a penalty (0.5 = halve). */
  decreaseFactor?: number;
}

/** The providers the governor buckets by (mirrors TurnProvider in papercusp-shared). */
export const GOVERNOR_PROVIDERS = ['anthropic', 'openai', 'unknown'] as const;
export type GovernorProvider = (typeof GOVERNOR_PROVIDERS)[number];

/** The baked AIMD defaults — applyCached restores these when no override is set, keeping the config declarative. */
export const DEFAULT_AIMD_TUNING: Required<AimdTuningConfig> = {
  cleanTurnsPerStep: AIMD_CLEAN_TURNS_PER_STEP,
  decreaseFactor: 0.5,
};

export interface RateLimitConfig {
  /** Fleet-wide cap on concurrently-running agent spawns. The governor's global gate + the
      orchestrator dispatch ceiling + pty-bridge all read this live. The user drops it to e.g. 2
      when using Claude personally so the fleet backs off. */
  maxSimultaneousAgents: number;
  /** AIMD floor (D-005): the effective concurrency never adapts below this. */
  concurrencyFloor: number;
  /** P-021: per-provider cold-start FLOOR overrides ({maxConcurrent, rpm}). Absent ⇒ baked DEFAULT_FLOORS. */
  providerFloors?: Partial<Record<GovernorProvider, ProviderFloorConfig>>;
  /** P-021: AIMD response-curve tuning. Absent ⇒ baked DEFAULT_AIMD_TUNING. */
  aimd?: AimdTuningConfig;
  /**
   * P-009: WHERE `maxSimultaneousAgents` came from — and therefore whether it is a CAP at all.
   *
   * `'user'`  an explicit, deliberate throttle ("I'm using Claude myself, fleet back off"). It is
   *           real user intent, so it still installs a hard cap.
   * `'seed'`  nobody asked for a limit; the number is only the host's boot-time starting point.
   *           It seeds the probe window and installs NO cap, so productive capacity can grow past
   *           it. This is what stops a resource-profile guess from silently becoming a maximum.
   *
   * Optional so every existing construction site stays valid; absent is read as `'seed'`.
   */
  maxSimultaneousAgentsSource?: 'user' | 'seed';
}

/**
 * P-009 — the baked absolute ceiling is RETIRED.
 *
 * This was 64: a flat number that capped what a user was ALLOWED to ask for, independent of what
 * the machine or the provider could actually sustain. capless-inference-gateway P-004 listed it in
 * the deletion matrix (capacity-inventory.ts legacyFields) precisely because a productive-capacity
 * maximum cannot be a compile-time constant. Admission is now governed by observation: the global
 * gate probes upward and contracts on measured pressure, per-lane and with expiry.
 *
 * Retained ONLY as a sanity bound on absurd/hostile input (a typo'd 1e9 would allocate nonsense),
 * which is why it is deliberately far above any real fleet size. It is NOT a capacity verdict, and
 * nothing may reintroduce it as one.
 */
export const RATE_LIMIT_SANITY_BOUND = 100_000;

/** The DEFAULT cap is SEEDED from the host's resource profile (P0 of
    operator-scalability-event-loop-2026-06-16) instead of a constant tuned for one box: a laptop
    sharing an embedded PG seeds a small cap, a 128-core server seeds the ceiling. This is only the
    DEFAULT — the user's persisted live config (PG `operator_rate_limit_config`) still wins, since
    `clampRateLimitConfig` falls back to this seed ONLY when no stored value exists, and
    init/writeRateLimitConfig push the stored value over it. Memoized via getResourceProfile(). */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  get maxSimultaneousAgents(): number {
    return getResourceProfile().maxSimultaneousAgents;
  },
  concurrencyFloor: 1,
};

function clampInt(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** Optional positive int within [lo,hi], or undefined when absent/invalid (an OPTIONAL override field). */
function optInt(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === 'number' ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n) || n < lo || n > hi) return undefined;
  return n;
}

/** Clamp the per-provider floor overrides, dropping invalid fields + empty entries (P-021). */
function clampProviderFloors(
  input: Partial<RateLimitConfig>['providerFloors'],
): RateLimitConfig['providerFloors'] {
  if (!input || typeof input !== 'object') return undefined;
  const out: Partial<Record<GovernorProvider, ProviderFloorConfig>> = {};
  for (const provider of GOVERNOR_PROVIDERS) {
    const raw = input[provider];
    if (!raw || typeof raw !== 'object') continue;
    const entry: ProviderFloorConfig = {};
    // P-009: the baked 256 provider-override ceiling is retired. A per-provider FLOOR override is a
    // cold-start starting point, and capping how high an operator may seed it made that seed a
    // maximum by the back door. Only the sanity bound remains.
    const mc = optInt(raw.maxConcurrent, 1, RATE_LIMIT_SANITY_BOUND);
    const rpm = optInt(raw.rpm, 1, 100_000);
    if (mc !== undefined) entry.maxConcurrent = mc;
    if (rpm !== undefined) entry.rpm = rpm;
    if (Object.keys(entry).length) out[provider] = entry;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Clamp the AIMD curve tuning, dropping invalid fields (P-021). decreaseFactor ∈ (0,1). */
function clampAimd(input: AimdTuningConfig | undefined): AimdTuningConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: AimdTuningConfig = {};
  const cps = optInt(input.cleanTurnsPerStep, 1, 1000);
  if (cps !== undefined) out.cleanTurnsPerStep = cps;
  if (typeof input.decreaseFactor === 'number' && input.decreaseFactor > 0 && input.decreaseFactor < 1) {
    out.decreaseFactor = input.decreaseFactor;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Coerce arbitrary input into a valid config (the route validates; this is the safety floor). */
export function clampRateLimitConfig(input: Partial<RateLimitConfig> | null | undefined): RateLimitConfig {
  // P-009: WHETHER the caller actually asked for a limit is now load-bearing, so it is decided
  // BEFORE clamping — once the resource-profile default has been substituted the two are
  // indistinguishable, and treating the substituted default as user intent is exactly how a
  // boot-time guess became a hard productive-capacity maximum.
  // A caller that already KNOWS the provenance states it, and that wins: the PUT route rewrites the
  // whole config on every edit, so a floor-only edit would otherwise re-send the seeded default as a
  // number and silently promote it to a user cap — the exact back-door this field exists to close.
  const explicit =
    input?.maxSimultaneousAgentsSource !== undefined
      ? input.maxSimultaneousAgentsSource === 'user'
      : typeof input?.maxSimultaneousAgents === 'number' && Number.isFinite(input.maxSimultaneousAgents);
  // The 64 ceiling is gone: an explicit request is honored up to the sanity bound only.
  const max = clampInt(input?.maxSimultaneousAgents, DEFAULT_RATE_LIMIT_CONFIG.maxSimultaneousAgents, 1, RATE_LIMIT_SANITY_BOUND);
  const floor = clampInt(input?.concurrencyFloor, DEFAULT_RATE_LIMIT_CONFIG.concurrencyFloor, 1, max);
  const cfg: RateLimitConfig = {
    maxSimultaneousAgents: max,
    concurrencyFloor: floor,
    maxSimultaneousAgentsSource: explicit ? 'user' : 'seed',
  };
  const providerFloors = clampProviderFloors(input?.providerFloors);
  if (providerFloors) cfg.providerFloors = providerFloors;
  const aimd = clampAimd(input?.aimd);
  if (aimd) cfg.aimd = aimd;
  return cfg;
}

const CHANNEL = 'rate-limit-config-changes';
/**
 * PG NOTIFY channel for CROSS-PROCESS propagation (EI-18106936190883400). The in-process
 * bus above (CHANNEL / getRateLimitBus) only fans out within ONE Node process — but this
 * dev box (:3070 release + :3170 staging) and any clustered deploy (httpWorkers > 1) run
 * MULTIPLE operator processes against the SAME PG-backed config. A write handled by one
 * process updated ONLY that process's `cached` + its own governor's global gate; every
 * OTHER process's `cached` (and therefore the cap it actually ENFORCES) silently kept the
 * value from its own last boot/write forever. That is exactly the reported divergence: the
 * editable input (a caller's fresh `readRateLimitConfig()` PG read) and the enforcing layer
 * (another process's stale `getCachedRateLimitConfig()`, feeding its governor) permanently
 * disagreeing. This was the module's own documented TODO ("PG LISTEN/NOTIFY is the
 * documented multi-process extension") — every process now NOTIFYs its peers on write and
 * LISTENs to resync from PG (the single source of truth) on any peer's write.
 */
const NOTIFY_CHANNEL = 'papercusp_rate_limit_config_changed';
/**
 * LAZY on purpose — `null` means "not seeded yet", NOT "no config".
 *
 * This used to be `= { ...DEFAULT_RATE_LIMIT_CONFIG }` at module scope, which
 * SPREADS the object and therefore INVOKES its `maxSimultaneousAgents` getter
 * (line ~85) during module evaluation — i.e. `getResourceProfile()` ran on
 * `import`, in every process and every test that merely reaches this module.
 * That defeated two things the getter exists to guarantee:
 *
 *  1. `primePowerSource()`'s own doc comment warns that a profile read BEFORE it
 *     runs memoizes the caps as AC. An import-time read makes losing that race
 *     the DEFAULT, not a race — battery detection could never affect the caps.
 *  2. It dragged env/PG-discovery detection (`detectEmbeddedPg` →
 *     `getHarnessAdminUrlWithSource`, `detectHostRole` → `utilityHostEnabled`)
 *     into the module graph of every unit test that transitively imports this
 *     file, so any test partially mocking `embedded-pg-discovery` or
 *     `background-workers` died at COLLECTION with "No <export> is defined on
 *     the mock" — a failure with no relationship to what the test asserts.
 *     (Green-checkpoint red for candidate e0c95ae7; 3 files broken this way.)
 *
 * Seed it on first READ instead. `getCachedRateLimitConfig()` is the only reader,
 * so the observable value is unchanged — it is just resolved when someone asks
 * for it rather than when the module is loaded.
 */
let cached: RateLimitConfig | null = null;
let booted = false;

export type RateLimitConfigEnvelope = { type: 'rate_limit_config_changed'; config: RateLimitConfig; ts: number };

export function getRateLimitBus() {
  return getChannel<RateLimitConfigEnvelope>(CHANNEL, { ringSize: 16 });
}

/** The live value (synchronous) the orchestrator + pty-bridge read every tick. Reflects the last
    PG load + bus publish in THIS process. */
export function getCachedRateLimitConfig(): RateLimitConfig {
  return (cached ??= { ...DEFAULT_RATE_LIMIT_CONFIG });
}

function applyCached(cfg: RateLimitConfig): void {
  cached = cfg;
  // Push the fleet cap + AIMD floor into the governor registry's global gate — honored by the
  // next acquire (D-004/D-005).
  //
  // P-009: a number the user never asked for must not become a productive-capacity MAXIMUM. Only an
  // explicit `maxSimultaneousAgents` installs a hard cap; the host's resource-profile default is
  // pushed as a SEED, which bootstraps the probe window and leaves it free to grow past that guess.
  // This is the concrete guarantee behind "live config cannot reinstall a productive-capacity
  // maximum": clearing the user's value returns the fleet to observation, not to a baked ceiling.
  if (cfg.maxSimultaneousAgentsSource === 'user') {
    setGlobalConcurrencyCap(cfg.maxSimultaneousAgents);
  } else {
    setGlobalConcurrencyCap(undefined);
    setGlobalConcurrencySeed(cfg.maxSimultaneousAgents);
  }
  setGlobalConcurrencyFloor(cfg.concurrencyFloor);
  // P-021: push the per-provider floor overrides + AIMD curve. DECLARATIVE — a provider absent from
  // the config clears its override (setProviderFloorOverride is unchanged-guarded so a benign re-apply
  // never re-seats a header-learned bucket), and an absent aimd block restores the baked defaults.
  for (const provider of GOVERNOR_PROVIDERS) {
    setProviderFloorOverride(provider, cfg.providerFloors?.[provider]);
  }
  setAimdTuning({
    cleanTurnsPerStep: cfg.aimd?.cleanTurnsPerStep ?? DEFAULT_AIMD_TUNING.cleanTurnsPerStep,
    decreaseFactor: cfg.aimd?.decreaseFactor ?? DEFAULT_AIMD_TUNING.decreaseFactor,
  });
}

/** Load from PG, install into the governor, and subscribe to live changes. Idempotent; call once
    at operator boot (alongside the governor store + observer wiring). */
export async function initRateLimitConfig(): Promise<void> {
  if (booted) return;
  booted = true;
  // Re-apply on any in-process publish (e.g. a PUT handled on another request in this process).
  getRateLimitBus().onPublish(({ event }) => applyCached(event.config));
  // Cross-process resync (see NOTIFY_CHANNEL doc above): another operator process's write
  // NOTIFYs this one — re-read the persisted value from PG (the source of truth) rather than
  // trusting our own possibly-stale `cached`. Best-effort: a resync failure just leaves the
  // prior cached value in place (never throws, never blocks the notify bus).
  createNotifyBus(NOTIFY_CHANNEL, 'rate-limit-config').subscribe(() => {
    readOperatorState<Partial<RateLimitConfig>>('operator_rate_limit_config')
      .then((stored) => applyCached(clampRateLimitConfig(stored ?? {})))
      .catch((err) => console.error('[rate-limit-config] cross-process resync failed:', err));
  });
  const stored = await readOperatorState<Partial<RateLimitConfig>>('operator_rate_limit_config').catch(() => null);
  applyCached(clampRateLimitConfig(stored ?? {}));
}

/** Read the persisted config (clamped), independent of the cached value. */
export async function readRateLimitConfig(): Promise<RateLimitConfig> {
  const stored = await readOperatorState<Partial<RateLimitConfig>>('operator_rate_limit_config').catch(() => null);
  return clampRateLimitConfig(stored ?? {});
}

/** Persist + propagate live. Returns the clamped value actually stored. */
export async function writeRateLimitConfig(input: Partial<RateLimitConfig>): Promise<RateLimitConfig> {
  const cfg = clampRateLimitConfig(input);
  await writeOperatorState('operator_rate_limit_config', cfg);
  applyCached(cfg); // update THIS process immediately (no wait for the publish round-trip)
  getRateLimitBus().publish({ type: 'rate_limit_config_changed', config: cfg, ts: Date.now() });
  // Wake every OTHER operator process sharing this PG (see NOTIFY_CHANNEL doc above) so their
  // `cached` — and therefore their governor's actually-enforced cap — converges too. Best-effort:
  // the value is already durably persisted, so a notify failure never blocks the write; the next
  // boot (or any other write) still converges it.
  // The `.catch()` alone did NOT deliver the best-effort contract stated above: `getOrgPg()`
  // acquires the pool SYNCHRONOUSLY and can throw before any promise exists to catch on, so a
  // pool-acquisition failure propagated out of writeRateLimitConfig and DID block the write —
  // the one thing this comment promises cannot happen. Surfaced by the forbid-real-PG rail
  // [EI-19311807188719573], which throws exactly there. Wrap the acquisition too.
  try {
    const { sql } = getOrgPg();
    await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, '')`;
  } catch (err: unknown) {
    console.error('[rate-limit-config] cross-process notify failed:', err);
  }
  return cfg;
}

/** Revert the rate-limit config to the host-seeded defaults (clears the override), propagated
    live like any write. Returns the resulting (default) config. The override concern's reset. */
export async function resetRateLimitConfig(): Promise<RateLimitConfig> {
  // clampRateLimitConfig({}) resolves the getter-backed defaults to concrete numbers; persisting
  // those IS the revert (a later host-profile change won't re-seed, but the user can re-clear).
  return writeRateLimitConfig({});
}

// Self-register as a runtime-config override concern (P-024 registry / sentinel-herald P-037):
// the live fleet cap + AIMD floor show up in config:list-overrides, and config:reset-overrides
// can revert them to the host-seeded defaults.
registerOverrideConcern({
  name: 'rate-limit-config',
  description: 'fleet rate-limit cap + AIMD floor (maxSimultaneousAgents / concurrencyFloor)',
  auditAction: 'operator:rate_limit_config',
  diff: async () => {
    const cfg = await readRateLimitConfig();
    const def = DEFAULT_RATE_LIMIT_CONFIG; // getter resolves maxSimultaneousAgents per-read
    const entries: OverrideEntry[] = [];
    for (const k of ['maxSimultaneousAgents', 'concurrencyFloor'] as const) {
      if (cfg[k] !== def[k]) entries.push({ key: k, effective: cfg[k], default: def[k], layer: 'pg-settings' });
    }
    // P-021: surface the per-provider floor + AIMD-curve overrides when set (default = baked governor floors).
    if (cfg.providerFloors) {
      for (const provider of GOVERNOR_PROVIDERS) {
        if (cfg.providerFloors[provider]) {
          entries.push({ key: `providerFloors.${provider}`, effective: cfg.providerFloors[provider], default: 'DEFAULT_FLOORS baked', layer: 'pg-settings' });
        }
      }
    }
    if (cfg.aimd) entries.push({ key: 'aimd', effective: cfg.aimd, default: DEFAULT_AIMD_TUNING, layer: 'pg-settings' });
    return entries;
  },
  capture: () => readRateLimitConfig(),
  reset: () => resetRateLimitConfig(),
  restore: (snap) => writeRateLimitConfig(snap as RateLimitConfig).then(() => {}),
});

/** Test hook — reset the module's cached state + boot latch. */
export function __resetRateLimitConfigForTest(): void {
  cached = { ...DEFAULT_RATE_LIMIT_CONFIG };
  booted = false;
  setGlobalConcurrencyCap(undefined);
  setGlobalConcurrencyFloor(undefined);
  // P-021: also clear the per-provider floor overrides + restore the baked AIMD curve.
  for (const provider of GOVERNOR_PROVIDERS) setProviderFloorOverride(provider, undefined);
  setAimdTuning(DEFAULT_AIMD_TUNING);
}
