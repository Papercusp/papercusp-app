/**
 * @papercusp/module-singleton — pin a module's mutable state to the realm, and
 * COUNT how many times the module body was evaluated.
 *
 * ## The hazard
 *
 * A module that holds mutable state in module scope:
 *
 *     const registry = new Map();   // module-scoped
 *
 * is a singleton only as long as the loader produces exactly ONE module record
 * for it. Several ordinary seams break that assumption without any error:
 *
 *   - a tsx/ts-node CJS preflight alongside the ESM loader (two module systems),
 *   - the same package reached through both a bare specifier
 *     (`@scope/pkg`) and a relative path (`../pkg/src/index.ts`),
 *   - `node_modules/@scope/*` symlinked into a monorepo (two real paths),
 *   - a bundled copy living beside the source copy.
 *
 * When it splits, each module record gets its OWN `registry`, and writes to one
 * are invisible to readers of the other. Nothing throws. The symptom is a
 * *partial* view that looks like a complete one.
 *
 * ## Why counting matters as much as pinning
 *
 * Pinning the state to `globalThis` under a `Symbol.for` key fixes correctness —
 * both module records then share one object. But it also makes the duplication
 * INVISIBLE: once the state is shared, nothing distinguishes one module record
 * from two, so the underlying packaging fault is never noticed or fixed.
 *
 * This module therefore does both in one call. `pinModuleState` returns the
 * shared state (correctness) and increments an evaluation counter
 * (observability). `listModuleDuplications()` reports every key whose module body
 * ran more than once, so a split singleton can be surfaced by a health check
 * instead of being discovered days later from a contradictory reading.
 *
 * Observed live: `@papercusp/scheduled-registry` was evaluated twice inside one
 * process. A timer armed against instance A fired every 2 minutes while being
 * absent from the inventory served by instance B — in the same pid. It went
 * unnoticed for 6+ days because the surface meant to report the timers was the
 * surface that had gone blind (EI-19451658870832332 / EI-19463700807328229).
 *
 * ## Contract — call it ONCE, at module scope
 *
 *     const state = pinModuleState('@scope/pkg.state', () => ({ registry: new Map() }));
 *
 * `evaluations` counts CALLS, so this is only a module-record count when the call
 * happens exactly once per module evaluation. Calling it from a function that
 * runs repeatedly makes the count meaningless. `init` runs at most once per
 * realm; later evaluations receive the state the first one built.
 *
 * This module deliberately holds NO module-scoped state of its own — every read
 * goes through `globalThis` — so the detector cannot split the way its subjects
 * can.
 */

/** A key whose module body was evaluated more than once in this realm. */
export interface ModuleDuplication {
  /** The key passed to `pinModuleState`. */
  key: string;
  /** How many times `pinModuleState` was called for this key (>= 2 to be a duplication). */
  evaluations: number;
  /** Epoch ms when the first evaluation pinned the state. */
  firstSeenAt: number;
  /** Epoch ms of the most recent evaluation. */
  lastSeenAt: number;
}

interface Slot {
  value: unknown;
  evaluations: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/**
 * `Symbol.for` is the cross-realm symbol registry: a second module record
 * resolves the SAME symbol, which is exactly the property that lets two module
 * records find one store. A plain `Symbol()` would mint a distinct key per
 * evaluation and silently reintroduce the split this module exists to close.
 */
const SLOTS_KEY = Symbol.for('@papercusp/module-singleton.slots');

function slots(): Map<string, Slot> {
  const store = globalThis as unknown as Record<symbol, Map<string, Slot> | undefined>;
  let map = store[SLOTS_KEY];
  if (!map) {
    map = new Map<string, Slot>();
    store[SLOTS_KEY] = map;
  }
  return map;
}

/**
 * Pin a module's mutable state to the realm and record this evaluation.
 *
 * Returns the SAME object for every module record that uses `key`, so
 * module-scoped state stops being per-module-record. Call once, at module scope.
 *
 * @param key    A stable, globally unique id — use the package name plus a
 *               suffix, e.g. `'@papercusp/scheduled-registry.state'`. Two
 *               unrelated modules sharing a key would share state, so the
 *               package name is not optional decoration.
 * @param init   Builds the initial state. Runs at most once per realm.
 */
export function pinModuleState<T>(key: string, init: () => T): T {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('pinModuleState: key must be a non-empty string');
  }
  const map = slots();
  const now = Date.now();
  const existing = map.get(key);
  if (existing) {
    existing.evaluations += 1;
    existing.lastSeenAt = now;
    return existing.value as T;
  }
  const value = init();
  map.set(key, { value, evaluations: 1, firstSeenAt: now, lastSeenAt: now });
  return value;
}

/**
 * How many times `pinModuleState` ran for `key` in this realm.
 *
 * `0` means the module was never evaluated — which is NOT the same as "evaluated
 * once". A caller reporting on a module it expects to be loaded should treat `0`
 * as "not loaded / not observable", never as a healthy singleton.
 */
export function moduleEvaluationCount(key: string): number {
  return slots().get(key)?.evaluations ?? 0;
}

/**
 * Every key whose module body was evaluated more than once — i.e. every split
 * singleton in this realm. An empty array means no duplication was observed
 * AMONG KEYS THAT USE THIS MODULE; it says nothing about modules that pin their
 * state by hand.
 *
 * Sorted by `evaluations` descending, then `key`, so the report is stable.
 */
export function listModuleDuplications(): ModuleDuplication[] {
  const out: ModuleDuplication[] = [];
  for (const [key, slot] of slots()) {
    if (slot.evaluations > 1) {
      out.push({
        key,
        evaluations: slot.evaluations,
        firstSeenAt: slot.firstSeenAt,
        lastSeenAt: slot.lastSeenAt,
      });
    }
  }
  out.sort((a, b) => b.evaluations - a.evaluations || a.key.localeCompare(b.key));
  return out;
}

/** Every pinned key in this realm, duplicated or not. Diagnostics only. */
export function listPinnedModuleKeys(): string[] {
  return [...slots().keys()].sort();
}

/**
 * Render a one-line human warning per duplication, or `[]` when clean.
 *
 * Kept here so every surface that reports duplication says the same thing —
 * including that a duplication is a PACKAGING fault, not a runtime error to
 * retry.
 */
export function formatModuleDuplicationWarnings(
  duplications: ModuleDuplication[] = listModuleDuplications(),
): string[] {
  return duplications.map(
    (d) =>
      `SPLIT MODULE SINGLETON: '${d.key}' was evaluated ${d.evaluations}x in this process. ` +
      `State is shared (pinned), so behavior is correct, but the duplicate module record is a ` +
      `packaging fault — check for a bare-vs-relative import of the same file, a symlinked ` +
      `node_modules copy, or a CJS/ESM double-load.`,
  );
}

/**
 * Drop all pinned state in this realm. TEST-ONLY.
 *
 * Production code must never call this: it detaches live state from every module
 * record already holding a reference, which is the very split this module exists
 * to prevent.
 */
export function resetPinnedModuleStateForTest(): void {
  slots().clear();
}
