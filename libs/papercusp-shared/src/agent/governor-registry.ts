/**
 * Backend provider profiles + the shared governor registry (agent-turn-robustness P-011).
 *
 * Declares, per backend, which provider/limit-model applies and whether the backend
 * self-paces — then hands out a SINGLETON `RateLimitGovernor` per `(provider, modelClass)`
 * so all callers that hit the same provider+model-class share ONE budget (otherwise the
 * gym + fleet co-burst the same account). Anthropic limits are per-model-class (opus vs
 * sonnet are separate buckets), so the key includes the class. omp is model-agnostic with
 * built-in fallback chaining → self-pacing → concurrency-cap only (no token budget; we
 * can't see which provider its internal calls hit).
 *
 * Cold-start floors are CONSERVATIVE (D-003); `governor.recordResponse(headers)` auto-tunes
 * them up from the provider's `*-ratelimit-*-limit` headers when available (API-key paths).
 */
import type { TurnBackend, TurnProvider } from './turn-error';
import { RateLimitGovernor, type GovernorLimits, type GovernorDeps, type GovernorState, type GovernorPauseEvent, type GovernorStore, type GlobalConcurrencyGate, type GlobalFeedbackEvent } from '../resilience/governor';

export type LimitModel = 'subscription' | 'apiKey';

export interface BackendProfile {
  provider: TurnProvider;
  /** omp self-paces via fallback chaining → we only cap its concurrency. */
  selfPacing: boolean;
}

export const BACKEND_PROFILES: Record<TurnBackend, BackendProfile> = {
  'anthropic-direct': { provider: 'anthropic', selfPacing: false },
  'claude-code': { provider: 'anthropic', selfPacing: false },
  omp: { provider: 'unknown', selfPacing: true },
  codex: { provider: 'openai', selfPacing: false },
};

/**
 * Whether a provider runs on a precise header-driven API-key bucket or a coarse subscription —
 * a RUNTIME credential fact (D-006), NOT a compile-time const. The ITPM/OTPM token-bucket is
 * only honest with an API key (which returns `*-ratelimit-*` per-minute headroom headers); a
 * subscription (Claude-Max / ChatGPT OAuth) exposes none, so it's concurrency + RPM +
 * honor-retry-after only. Resolved from env at call time so pointing a backend at an API key
 * (e.g. to dodge the Max rate window — D-006) flips it to precise mode without a code change.
 */
export function resolveProviderLimitModel(provider: TurnProvider, env: Record<string, string | undefined> = process.env): LimitModel {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY ? 'apiKey' : 'subscription';
  if (provider === 'openai') return env.OPENAI_API_KEY ? 'apiKey' : 'subscription';
  return 'subscription'; // unknown / multi-provider (omp): no single bucket → coarse
}

/** The runtime limit model for a backend (omp self-paces → always coarse subscription mode). */
export function resolveLimitModel(backend: TurnBackend, env: Record<string, string | undefined> = process.env): LimitModel {
  const p = BACKEND_PROFILES[backend];
  if (p.selfPacing) return 'subscription';
  return resolveProviderLimitModel(p.provider, env);
}

/** Anthropic rate limits are per model class (opus/sonnet/haiku are separate buckets). */
export function modelClassOf(model: string): string {
  const m = model.toLowerCase();
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  return 'default';
}

/** Conservative cold-start floors per provider (auto-tuned UP from headers). */
const DEFAULT_FLOORS: Record<TurnProvider, GovernorLimits> = {
  // Subscriptions don't expose per-minute headroom, so the floor is the safety: a low
  // concurrency cap (kills the burst) + a conservative RPM. A 429 penalty pauses
  // regardless if we're still too fast.
  anthropic: { maxConcurrent: 3, rpm: 45 },
  openai: { maxConcurrent: 3, rpm: 45 },
  // omp / unknown: self-pacing → concurrency-cap ONLY (no rpm/token budget — we don't
  // know which provider its internal call hit, and it self-heals via fallback chaining).
  unknown: { maxConcurrent: 3 },
};

// P-021 (live-configurability-audit): per-provider runtime FLOOR overrides (the `fleet:governor_floors`
// dial, host-pushed via operator:rate_limit_config → setProviderFloorOverride). Consulted by
// effectiveFloor() at governor CREATION and pushed into EXISTING buckets on set (so the knob is fully
// live, not new-buckets-only). Empty (default) ⇒ DEFAULT_FLOORS ⇒ byte-identical.
const providerFloorOverrides: Partial<Record<TurnProvider, Partial<GovernorLimits>>> = {};

