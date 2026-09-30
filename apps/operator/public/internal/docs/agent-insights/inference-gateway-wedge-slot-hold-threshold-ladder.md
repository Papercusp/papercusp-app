# Inference-gateway wedge: bound EVERY admission-slot-hold path below the self-heal / watchdog ladder
URL: /internal/docs/agent-insights/inference-gateway-wedge-slot-hold-threshold-ladder

The gateway restart-storms (watchdog WEDGE every ~6min — or a multi-minute freeze when the watchdog exhausts its hourly restart budget) whenever ANY code path lets a request hold its admission slot longer than the self-heal (75s) / watchdog (120s) thresholds. There are THREE such paths and they were fixed ONE AT A TIME (2026-06-20): the 429-absorb wait, the transport-STALL retry (catch-block — it bypassed the 429 deadline), and the non-streaming 5-min headers wait. The durable principle is one threshold LADDER: internal-retry deadline (60s) < self-heal (75s) < watchdog (120s), and EVERY slot-hold path must respect it. A wedge is a BUG; forwarded 429/503s under load are CAPACITY (a different problem).

## TL;DR

A gateway WEDGE = `inFlight >= maxConcurrent` + `totalRequests` FROZEN + a growing queue, sustained ≥120s →
`watchdog.mjs` full-restarts `:8788` (\~15-30s of fleet-wide connection-refused = an "API error" across
sessions). If the watchdog exhausts its hourly restart budget, the gateway stays frozen for many minutes
(observed: a single 27-minute freeze).

The wedge forms whenever a request HOLDS its admission slot longer than the safety thresholds. The durable
fix is to make every slot-hold path respect ONE ladder:

```
INTERNAL_RETRY_DEADLINE_MS (60s)  <  DEFAULT_SELFHEAL_FREEZE_MS (75s)  <  watchdog FREEZE_MS (120s)
```

## The three slot-hold paths (all in `gateway.ts`; fixed 2026-06-20, one at a time)

The first fix bounded ONLY path 1 — and the gateway kept wedging every \~6 min. **The lesson: enumerate
ALL the paths that can hold a slot, not the first one you find.** A `tsc`-clean, tests-green fix that
addresses one path is still a band-aid if another path wedges.

1. **429-absorb wait.** A transient/bare upstream 429 makes the gateway rotate + WAIT (up to the 30s
   `TRANSIENT_TOTAL_WAIT_BUDGET_MS`) while holding the slot. Bounded by `INTERNAL_RETRY_DEADLINE_MS`: the
   `if (internalRetry)` decision sheds a retryable 429 once `Date.now() >= retryDeadlineAt`, and the
   transient wait is `Math.min(…, retryDeadlineAt - Date.now())`.

2. **Transport-STALL retry — the path the first fix MISSED.** Every account now egresses through a proxy,
   so EVERY Anthropic-wide TTFB stall enters the egress-circuit catch-block (`hasEgressProxy`), which
   rotated + `continue`d the loop with NO deadline check → chained up to `INTERNAL_RETRY_MAX_ATTEMPTS × ~60s` stalls = \~360s on one slot, bypassing the path-1 deadline entirely. Fixed: gate that retry with
   `&& Date.now() < retryDeadlineAt` → past the deadline it falls through to a fast retryable 503 that frees
   the slot.

3. **Headers wait.** `armStall(isStream ? streamHeaders(60s) : headers(5min))`. The NON-streaming headers
   timeout (5 min) alone is `>>` the 120s watchdog. Fixed: cap the HEADERS arm by `retryDeadlineAt -
   Date.now()` — **only the headers wait, NOT the body-idle**, so a healthy long STREAM that is making
   progress keeps its slot (body-idle resets on each byte).

## A FOURTH mode (different class): the stuck-stream slot leak

2026-06-21 — after the three retry/wait paths above were fixed, the storm wedges stopped (≥1.5 h clean),
but a SINGLE wedge surfaced with a *different* signature: `24/24 in-flight, 82 queued` frozen 120s with
**zero 429s, zero STALLED, zero fetch-failures** — only repeated SELF-HEAL reclaims of the SAME slot whose
held time kept GROWING: `slot #178, held 4800s → 4860s, stream=true`. **80 minutes** — well past the 20-min
hard ceiling. The reclaim AND the ceiling both `abort(currentAc) + res.destroy()`, yet the slot never freed.

Root cause: the streaming-body await resolved ONLY on `res` / `nodeStream` events —
`new Promise(resolve => { res.on('finish'|'close'|'error', resolve); nodeStream.on('error', …) })`. A stream
where the CLIENT is half-open (never emits res `'close'`) AND the upstream body has ended-or-hung (never
emits nodeStream `'error'`) pins its slot **forever**: the await does NOT listen to the abort signal, so the
self-heal reclaim and the 20-min ceiling — which both abort `ac` — are *ignored*. These leaked slots
accumulate until all 24 are pinned → freeze → wedge. Cadence \~1.5 h (slow leak), vs the 6-min storm cadence.

Fix: make BOTH streaming awaits (the `up.body` pipe AND the peeked-rest pipe) also force-tear-down + resolve
on the abort signal, so a reclaim/ceiling actually frees a stuck-stream slot:

