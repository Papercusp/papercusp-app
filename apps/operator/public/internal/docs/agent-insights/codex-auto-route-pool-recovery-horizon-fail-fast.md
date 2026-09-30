# Codex auto-routing: the pool recovery horizon — fail fast when every account is walled, absorb only toward real capacity
URL: /internal/docs/agent-insights/codex-auto-route-pool-recovery-horizon-fail-fast

Why `auto`-routed codex requests hung ~2min then 429'd when the ChatGPT pool was all-walled, and the fix: the failover pool now exposes its RECOVERY HORIZON (earliestAvailableAt), the throttle ladder absorbs only when that horizon is inside the absorb budget, the absorb sleeps toward the POOL horizon (not the failed account's reset), terminal 429s carry x-papercusp-pool-recovery-at, a transport-probe readmit is bounded so it cannot clear a 7d usage wall, and the durable availability store readmits a parked account on a NEWER serviceable reading (store↔pool reconciliation).

## The symptom (owner-measured 2026-09-05)

Every `auto`-routed codex request hung for the whole absorb budget (\~2 min for an `su`-labelled session) and then returned a shaped 429; the codex CLI's own retries turned that into an indefinite stall. `accounts:status` showed 5/7 codex accounts at `utilization7d: 1.0` (`measured-wall`) and the other two 5h-walled — the pool's EARLIEST recovery was \~3h out, yet each request slept \~2 min hoping for capacity that could not arrive. Root cause + measurements: plan `codex-auto-route-all-walled-fail-fast-2026-09-05` D-001.

## Why it hung

1. `decideThrottleRecovery` rung 2 (ABSORB) fired whenever the absorb budget was open and no head was written. It had NO notion of whether the POOL could recover inside that budget — `transient` was computed but not consulted for rung 2.
2. Both codex absorb branches slept toward the FAILED ACCOUNT's reset (`taken.resetAt`), so on a 7d wall the sleep was `min(remainingBudget, days)` = the entire remaining budget — then the re-pick found the same walled pool.
3. The egress-probe transport recovery called `pool.readmit(id)` unbounded on every successful probe, clearing 7d usage walls a healthy proxy does not cure — the fleet re-burned every walled account and `active()` kept "finding" capacity that did not exist.
4. The pool's in-memory park and the durable availability store (`operator_account_pool`, refreshed into the gateway's rate hints) could disagree with no reconciliation: a park won until it expired even when the store had a NEWER reading saying the account was back.

## The fix (plan P-001..P-008)

* **`AccountPool.earliestAvailableAt({ now, keyOf, recoverAtOf })`** (account-failover.ts): `0` when any entry is unparked AND `keyOf` finite (serviceable now); else the EARLIEST of each entry's known recovery instant — the later of its park expiry and the caller's `recoverAtOf` (a durable window reset / governor pause the pool cannot see); `Infinity` when nothing is known. Plus `parkState(id) → { parkedAt, until }` and `readmit(id, { reason, maxParkMs }) → boolean`.
* **Ladder gate** (throttle-recovery-ladder.ts): optional `poolRecoveryAt`; rung 2 absorbs only when `poolRecoveryAt === undefined || poolRecoveryAt <= absorbDeadlineAt`. Omitted ⇒ the Claude lane's decision table is byte-identical.
* **gateway.ts** `codexPoolRecoveryAt(pool, at, failed, hardPin)`: the pool horizon under the shared health key + `hintRecoveryAt` (the SAME walls `accountHealthKey` scores Infinity — governor pause, full 5h/7d window, burn SHED, egress circuit — read back as an instant), with the account that JUST 429'd overlaid as out until its parsed reset (the kernel settles its last attempt without an `onExhausted`). A HARD pin narrows the pool to the pinned account. Both codex 429 sites pass it to the ladder; the absorb sleeps toward it; a terminal 429 stamps `x-papercusp-pool-recovery-at` (ISO | `now` | `unknown`) and `recordStall` uses the pool horizon so the stall-waker gates on real capacity.
* **Bounded transport readmit** (P-005): `readmitProviderAccount` passes `{ reason:'transport', maxParkMs: EGRESS_CIRCUIT_OPEN_MAX_MS }` — a park longer than the circuit ceiling is a usage wall and is REFUSED (logged). `/admin/readmit` passes `reason:'admin'` (unbounded, the operator lever).
* **Store↔pool reconciliation** (P-008, owner: "auto routing should look at the same system that knows which accounts are available"): rate hints carry `readingAt` (`utilizationAt`); after every `setAccountRateHints` and at every absorb re-entry, `reconcileParksWithStore` readmits (`reason:'store'`) any parked account whose reading is NEWER than the park (`readingAt > parkedAt`) and reports it serviceable (the shared `accountHealthKey` is finite; do not infer serviceability from an absent recovery timestamp because SHED/full readings can be walls whose reset is unknown). An older reading, or one that still reports a wall, leaves the park.
* **P-004** codex-oauth-proxy.ts: the non-stream aggregation timer resolves `'timeout'` BEFORE calling `onTimeout` (which aborts the shared signal) — previously the race read the gateway's own deadline as a client abort and destroyed the socket silently instead of answering 504. gateway.ts sinks the aggregate promise's rejection at creation (`end()` still awaits the original) so an abort before `end()` is not an unhandledRejection.

## A second defect the horizon surfaced

The bearer kernel adapter's `rateResetAt` used the Anthropic-dialect `parseRateReset`, which reads neither `retry-after: 80ms` nor OpenAI's `x-ratelimit-reset-*` durations, so every bearer 429 parked the account for the 15s failover backoff while the outer ladder (`parseCodexRateReset`) saw the real 80ms reset. Invisible before (the single-account fallback re-picked the parked account anyway); with the horizon it read as "pool cannot recover in budget" → a false fail-fast on a transient burst. Fixed by using `parseCodexRateReset` in the adapter. Lesson: when two layers park/estimate the same account, they must consult ONE dialect parser.

## How to read it live

* journal: `Codex OAuth absorb on '<id>' → … wait <ms>ms (pool recovery <iso|now|unknown>)` and `forwarding terminal 429 (…; pool recovery <iso|unknown>)`; `readmit (transport) REFUSED — park runs …s more, exceeds the …s transport horizon`; `park (…s left) cleared — availability store reports capacity (reading …s old, u5h=…, u7d=…)`.
* a shaped 429 carries `x-papercusp-pool-recovery-at`; `retry-after` stays capped at the bee cap.
* Tests: account-failover.test.ts (horizon + bounded readmit), throttle-recovery-ladder.test.ts (rung-2 × horizon goldens), gateway-openai-proxy.test.ts (`pool recovery horizon + store↔pool reconciliation` describe), codex-oauth-proxy.test.ts (deadline-vs-abort race).

## What this deliberately does NOT do

It never widens the absorb, retries harder, or readmits walled accounts to "fix" a capacity shortage: an all-walled pool now fails FAST with the horizon on the wire, and the shortage itself is reported separately (plan P-009: the oddsmith-sidecar burn is investigated report-before-acting).
