# Inference-gateway: a stalled/429'd account is ONE OF THREE signals — never conflate them
URL: /internal/docs/agent-insights/inference-gateway-three-rate-signals-not-one

When an account fails in the gateway it is one of three DISTINCT things, each handled differently: (1) a TRANSPORT stall — a flaky Rayobyte egress proxy 60s-hangs (route around it, do NOT count it as account exhaustion); (2) a per-minute RATE 429 — a transient burst throttle (AIMD-decrease the account's LEARNED rpm and pace, don't just re-walk into it); (3) a token-budget USAGE CAP — 5h/7d window (switch accounts). Two 2026-06-22 bugs came from conflating these: the egress circuit's transport penalty was counted toward the account's sustained/exhaustion verdict (a flaky proxy falsely marked quota-healthy accounts exhausted + triggered paid scale-out), and subscription accounts had a STATIC rpm floor that could never learn down (a soft-throttled account re-429'd forever). Diagnose proxy-vs-account with curl -x <proxy>: a fast 401 = healthy proxy ⇒ the hang is account-side.

## The core idea

When an account "fails" at the gateway, it is **one of three different things**.
They look similar (a paused account, a non-200, a hang) but have *opposite* correct
responses. Conflating them is the bug class this doc prevents.

| Signal              | What it is                                                                                                                               | Correct response                                                                       | The wrong response (the bug)                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Transport stall** | the account's egress PROXY hangs (a Rayobyte squid CONNECT-hangs \~60s) — the request never reaches Anthropic                            | route AROUND the proxy (egress circuit + half-open probe); the account's QUOTA is fine | counting it as a rate penalty → falsely marks a quota-healthy account "exhausted" + triggers paid scale-out |
| **Rate 429**        | a per-minute / burst throttle (`x-should-retry:true`, no window headers) — capacity exists, the account is just going too fast right now | AIMD-decrease the account's LEARNED rpm and PACE to it; retry at the paced rate        | pace at a STATIC floor that can't learn down → re-walk into the same 429 forever                            |
| **Usage cap**       | a token-budget rolling window (5h / 7d, `x-should-retry:false` + window reset) — the account is genuinely out for hours                  | pause to the (bounded, re-probed) reset and SWITCH to another account                  | wait on the same account for hours, or treat it as transient                                                |

The tell that separates **transport** from **account**: `curl -x http://<proxy> https://api.anthropic.com/v1/messages -X POST -d '{}'`.
A **fast 401** (\~1–2s) = the proxy is healthy ⇒ any 60s "no activity" stall is **account-side**
(Anthropic holding the request — a soft-throttle), NOT a dead proxy. (A genuinely dead proxy
times out the curl.) Compare against a known-good account's proxy for a baseline.

## How the gateway encodes the distinction (2026-06-22)

The signal travels as a tag on the governor pause so every downstream consumer treats it right.

* `GovernorPauseEvent.source: 'penalty' | 'headers' | 'transport'` (governor.ts). A transport
  pause carries `source:'transport'`.
* `RateLimitGovernor.penalize({ transport?, rateLimited? })`:
  * `transport:true` (egress circuit, gateway.ts) — pauses the account so the pin yields + the
    selector routes around the bad proxy, but **skips the fleet AIMD shrink** (one bad proxy is not
    fleet-wide rate pressure) and tags `source:'transport'`.
  * `rateLimited:true` (the transient/bare-429 path, gateway.ts) — AIMD-decreases the account's
    learned `rpmFactor` (below). NOT set for a usage cap, NOT set for a transport stall.
* The account-pool exhaustion observer (`onGovernorPause` in account-pool-store.ts) **early-returns
  on `source:'transport'`** — so a proxy fault never feeds `penaltyCount`, never trips
  `isSustainedlyLimited` (account-pool.ts: ≥`sustainedPenaltyThreshold` penalties in the window),
  never emits `rate-limit:exhausted`, never triggers paid scale-out.
* `agent-governor-observer.ts` also skips `source:'transport'` — no false "rate-limited — paused" toast.

### Bug #1 it fixed (the false-exhaustion)

"Sustainedly limited / exhausted" trips on penalty COUNT (≥3 in 15 min), and the egress circuit's
transport penalty went through the SAME `gov.penalize → onGovernorPause → recordAccountPenalty`
path as a real 429. A flaky proxy (ownerhandle: 6% of its 5h token budget, but its proxy 60s-stalling)
racked `penaltyCount` to 32 → falsely "exhausted". Evidence the fix worked: the two flakiest-proxy
accounts dropped 60→2 and 32→5 penalties on deploy and the quota-healthy ones rejoined rotation.

## Adaptive per-account RPM (the per-account analog of the global AIMD)

The global concurrency AIMD (governor-registry `globalGate`, halve-on-penalty / +1-per-5-clean)
adapts HOW MANY agents run at once. It does NOT adapt each account's RATE. That was bug #2:

Claude-Max **subscription** accounts expose no per-minute headroom headers (`recordHeaders` only
tunes from API-key `anthropic-ratelimit-*`), so `limits.rpm` was a static **45 floor**. An account
Anthropic soft-throttled below 45rpm kept getting paced at 45 → kept 429ing, with no way to learn down.

The fix (governor.ts): a learned `rpmFactor ∈ [RPM_AIMD_MIN_FACTOR, 1]` per account (`GovernorState.rpmFactor`
/ `rpmFactorAt`).

* `decideRate` paces to `limits.rpm × effectiveRpmFactor(now)`.
* A rate-429 (`penalize({rateLimited:true})`) **halves** the factor — the prediction was too high.
* `effectiveRpmFactor` **recovers it linearly back to 1 over `RPM_AIMD_RECOVER_MS`** (default 5 min) —
  a transient throttle doesn't permanently cap the account; it probes back up.
* Env-tunable: `PAPERCUSP_GATEWAY_RPM_AIMD_{DECREASE,MIN,RECOVER_MS}`; set `MIN=1` to disable (no-op factor).

This closes the predict → wait → learn → retry loop: the existing rpm wait-gate already *predicts*
(holds a request until the window allows) and *retries at the safe time*; the missing piece was
*learning the prediction down when wrong*, which the factor supplies.

## Gotcha: the DEAD-PROXY watchdog alert can't tell proxy from account

`watchdog.mjs` logs `DEAD-PROXY: '<acct>' egress failing N%` when `egressFailRateByAccount` (a
volume-fair fails÷attempts rate in `/stats`) crosses ≥50% over ≥20 attempts. But a 60s account-side
hang is recorded as an "egress failure" exactly like a dead proxy — the gateway can't distinguish
them per-request. **So a DEAD-PROXY alert is NOT automatically a "pull the Rayobyte proxy" signal.**
Verify with the `curl -x` test above first: healthy proxy ⇒ it's account-side throttling (the
adaptive-RPM's job), not a proxy to escalate.

## When the pool IS exhausted — two more fixes (2026-06-22)

**Over-park.** An account-keyed bucket left a 429's pause UNCAPPED, so a TRANSIENT 429 (`x-should-retry:true`)
that carried a far-future rolling-window reset parked the account for HOURS (ownerhandle: live 429 was
x-should-retry:true, yet `pausedUntil` was \~7h). Fix (governor.ts `penalize`): a transient rate-429
(`opts.rateLimited`) caps the pause to `ROLLING_WINDOW_REPROBE_MS` even on an account-keyed bucket — re-probe in
\~2 min instead of parking for hours. A genuine usage cap (no `rateLimited`) still parks uncapped — the
sustained/scale-out signal keys off penalty COUNT, not pause length, so it's unaffected.

**Auto-wake coverage.** The stall-waker (`stall-waker.ts` + `ensureStallWakerLoop`) re-wakes an IDENTIFIED cup's
turn when its account recovers — *let them wait, then go through when capacity returns*. BUT `recordStall` only
fired on the rare fast-shed exit, so the dominant failures (egress-exhausted 503, forwarded upstream-429)
recorded nothing → `/admin/stalls` sat EMPTY while the whole pool was throttled → no cup was ever re-woken. Fix
(gateway.ts): `recordStall` now fires on every cup-facing retryable exit (egress-exhausted 503, token-stall 503,
forwarded 429/529) for a cup carrying `x-papercusp-owner`. **Caveat:** the waker only re-wakes a RESUMABLE
session (a watching coord wake-key); a one-shot turn whose process exited can't be woken (re-spawn-on-stall is
future scope). Verify it's working: `curl :8788/admin/stalls` should be non-empty when the pool is throttled.

