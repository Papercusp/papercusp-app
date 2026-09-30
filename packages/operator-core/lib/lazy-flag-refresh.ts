/**
 * lazy-flag-refresh — the ONE canonical way to keep a module-level config cache fresh from the flag
 * bus WITHOUT touching a flag binding at import (EI-19416650993725684, residual of WI-6650).
 *
 * ## The trap this exists to close
 *
 * A module that READS a `@papercusp/flags/server` binding at module scope becomes unimportable under
 * a PARTIAL vitest mock of that surface:
 *
 *   vi.mock('@papercusp/flags/server', () => ({ getFlag }));   // narrow mock, for the test's own needs
 *   → Error: [vitest] No "onFlagChange" export is defined on the "@papercusp/flags/server" mock.
 *
 * Vitest's mocked-module proxy throws on binding ACCESS, not on invocation, so the throw lands at
 * COLLECTION time and kills the WHOLE test file (zero tests run). Worse, the error names the MOCK,
 * not the importer — so it reads as unrelated to whoever's change actually grew the import edge, and
 * it reds the fleet's green gate rather than one suite. The reach is arbitrary: any test whose
 * transitive import graph touches such a module inherits the landmine.
 *
 * ⚠ MEASURED, do not "simplify" a caller back to a defensive module-scope form: they do NOT work,
 * because they are all still binding ACCESSES — `onFlagChange?.(...)`, `typeof onFlagChange`,
 * try/catch around the call, and `import * as ns` + `ns.onFlagChange?.()` throw identically. Moving
 * the access inside a function body is the only fix that keeps the import pure.
 *
 * ⚠ AND THIS HELPER MUST NOT MOVE INTO `@papercusp/flags/server`. It looks like it belongs there,
 * and putting it there silently re-creates the bug with a new name: a caller's module-scope
 * `lazyFlagRefresh(...)` would then be a binding access on that same mocked surface, so a partial
 * mock would need to stub `lazyFlagRefresh` instead of `onFlagChange`. The helper only works because
 * it lives on the far side of a DIFFERENT module specifier.
 *
 * ## Usage
 *
 *   const armFlagRefresh = lazyFlagRefresh(refreshMyConfig, {
 *     keys: [FLAGS.MY_FLAG],
 *     unpopulated: {
 *       kind: 'gates-an-override-store',
 *       serves: 'MY_BAKED_DEFAULTS — what production runs whenever no override is stored',
 *     },
 *   });
 *
 *   export function myConfigNow(): MyConfig {   // every SYNC reader arms
 *     armFlagRefresh();
 *     return cached;
 *   }
 *
 * The `unpopulated` declaration is REQUIRED and is the whole point of the second argument — see
 * "The one behaviour this DOES change" below before choosing a `kind`.
 *
 * The `lazyFlagRefresh(...)` call itself is PURE — it closes over the callback and touches no flag
 * binding — so the module stays importable under any mock. The real subscription is installed by
 * whichever reader runs first.
 *
 * ## Why arming from READERS is sufficient (and why refresh functions should NOT arm)
 *
 * The subscription exists solely to keep a cache fresh FOR ITS READERS. A process where no reader
 * ever runs has nothing to keep fresh, so never arming there is correct, not a gap. Callers in this
 * codebase also pair the subscription with a ~60s `managedSetInterval` refresh and a same-process
 * write path; the subscription is an IMMEDIACY optimisation layered on those, never the only route
 * to a fresh value. That is what bounds the blast radius of a missed arm point to one refresh
 * interval instead of "stale forever".
 *
 * Do not also arm from the refresh function itself: it makes the first timer tick re-enter this
 * helper and kick a redundant concurrent refresh, for a guarantee that buys nothing (see above).
 *
 * ## The one behaviour this DOES change — know it before migrating a caller
 *
 * A module-scope subscription got its first population from the boot flag-reload, on the bus's
 * schedule and independent of readers. Lazy arming moves that to the FIRST READER CALL — and because
 * the refresh is async while the reader is sync, THAT FIRST CALL STILL SEES THE PRE-REFRESH VALUE.
 * Where the boot reload had already fired before the first read, this widens that window by one
 * refresh round-trip.
 *
 * ⚠ THIS IS THE ONE PROPERTY NO ROUTINE SIGNAL MEASURES. The source lint, the partial-mock
 * importability test, `tsc` and the unit suites all check IMPORTABILITY and TYPES — they emit an
 * identical green for a safe migration and an unsafe one. So the safety of the pre-refresh window is
 * decided entirely by a judgement the author has to make deliberately, which is why the
 * `unpopulated` declaration below is a REQUIRED argument rather than a doc paragraph. (A doc
 * paragraph was tried first and demonstrably failed: EI-19448574704459898 records an agent reading
 * this very section and still migrating `issues-engineer.ts`, all-green, onto a dead data partition.)
 *
 * ### The discriminator: does the flag gate an OVERRIDE STORE, or SELECT A BEHAVIOUR?
 *
 * "Is the flag default-ON?" is NOT the test — measured 2026-08-03, 4 of the 7 callers here are gated
 * on default-ON flags and all 4 are safe. The test is what the unpopulated value POINTS AT:
 *
 * - **Gates an override store** (`telemetry-buffer-config`, `capability-tier-overrides`,
 *   `capability-envelope-overrides`) — the flag decides only whether a STORED OVERRIDE is honoured,
 *   so unpopulated serves the baked constants, which is what production runs whenever no override is
 *   set (the normal case). Safe by construction, default-ON or not. Do NOT seed these: the cached
 *   value is an object read from PG, not a mirror of the flag.
 * - **Selects a behaviour** — the flag chooses between two substantive behaviours, so the window
 *   genuinely serves the OTHER one. Safe only if that is a self-healing DEGRADATION (a skipped cache
 *   bump, a claim without its lease) rather than a WRONG ANSWER. Justify it in `safeBecause`.
 * - **Seeded from the flag default** (`work-item-redundancy`, `work-item-claim-lease-wiring`,
 *   `events/cache-eca-rule`, `issues-engineer`) — the STRONGEST kind and the one to prefer whenever
 *   the cached value is a plain mirror of a flag. Pass a `seed` and the divergence disappears
 *   instead of needing a justification. As of 2026-08-03 every behaviour-selector here has been
 *   converted, which is why the list above is empty: when a caller looks like it selects a
 *   behaviour, the question to ask first is why it cannot simply be seeded.
 *
 * The unsafe shape is a behaviour-selector whose off-branch points at something DEAD or WRONG rather
 * than merely reduced. `issues-engineer.ts` was the worked example: UNSEEDED it resolved `false` →
 * the legacy `'default'` coord workspace, a partition taking no writes while every live row sits
 * elsewhere — a hard, deterministic zero on the first read per process, not a degradation. It was
 * migrated, measured all-green, and correctly REVERTED (EI-19448574704459898). It is now migrated
 * and KEPT, because the `seed` puts `FLAG_DEFAULTS[ISSUES_PER_WORKSPACE]` (true → the active
 * workspace) in front of that first read, which is what every live-writing process resolves anyway.
 * Read that as the general lesson: a caller blocked on an unsafe unpopulated VALUE is usually one
 * `seed` away, not one boot-warm away.
 *
 * ### The SECOND axis: read-site displacement (the value is not the only thing that moves)
 *
 * Everything above is about WHAT VALUE the window serves. That is necessary and NOT sufficient:
 * lazy arming also moves WHERE THE FLAG READ HAPPENS — from a boot-time subscription to the first
 * reader call — and a flag read has observable effects beyond the value it returns. Ask separately:
 * is every code path that can reach a reader allowed to perform a flag read AT ALL?
 *
 * Measured 2026-08-03 (EI-19448574704459898), found by a peer running the gate's break set: the
 * `capability-envelope-overrides` migration turned `projected-tool-deps.test.ts:71` red — an EXEMPT
 * superuser caller now caused `getFlag(CAPABILITY_ENVELOPE_OVERRIDES, systemDistinctId())`, because
 * `checkCapabilityEnvelopeImpl` calls the two sync getters at the TOP of the function, BEFORE its
 * `if (!decision.applied) return null` early-out. The VALUE was flawless (an empty override map, a
 * flag that is default-OFF and dark — the safest cell in the whole table above); the READ SITE was
 * the regression. A value-only audit — which is exactly what this header contained until that red —
 * marks that caller "safe by construction" and misses it completely.
 *
 * In that specific case the invariant survived on the merits (a different flag, read under the SYSTEM
 * distinctId rather than the caller's, producing no verdict and no gating), so the over-broad
 * assertion was narrowed rather than the code changed. Do not read that outcome as "read-site
 * displacement is benign" — it is the question, not the answer, and it happened to resolve well once.
 *
 * ⚠ There is NO "warm it on a boot path" escape hatch, despite what this file used to claim. It
 * pointed at `task-manager/enabled.ts`'s `warmTaskManagerFlag()` as the pattern to copy —
 * that function has ZERO production call sites (verified 2026-08-03: only its own definition, its
 * post-flip re-warm, and its test). `task-manager` is safe because its unpopulated state is
 * deliberately fail-OPEN (`cached !== false`), i.e. it CHOSE a safe fallback — not because anything
 * warms it early. Choosing the safe fallback is the real remedy; a warm you have to remember to call
 * from every process that reads is not one.
 *
 * ## Guards
 *
 * - `scripts/check-no-module-scope-flag-subscribe.mjs` — shrink-only source lint; fails on a NEW
 *   column-0 `onFlagChange(` / eager `FLAG_DEFAULTS[...]` deref. Its BASELINE is the not-yet-migrated
 *   set; migrating a module off it means DE-LISTING the file in the same change.
 * - `packages/operator-core/lib/flags-partial-mock-importable.test.ts` — the mechanism-level
 *   counterpart: imports every migrated module under an EMPTY flags mock, so a regression the source
 *   lint cannot see (an IIFE, a helper call, a `const _ = subscribe()`) still fails loudly. Add one
 *   import line there per module you migrate.
 * - The SAME source lint also cross-checks each call's `unpopulated.kind` against its own `keys`
 *   (`not-flag-gated` must pass no keys; the flag-gated kinds must pass at least one) and against
 *   its `seed` — `seeded-from-flag-default` must actually PASS one, no other kind may, and that
 *   seed's body must deref `FLAG_DEFAULTS[...]` rather than assign a literal. That last check is
 *   what makes "seed from the registry, not a literal" (below) enforceable instead of advisory: a
 *   literal agrees with the registry exactly until the flag graduates, so it fails silently, later,
 *   in a file nobody is looking at. Its cases live in
 *   `agent-tools/coordination/no-module-scope-flag-subscribe-guard.test.ts`.
 *   What the lint deliberately CANNOT check is whether a `selects-behaviour` justification is TRUE —
 *   that judgement is the author's, which is exactly why it is a required, greppable, reviewable
 *   field rather than an inference.
 */
