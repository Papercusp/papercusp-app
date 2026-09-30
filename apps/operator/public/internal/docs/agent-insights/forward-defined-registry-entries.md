# Forward-defined registry entries — advance-mapping without losing the drift signal
URL: /internal/docs/agent-insights/forward-defined-registry-entries

When you need to map something before its target exists, the cheap path is a `FORWARD_DEFINED` set + a sanity assertion that flips when the target lands. Keeps the drift visible.

## What

Sometimes you want to add an entry to a registry **before** the
thing it references exists. Example from P-067 (bridge module):

The bridge maps `harness_shared.<table>` → camelCase queryNames
that consumers subscribe to. When v5 plan addendum 3 added two new
tables (`contributor_usage_events` + `insights_first_visit`), the
matching camelCase queryNames (`contributorUsageEvents.byHarness` +
`insightsFirstVisit.byHarness`) don't exist in the v2 sync-resolver
registry YET — those will land with P-073 (Insights tab) work.

Three options for the bridge:

1. **Wait.** Add nothing to the bridge until v2 entries exist.
   Problem: when the consumer lands, someone has to remember to also
   wire the bridge. Easy to forget — drift.
2. **Map anyway, ignore the consistency assertion.** Bridge fires
   `contributorUsageEvents.byHarness` events that nothing listens to.
   Harmless, but the consistency assertion ("every bridged name is
   in v2") flips to false, becomes noise, gets disabled.
3. **Forward-define with explicit tracking.** Map the names + add
   them to a `FORWARD_DEFINED` set + add a sanity assertion that
   inverts the consistency check.

Option 3 is what shipped. It preserves the drift signal.

## The pattern

```ts
describe('TABLE_TO_QUERY_NAMES vs v2 registry consistency', () => {
  /**
   * Forward-defined names — mapped in the bridge BEFORE the
   * corresponding v2 registry entry exists. Trigger events for
   * these tables fire (as expected) but currently invalidate
   * nothing; the matching consumer + v2 entry will land later.
   *
   * REMOVE an entry from this set as soon as its v2 registry
   * entry lands — otherwise drift between intent ("this should
   * land soon") and reality ("it never did") stops being visible.
   */
  const FORWARD_DEFINED = new Set<string>([
    'contributorUsageEvents.byHarness',
    'insightsFirstVisit.byHarness',
  ]);

  it('every bridged query name is either in v2 OR explicitly forward-defined', () => {
    const v2 = new Set(knownQueryNamesV2());
    const bridged = allBridgedQueryNames();
    const unaccountedFor = bridged.filter((n) =>
      !v2.has(n) && !FORWARD_DEFINED.has(n)
    );
    expect(unaccountedFor).toEqual([]);
  });

  it('forward-defined names are NOT in v2 registry (sanity)', () => {
    const v2 = new Set(knownQueryNamesV2());
    const stillForward = Array.from(FORWARD_DEFINED).filter((n) => !v2.has(n));
    // If this assertion fails, a forward-defined name has been
    // implemented and its entry in FORWARD_DEFINED should be removed.
    expect(stillForward.sort()).toEqual(Array.from(FORWARD_DEFINED).sort());
  });
});
```

The two assertions work together:

* The first **passes** as long as every bridged name is EITHER in
  v2 OR explicitly forward-defined. Drift in either direction
  surfaces.
* The second **fails the moment a forward-defined name lands in
  v2**. The failure message tells you to remove the entry from
  `FORWARD_DEFINED`. The drift signal is preserved.

## Why this matters

The naïve "I'll just disable the consistency check while it's
forward-defined" pattern destroys the drift signal:

* No way to tell what's intentionally-pending vs accidentally-broken.
* When the v2 entry lands, no test fires; the forward-define
  becomes obsolete vestigial code.
* New agents reading the code can't tell what's intent vs bug.

The `FORWARD_DEFINED` set is documentation in code: "these names
are deliberately mapped before their target exists." The sanity
assertion makes that documentation **load-bearing** — the test
suite forces you to update it.

## When to use this

Whenever you're tempted to:

* Add a value to a registry/map ahead of its consumer landing.
* Suppress a lint/test failure with `// @ts-expect-error` or
  `// eslint-disable-next-line` for "this will be fixed in a
  follow-up."
* Add a `TODO` for "remove this when X lands" — the comment is
  passive; the assertion is active.

In each case: the question is "how will future-you/future-agent
know this is still pending vs forgotten?" `FORWARD_DEFINED` + an
inverted assertion answers it.

## What it looks like in the wild (this codebase)

* `packages/operator-core/lib/sync-resolver/table-to-query-names.test.ts`
  — the canonical example. 2 entries:
  `contributorUsageEvents.byHarness` + `insightsFirstVisit.byHarness`
  for P-073 Insights tab work.

## Variations

* **`FORWARD_DEFINED` with expiration**: if you also know a target
  date, fail when current date > expiration with "this should have
  been resolved by N." Stronger signal at the cost of brittleness.
* **Inverted-only**: if you can't easily list every value (e.g., a
  pattern instead of a finite set), invert: `expect(orphans).toEqual([])`
  with a comment explaining "if a real orphan appears, decide
  whether to add to FORWARD\_DEFINED or fix the registry."
* **Per-domain**: large registries can have multiple
  `FORWARD_DEFINED` sets keyed by purpose (e.g.,
  `FORWARD_DEFINED_PLANNED_THIS_QUARTER` vs
  `FORWARD_DEFINED_DEFERRED_INDEFINITELY`). Helps prioritization.

## Related

* `packages/operator-core/lib/sync-resolver/table-to-query-names.ts` —
  the bridge that uses this pattern.
* `packages/operator-core/lib/sync-resolver/index.ts` — the v2 registry the
  bridge maps INTO.
* [Adding a query to the sync resolver](/internal/docs/agent-insights/adding-a-sync-query)
  — when you migrate a forward-defined name, removing it from
  `FORWARD_DEFINED` is step 4 of the recipe.
