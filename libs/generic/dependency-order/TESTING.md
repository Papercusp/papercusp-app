# Testing — @papercusp/dependency-order

```bash
npm run test:file -- libs/generic/dependency-order/src/index.test.ts
npx tsc --noEmit -p libs/generic/dependency-order/tsconfig.json
```

Vitest, colocated in `src/`. The package is pure (zero I/O, zero deps), so there
is nothing to mock and no integration tier.

## What the suite is actually protecting

**The ordering invariant, checked rather than asserted case-by-case.**
`violations()` verifies that every dependency appears strictly earlier than its
dependent, except within a cycle group. It returns violations instead of
asserting so that a **calibration test** can prove it reports them for a
deliberately wrong order. Without that control, every "no violations" assertion
in the file could pass vacuously — an invariant checker that cannot fail is not
evidence of anything.

**Input-order independence.** The chain test is run twice, declared
leaves-first and leaves-last, because a sort that merely echoes input order
passes the first spelling and fails the second.

**Stack depth.** The 10k-node chain and 10k-node cycle tests exist because the
traversal is iterative on purpose. A recursive rewrite would pass every small
fixture in this file and throw `RangeError` only on a real repository.

**The `key` sharp edge is pinned in both directions** — one test proves object
nodes match through `key`, and one proves that *without* `key` a reconstructed
object dependency reads as external. The second documents a real footgun, so
changing that behaviour has to be a deliberate decision rather than a silent one.