import { onFlagChange } from '@papercusp/flags/server';

/**
 * What a SYNC reader of the cache serves BEFORE the first async refresh lands — the one property no
 * routine signal in this repo measures, so it is declared explicitly at every call site.
 *
 * The `kind` is cross-checked by `scripts/check-no-module-scope-flag-subscribe.mjs` against the
 * call's flag keys, so a declaration cannot silently contradict its own arguments.
 */
export type UnpopulatedState =
  /**
   * The flag decides only whether a STORED OVERRIDE is honoured. Unpopulated therefore serves the
   * module's baked constants — exactly what production runs whenever no override is set. Safe by
   * construction, whether or not the flag is default-ON.
   */
  | { kind: 'gates-an-override-store'; serves: string }
  /**
   * The call passes a `seed` that populates the cache SYNCHRONOUSLY on arm from
   * `FLAG_DEFAULTS[<key>]`, so the pre-refresh window serves the flag's own declared default rather
   * than a hardcoded constant. This is the STRONGEST kind and the one to prefer when the cached
   * value is a simple flag mirror: it collapses the divergence window to "a runtime OVERRIDE that
   * differs from the default has not taken effect yet" — which is what this helper's header always
   * CLAIMED the window was, and what it only actually becomes once seeded.
   */
  | { kind: 'seeded-from-flag-default'; serves: string }
  /** The cache is not flag-gated at all; the `key === null` bus reload is used purely as a "refresh now" signal. */
  | { kind: 'not-flag-gated'; serves: string }
  /**
   * The flag selects between two substantive behaviours, so the pre-refresh window genuinely serves
   * the OTHER one. Permitted only when that is a self-healing DEGRADATION rather than a wrong
   * answer — and `safeBecause` has to say which, in terms of what the off-branch actually points at.
   */
  | { kind: 'selects-behaviour'; serves: string; safeBecause: string };