/** The effective cold-start floor for a provider = baked DEFAULT_FLOORS merged with any runtime override. */
function effectiveFloor(provider: TurnProvider): GovernorLimits {
  return { ...DEFAULT_FLOORS[provider], ...(providerFloorOverrides[provider] ?? {}) };
}

const registry = new Map<string, RateLimitGovernor>();

// --- Fleet-wide concurrency cap (rate-limit-layer-v2 D-004) ------------------------------------
// A single shared counter + cap that EVERY governor consults on top of its own per-bucket
// maxConcurrent, so the TOTAL concurrent agents across all (provider,modelClass) buckets is
// bounded by the user's live `maxSimultaneousAgents`. The production registry uses one default
// gate, while tests and embedders can create independent instances.
//
// --- AIMD adaptive concurrency (rate-limit-layer-v2 D-005) -------------------------------------
// The user's cap is the HARD ceiling; each gate runs an EFFECTIVE concurrency `eff ≤ cap` that
// additively increases (+1 per N consecutive clean turns) and multiplicatively decreases (halve
// toward the floor) on an account-wide penalty. Inactive (eff undefined, legacy-identical) until
// a finite cap or seed is installed; headers govern RATE, this governs CONCURRENCY.
export const AIMD_CLEAN_TURNS_PER_STEP = 5;

// --- P-009: the global window is a PROBE, not a baked maximum ---------------------------------
// spec capless-p009-provider-governor@1: "Provider and global rate observations contract only the
// causally affected account/model lane and resume probing when the observed constraint expires."
/** How long a global contraction stands before the window resumes probing. Env-tunable. */
export const GLOBAL_CONSTRAINT_TTL_MS = Number(process.env.PAPERCUSP_GLOBAL_CONSTRAINT_TTL_MS) || 5 * 60_000;
const DEFAULT_AIMD_DECREASE_FACTOR = 0.5;
const DEFAULT_GLOBAL_FLOOR = 1;

export interface GlobalConcurrencySnapshot {
  cap: number;
  inFlight: number;
}

export interface EffectiveConcurrencySnapshot {
  effective: number | null;
  floor: number;
  cleanStreak: number;
  /** P-009: the window AFTER expiry — what admission actually enforces right now. */
  effectiveAfterExpiry: number | null;
  /** P-009: the highest window this gate has sustained (the "prior probe window" it resumes to). */
  peak: number;
  /** P-009: epoch ms of the standing contraction, or null when none is in force. */
  contractedAt: number | null;
  /** P-009: true once the standing contraction has aged past its TTL (probing has resumed). */
  constraintExpired: boolean;
}

/**
 * The instance controller extends the generic gate with the live configuration/readback seams
 * used by the production wrappers and hermetic tests.
 */
export interface GlobalConcurrencyGateController extends GlobalConcurrencyGate {
  // Narrowed from the base interface's optional signature: this controller's factory
  // (createGlobalConcurrencyGate below) always implements both hooks unconditionally, so
  // callers holding a GlobalConcurrencyGateController — unlike a generic GlobalConcurrencyGate,
  // which some implementations may omit — never need the `?.()` guard.
  noteClean(ev?: GlobalFeedbackEvent): void;
  notePenalty(ev?: GlobalFeedbackEvent): void;
  setCap(n: number | undefined): void;
  setFloor(n: number | undefined): void;
  setSeed(n: number | undefined): void;
  setClock(fn: (() => number) | undefined): void;
  setTuning(t: { cleanTurnsPerStep?: number; decreaseFactor?: number } | undefined): void;
  getTuning(): { cleanTurnsPerStep: number; decreaseFactor: number };
  globalSnapshot(): GlobalConcurrencySnapshot;
  effectiveSnapshot(): EffectiveConcurrencySnapshot;
  /** Reset transient state using the legacy registry semantics (configured cap/floor remain live). */
  reset(): void;
}

export interface GlobalConcurrencyGateOptions {
  now?: () => number;
}

/**
 * Create an instance-scoped fleet concurrency gate.
 *
 * All mutable AIMD/counter/clock state lives in this closure. The registry keeps one production
 * instance for backwards-compatible module-level wrappers, while tests and embedders can inject
 * another instance through `GovernorDeps.globalGate`. Two consumers in one process therefore
 * cannot race over one ambient window unless they explicitly choose to share a gate.
 */
