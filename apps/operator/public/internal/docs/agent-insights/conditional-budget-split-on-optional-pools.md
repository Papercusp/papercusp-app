# Split a budget conditionally on which pools are actually active
URL: /internal/docs/agent-insights/conditional-budget-split-on-optional-pools

When fanning out a `limit` across N optional pools (user / workspace / N harnesses), the per-pool slice must depend on which pools are non-empty THIS call — not a fixed compile-time ratio.

import { Aside } from '@astrojs/starlight/components';

## The trap

`buildMemoryContextBlock` fans out one `limit` across multiple optional pools:

* per-user pool (skipped when `userId` is `null` — workspace-bearer routes)
* legacy `workspace:<wsId>` pool (was present during the deprecation window —
  **since drained, D-005**; the live `buildMemoryContextBlock` no longer pulls
  it, so the concrete user-vs-workspace example below is now historical)
* N per-harness pools (zero when no harness slugs supplied)

The original code hardcoded:

```ts
const userLimit = input.limit ?? 6;
const workspaceLimit = Math.ceil(userLimit / 2);
```

`workspaceLimit` is *always* half the budget, even when there's no user pull
to share with. A workspace-bearer caller that passed `limit: 9` got
`workspaceLimit = 5` — wasting 44 % of its budget on a pool that didn't exist.

This was caught only because a unit test asserted the expected `limit: 9`.

## The pattern

When the budget split is supposed to share a pool budget, **condition the
share on which pools are actually firing**, not on a fixed ratio:

```ts
// Fixed split — wrong when pools are optional
const workspaceLimit = Math.ceil(userLimit / 2);

// Conditional split — correct
const workspaceLimit = input.userId ? Math.ceil(userLimit / 2) : userLimit;
```

The principle generalises: for **N optional pools**, divide by the count of
pools that will actually fire this call:

```ts
const activePools = [
  input.userId ? 'user' : null,
  needLegacyWorkspace ? 'workspace' : null,
  ...harnessSlugs.map((s) => `harness:${s}`),
].filter(Boolean);
const perPoolLimit = Math.ceil(userLimit / activePools.length);
```

Or — when each pool has a meaningful natural cap (`PER_HARNESS_LIMIT = 3` in
the same file), don't divide at all; sum the caps and let the caller bound
the merged total.

## How to spot this

Greppable signature: any `const fooLimit = Math.ceil(<budget> / 2)` near a
`client.search(... { limit: fooLimit })`. If the *other* pool can be empty
or unset, the divisor is wrong.

In tests, the signal is: a test that fixes the budget at `limit: N`,
isolates one pool, and asserts the *exact* request limit. If that test
expects `N` but the implementation passes `N/2`, this bug is present.

## Why it stuck around

The fixed `/ 2` worked correctly when both pools were always present —
that was the codebase invariant before the memory-harness-scope plan turned
the per-user pull optional. The bug only became visible once
`buildMemoryContextBlock` started accepting `userId: null`.

This is a recurring shape: **a new optional shape introduced, while a
legacy assumption about co-presence stays implicit.** Audit any other
budget / quota / ratio constant when adding an optional pool. The
`forward-defined-registry-entries` pattern has the same flavor — adding a
new variant breaks the assumption that the variant list is closed.

## See also

* `packages/operator-core/lib/memory/injection.ts` — the canonical fix
  (commit `5b0e48ee`). **Update:** the legacy `workspace:` pool this split fed
  has since been **drained** (D-005), so the live code no longer divides a budget
  here — it pulls the user pool at `limit` and each harness pool at
  `PER_HARNESS_LIMIT`, with no `workspaceLimit`. The pattern above still holds for
  any future multi-pool fan-out.
* `packages/operator-core/lib/memory/injection.test.ts` — the test that caught it
  was replaced (now `pulls user + harness scopes only — no deprecated workspace
  pull (D-005)`).
* [`pure-decision-functions-pulled-from-daemons`](/internal/docs/agent-insights/pure-decision-functions-pulled-from-daemons/)
  — extracting `decideBudgetSplit(input)` as a pure function with tests
  would have caught this on the first variant.

"Half the budget for workspace" is a *defaulted assumption*, not a
specification. Encode the assumption as a function whose inputs include the
set of active pools — then the next person adding a pool can't accidentally
silently misallocate the budget.