## Holding the caller through a throttle instead of erroring (in-request absorption, 2026-06-22)

The autowake (above) re-runs a turn AFTER it fails (coordination-level — the caller DOES see the error, then
the session is re-woken). DISTINCT from it is IN-REQUEST absorption: the gateway holds the caller's open request
and retries behind the scenes so a TRANSIENT throttle is never surfaced as an error. Three nested budgets, each
bounded so a request can never hang:

* **Pre-admission wait** (`maxQueueWaitMs`, default 4 min, `PAPERCUSP_GATEWAY_MAX_QUEUE_WAIT_MS`): a request
  whose account is rate-paced parks — holding NO admission slot → cannot wedge — for the rate to clear before
  failing with a retry-after. A doomed request fail-fast-sheds (the soonest reset is beyond the window), so it
  never waits the full budget for nothing.
* **Post-admission slot-hold retry** (`internalRetryDeadlineMs`, 60 s): rotation across accounts + a 30 s
  transient-wait budget, bounded by the wedge-prevention ladder (self-heal 75 s / watchdog 120 s) — a request
  HOLDING a slot can never retry past this.
* **Post-admission ABSORB** (`requestAbsorbMs` / `PAPERCUSP_GATEWAY_REQUEST_ABSORB_MS`, default 0 = OFF; the dev
  box runs 2 min via the `.service.d/absorb.conf` drop-in): when the 60 s slot-hold deadline would shed a
  retryable TRANSIENT 429, instead RELEASE the admission slot (the re-acquire's wait holds NO slot → cannot
  wedge — the wedge ladder bounds SLOT-hold time, and none is held while parked), wait the throttle out,
  re-acquire, and retry — up to this budget. So the caller WAITS and succeeds instead of erroring. Three
  non-obvious correctness points: (1) it fires at the FORWARD point (`!proceed && transient`), NOT the
  deadline-shed — at the real deadline `proceed` is already false because the transient wait-budget clamps its
  wait to `retryDeadlineAt`, so a deadline-gated absorb would essentially never run; (2) gated on `transient`
  (short reset) so a multi-hour USAGE CAP is forwarded/switched, never absorbed; (3) the re-acquire waits up to
  the REMAINING ABSORB budget, NOT `maxQueueWaitMs` — the whole point is to out-wait the penalty pause (a 429
  paces the account `BARE_429_FAILOVER_BACKOFF_MS` = 15 s). Size `maxQueueWaitMs + requestAbsorbMs` \< the cup
  CLI's \~10-min SDK request timeout.