export function createGlobalConcurrencyGate(options: GlobalConcurrencyGateOptions = {}): GlobalConcurrencyGateController {
  let globalCap = Infinity;
  let globalInFlight = 0;
  let globalFloor = DEFAULT_GLOBAL_FLOOR;
  let aimdEff: number | undefined;
  let aimdCleanStreak = 0;
  // P-021 (live-configurability-audit): the AIMD response-curve is host-tunable at runtime.
  let aimdCleanTurnsPerStep = AIMD_CLEAN_TURNS_PER_STEP;
  let aimdDecreaseFactor = DEFAULT_AIMD_DECREASE_FACTOR;
  /** Bootstrap window when no explicit user cap is set — a SEED to start observing from, never a maximum. */
  let globalSeed: number | undefined;
  /** The largest effective window this gate has actually sustained — the prior probe window. */
  let aimdPeak = 0;
  /** Epoch ms of the most recent contraction (anchors TTL expiry). 0 = not contracted. */
  let aimdContractedAt = 0;
  /** Injectable clock so a test can advance the freshness clock (the clause's own probeMethod). */
  let gateNow: () => number = options.now ?? (() => Date.now());

  /**
   * The effective global window at `now`, AFTER expiry.
   *
   * A contraction older than GLOBAL_CONSTRAINT_TTL_MS has expired: the observation that justified it
   * is stale, so the window resumes probing at the peak it had previously sustained rather than
   * remaining shrunk. Pure — callers read it, they do not mutate through it.
   */
  function effectiveGlobalWindow(): number {
    if (aimdEff === undefined) return Infinity;
    if (aimdContractedAt > 0 && gateNow() - aimdContractedAt >= GLOBAL_CONSTRAINT_TTL_MS) {
      return Math.min(globalCap, Math.max(aimdEff, aimdPeak));
    }
    return aimdEff;
  }

  const gate: GlobalConcurrencyGateController = {
    tryAcquire(opts) {
      const effectiveLimit = Math.min(globalCap, effectiveGlobalWindow());
      // The gateway already treats tier 1 (interactive/queen/scout/overwatch) as a
      // reserved lane. Preserve that SAME contract before the request reaches the
      // gateway: when AIMD has shed the ordinary lane, tier 1 may use otherwise-idle
      // hard-cap headroom. Per-bucket maxConcurrent still bounds each producer, and the
      // gateway remains the authoritative cross-account admission queue.
      const limit = opts?.priorityTier === 1 ? globalCap : effectiveLimit;
      if (globalInFlight >= limit) return false;
      globalInFlight += 1;
      return true;
    },
    release() {
      globalInFlight = Math.max(0, globalInFlight - 1);
    },
    // WI-38062: the fleet gate's live occupancy vs the limit for the CALLER'S band, so a denial it
    // produced carries real numbers instead of a constant. Mirrors tryAcquire's band selection
    // exactly (tier 1 is measured against the hard cap, not the AIMD-shed effective limit) — read
    // via the same expression so the two can't drift into reporting a limit that was never applied.
    snapshot(opts) {
      const effectiveLimit = Math.min(globalCap, effectiveGlobalWindow());
      const limit = opts?.priorityTier === 1 ? globalCap : effectiveLimit;
      return { inFlight: globalInFlight, limit };
    },
    noteClean(ev) {
      // P-009 (1): recovery is scoped exactly like contraction. An account-keyed lane's clean turn is
      // evidence about THAT account, so it must not ramp the fleet window either — otherwise the gate
      // would drift, crediting siblings for a recovery it refused to be penalised for.
      if (ev?.accountScoped) return;
      if (aimdEff === undefined) return; // AIMD inactive: no seed and no cap installed
      aimdCleanStreak += 1;
      if (aimdCleanStreak >= aimdCleanTurnsPerStep) {
        aimdCleanStreak = 0;
        // P-009 (2): additive increase is bounded ONLY by an explicit user cap. Without one,
        // `globalCap` is Infinity and the window PROBES UPWARD indefinitely instead of being pinned
        // to whatever seed it happened to boot with — a seed bootstraps observation, it is not a
        // ceiling. Reaching a new high clears the contraction anchor: the window has proven this
        // level, so there is no stale constraint left to expire.
        if (aimdEff < globalCap) {
          aimdEff += 1;
          if (aimdEff > aimdPeak) {
            aimdPeak = aimdEff;
            aimdContractedAt = 0;
          }
        }
      }
    },
    notePenalty(ev) {
      // P-009 (1): THE core fix. An account-keyed observation is one account's budget fact, never
      // evidence about its siblings, so it must not contract the fleet-wide window. Before this, any
      // single account's 429 halved the whole fleet — the clause's falsifier arm 1 ("a provider fault
      // shrinks unrelated accounts"). That lane is NOT left ungoverned: penalize() already decreased
      // its own rpmFactor and parked it with a bounded re-probe, both of which recover on their own
      // clock. An account-BLIND lane (no '@'), or a local-saturation signal from the connection /
      // loop-pressure governors, still legitimately contracts the fleet.
      if (ev?.accountScoped) return;
      aimdCleanStreak = 0;
      if (aimdEff === undefined) return;
      if (aimdEff > aimdPeak) aimdPeak = aimdEff; // remember the window we are contracting away from
      aimdEff = Math.max(globalFloor, Math.floor(aimdEff * aimdDecreaseFactor)); // multiplicative decrease to floor
      aimdContractedAt = gateNow(); // start the shelf life (P-009 (2))
    },
    setCap(n) {
      if (typeof n === 'number' && n > 0) {
        const prevCap = globalCap;
        globalCap = n;
        // The user's edit is honored LIVE: when eff is not adapted-down (fresh, or sitting at the old
        // cap) it follows the edit in both directions. Only a penalty-adapted eff (< old cap) holds
        // its safe level on a raise and ramps up via clean turns.
        if (aimdEff === undefined || !Number.isFinite(prevCap) || aimdEff >= prevCap) {
          aimdEff = n;
        } else {
          aimdEff = Math.min(aimdEff, n);
        }
        if (aimdEff < globalFloor) aimdEff = Math.min(globalFloor, globalCap);
      } else {
        globalCap = Infinity;
        // P-009: clearing the USER's cap must not disable adaptation. When a seed is installed the
        // window keeps probing from it (uncapped); only with neither cap nor seed is AIMD inactive.
        aimdEff = globalSeed;
        aimdCleanStreak = 0;
      }
      aimdPeak = Math.max(aimdPeak, aimdEff ?? 0);
      aimdContractedAt = 0; // an explicit config write supersedes any standing observation
    },
    setSeed(n) {
      globalSeed = typeof n === 'number' && n > 0 ? Math.floor(n) : undefined;
      // Only ADOPT the seed as the live window when nothing has been learned yet: a window that has
      // already adapted (or a user cap) outranks a boot-time guess.
      if (aimdEff === undefined && globalSeed !== undefined && !Number.isFinite(globalCap)) {
        aimdEff = globalSeed;
        aimdPeak = Math.max(aimdPeak, globalSeed);
      }
    },
    setFloor(n) {
      globalFloor = typeof n === 'number' && n >= 1 ? Math.floor(n) : DEFAULT_GLOBAL_FLOOR;
      if (aimdEff !== undefined && aimdEff < globalFloor) aimdEff = Math.min(globalFloor, globalCap);
    },
    setClock(fn) {
      gateNow = fn ?? (() => Date.now());
    },
    setTuning(t) {
      if (typeof t?.cleanTurnsPerStep === 'number' && t.cleanTurnsPerStep >= 1) {
        aimdCleanTurnsPerStep = Math.floor(t.cleanTurnsPerStep);
      }
      if (typeof t?.decreaseFactor === 'number' && t.decreaseFactor > 0 && t.decreaseFactor < 1) {
        aimdDecreaseFactor = t.decreaseFactor;
      }
    },
    getTuning() {
      return { cleanTurnsPerStep: aimdCleanTurnsPerStep, decreaseFactor: aimdDecreaseFactor };
    },
    globalSnapshot() {
      return { cap: globalCap, inFlight: globalInFlight };
    },
    effectiveSnapshot() {
      const after = effectiveGlobalWindow();
      return {
        effective: aimdEff ?? null,
        floor: globalFloor,
        cleanStreak: aimdCleanStreak,
        effectiveAfterExpiry: Number.isFinite(after) ? after : null,
        peak: aimdPeak,
        contractedAt: aimdContractedAt || null,
        constraintExpired: aimdContractedAt > 0 && gateNow() - aimdContractedAt >= GLOBAL_CONSTRAINT_TTL_MS,
      };
    },
    reset() {
      // Preserve configured cap/floor/effective state to match resetGovernorRegistry's historical
      // semantics; callers explicitly clear configuration through setCap/setFloor when required.
      globalInFlight = 0;
      aimdCleanStreak = 0;
      aimdCleanTurnsPerStep = AIMD_CLEAN_TURNS_PER_STEP;
      aimdDecreaseFactor = DEFAULT_AIMD_DECREASE_FACTOR;
      globalSeed = undefined;
      aimdPeak = 0;
      aimdContractedAt = 0;
      gateNow = () => Date.now();
    },
  };
  return gate;
}

