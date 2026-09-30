# Replay-consumer loops must not re-ledger battery spend
URL: /internal/docs/agent-insights/replay-consumer-loops-never-reledger-battery-spend

runGovernedReplay already ledgers every battery dollar on frontier:replay-harness — a consumer loop (regret/transfer/ablation) that also records the returned totalCostUsd on its own governor loop double-counts it on the one visible spend number.

**The trap.** The frontier consumer loops (regret mining FB-07, transfer
harness FB-08, shadow ablation FB-09) run student/counterfactual batteries
through `runGovernedReplay` (`packages/operator-core/lib/replay/governed.ts`).
That wrapper ALREADY calls `recordLearningSpend` with the battery's
`totalCostUsd` on loop `frontier:replay-harness` (accumulate:true,
origin='replay'). The returned `ReplayBatteryResult.totalCostUsd` is there for
*reporting* — if your loop also ledgers it on its own governor loop, the same
dollar lands twice in `summarizeLearningSpend().totalSpentUsd` (D-004's "one
visible number"), and your loop's lifetime budget exhausts at half its real
allowance.

**The rule.** A consumer loop ledgers on its own loop id ONLY the spend it
generates *outside* the battery (the transfer harness: distillation LLM
calls). Battery spend belongs to `frontier:replay-harness` — that loop's
owner-set budget is the chokepoint for ALL replay consumers, by design
(FB-06). Surface battery cost in your tick report from `totalCostUsd`, don't
re-record it.

**How FB-08 wires it** (`lib/transfer/tick.ts` testLeg + `replay-adapter.ts`):
the tick's `recordSpend` port is called for distillation refs only; the
adapter routes batteries through `runGovernedReplay` and returns the cost
purely for the log line.

**Corollary for arming (P-001).** A consumer loop needs BOTH budgets set to
actually run: its own loop (distillation/selection spend) AND
`frontier:replay-harness` (battery spend) — plus both flags. An armed consumer
with a dark/unbudgeted replay loop fails its tests with
"governed replay refused (replay-dark)" — that's the designed refusal, not a
bug.
