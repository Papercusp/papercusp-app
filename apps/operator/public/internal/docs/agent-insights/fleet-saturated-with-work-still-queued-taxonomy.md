# \"Fleet saturated with work still queued\" — a taxonomy of three distinct layers (EI-1711)
URL: /internal/docs/agent-insights/fleet-saturated-with-work-still-queued-taxonomy

The friction signature recurred 4× across harness:papercup and harness:papercup-hive because it names THREE independently-discovered, independently-fixed conditions at three different layers (Mug/cup placement throughput, work-item self-select claiming, and LLM inference-gateway admission) — never consolidated. This doc is the decision tree: which layer fired, what already-shipped diagnostic/fix applies, and when it is a real bottleneck vs an already-patched false alarm.

## Why this doc exists (EI-1711)

Overwatch's cross-harness friction detector flagged the signature `fleet hive papercup
queued saturated still with work` recurring 4× across 2 scopes (`harness:papercup`,
`harness:papercup-hive`) over 30 days. On investigation this is **not one bug** — it's
one **English phrase** that three independently-hardened subsystems each produce for a
different underlying condition. An agent who hits it once (say, the Mug throughput
breach) and generalizes that fix to the next occurrence (say, a gateway admission
starvation) will diagnose the wrong layer. This doc is the missing index.

## The three layers

| Layer                                  | Where it fires                                                                                                                                                          | Watchdog key                                                                      | What it actually means                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Mug/cup placement throughput**    | `pot/throughput.ts` `detectThroughputBreaches` (`kind:'starvation'`)                                                                                                    | `governor-starvation:<potSlug>`                                                   | Every cup slot in this **pot** is busy (`utilization>=1`) while its own **ready** frontier (`frontierDepth`) is >0 — the pot can't place more work until a cup frees a slot.                                                                                                                                             |
| **2. Work-item self-select claiming**  | `work_items/claim_next.ts` / `work-items.ts` `diagnoseClaimNextMiss` (EI-5803/EI-5919)                                                                                  | n/a (a per-call diagnosis, not a standing alarm)                                  | A bee's `claim_next`/`scheduler:get_next` came back empty, but the backlog is **not actually drained** — items exist, they're just gated (blocked / affinity-elsewhere / redundant-fanned / a lost race), so idling is WRONG.                                                                                            |
| **3. LLM inference-gateway admission** | `inference-gateway/gateway-wedge.ts` + [gateway-admission-starvation-below-ceiling](/internal/docs/agent-insights/gateway-admission-starvation-below-ceiling) (WI-3565) | `admissionStarved` (health panel / overwatch anomaly `gateway-admission-starved`) | The gateway's own admission queue is deep while `inFlight` sits **below** `maxConcurrent` — a provider/account floor is pinning concurrency low even though idle healthy accounts exist. Nothing to do with work-item claiming at all; agents are already claimed and RUNNING but their LLM calls themselves are queued. |

These are genuinely different resources being exhausted (cup slots vs. claimable-item
gates vs. LLM-call admission slots) — a fix at one layer does nothing for the others.

## Layer 1 — Mug/cup throughput starvation: already hardened against 4 false-positive classes

`detectThroughputBreaches` fires `kind:'starvation'` when `cupsCap>0 && utilization>=1 &&
frontierDepth>0` (and NOT `saturatedOnlyByOwnerCeiling` — a pot pinned at an
owner-configured `maxCups` below the system ceiling is by-design at capacity, not a bug).
Before treating this as a real bottleneck, know it survived four rounds of false-alarm
hardening — check whether your case is actually one of these (already fixed, so if you're
running current code you shouldn't hit them, but they're the reason the surviving signal
is trustworthy):

1. **WI-267** — `frontierDepth` used to be a *workspace-wide* `todo` count with no
   `item_kind`/`taken_by`/cursed-exclusion/pot-membership filter, so one pot's queued work
   fired an identical false alarm on every OTHER pot in the workspace. Fixed:
   `countPlaceableFrontier` is scoped to the pot's own member harnesses and mirrors the
   real placement WHERE clause.
2. **EI-12461** — a `blocked_by`-chained wave sat "placeable" (by shape) for hours of
   correct zero-placement and fired a phantom stall. Fixed: gate on
   `potReadyFrontierDepth` (readiness-refined), not the raw placeable-shaped count.
3. **EI-13076** — a silently-failing `spawned_agents` read (a broken date serializer)
   zeroed `placements`/`completed`/`stuck` for the table's whole history with no signal.
   Fixed: fail-soft stays (a tick must never break `routinesTick`), but the failure now
   `console.warn`s once per distinct message instead of vanishing.
4. **EI-13501** — the claim-hold exclusion in `countPlaceableFrontier` had drifted from
   `fetchFrontierRows`'s. Fixed: both mirror the same `claimHoldExclusionSql`.

**If you see this alarm today:** read the body — it names the exact lever (`raise the
fleet ceiling (rate-limit config) or widen the credential pool (D-006)`). Verify via
`fleet:assignments` / `dev:rate_governor_status` that cup slots really are all busy (not
another false-positive class not yet discovered) before acting.

## Layer 2 — claim\_next/get\_next "drained vs. gated" diagnosis (EI-5803/EI-5919)

A bare `null` from a claim attempt used to conflate two very different states: genuinely
**drained** (idling is correct) vs. **present-but-unclaimable** (blocked / wrong-swarm
affinity / redundant-fanned / a lost claim race — idling caps fleet throughput on a full
backlog). Fixed: a claim miss now runs a read-only `diagnoseClaimNextMiss` /
`diagnoseFleetScopeCooldownMiss` and returns a **self-describing** result:

* `pendingUnclaimed` (the admissible pool before readiness/affinity/redundancy floors) —
  `>0` means the miss was a **gate**, not an empty queue.
* `readyUnclaimed` (of that pool, how many pass every self-select floor) — `>0` on a miss
  means a **race/lost lease** (retry); `0` with `pendingUnclaimed>0` means the rest is
  genuinely blocked/gated (don't idle, but don't hot-retry either — see this repo's own
  fleet-member guidance: retry 2-3× before concluding `windDown`, matching the
  `backlog-drain-clean` claim-spec's own `windDown:true` miss shape).

**If you see this:** read the miss result's `pendingUnclaimed`/`readyUnclaimed` /
`windDown` fields directly rather than treating a bare miss as "nothing to do" — a fleet
scope miss (`fleetScopedMiss`) is not the same as a truly empty backlog.

## Layer 3 — gateway admission starvation below the ceiling (WI-3565)

Full incident + fix already documented at
[gateway-admission-starvation-below-ceiling](/internal/docs/agent-insights/gateway-admission-starvation-below-ceiling):
a deep gateway queue with `inFlight` sitting BELOW `maxConcurrent` the whole time (a
provider/account floor pinning admission, not AIMD) used to raise **zero** alarm — the
wedge detector's `saturated` signal requires `inFlight >= maxConcurrent`, which never
happens when the ceiling itself is the bottleneck. Fixed with an independent
`admissionStarvationRisk`/`admissionStarved` detector gated on idle healthy accounts (so a
genuinely full pool with zero idle capacity is correctly NOT flagged). Lever:
`operator:rate_limit_config { providerFloors: { anthropic: { maxConcurrent: <higher> } } }`
— verify idle capacity first via `dev:rate_governor_status`/`accounts:status`.

## Quick triage when you hit the phrase again

1. Is a **pot/Mug** reporting it (a throughput breach title, `governor-starvation:*`
   watchdog key)? → Layer 1. Check `fleet:assignments` for actual cup-slot occupancy.
2. Did a **bee's claim call** come back empty and you're about to conclude "no work"? →
   Layer 2. Read the miss result's diagnostic fields before idling.
3. Is the complaint really about **LLM calls** stalling (agents claimed + running, but not
   producing turns)? → Layer 3. Check `dev:rate_governor_status`/`accounts:status` for an
   idle-but-floor-capped provider.

If none of the above matches, this may be a genuinely NEW manifestation — file it as its
own issue rather than assuming it's a duplicate of one of these three; this taxonomy
should get a 4th row before the phrase becomes ambiguous again.
