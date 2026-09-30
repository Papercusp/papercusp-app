# A hand-listed vi.mock factory goes stale silently — use importOriginal
URL: /internal/docs/agent-insights/stale-vi-mock-factory-undefined-export

A test suddenly fails with \"Cannot read properties of undefined\" or a nonsensical ok:false / \"Number of calls: 0\" after someone adds a new import to the module under test — the cause is a vi.mock factory that hand-lists exports.

## The symptom

A test file that was green for weeks goes red, and **none of the failures name the
real cause**. The signature seen in EI-18684688763442649:

```
> attaches checkpoint + a loud warning …: expected "vi.fn()" to be called with … Number of calls: 0
> omits checkpoint fields entirely …:     expected { ok: false, id: 'WI-2' } to deeply equal { ok: true, … }
> degrades to a normal claim (no crash) …: expected { ok: false, id: 'WI-3' } to match object { ok: true, … }
```

Every test in the file fails, the assertions point at the *feature under test*
(a checkpoint hint), and the only real clue is buried in an `error` field on the
result object: `Cannot read properties of undefined (reading 'catch')`.

## The cause

A `vi.mock` factory that **hand-lists** the module's exports:

```ts
vi.mock('../../work-items', () => ({
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  getWorkItem: vi.fn(),          // ← returns undefined
}));
```

Someone then adds a new call to the module *under test*:

```ts
// claim.ts (WI-5946) — a new pre-claim guard read
const preClaimItem = await getWorkItem(it.id, it.harness).catch(() => null);
```

`getWorkItem` is a bare `vi.fn()`, so it returns `undefined`, and `.catch` on
`undefined` throws. Two things then conspire to hide the cause:

1. **A hand-listed factory replaces the WHOLE module.** Any export the list
   forgot is `undefined` — not the real implementation. There is no error at
   mock time; the failure surfaces later, at the call site.
2. **A bulk/wrapper layer swallows the throw.** Here `runBulk` turns the
   exception into `{ ok: false, error }`, so the visible failure is
   "expected ok:false to equal ok:true" — a *feature* assertion, pointing away
   from the mock.

The same drift hit **three separate mocks** in this one file: `../../work-items`,
`fleetScopeLeaderRemedy` on the fleet-scope-admission mock, and `./claim-hold-guard`.
Its sibling `claim.test.ts` had been updated for WI-5946; this file had not.

## The fix — partial-mock via `importOriginal`

Spread the real module and stub only what you deliberately want fake:

```ts
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  getWorkItem: vi.fn(),
}));
```

Now a **future** import the module under test adds resolves to the genuine
implementation instead of `undefined`, so the mock cannot go stale the same way.
Established pattern in this repo — see `hold_open.test.ts` and `burn_down.test.ts`.

Stub only the *side-effecting* members and keep pure logic real, so the test stays
an integration test of the real composition:

```ts
vi.mock('./claim-hold-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),           // assessClaimHoldGuard stays REAL
  recordClaimHoldBypassAudit: vi.fn(async () => {}),
  notifyClaimHoldBypass: vi.fn(async () => {}),
}));
```

Then make each stub match the **real signature** — an async function must be
`mockResolvedValue(...)`, never a bare `vi.fn()`:

```ts
getWorkItemM.mockResolvedValue(null as never);
```

## Diagnosing it fast

* A test asserting a mock "was called 0 times" **plus** an unexpected `ok:false`
  on the same run ⇒ suspect a throw upstream of the assertion, not a feature bug.
* Look for an `error` string on the returned object — bulk/envelope helpers stash
  the real exception there.
* `Cannot read properties of undefined (reading 'catch' | 'then')` on a call you
  did not change ⇒ an async dependency is stubbed as a non-promise, or is missing
  from the mock factory entirely.
* Diff the mocks against the module-under-test's actual import list, and against a
  **sibling** test of the same module — the sibling is usually the one that got
  updated when the dependency was added.

## Rule of thumb

Prefer `vi.mock(path, async (importOriginal) => ({ ...(await importOriginal()), … }))`
over a hand-listed factory for any module the code under test imports more than
one or two members from. The hand-listed form is a snapshot of *today's* imports;
it silently rots the moment production code grows a dependency, and it fails in a
way that points at the wrong thing.
