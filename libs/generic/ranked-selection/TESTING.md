# Testing — @papercusp/ranked-selection

```bash
npm run test:file -- libs/generic/ranked-selection/src/index.test.ts
```

Vitest, pure unit tests, no fixtures and no I/O.

## Falsifiability controls live in the test file, permanently

`src/index.test.ts` keeps two deliberately-wrong implementations beside the real
subject:

- `selectFillingToMax` — fills to `max` instead of `min` (the cap-becomes-quota
  bug).
- `selectBlendingProvenance` — labels every pick `'floor'` (the silent-blend
  bug).

Each is asserted against by the *same* assertion that guards the real
implementation, so the guard is demonstrably able to fail. Without them, "fills
to min" passes trivially whenever the fill pool happens to be short, and
"labelling is preserved" passes trivially whenever every pick was qualified
anyway.

**Do not prove falsifiability by mutating the real implementation in place.**
This repository's working tree is swept and committed on a schedule by git-sync,
so a file held in a mutated state for the duration of a test run can be
committed even when nothing goes wrong and no handler fails — a `trap` does not
close that window. Keeping the wrong implementations permanently in the test file
is the tier-2 pattern from the repo's mutation-probe table: a module you
`import` gets a wrong control kept beside it, never an edit to the subject.

## What is deliberately not tested here

Delivery. This library returns an ordered menu and never wakes, sends, or
persists anything; the consumers own their delivery semantics and test them.
