/**
 * @papercusp/scheduled-registry — a generic, named, listable wrapper over setInterval.
 *
 * The problem (schedule-inventory-and-ephemeral-tier-2026-06-26): raw `setInterval`
 * calls are runtime-INVISIBLE — no registry, no names, no fire history — so "what is
 * running on a timer?" is answerable only by grep. This wraps `setInterval` so every
 * armed timer is REGISTERED with a name + category + last-fire/last-error/armed state,
 * and `listManaged()` returns the whole set. A `lint:no-raw-setinterval` guard (host
 * side) then forbids bare `setInterval`, so nothing escapes the inventory.
 *
 * KEY PRINCIPLE — visibility != control. Registering a timer does NOT centralize its
 * scheduling: a watchdog still runs as its own out-of-band interval; it just becomes
 * LISTABLE. The category records WHY (lifecycle / watchdog / cache stay bespoke;
 * global-sweep / ephemeral-harness are the centrally-driven classes).
 *
 * Pure registry over INJECTED time + timers (configure*() seam): tests pass a fake
 * setInterval/now/shouldShed and drive ticks deterministically; production defaults to
 * the Node globals. Zero domain coupling, zero runtime deps. Two papercusp consumers:
 * the in-process host health sweeps (ex-in-process-periodic) and the ephemeral blueprint
 * cadence tier — both register here rather than each owning a bespoke scheduler (D-006:
 * one in-process mechanism, not three).
 */

import {
  moduleEvaluationCount as pinnedEvaluationCount,
  pinModuleState,
} from '@papercusp/module-singleton';

/** Why a timer exists — drives the inventory's scope/tier and whether it's centrally driven. */
export type ManagedCategory =
  | 'lifecycle' // per-connection/stream/spawn — bespoke, cannot be central
  | 'watchdog' // out-of-band sentinel — bespoke, must survive what it watches
  | 'cache' // per-process memo refresh — bespoke
  | 'global-sweep' // host-wide idempotent sweep — centrally driven (in-process tier)
  | 'ephemeral-harness' // per-harness frequent cadence — centrally driven (ephemeral tier)
  | 'external-process' // a separate process's timer (gateway/launcher/bench)
  | (string & {}); // forward-compat: any host-defined category

/**
 * The push-don't-poll DATA-SOURCE verdict for a timer (D-004,
 * stop-discarded-dedup-and-audit-server-polling-2026-07-26 / P-011) — orthogonal to
 * `ManagedCategory` above (which is about SCHEDULING MECHANISM/ownership, not data source):
 *
 *   - 'must-sample'   — no event source exists to subscribe to (port reachability, PID
 *                        liveness, disk usage, an external HTTP probe). Legitimately a timer.
 *   - 'timeout-reaper' — the passage of time IS the trigger (stale-claim sweep, presence
 *                        reaper, epoch-key reconcile, a deadline check). A timeout
 *                        implemented as a subscription is just a timer with extra steps.
 *   - 'violation'      — recomputes derived state from a store that ALREADY emits change
 *                        events, on a timer, regardless of subscriber presence. The actual
 *                        push-don't-poll sin — convert this to invalidate-on-write instead.
 *
 * OPTIONAL at the type level (a required field would force every one of the ~97 existing
 * `managedSetInterval`/`PeriodicCheck` call sites to be edited in this one change — too large
 * a blast radius for one PR). The real enforcement is `scripts/check-timer-classification.mjs`
 * (lint:timer-classification): a shrink-only BASELINE grandfathers today's unclassified call
 * sites; a NEW site outside the baseline that omits `classification` fails the build. This is
 * the SAME staged-rollout shape as `lint:no-raw-setinterval` (P-007/P-008) — visibility (an
 * optional field + inventory column) becoming enforceable control (a lint gate) without a
 * flag-day rewrite of every existing timer.
 */
export type TimerClassification = 'must-sample' | 'timeout-reaper' | 'violation';