export interface LazyFlagRefreshOptions {
  /**
   * Flag keys that should trigger a refresh. A `null` key (the bus-wide reload signal) ALWAYS
   * triggers one, matching the hand-written form this replaces. Omit for a cache that is not
   * flag-gated and only wants the reload signal.
   */
  keys?: readonly string[];
  /** REQUIRED — see {@link UnpopulatedState}. This argument exists to force the judgement. */
  unpopulated: UnpopulatedState;
  /**
   * Optional SYNCHRONOUS seed, run once on the arming call BEFORE the async refresh is kicked — the
   * fix for a cache whose unpopulated value would otherwise be a hardcoded constant that contradicts
   * its own flag's default.
   *
   * Seed from `FLAG_DEFAULTS[<key>]`, not a literal, so the seed cannot drift from the registry when
   * a flag graduates. Doing that deref HERE is safe and is explicitly permitted by
   * `check-no-module-scope-flag-subscribe.mjs` — only a MODULE-SCOPE `FLAG_DEFAULTS[...]` deref makes
   * a module unimportable under a partial mock; inside this callback it runs on the arming call.
   *
   * Live case (EI-19448574704459898): `work-item-redundancy.ts` cached `false` while its flag is
   * DEFAULT ON, so after migration the first synchronous read in every process answered "redundancy
   * off" — caught by its own default-ON test, which had passed for six weeks because the pre-migration
   * module-scope refresh started at IMPORT and resolved before anything read it.
   */
  seed?: () => void;
}

