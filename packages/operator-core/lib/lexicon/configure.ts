/**
 * Server-side wiring for `@papercusp/lexicon` — the twin of operator-vite's
 * `useLexicon()` hook.
 *
 * The lexicon lib is brand-neutral and pack-agnostic; the one host-specific
 * bit is "which brand pack is active right now", which here = the `the-hive`
 * feature flag. The ambient `term()` resolver must be SYNC, so we keep a
 * process-cached pack id (the branding flag is machine-global — see
 * flag-distinct-id) refreshed on first read + every flag change.
 *
 * ⚠ IMPORTING THIS MODULE MUST NOT TOUCH A FLAG BINDING (WI-6650). It used to do
 * so twice at module scope — an eager `void refreshLexiconPack()` whose body
 * reaches `getFlag`, and a bare `onFlagChange(...)` — which made every file whose
 * import graph reached here (via flag-bus.ts) uncollectable under a PARTIAL
 * `vi.mock('@papercusp/flags/server')`. Both are now behind the lazy arm below.
 * See lazy-flag-refresh.ts for the mechanism and why defensive module-scope forms
 * (`onFlagChange?.()`, `typeof`, try/catch, `import * as ns`) do NOT work.
 *
 * Loaded for side effect by flag-bus.ts, which is still the right place for it:
 * the side effect that matters is `configureLexicon(...)` wiring the sync seam so
 * `term()` is answerable from the first call. The flag subscription is no longer
 * part of that import — it arms on the first read instead.
 * Server code that emits user-facing strings resolves via `term()` (re-exported
 * from this directory's index, or imported from `@papercusp/lexicon` directly —
 * either works once this module has loaded).
 */
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { type BrandPackId, configureLexicon } from '@papercusp/lexicon';

import { systemDistinctId } from '../flag-distinct-id';
import { lazyFlagRefresh } from '../lazy-flag-refresh';

let cachedPackId: BrandPackId = 'classic';
/**
 * Has a real flag read ever landed in this process? Gates the seed — see the arm
 * site below for why a seed must not overwrite an already-resolved cache.
 */
let packIdResolved = false;

/** Re-read the the-hive flag and update the cached active pack id. */
export async function refreshLexiconPack(): Promise<BrandPackId> {
  try {
    const on = await getFlag(FLAGS.THE_HIVE, systemDistinctId());
    cachedPackId = on ? 'the-hive' : 'classic';
  } catch {
    cachedPackId = 'classic';
  }
  // Set in BOTH branches: the catch is a resolved read that fell back, not an
  // unpopulated cache, and re-seeding over it would discard that decision.
  packIdResolved = true;
  return cachedPackId;
}

/**
 * Adapter, not a direct pass: `lazyFlagRefresh` takes `() => void | Promise<void>` and DISCARDS
 * the result (`void Promise.resolve(refresh())`), while `refreshLexiconPack` is exported API that
 * RESOLVES TO the new pack id — its callers assert on that value. Widening the helper's parameter
 * to accommodate this one caller would erase the signal the other eleven call sites rely on: that
 * their return value is thrown away. Awaiting here keeps the kick's timing identical to passing
 * the function directly. This is a definition, not a module-scope call — nothing runs until armed.
 */
const refreshLexiconPackVoid = async (): Promise<void> => {
  await refreshLexiconPack();
};

/**
 * Arms the flag subscription on first read (WI-6650).
 *
 * `activeServerPackId()` is the SOLE arm site and that is deliberate: the
 * `configureLexicon` seam at the bottom of this file is pointed at that same
 * function rather than at a `() => cachedPackId` closure, so `term()` — the hot
 * reader, which calls `host.activePackId()` live on every single call
 * (libs/generic/lexicon/src/config.ts) — arms through it too. Wiring the seam to
 * a raw closure over `cachedPackId` would leave the real read path unarmed while
 * LOOKING migrated, which is the hidden-reader shape that keeps
 * auth-config-overrides.ts on this guard's BASELINE. ⚠ Any NEW sync reader of
 * `cachedPackId` must arm as well, or be routed through this getter.
 *
 * Read-site displacement (the second axis in lazy-flag-refresh.ts): the flag read
 * moves from boot to the first `term()`/`activeServerPackId()` call. Safe here —
 * it is a `getFlag(THE_HIVE, systemDistinctId())` under the SYSTEM distinct id
 * that selects a string pack and produces no authorization verdict, so no caller
 * is disallowed from causing it.
 */
const armLexiconFlagRefresh = lazyFlagRefresh(refreshLexiconPackVoid, {
  keys: [FLAGS.THE_HIVE],
  // Seed from the flag REGISTRY, not the `'classic'` literal this cache was
  // initialised with, so the pre-refresh window cannot drift if THE_HIVE ever
  // graduates out of DARK_FLAGS. The deref is LAZY (inside this callback), the
  // form check-no-module-scope-flag-subscribe.mjs documents as correct.
  //
  // The guard is part of the seed's meaning, not a workaround: a seed exists to
  // fill a cache that has NEVER been populated. `refreshLexiconPack` is exported
  // and callable directly, so without this check an arm that happens AFTER an
  // explicit refresh would reset a correct value back to the flag default.
  seed: () => {
    if (packIdResolved) return;
    cachedPackId = FLAG_DEFAULTS[FLAGS.THE_HIVE] ? 'the-hive' : 'classic';
  },
  unpopulated: {
    kind: 'seeded-from-flag-default',
    serves:
      "FLAG_DEFAULTS[THE_HIVE] — currently false (THE_HIVE is in DARK_FLAGS, case 'parked': " +
      'the-hive-lexicon is cut from public V1 and reachable only via the TESTING-gated ' +
      'BrandSwitcher), so the seed resolves to the `classic` pack. That is the public default ' +
      'and is byte-identical to the literal this cache was initialised with before the ' +
      'migration, so the pre-refresh window serves exactly what it served before. It diverges ' +
      'only where a runtime OVERRIDE turns the-hive ON, and self-heals within one getFlag ' +
      'round-trip; the cost of that window is brand STRINGS resolving to the classic pack for ' +
      'one round-trip, never a wrong value or a dead code path.',
  },
});

/** The cached active pack id (sync). Arms the refresh subscription on first use. */
export function activeServerPackId(): BrandPackId {
  armLexiconFlagRefresh();
  return cachedPackId;
}

// Wire the seam synchronously so `term()` is correct from the first call. It is
// pointed at the ARMED getter (not a raw `() => cachedPackId` closure) so that
// `term()` arms the refresh too — see armLexiconFlagRefresh above.
configureLexicon({ activePackId: activeServerPackId });