export interface ManagedTimerOptions {
  category: ManagedCategory;
  /** Heavy ticks shed a cycle under load when the injected shouldShed(name) returns true. Light ticks omit it. */
  shed?: boolean;
  /** Also run ONCE immediately on arm (heal-on-startup), not only after the first interval. */
  fireOnArm?: boolean;
  /**
   * Allow MANY live timers under one `name` (per-connection lifecycle timers — a WS/SSE
   * keepalive armed per socket). Without this, re-arming a name stops the previous timer
   * (a collision). With it, each arm coexists under a unique internal key and listManaged()
   * AGGREGATES them into ONE inventory row carrying the live instance count + most-recent
   * fire — so the timer is VISIBLE without per-connection churn.
   */
  instanced?: boolean;
  /** D-004 push-don't-poll classification (P-011) — see `TimerClassification`. Declaring it
   *  makes the timer's data-source verdict VISIBLE in schedule:inventory instead of living
   *  only in a plan/audit document that goes stale; omit only for a call site the shrink-only
   *  lint BASELINE still grandfathers. */
  classification?: TimerClassification;
  /**
   * Permit a real recurring timer to arm under Vitest. Production call sites should omit this:
   * the default timer backend is inert in Vitest so a background callback cannot outlive the
   * module mocks in an unrelated test. Tests that deliberately exercise a real interval may
   * opt in; injected timer backends (the normal deterministic test seam) remain active.
   */
  allowInTest?: boolean;
}

/** The public, listable view of one armed timer. */
export interface ManagedEntry {
  name: string;
  category: ManagedCategory;
  intervalMs: number;
  /** epoch ms when armed. */
  armedAt: number;
  /** epoch ms of the last successful (or attempted) fire, or null if never fired. */
  lastFireAt: number | null;
  /** last tick error message, or null if the last tick succeeded / none yet. */
  lastError: string | null;
  /** true while a tick is in flight (the re-entrancy guard is engaged). */
  running: boolean;
  /** count of fires (including ones that threw). */
  fires: number;
  /** whether this timer participates in load-shedding. */
  shed: boolean;
  /** true for per-connection instanced timers (aggregated by name in listManaged). */
  instanced: boolean;
  /** number of live instances aggregated into this row (1 for a singleton). */
  instances: number;
  /** D-004 push-don't-poll classification (P-011), or null when the call site hasn't
   *  declared one yet (grandfathered by the shrink-only lint BASELINE). */
  classification: TimerClassification | null;
}

export interface ManagedHandle {
  /** Clear the timer and deregister it from the inventory. Idempotent. */
  stop(): void;
}

/** A minimal timer handle — the Node Timeout's `.unref()` is honored when present. */
export interface TimerHandle {
  unref?: () => void;
}

export type SetIntervalImpl = (cb: () => void, ms: number) => TimerHandle;
export type SetTimeoutImpl = (cb: () => void, ms: number) => TimerHandle;
export type ClearTimerImpl = (h: TimerHandle) => void;

/**
 * Are Vitest's fake timers currently installed?
 *
 * `vi.useFakeTimers()` delegates to @sinonjs/fake-timers, which REPLACES the global timer
 * functions and stamps each installed function with a back-reference to its clock
 * (`target[method].clock = clock` — fake-timers-src.js). That property is absent on the native
 * function and on a plain `vi.spyOn(globalThis, 'setInterval')` wrapper, so its presence is a
 * precise "a fake clock owns this timer" signal rather than a general "we are under test" one.
 *
 * This matters because `defaultSetIntervalImpl` resolves `setInterval` at CALL time: with fake
 * timers installed the default backend is already driven by the fake clock, so an armed callback
 * is deterministic and is torn down with the clock. It cannot outlive the test and reach another
 * test's factory mocks — which is the only hazard the Vitest inertness guard exists to prevent.
 */
function timersAreFaked(): boolean {
  return (globalThis.setInterval as unknown as { clock?: unknown } | undefined)?.clock !== undefined;
}

/**
 * True only INSIDE a Vitest worker, where test files and their factory mocks load.
 *
 * `process.env.VITEST` alone does not answer that. An environment variable is inherited by
 * every child process a test spawns (`spawn` copies `process.env` by default), so a real
 * standalone child, such as a perf peer booting the substrate, also reads `VITEST=true`. It
 * has no test files and no mocks, and needs its production intervals. When the guard keyed on
 * the env var alone, such a child's `hyperbee-merge-poll` never armed: its reader never
 * merged past the first pass, and `substrate-compaction.integration.test.ts` hung to its 600s
 * timeout on every run from 2026-08-23 (WI-10002781).
 *
 * Vitest installs its per-process worker state on `globalThis.__vitest_worker__`
 * (`getWorkerState()` reads it). A global is not inherited across `spawn`, so it marks the
 * worker process precisely. The env var is still required, so a stray global outside Vitest
 * never disarms anything.
 */
