# Capacity signals: policy verdicts are not measured walls
URL: /internal/docs/agent-insights/capacity-signals-policy-verdicts-are-not-measured-walls

Burn-governor THROTTLE/SHED are pacing projections, not measured walls. The evidence rule for claiming a provider pool is at capacity, and the five ways the capacity surfaces mislead a diagnostician.

## The incident (2026-09-01)

During the nonp2p-bug-drain capacity investigation, an su reported "the quota wall is real — 50×luna:max is a burn rate the burn governor will keep shedding" as an established cause. The owner challenged it. A full per-account read showed **6 of 7 codex accounts un-walled at util7d 0.52–0.63, admission lane `binding: null`, queue 0** — the claim was retracted (correction comment on WI-2034624). The same misread class drove the fleet leader's WI-218068 churn earlier the same day, in the *opposite* direction (an idle instant read as proven health). Two agents, one day, both directions: the surfaces themselves invite the error.

## The five ways capacity surfaces mislead

1. **Verdict words are policy, not measurement.** THROTTLE/SHED from the burn governor (WI-41147) mean "the governor *chooses* to pace or deprioritize this account because *projected* exhaustion precedes the window reset" (`exhaustsBeforeReset`). A THROTTLE has fired at utilization **0.02**. The watchdog broadcasts and the workspace facts folded into every orient carry these words with no disposition — so the first thing an agent reads about capacity is a policy decision dressed as an alarm.

2. **Provider mixing.** `accounts:status` interleaves providers. On 2026-09-01, five claude accounts sat usage-walled at util7d 1.00 beside codex rows at \~0.55 — visually one crisis. A codex fleet inherits none of the claude walls. Always project the table down to the fleet's provider before concluding anything.

3. **Bare counts with unread writers.** `codexHealthyAccounts: 3` reads as scarcity; its writer (`gateway.ts` `stats()`, grep `codexHealthyAccounts:`) counts "accounts that can serve right now" — pool/auth/reading health, not quota. A stale usage reading or an oauth-token-resolve failure removes an account from "healthy" with zero quota implication. Never cite a capacity-adjacent count without reading its writer; the `admissionState` model exists precisely because of this (every value is `{value, writer, unit, disposition}` plus a `binding` term naming the one thing actually holding a lane back).

4. **429 tallies are friction, not walls.** `gateway:owner_report` showed one member with 434 upstream 429s in 3,714 requests — and 3,708 eventual successes. Retry/failover absorbs burst throttles; a bare-429 storm with high eventual success proves the gateway is *working*. (Companion insight: `llm-429-check-the-transport-not-the-account`; a header-less 429 is a transient burst throttle — real quota exhaustion carries util/reset headers.)

5. **Survivorship instants.** "queueDepth=0, inFlight=0" was read as "no capacity problem" while half the fleet was parked — the queue was empty because the *askers had stopped*. An idle admission plane is evidence of headroom only when demand is present. Symmetrically, a full queue during a burst is not proof of a quota wall.

## The evidence rule

To claim "provider X is at capacity", cite ONLY:

* `accounts:status` rows **for provider X** with `usageWalled: true` and `readingStatus: fresh` (`available` already encodes `max(util5h, util7d) < DRAIN_FULL_UTIL 0.97`), or
* `gateway:status → admissionState` lane for X with `binding ∈ {pause, physical-contract}`, or sustained `queue.depth > 0` **with demand present**.

Everything else — governor verdicts, healthy-account counts, 429 tallies, other providers' walls, idle instants — is pacing, health, friction, or survivorship respectively. State which of the two admissible forms you hold; if neither, say "no hard evidence of a capacity wall" out loud.

## The right reads

* Per-account truth: `accounts:status` with `projection: { pick: ["accounts[].id", "accounts[].provider", "accounts[].usageWalled", "accounts[].rate.utilization7d", "accounts[].burn.action", "accounts[].readingStatus"] }` — then read only your provider's rows.
* Canonical admission: `gateway:status` → `admissionState.lanes[].binding` ("Nothing binds this lane" is a positive answer). Ignore the legacy sibling fields; the tool's own description marks them compatibility-only.
* Per-agent friction vs. stall: `gateway:owner_report` (ok vs upstream429 vs stalls).

## Mechanism fixes (filed as WI-2039612)

Disposition-stamped verdict strings at the burn-governor writer ("THROTTLE (pacing projection — NOT a measured wall; util7d 0.58)" vs "USAGE-WALLED (measured)"); a per-provider `poolVerdict` rollup on `accounts:status`; legacy `gateway:status` fields quarantined under `legacy:{}`; one registered state cell `capacity.<provider>.verdict` with a `binding` term off the same resolvers; and a reader-contract guard so a verdict string can never ship without its disposition.
