# Inference admission control loop — gateway priority tiers (sink) + Mug capacity dispatch (source)
URL: /internal/docs/agent-insights/gateway-admission-control-loop

Under inference scarcity the platform runs a TWO-SIDED admission control loop sharing ONE capacity oracle (the gateway /stats). SINK side (gateway-priority-tiers, GATEWAY_PRIORITY_TIERS): per-tier admission caps + a reserved tier-1 floor so the interactive/Mug/Scout lane is never crowded out by batch cups — it ALLOCATES scarce capacity fairly. SOURCE side (mug-capacity-dispatch, QUEEN_CAPACITY_DISPATCH): the Mug clamps fresh-cup placement to what the pool can sustain (read from the same gateway /stats) so it stops FLOODING a saturated pool with requests that just park/fail — it REDUCES the inflow. Neither CREATES capacity (the durable lever is more accounts); they make scarce capacity go to the right work. Both flag-gated, fail-safe (gateway-unreachable ⇒ no change), byte-identical off.

:::caution\[The SOURCE half of this loop is retired — the SINK half is live]
`QUEEN_CAPACITY_DISPATCH` clamps **Mug `fleet:place_batch`** placement, and both the Mug and
`fleet:place_batch` were **retired 2026-08-09**
([canonical account](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired)). So the
inflow-reduction half described below **no longer fires** — nothing places cups to clamp.

The **sink** half (gateway priority tiers, `getSpawnHeadroom`, the concurrency ceiling) is
unchanged and still governs live launches. Do not read this page as evidence that inflow is
still being throttled at the source: today it is not.
:::

## The core idea

When the inference pool is capacity-scarce (accounts at their 5h/7d caps or short-term-throttled), two
things must happen: scarce capacity must go to the RIGHT work, and the fleet must stop generating work the
pool can't serve. Those are the two ends of one control loop, and they read the SAME oracle — the gateway
`/stats` (the only process that sees `anthropic-ratelimit-*`).

| Side                       | Flag                      | Where                   | What it does                                                                                                                                        |
| -------------------------- | ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SINK** (allocate)        | `GATEWAY_PRIORITY_TIERS`  | gateway admission       | per-tier in-flight caps + a reserved **tier-1 floor** — mug/scout/overwatch/interactive (tier 1) are never fully crowded out by batch cups (tier 3) |
| **SOURCE** (reduce inflow) | `QUEEN_CAPACITY_DISPATCH` | Mug `fleet:place_batch` | clamp FRESH-cup placement to what the pool can sustain, so the Mug stops flooding a saturated gateway with cup requests that just park/fail         |

**Neither creates capacity.** Under total exhaustion even tier-1 gets little; the durable lever is more
accounts / window resets (an owner action). These just stop the waste and protect the important lane.

## SINK side — gateway priority tiers

`PriorityAdmissionQueue` (priority-admission.ts) gains an optional tier layer: per-tier in-flight `caps` + a
`tier1Reserve` (tier > 1 is refused once `running ≥ maxConcurrent − reserve`, holding that many slots open for
tier 1). `launch.ts resolvePriorityTiers` reads `GATEWAY_PRIORITY_TIERS`, builds the role→tier map
(`mug/scout/overwatch/interactive=1, su=2, cup=3, default=4`) + caps + reserve (`ceil(slots × 0.15)`) from
the live AIMD cap, and passes them to the gateway. Requests carry their role in `x-papercusp-priority`
(stamped at the spawn by `spawn-env`, flag-gated). **Two-process deploy caveat:** the gateway reads the flag
at startup (needs a restart); the spawn-env tagging rides the OPERATOR deploy — until BOTH are live, requests
are untagged → tier-4 and the reserve sits idle (harmless when account-limited, not slot-limited).

## SOURCE side — Mug capacity dispatch

`fleet/capacity-dispatch.ts`: `computeCapacityHeadroom(beeHeadroom, signal, config)` is PURE — it clamps the
fresh-spawn headroom by `factor = min(budgetLeg, queueLeg)`, forced to 0 when the pool is `paused`/`rejected`,
floored at `minHeadroom` (so high-priority work always flows; the tiers then prioritize it). The signal is a
projection of the gateway `/stats` headroom (`utilization`, `paused`, `rejected`, `queueDepth`). The
flag-gated wrapper `queenCapacityHeadroom` reads `QUEEN_CAPACITY_DISPATCH` + fetches the gateway oracle;
`fleet:place_batch` (place\_batch.ts) calls it right after `getSpawnHeadroom`, BEFORE `planBatchPlacement`, so
the clamp flows into the plan. Because the frontier is importance-ranked, clamping the headroom naturally
**defers the lowest-priority tasks first**. Config is env-tunable (`QUEEN_CAPACITY_{MIN_HEADROOM,
QUEUE_SOFT_CAP,UTIL_HIGH}`).

**Fail-safe everywhere:** flag-OFF, gateway-flag-OFF, or gateway-unreachable ⇒ NO clamp (the raw headroom).
Never strand the fleet on a missing/stale signal.

## Verified behavior (2026-06-22, live during a real crisis)

Gateway `/stats` read `utilization:1, paused:true, rejected:true` (all 8 accounts capped/throttled). The
oracle threw the right verdict: `headroom 20 → 2` (throttle to the floor — place only a couple of
high-priority cups instead of flooding the paused pool), `8 → 2`, `2 → 2` (already at floor). With the flag
OFF or the gateway unreachable it returns the raw headroom unchanged.

## Gotcha: the two flags activate on DIFFERENT processes

`GATEWAY_PRIORITY_TIERS` enforcement is in the **gateway** (`:8788`, staging tree — a gateway restart picks
it up) but its TAGGING is in the **operator** (spawn-env, release tree — rides the deploy).
`QUEEN_CAPACITY_DISPATCH` is entirely in the **operator** (`fleet:place_batch`) → activates on the operator
deploy. So flipping the flag defaults ON is correct and safe, but the live effect of each piece lands when its
host next picks up the code — verify per-process, not just per-flag.
