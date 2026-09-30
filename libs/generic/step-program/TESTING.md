# Testing — @papercusp/step-program

**Run:** `npm test` (from this dir) or `npx vitest run` — Vitest, node env, no
external services. The lib is pure (zero runtime deps), so the tests need no
Postgres, Docker, or network.

## What's covered

| File | Covers |
|---|---|
| `src/expr.test.ts` | The condition evaluator: operators, precedence, paths, truthiness, numeric-string coercion, and the **no-eval safety boundary** (function-call / assignment syntax must not parse). |
| `src/interpolate.test.ts` | `{{ path }}` substitution: type-preservation for a whole-string placeholder, mixed-string stringification, missing-path handling, recursion, no-mutation. |
| `src/interpreter.test.ts` | `planStep` (invoke/skip + interpolation + bind, omitted-args default) and `selectGateBranch` (first-match, fallback, no-match). |
| `src/runner.test.ts` | `runProgram` end-to-end with an in-memory fake op map: step execution + result-binding, cross-step interpolation, the `runOp` seam (op-call labels + opaque `ctx` pass-through), the recursion guard (strict `>`), `no-gate-match`, the `isResolved` predicate, and the empty-steps structural error. |
| `src/aggregate.test.ts` | The poll reducer: fenced + lenient vote parsing, advocate-veto parsing, confidence clamping, the confidence-weighted + majority tallies, margin/mean-confidence math. |

## What's NOT covered here

Integration with a real op registry + a durable runtime (DBOS-step `runOp`) is
the **consumer's** concern — those tests live with the adapter (in Papercusp's
`packages/operator-core/lib/coord-ops/program-runner.test.ts`), per the
algorithm-vs-integration test split.

## After editing

Run `npx vitest run` here. If you change the interpreter/runner surface, also run
the consuming adapter's tests (`@papercusp/operator-core` coord-ops) and the
`@papercusp/orchestrator` blueprint suite — they re-export this lib.
