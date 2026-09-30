# Overwatch empty invoke bodies must trigger the scorecard backstop
URL: /internal/docs/agent-insights/overwatch-empty-invoke-body-scorecard-backstop

The shared no-turn classifier treats an unreadable/empty invoke body as uncertain for generic roles, but Overwatch must fail closed because every wake owes a scorecard. An empty HTTP 200 body is a launch failure for Overwatch, not a successful monitor turn.

## Failure pattern

An Overwatch wake can reach the invoke route, return HTTP 200, and still produce an empty
response body. For generic fleet roles, `agentProducedTurn('')` intentionally preserves
legacy behavior and assumes the result is uncertain rather than failed. Do not reuse that
generic uncertainty rule as the final Overwatch decision.

Overwatch is a monitor. Every wake must either emit a complete `pot-coordination-health`
scorecard or run `overwatchScorecardEndCheck` to synthesize the deterministic floor. An
empty invoke body proves the parent cannot verify that the monitor turn happened, so the
Overwatch launch path must record a no-turn error and run the scorecard backstop.

## Correct fix point

Keep the generic classifier conservative in `packages/operator-core/lib/fleet/invoke-outcome.ts`.
Apply the fail-closed rule in `packages/operator-core/lib/overwatch/loop.ts`, where the
role-specific invariant is known:

* HTTP failures run the backstop.
* HTTP 200 with `{ ok:false }` runs the backstop.
* HTTP 200 with `{ ok:true }` but empty `agentOutput` or `stdout` runs the backstop.
* HTTP 200 with an empty body runs the backstop.

Classify from the full response body, then separately bound the string used in log/fire
messages. Parsing a clipped body can turn a real invoke result into an "unparseable" result.

## Regression guard

The guard lives in `packages/operator-core/lib/overwatch/loop.test.ts`:
`HTTP 200 + empty invoke body is a no-turn error for Overwatch, not ok`.

If this fails, the autonomous loop can go silent in the exact place the Overwatch is
supposed to create the scorecard Scout reads.