const globalGate = createGlobalConcurrencyGate();

/** Test/host hook: drive the gate's expiry clock. Pass undefined to restore `Date.now`. */
export function setGlobalGateClock(fn: (() => number) | undefined): void {
  globalGate.setClock(fn);
}

/** Set the fleet-wide concurrent-agent cap (the user's live `maxSimultaneousAgents`). `undefined`
    or ≤0 clears it (Infinity = unbounded, AIMD inactive). Honored by the very next `acquire`
    across all buckets; the AIMD effective concurrency starts at the cap and adapts under it. */
export function setGlobalConcurrencyCap(n: number | undefined): void {
  globalGate.setCap(n);
}

/**
 * P-009: install the BOOTSTRAP window the global gate starts observing from when the user has set
 * no explicit `maxSimultaneousAgents`.
 *
 * This is deliberately NOT `setGlobalConcurrencyCap`. A seed is where probing STARTS; a cap is a
 * ceiling probing may never cross. The host derives the seed from its resource profile — a fact
 * about the machine's starting point, not a licence to cap productive capacity — so with only a
 * seed installed `globalCap` stays Infinity and `noteClean` probes upward past the seed. Passing
 * `undefined` clears it (AIMD inactive again unless a cap is set).
 */
export function setGlobalConcurrencySeed(n: number | undefined): void {
  globalGate.setSeed(n);
}