```
const onAbort = () => { try { nodeStream.destroy(); } catch {} try { res.destroy(); } catch {} resolve(); };
ac.signal.aborted ? onAbort() : ac.signal.addEventListener('abort', onAbort, { once: true });
```

Purely additive — it never fires for a healthy stream (which completes via res `'finish'` before anything
aborts `ac`). **The log TELL that distinguishes this mode:** a SELF-HEAL reclaim line whose `held Ns` GROWS
across reclaims of the SAME `slot #` (the abort isn't landing) — vs a healthy reclaim where the slot frees
and the next reclaim targets a different, younger slot. Generalizes the ladder principle: it is not enough
to *signal* an abort; every slot-hold await must actually *resolve on* that abort.

## Diagnose

* `journalctl --user -u papercup-inference-gateway-watchdog.service | grep WEDGE` → the restart cadence +
  the frozen signature (`totalRequests frozen @N, Q queued, inFlight/maxConcurrent for Ts`).
* **`inFlight > maxConcurrent`** in the WEDGE line = requests admitted under a higher AIMD cap, now STUCK
  after AIMD shrank — i.e. not completing (stall-driven, paths 2/3). **`inFlight == maxConcurrent`** at the
  AIMD floor = the 429-squat (path 1; see [the admission-slot-squat doc](./inference-gateway-wedge-admission-slot-squat)).
* `journalctl … -u papercup-inference-gateway.service --since '-15 min' | grep -oiE "STALLED|upstream 429|fetch failed" | sort | uniq -c` — STALLED dominating ⇒ stall paths; 429 dominating ⇒ path 1 or capacity.

## Related admission failure: a per-account quota-429 must NOT throttle GLOBAL concurrency (2026-06-21)

Symptom: cups get frequent "API error" **even though `accounts:status` shows accounts with headroom**
(e.g. 5/8 at 9-44% 5h-util while 3 are at 98-99%). Owner: "the router should be smart enough to use the
account with budget." It already is — this is NOT a routing bug and NOT capacity.

Root cause: the AIMD controller's throttle signal was wired to EVERY upstream 429. `active()` round-robins,
so \~3/8 of requests transiently hit a 98-99%-maxed account → a per-account **quota**-429 → which the gateway
**routes around fine** (governor predictive-pause ≥0.95 + the route-to-capacity walk + failover rotation).
But each of those routed-around quota-429s ALSO called `aimd.recordThrottle()`, so the GLOBAL admission
concurrency collapsed to the AIMD **floor** (`effective=4, queued=34, decreases=3`). Requests then timed out
in the admission queue (`maxQueueWaitMs`) → a synthetic 429 = the cup "API error" — **before the correct
budget-aware routing ever ran.** With per-account egress IPs, one account's quota says nothing about the
others' capacity, so shrinking GLOBAL concurrency is exactly the wrong response.

The tell: `/admin/config` (or `gateway:status`) shows `aimd.effective` pinned near the floor + `queued` high

* `decreases` climbing, while `accounts:status` shows real headroom on several accounts. Admission choke, not
  routing.

Fix (`gateway.ts`): defer `aimd.recordThrottle()` from "every 429" to fire ONLY for a 429 that could NOT be
routed around to a healthy account (a `routedAround` flag set when `pool.onExhausted` returns a different
healthy account). A per-account quota-429 that fails over is a ROUTING event, invisible to global AIMD;
genuine pool-wide saturation (no healthy account) still shrinks it. **Do NOT** add a redundant pool-level
utilization-skip — the governor already pre-emptively pauses ≥0.95-util accounts (`UNIFIED_PREDICT_PAUSE_WATERMARK`),
and a hard skip would under-utilize Max 5h/7d rolling windows that recover continuously.

## Wedge vs capacity — do NOT conflate

A WEDGE is a gateway BUG (a slot-hold threshold inversion) — fix it in code and verify the watchdog stops
restarting. Forwarded 429/503s to cups under heavy opus demand are CAPACITY: the account pool can't serve
the load; the gateway can only PACE / shed gracefully. Levers: add Max accounts, pace the fleet
(`maxSimultaneousAgents`), or route some load to Sonnet. The wedge fix removes the catastrophic
connection-refused blips — it cannot manufacture quota.

## Verify a wedge fix for REAL (not prematurely)

The gateway runs `tsx` from the working tree, so `systemctl --user restart
papercup-inference-gateway.service` loads the edit. Then WATCH `wedges-since-deploy` over a window LONGER
than the prior restart cadence (wedges every \~6 min → watch ≥15 min). **0 wedges across the window +
`totalRequests` climbing = fixed.** A calm window (no stalls/429s) is NOT proof the fix works — the storm
paths are covered by the `gateway.test.ts` chaos tests instead, so lean on those plus the watch.

## Related: hot-reload the pool with NO restart (B-GW-HOT, 2026-06-20)

Account/egress changes used to need a gateway restart (the pool was resolved once at boot — swapping one
bad account took two restarts). Now the gateway hot-reloads the DB pool: a 60s poll + `POST /admin/reload`

* the `gateway:reload` agent tool (`gateway:status` reads `/admin/config`). So `accounts:register` /
  `accounts:remove` / an egress change applies live — `accounts:register <x>` → `gateway:reload` →
  `gateway:status` (confirm the config `version` bumped). The atomic swap is `createFailoverPool(...).reload()`
  (account-failover.ts) driven by `reloadPool()` in launch.ts.
