# vi.mock + mockRejectedValue/async-throw trips vitest's uncaught-error guard even when the caller catches it — inject the reader instead
URL: /internal/docs/agent-insights/vitest-mock-async-throw-trips-uncaught-guard

In operator-core's vitest setup, driving a vi.mock'd module export (e.g. getFlag) with mockRejectedValue(err) or mockImplementation(async () => { throw }) to exercise a caller's try/catch fails the test as an uncaught error AT THE MOCK SITE — even though the caller genuinely catches it and returns a fallback. A synchronous throwing mockImplementation doesn't fix it either. The reliable pattern is dependency injection: give the function an optional reader/fn param and inject a throwing closure directly in the test, no module mock.

## The mistake this prevents

Testing an error-path in `operator-core` — "the caller must fail open (or
closed) when a dependency throws" — by `vi.mock`-ing the dependency's module
and driving it with `mockRejectedValue(err)` or
`mockImplementation(async () => { throw new Error(...) })` looks like the
obvious approach (it's the standard vitest idiom for "make this call reject").
It doesn't work reliably here: the repo's vitest setup treats the throw as an
**uncaught error at the mock call site**, and fails the test with that error —
even when the calling code has a real `try { … } catch { return fallback }`
around the call and the test's actual assertion (on the fallback value) would
otherwise pass. Switching to a **synchronous** throwing `mockImplementation`
does not fix it either; the guard still fires.

Concretely, this bit `FLAGS.POT_SEED_BUNDLE`'s fail-open gate
(`bootstrap-papercusp-hive.ts`): the requirement is "a flags-read hiccup must
never silently force the cold join path" — i.e. a thrown flag-read error
should make the gate behave as if the flag were ON. Mocking
`@papercusp/flags/server`'s `getFlag` to reject cost \~3 failed iterations
chasing the uncaught-error report before switching approach.

## The rule

**Don't module-mock a throwing async dependency to test a caller's catch
block — inject the reader instead.** Give the function under test an optional
parameter for the call it needs to make (defaulted to the real
implementation), and pass a throwing closure directly in the test:

```ts
// bootstrap-papercusp-hive.ts
export async function seedBundleEnabled(
  readFlag: () => Promise<boolean> = () => getFlag(FLAGS.POT_SEED_BUNDLE, 'system'),
): Promise<boolean> {
  try {
    return await readFlag();
  } catch {
    return true; // fail OPEN — a flags hiccup never silently forces cold
  }
}
```

```ts
// bootstrap-papercusp-hive-seed-flag.test.ts — no vi.mock at all
it('a flag-read THROW ⇒ fails OPEN (true)', async () => {
  expect(
    await seedBundleEnabled(async () => {
      throw new Error('posthog unreachable');
    }),
  ).toBe(true);
});
```

This is strictly better than the module-mock version even ignoring the guard
issue: no `vi.mock` hoisting, no module-path coupling, and the injected
closure makes the exact failure mode being tested (a rejected/throwing read)
completely explicit at the call site.

:::note\[Naming: the file is `hive`, the flag is `POT_` — both are correct]
Do not "fix" either to match the other. The hive→pot rename covers **tool verbs
and flag keys**, not **filenames / identifier vocabulary**, so the live tree
genuinely has `FLAGS.POT_SEED_BUNDLE` read inside
`packages/operator-core/lib/harness/bootstrap-papercusp-hive.ts`. This page
previously had it backwards in *both* directions at once — renaming the
filenames (which never moved) to `bootstrap-papercusp-pot.ts` while leaving the
flag as `HIVE_SEED_BUNDLE` (which did move). There is no `bootstrap-papercusp-pot.ts`
in the tree; verify a name before renaming it in prose.
:::

**Still current (verified 2026-08-04).** The rule is not just advice here — the
code obeys it: `seedBundleEnabled` (`bootstrap-papercusp-hive.ts:64`) carries the
optional `readFlag` seam exactly as shown, its test file contains **zero**
`vi.mock` / `mockRejectedValue`, and the pattern has since propagated to a sibling
gate (`seedSelfAdmitEnabled`, same file, same shape). Related and probably the
same family, though not confirmed to be the identical mechanism: a persistent
`mockRejectedValue(...)` combined with a `beforeEach(() => fn.mockReset())` leaks
a stray unhandled rejection that fails a test whose caller *does* handle the
rejection — another reason to reach for the injected seam rather than a module mock.

## When this applies

* You're testing that a caller correctly handles a dependency **throwing or
  rejecting**, specifically (not just returning an unusual value).
* The dependency is normally reached via a plain top-level import (not already
  behind an injected seam).
* You're in `operator-core` (or any package sharing its vitest config /
  fail-on-console-and-uncaught-error setup).

If the caller already accepts the dependency as a parameter (or the codebase's
`configure*()` seam convention already applies), there's no new work — this is
simply a reason to keep using that seam for error-path tests rather than
reaching for `vi.mock` + `mockRejectedValue`.

## Symptom signature

* The test fails with the mock's thrown `Error` reported as an **uncaught
  error**, pointing at the `mockRejectedValue(...)` / `mockImplementation`
  call site — not at the test's own `expect(...)` assertion, which may never
  even run.
* Switching `mockRejectedValue` → a synchronous throwing
  `mockImplementation(() => { throw ... })` does not change the outcome.
* The calling code's `try/catch` is provably correct (a plain unit test of the
  catch block in isolation, or manual inspection, confirms the fallback logic)
  — the test framework's uncaught-error detection is firing on the mock's
  throw before/around the caller's own catch, not a real bug in the caught
  code.