/**
 * Build the arming function for a module-level config cache.
 *
 * @param refresh The module's existing refresh routine. Invoked once on the arming call (standing in
 *                for the boot flag-reload that a module-scope subscription used to catch), and again
 *                on every matching flag change. Errors are swallowed — every caller in this codebase
 *                already fails its refresh safe to a baked default, and a config refresh must never
 *                reject into a hot-path reader.
 * @param options Flag keys plus the REQUIRED `unpopulated` declaration.
 * @returns An idempotent, synchronous `arm()` to call from every reader of the cache.
 */
export function lazyFlagRefresh(
  refresh: () => void | Promise<void>,
  options: LazyFlagRefreshOptions,
): () => void {
  const keys: readonly string[] = options.keys ?? [];
  let armed = false;
  const kick = (): void => {
    try {
      void Promise.resolve(refresh()).catch(() => {});
    } catch {
      /* a synchronous throw in a config refresh must never reach a hot-path reader */
    }
  };
  return function armFlagRefresh(): void {
    if (armed) return;
    armed = true; // set FIRST — a refresh that reaches a reader cannot re-enter this arming path
    if (options.seed) {
      try {
        options.seed(); // SYNCHRONOUS, before the kick — the reader that armed us sees this value
      } catch {
        /* a seed must never reach a hot-path reader; the async refresh still corrects the cache */
      }
    }
    onFlagChange((key) => {
      if (key === null || keys.includes(key)) kick();
    });
    kick(); // first population; the module-scope subscription used to get this from the boot reload
  };
}