/** Set the AIMD floor (D-005) — the effective concurrency never adapts below it. */
export function setGlobalConcurrencyFloor(n: number | undefined): void {
  globalGate.setFloor(n);
}

/** P-021: tune the AIMD response curve live — the additive-increase cadence (`cleanTurnsPerStep`,
    +1 eff per N clean turns) and the multiplicative-decrease `decreaseFactor` ∈ (0,1) applied on a
    penalty. Only valid fields are taken; omitted/invalid keep the current value. Honored by the very
    next clean turn / penalty across all buckets (the gate reads the live vars). */
export function setAimdTuning(t: { cleanTurnsPerStep?: number; decreaseFactor?: number } | undefined): void {
  globalGate.setTuning(t);
}

/** The live AIMD response-curve tuning (for observability / the config readback). */
export function getAimdTuning(): { cleanTurnsPerStep: number; decreaseFactor: number } {
  return globalGate.getTuning();
}

/** P-021: override (or clear, when `limits` omits a field / is undefined) a provider's conservative
    cold-start FLOOR live — applied to new buckets AND pushed into existing ones immediately, so the
    knob is fully live. Subscriptions expose no per-minute headroom, so this static floor is the only
    rpm gate they get; raising/lowering it tunes the whole fleet's pace to a provider without a deploy. */
export function setProviderFloorOverride(provider: TurnProvider, limits: Partial<GovernorLimits> | undefined): void {
  const next = limits && Object.keys(limits).length > 0 ? { ...limits } : undefined;
  // UNCHANGED guard: only re-push when the override actually changes. A benign re-apply (e.g. a
  // maxSimultaneousAgents-only edit re-runs applyCached) must NOT re-seat existing buckets to the
  // static floor — that would discard each bucket's header-learned rpm (recordResponse auto-tune).
  if (JSON.stringify(providerFloorOverrides[provider] ?? null) === JSON.stringify(next ?? null)) return;
  if (!next) delete providerFloorOverrides[provider];
  else providerFloorOverrides[provider] = next;
  // Push the new effective floor into every EXISTING bucket of this provider (fully-live, not new-only).
  const floor = effectiveFloor(provider);
  for (const [key, g] of registry) {
    if (parseGovernorKey(key).provider === provider) g.setFloor(floor);
  }
}