The HONEST CEILING: under a SUSTAINED throttle/overload longer than the absorb budget with zero free capacity,
the caller STILL eventually gets a (retryable) error — no in-request trick conjures capacity. Verified live
2026-06-22: a request held 113 s through an ownerhandle6+ownerhandle8 429 + 529 crisis (`absorb-retry … holding the
caller`), then forwarded a retryable 503 when the overload outlasted the 2-min budget. The absorb covers BOTH
transient rate-429s AND 529 SERVER-OVERLOADS: a 529 doesn't rate-pause the account (so the re-acquire would
return immediately), so the absorb backs off `OVERLOAD_529_BACKOFF_MS` (1 s) before each re-acquire rather than
hammering the overload. Only a multi-hour USAGE CAP is excluded (by `transient`) — those switch accounts /
get re-woken by the autowake, never held.

## The autowake (and the whole call path) is ROLE-AGNOSTIC (2026-06-22)

The rate-limit/retry/autowake machinery must behave the SAME for ANY caller — a harness cup, an su/psu engineer
session, anything holding a coord wake-key — not just cup spawns. The one role-specific gate was the waker's
idle-check (`StallWakerDeps.ownerIsIdle`, formerly `beeIsIdle`): it read ONLY `harness_shared.spawned_agents`
(cup spawns), so an su/psu session RECORDED a stall but was never confirmed-idle → never re-woken (the gap
su-b813f hit). Fix (stall-waker-loop.ts): `ownerIsIdle` now takes the most-recent activity from EITHER the cup
nursery's stream output (`spawned_agents`) OR `coord_presence.last_active_at` (EVERY coord agent has one, any
role). Everything else was already caller-agnostic: the wake (`forceEndTurn`/`wakeRecipients`) keys off the
coord owner-id, `recordStall` off the `x-papercusp-owner` header, `capacityBack` off the account. (The OTHER
`spawned_agents` readers — placement-gather, spawn-reclaim, spawn-tree — are correctly cup-FLEET operations, NOT
the call path, and stay cup-scoped.)

## What's genuinely external (not a gateway bug)

When most accounts are at their weekly cap and the one or two with headroom get Anthropic-side
soft-throttled, the pool is simply short of clean capacity. The gateway now degrades gracefully
(paces to learned rates, routes around bad proxies, fails fast instead of hanging) — but the durable
lever is **more accounts / weekly-window resets**, which is an owner action, not a code fix. Don't
manufacture hot-path changes on a healthy, converged gateway to chase a capacity shortfall.