function inVitestWorker(): boolean {
  return (
    Boolean(process.env.VITEST) &&
    (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== undefined
  );
}

const defaultSetIntervalImpl: SetIntervalImpl = (cb, ms) => setInterval(cb, ms) as unknown as TimerHandle;
const defaultClearIntervalImpl: ClearTimerImpl = (h) => clearInterval(h as unknown as ReturnType<typeof setInterval>);
const defaultSetTimeoutImpl: SetTimeoutImpl = (cb, ms) => setTimeout(cb, ms) as unknown as TimerHandle;

export interface ScheduledRegistryConfig {
  setIntervalImpl?: SetIntervalImpl;
  clearIntervalImpl?: ClearTimerImpl;
  setTimeoutImpl?: SetTimeoutImpl;
  /** epoch-ms clock; defaults to Date.now. */
  now?: () => number;
  /** category-aware shed gate for `shed: true` timers; defaults to never-shed. */
  shouldShed?: (name: string) => boolean;
  log?: (msg: string) => void;
}

type ResolvedConfig = Required<ScheduledRegistryConfig>;

function defaults(): ResolvedConfig {
  return {
    setIntervalImpl: defaultSetIntervalImpl,
    clearIntervalImpl: defaultClearIntervalImpl,
    setTimeoutImpl: defaultSetTimeoutImpl,
    now: () => Date.now(),
    shouldShed: () => false,
    log: (m) => console.warn(`[scheduled-registry] ${m}`),
  };
}

interface InternalRecord {
  entry: ManagedEntry;
  /** unique registry key (== name for singletons; `name#N` for instanced timers). */
  key: string;
  timer: TimerHandle;
  running: boolean;
  stopped: boolean;
}

/**
 * Mutable state, PINNED TO globalThis rather than held in module scope.
 *
 * Why (EI-19451658870832332, measured live on bg-host 2026-08-03): this module can be
 * instantiated TWICE inside ONE process. The host entry runs under tsx (a CJS preflight
 * alongside an ESM loader), importers reach this package through both bare-specifier and
 * relative paths, and `node_modules/@papercusp/*` are symlinks into the repo. Any one of
 * those seams yields two module records — and module-scoped state then splits into two
 * DISJOINT inventories.
 *
 * The resulting failure is silent and expensive: a timer armed through instance A is absent
 * from `listManaged()` served by instance B, so `/api/internal/managed-timers` — and
 * `schedule:inventory` above it — reports a RUNNING timer as missing. Measured: the
 * dbos-executor-reaper reaped workflows every 2 minutes inside bg-host while absent from
 * that same process's own inventory, which read as "the reaper is dark" and cost hours of
 * investigation across several sessions. Absence from an inventory is evidence only when
 * there is exactly ONE inventory.
 *
 * A global-symbol key fixes the whole class without depending on WHICH seam duplicated the
 * module: it is correct under dual-package, symlink, CJS/ESM-split and bundled-copy alike.
 * `Symbol.for` is deliberate — it is the cross-realm symbol registry, so a second instance
 * resolves the SAME key instead of minting a fresh one.
 */
interface RegistryState {
  registry: Map<string, InternalRecord>;
  instanceCounter: number;
  resolved: ResolvedConfig;
}

/**
 * The pin key. Also the id this module reports under in
 * `listModuleDuplications()`, so a split here is visible in the REALM-WIDE
 * duplication report rather than only through this module's own accessor.
 */
const STATE_KEY = '@papercusp/scheduled-registry.state';

/**
 * Pinned + counted by `@papercusp/module-singleton` rather than hand-rolled here.
 *
 * This module was the FIRST subject of the split (EI-19451658870832332) and its
 * fix was written inline, before the primitive existed. Keeping that copy would
 * have been the more expensive kind of duplication: `listModuleDuplications()`
 * only knows about keys pinned THROUGH the primitive, so the one module known to
 * split in production would have been the one module missing from the central
 * report — the same "the detector cannot see its subject" shape as the original
 * bug (EI-19463700807328229).
 *
 * Calling `pinModuleState` at module scope is what makes the count a count of
 * module RECORDS: it must run exactly once per evaluation of this body, so it
 * must never be moved inside a function.
 */
const state: RegistryState = pinModuleState<RegistryState>(STATE_KEY, () => ({
  registry: new Map<string, InternalRecord>(),
  instanceCounter: 0,
  resolved: defaults(),
}));

/**
 * The one shared inventory. Safe to alias into module scope because the Map IDENTITY never
 * changes — every instance binds the same object. `resolved` and `instanceCounter` are
 * reassigned, so those are always read through `state` and must never be aliased this way.
 */
const registry = state.registry;

/**
 * Override the injected seams (timer fns, clock, shed gate, logger). Partial merge —
 * unspecified fields keep their current value. Call once at host boot (e.g. to wire the
 * host's tick-load-shed into `shouldShed`); tests call it to inject a controllable timer.
 */
export function configureScheduledRegistry(config: ScheduledRegistryConfig): void {
  state.resolved = { ...state.resolved, ...stripUndefined(config) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}

function makeTick(name: string, fn: () => void | Promise<void>, opts: ManagedTimerOptions, rec: InternalRecord): () => void {
  // Record a fire. fires + lastFireAt count every ATTEMPT (including throws); only lastError differs.
  const settle = (err?: unknown): void => {
    if (err === undefined) {
      rec.entry.lastError = null;
    } else {
      rec.entry.lastError = err instanceof Error ? err.message : String(err);
      state.resolved.log(`${name} tick failed (next interval retries): ${rec.entry.lastError}`);
    }
    rec.entry.lastFireAt = state.resolved.now();
    rec.entry.fires += 1;
    rec.running = false;
    rec.entry.running = false;
  };
  return () => {
    if (rec.stopped) return;
    if (rec.running) return; // re-entrancy guard — a slow tick never piles up a second run
    if (opts.shed && state.resolved.shouldShed(name)) return; // shed this cycle under load
    rec.running = true;
    rec.entry.running = true;
    // Run a SYNCHRONOUS tick synchronously — this preserves the bare-setInterval timing
    // semantics (a sync watchdog tick must complete in THIS turn, not a deferred microtask);
    // only a genuinely-async tick (returns a thenable) is awaited, so the re-entrancy guard
    // still holds across a slow async run.
    let result: void | Promise<void>;
    try {
      result = fn();
    } catch (e) {
      settle(e);
      return;
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      void Promise.resolve(result).then(
        () => settle(undefined),
        (e: unknown) => settle(e),
      );
    } else {
      settle(undefined);
    }
  };
}

/**
 * Arm a NAMED, listable interval. Returns a handle whose stop() clears + deregisters it.
 * Re-arming an existing name stops the previous timer first (no duplicate names, no leak).
 * The timer is unref'd so it never holds the process open.
 */
export function managedSetInterval(
  name: string,
  intervalMs: number,
  fn: () => void | Promise<void>,
  opts: ManagedTimerOptions,
): ManagedHandle {
  const instanced = opts.instanced ?? false;
  // A production module can arm a process-wide interval while a Vitest worker is loading a
  // test. If that interval fires after the worker has installed a factory mock, its callback
  // observes a partial module and turns an otherwise passing run into an unhandled rejection.
  // Keep the real backend inert under Vitest by default. Deterministic injected timer seams
  // still run, and a test that explicitly exercises a real interval can opt in.
  //
  // "Deterministic seam" means BOTH an injected setIntervalImpl AND `vi.useFakeTimers()` — see
  // timersAreFaked(). Treating only the injected case as deterministic silently disarms every
  // fake-timer test over a managedSetInterval call site (WI-40841).
  //
  // "Under Vitest" means inside a Vitest WORKER, not "VITEST is in the env": a child process a
  // test spawns inherits the env var but is a real process that needs real intervals
  // (WI-10002781). See inVitestWorker().
  if (
    inVitestWorker() &&
    !opts.allowInTest &&
    state.resolved.setIntervalImpl === defaultSetIntervalImpl &&
    !timersAreFaked()
  ) {
    if (!instanced) stopManaged(name);
    return { stop: () => undefined };
  }
  // Singletons key by name (re-arming replaces); instanced timers get a unique key so many
  // coexist under one display name (aggregated in listManaged).
  const key = instanced ? `${name}#${(state.instanceCounter += 1)}` : name;
  if (!instanced && registry.has(key)) {
    // Idempotent re-arm: silently stop the previous timer and register fresh. No warn —
    // host watchdogs re-arm across boot retries / test cases, and the inventory always
    // reflects the single latest registration. (A genuine name COLLISION is a code-review
    // concern surfaced by two distinct sites sharing a name, not a runtime warning.)
    stopManaged(key);
  }
  const entry: ManagedEntry = {
    name,
    category: opts.category,
    intervalMs,
    armedAt: state.resolved.now(),
    lastFireAt: null,
    lastError: null,
    running: false,
    fires: 0,
    shed: opts.shed ?? false,
    instanced,
    instances: 1,
    classification: opts.classification ?? null,
  };
  const rec: InternalRecord = { entry, key, timer: { unref: undefined }, running: false, stopped: false };
  const tick = makeTick(name, fn, opts, rec);
  rec.timer = state.resolved.setIntervalImpl(tick, intervalMs);
  rec.timer.unref?.();
  if (opts.fireOnArm) {
    const t = state.resolved.setTimeoutImpl(tick, 0);
    t.unref?.();
  }
  registry.set(key, rec);
  return { stop: () => stopManaged(key) };
}

/** Stop + deregister one timer by name. Returns whether it existed. Idempotent. */
export function stopManaged(name: string): boolean {
  const rec = registry.get(name);
  if (!rec) return false;
  rec.stopped = true;
  state.resolved.clearIntervalImpl(rec.timer);
  registry.delete(name);
  return true;
}

/**
 * The whole inventory of armed timers, sorted by name. Singletons appear one-per-name;
 * instanced timers are AGGREGATED into ONE row per name (instances = live count,
 * lastFireAt = most-recent across instances, fires = sum). Snapshot copies (mutation-safe).
 */
export function listManaged(): ManagedEntry[] {
  const singletons: ManagedEntry[] = [];
  const grouped = new Map<string, ManagedEntry>();
  for (const r of registry.values()) {
    if (!r.entry.instanced) {
      singletons.push({ ...r.entry });
      continue;
    }
    const g = grouped.get(r.entry.name);
    if (!g) {
      grouped.set(r.entry.name, { ...r.entry });
    } else {
      g.instances += 1;
      g.fires += r.entry.fires;
      g.armedAt = Math.min(g.armedAt, r.entry.armedAt);
      if (r.entry.lastFireAt != null) g.lastFireAt = Math.max(g.lastFireAt ?? 0, r.entry.lastFireAt);
      if (r.entry.lastError) g.lastError = r.entry.lastError;
      g.running = g.running || r.entry.running;
      if (g.classification == null && r.entry.classification != null) g.classification = r.entry.classification;
    }
  }
  return [...singletons, ...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One timer's current entry (singleton) or the aggregated row (instanced base name), or undefined. */
export function getManaged(name: string): ManagedEntry | undefined {
  const direct = registry.get(name);
  if (direct && !direct.entry.instanced) return { ...direct.entry };
  // instanced base name (keys are name#N) → return the aggregated row.
  return listManaged().find((e) => e.name === name);
}

/** Count of currently-armed timers (raw instances, NOT aggregated rows). */
export function managedCount(): number {
  return registry.size;
}

/**
 * How many times this module's body was evaluated in this process.
 *
 * `1` is healthy. `> 1` means the module is DUPLICATED — the state is still
 * shared (pinned), so the inventory is correct, but a duplicate module record is
 * a packaging fault that will silently split any NEW module-scoped state added
 * here later. `0` is impossible from a caller that imported this module.
 */
export function moduleEvaluationCount(): number {
  return pinnedEvaluationCount(STATE_KEY);
}

/**
 * Standing recurrence guard for EI-19451658870832332 — the split that made an
 * armed, firing timer absent from its own process's inventory for 6+ days.
 *
 * Returns `null` when healthy, or a ready-to-log warning when this module has
 * been evaluated more than once. Surfaces embed this beside the timer list so
 * the inventory reports its OWN trustworthiness: the failure mode was an
 * inventory that looked complete while being half of one, and the reader had no
 * way to tell. This is deliberately a property OF the inventory rather than a
 * separate health check, because a separate check is exactly what nobody ran.
 */
export function moduleDuplicationWarning(): string | null {
  const n = pinnedEvaluationCount(STATE_KEY);
  if (n <= 1) return null;
  return (
    `SPLIT MODULE SINGLETON: @papercusp/scheduled-registry was evaluated ${n}x in this process. ` +
    `State is pinned so this inventory is still complete, but a duplicate module record is a ` +
    `packaging fault (CJS/ESM double-load, a bare-vs-relative import of the same file, or a ` +
    `symlinked node_modules copy). Any NEW module-scoped state added to this file will split.`
  );
}

/** Stop ALL timers (graceful shutdown / test teardown). */
export function stopAllManaged(): void {
  for (const name of [...registry.keys()]) stopManaged(name);
}

/** Reset the registry AND restore default seams — for test isolation. */
export function resetScheduledRegistry(): void {
  stopAllManaged();
  state.resolved = defaults();
}