/** The live per-provider floor overrides (for observability / the config readback). */
export function getProviderFloorOverrides(): Partial<Record<TurnProvider, Partial<GovernorLimits>>> {
  return { ...providerFloorOverrides };
}

/** The live fleet-wide cap + current total in-flight — surfaced by the rate read-model / top-bar. */
export function globalConcurrencySnapshot(): GlobalConcurrencySnapshot {
  return globalGate.globalSnapshot();
}

/** The AIMD view (D-005): the adapted effective concurrency under the cap (null = AIMD inactive,
    i.e. no finite cap installed), the floor it never drops below, and the current clean streak. */
export function effectiveConcurrencySnapshot(): EffectiveConcurrencySnapshot {
  return globalGate.effectiveSnapshot();
}

/** P5-2 (operator-scalability-event-loop-2026-06-16): apply an EXTERNAL backpressure
 *  penalty to the global AIMD concurrency — a signal that is NOT a provider 429 but
 *  LOCAL saturation (event-loop pressure) the fleet should shed for. Multiplicative-
 *  decrease of the effective concurrency toward the floor, identical to a 429 penalty.
 *  No-op while AIMD is inactive (no finite cap installed). */
export function recordGlobalConcurrencyPenalty(): void {
  globalGate.notePenalty?.();
}

/** P5-2: record an external CLEAN signal — the local pressure cleared — nudging the
 *  AIMD effective concurrency back up one clean step. Mirrors a clean turn but is
 *  tick-driven, so eff recovers even when the fleet is idle (no turns to ramp it).
 *  No-op while AIMD is inactive. */
export function recordGlobalConcurrencyClean(): void {
  globalGate.noteClean?.();
}

// Cross-process shared-budget store (RB-007). When set (by the operator at boot, behind a flag),
// every NEW governor routes its rate+pause budget through it so the whole fleet + gym + this dev
// session share ONE account budget. Concurrency stays per-process. Default unset = in-memory.
let sharedStore: GovernorStore | undefined;

/** Install (or clear) the cross-process budget store. Resets the registry so subsequent
    `getGovernor` calls bind the store. Call once at boot, before any agent turn. */
export function setGovernorStore(store: GovernorStore | undefined): void {
  sharedStore = store;
  registry.clear();
}

/**
 * The bucket key for a `(provider, modelClass)` — optionally scoped to a specific
 * ACCOUNT (`cloud-deployment-layer` Phase 7, P-019). With no `accountId` the key is
 * the global `<provider>:<modelClass>` (unchanged — shared across the fleet). With
 * one it is `<provider>:<modelClass>@<accountId>`, giving that Claude account its
 * OWN governor state + (under the PG store) its own budget row, so accounts with
 * separate subscriptions track their separate rate limits. The `@` delimiter never
 * appears in `provider`/`modelClass`; account ids are validated to exclude it.
 */
export function governorKey(provider: TurnProvider, modelClass: string, accountId?: string): string {
  return accountId ? `${provider}:${modelClass}@${accountId}` : `${provider}:${modelClass}`;
}

/** Inverse of `governorKey` — split a bucket key back into its parts. */
export function parseGovernorKey(key: string): { provider: TurnProvider; modelClass: string; accountId?: string } {
  const at = key.indexOf('@');
  const accountId = at >= 0 ? key.slice(at + 1) : undefined;
  const base = at >= 0 ? key.slice(0, at) : key;
  const idx = base.indexOf(':');
  return { provider: base.slice(0, idx) as TurnProvider, modelClass: base.slice(idx + 1), accountId };
}

// --- Pause observability (RB-009) -------------------------------------------------------
// Every governor in the registry routes its onPause through ONE module-level emitter, keyed by
// bucket, so a host (the operator) subscribes once and surfaces "rate-limited — paused until
// <reset>" to coord/telemetry — without the domain-free governor knowing about any of that.
export type GovernorPauseListener = (ev: GovernorPauseEvent & { key: string }) => void;
const pauseListeners = new Set<GovernorPauseListener>();

/** Subscribe to pause transitions across ALL buckets. Returns an unsubscribe fn. */
export function onGovernorPause(cb: GovernorPauseListener): () => void {
  pauseListeners.add(cb);
  return () => pauseListeners.delete(cb);
}

function emitGovernorPause(ev: GovernorPauseEvent & { key: string }): void {
  for (const cb of pauseListeners) {
    try {
      cb(ev);
    } catch {
      /* a listener must never break the limiter */
    }
  }
}

/** The singleton governor for a `(provider, modelClass[, accountId])` bucket (created on first use). */
export function getGovernor(provider: TurnProvider, modelClass: string, deps?: GovernorDeps, accountId?: string): RateLimitGovernor {
  const key = governorKey(provider, modelClass, accountId);
  let g = registry.get(key);
  if (!g) {
    g = new RateLimitGovernor(
      effectiveFloor(provider), // baked DEFAULT_FLOORS + any runtime per-provider override (P-021)
      {
        ...deps,
        // Fleet-wide cap (D-004): share the registry's one global gate unless a test injects its own.
        globalGate: deps?.globalGate ?? globalGate,
        // ALWAYS tag the governor with its bucket key (account-blind `provider:class` vs `@<account>`-keyed)
        // — penalize() scopes the rolling-window false-pause cap to the FLEET-WIDE bucket only (an
        // account-keyed pause is the scale-out exhaustion signal, left uncapped). Needed even with no PG
        // store (in-memory tests), so it can't live behind the `sharedStore` branch below.
        storeKey: deps?.storeKey ?? key,
        // Bind the cross-process store (RB-007) unless the caller injected its own (tests do).
        ...(deps?.store ? {} : sharedStore ? { store: sharedStore } : {}),
        // Pool counters for denial evidence (WI-5391 item 3): the registry is the only layer
        // that can see a bucket's siblings, so it answers "how many `provider:modelClass`
        // buckets exist, and how many are paused right now" — one bucket per account
        // subscription (the account-blind base bucket counts as one). Stamped onto every
        // governor-attested denial so its exclusion from the error rate is retro-auditable.
        poolCounters:
          deps?.poolCounters ??
          (() => {
            const now = Date.now();
            let totalAccounts = 0;
            let pausedAccounts = 0;
            for (const [k, sibling] of registry) {
              const parsed = parseGovernorKey(k);
              if (parsed.provider !== provider || parsed.modelClass !== modelClass) continue;
              totalAccounts += 1;
              if (sibling.state.pausedUntil > now) pausedAccounts += 1;
            }
            return { pausedAccounts, totalAccounts };
          }),
        onPause: (ev) => {
          emitGovernorPause({ ...ev, key });
          deps?.onPause?.(ev);
        },
      },
    );
    registry.set(key, g);
  }
  return g;
}

export interface GovernorSnapshot {
  key: string;
  provider: TurnProvider;
  modelClass: string;
  /** Set when the bucket is scoped to a specific account (P-019); else global. */
  accountId?: string;
  /** Runtime credential fact (D-006): precise apiKey bucket vs coarse subscription. */
  limitModel: LimitModel;
  state: GovernorState;
}

/** Point-in-time snapshot of every live bucket — the headroom + pause status the read tool
    (`dev:rate_governor_status`) surfaces (RB-009). */
export function snapshotGovernors(): GovernorSnapshot[] {
  const out: GovernorSnapshot[] = [];
  for (const [key, g] of registry) {
    const { provider, modelClass, accountId } = parseGovernorKey(key);
    out.push({
      key,
      provider,
      modelClass,
      ...(accountId ? { accountId } : {}),
      limitModel: resolveProviderLimitModel(provider),
      state: g.snapshot(),
    });
  }
  return out;
}

/** Resolve the right shared governor for a backend + model: self-pacing backends (omp)
    collapse to a single concurrency-only bucket; others key by provider+model-class. An
    `accountId` (e.g. a frame's `PAPERCUSP_ACCOUNT_ID`) scopes the bucket to that account
    so its separate subscription tracks its separate rate limits (P-019). */
export function governorForBackend(backend: TurnBackend, model: string, deps?: GovernorDeps, accountId?: string): RateLimitGovernor {
  const p = BACKEND_PROFILES[backend];
  return getGovernor(p.provider, p.selfPacing ? 'self' : modelClassOf(model), deps, accountId);
}

/** Test hook — drop all singletons + reset the fleet-wide in-flight counter (cap is left as set;
    call setGlobalConcurrencyCap(undefined) to also clear the cap). */
export function resetGovernorRegistry(): void {
  registry.clear();
  globalGate.reset();
  // P-021: drop runtime floor overrides + restore the default AIMD curve so a test starts baked.
  for (const k of Object.keys(providerFloorOverrides)) delete providerFloorOverrides[k as TurnProvider];
}
