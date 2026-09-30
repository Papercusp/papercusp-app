# \"We hit the rate limit\" is usually account-routing, not real capacity
URL: /internal/docs/agent-insights/rate-limit-is-usually-account-routing-not-capacity

Papercusp runs LLM inference over a POOL of many Anthropic accounts behind an inference gateway with a per-account rate governor, so a true usage/quota wall is rare. Agents keep mis-reading a routing/config fault as exhaustion ('we hit the account limit', 'session limit', 'exceeded max wait', a 429) and give up. Several faults masquerade as a limit: (1) the account-aware routing is gated behind INFERENCE_GATEWAY + INFERENCE_GATEWAY_MULTI_ACCOUNT flags — OFF → spawned cups get no PAPERCUSP_ACCOUNT_ID → the governor keys the account-BLIND global anthropic:opus bucket → one account's 429 pauses it fleet-wide even with 6 idle accounts ('rate-limit pause exceeded max wait', exit 1, ~30ms, $0); (2) the gateway pools only some accounts — selectSpawnAccount pins a cup to a healthy account via x-papercusp-account, but if that account isn't in the gateway's pool the header is ignored and it falls back to its exhausted active() account, so the cup HANGS at $0. Verify with dev:rate_governor_status / accounts:status / the cup's /proc env / the gateway /healthz before concluding a limit.

## The mistake this prevents

Agents (including capable ones) repeatedly conclude **"we've hit the account / session /
usage limit"** the moment they see a `429`, a `rate_limit_error`, `"You've hit your
session limit"`, or `agent governor: rate-limit pause exceeded max wait` — and then give
up, throttle, wait hours for a "reset", or report the fleet as capacity-gated. **Almost
always there is idle capacity sitting on other accounts and the real cause is a
routing/config fault.** This was hit twice in one overnight session: an owner pushed back
with *"we have so many accounts, there is no way we're actually capacity-gated"* — and was
right.

## What's actually true (the multi-account system)

Papercusp routes **all** model calls through an **inference gateway** backed by a **pool of
many Anthropic accounts** (several Max subscriptions + a funded API key). A **rate
governor** paces and tracks **each account separately** (`anthropic:opus@<id>` buckets, not
just a global `anthropic:opus`). Aggregate capacity far exceeds any single account's limit,
so a genuine quota wall is rare. A spawned cup is supposed to be pinned to an available
account (`selectSpawnAccount` → `PAPERCUSP_ACCOUNT_ID` → `x-papercusp-account` header) and
the governor keys that account's bucket.

## The faults that masquerade as a limit

**1. Account-blind governor (the routing is flag-gated OFF).** In `operator-spawn.ts`,
`selectSpawnAccount` only runs when **both** `FLAGS.INFERENCE_GATEWAY` **and**
`FLAGS.INFERENCE_GATEWAY_MULTI_ACCOUNT` are on — and both default to `false`. With them off,
a spawned cup gets **no** `PAPERCUSP_ACCOUNT_ID`, so the spawn governor
(`orchestrator-runner.ts`) keys the **account-blind global `anthropic:opus` bucket**. One
account's 429 then pauses that bucket **fleet-wide**, and every opus spawn fails
`agent governor: rate-limit pause exceeded max wait` (exit 1, \~30 ms, **$0**) **even with
six idle accounts.** Tell: `spawned_agents.error_message` is the governor string, the spawn
dies in tens of ms, and `dev:rate_governor_status` shows the **global** `anthropic:opus`
bucket paused while `anthropic:opus@<someaccount>` is not.

**2. The gateway pools only some accounts.** Even with the flags on, `selectSpawnAccount`
pins the cup to a **healthy** account (e.g. `ownerhandle10`) via `x-papercusp-account`, **but the
gateway only routes to accounts in its own pool.** If the pinned account isn't pooled, the
header is unknown → the gateway **falls back to its single `active()` account** — which may
be exhausted (`/healthz` → `unified.rejected: true`, high `upstream429`). The cup's request
then **hangs at $0** (alive, `status=running`, no model call) instead of failing fast. Tell:
the cup is alive but has **zero** `agent_usage_samples`, and the gateway `/healthz`
`accountId` ≠ the cup's pinned `PAPERCUSP_ACCOUNT_ID`.

**3. The bare/header-less 429 stuck-loop (a TRANSIENT throttle read as exhaustion).** Anthropic
returns two shapes of `429`, and they mean opposite things — read the headers, not just the
status. A **quota** wall carries `anthropic-ratelimit-*` (unified util/reset) and/or `retry-after`
**and `x-should-retry: false`**: you really are out, wait/route elsewhere. A **bare** 429 —
`{"type":"rate_limit_error","message":"Error"}` with **NO `anthropic-ratelimit-*`, NO
`retry-after`, and `x-should-retry: true`** — is a **short transient BURST throttle**: capacity
exists, Anthropic is literally telling you to retry in a moment. The gateway's 429 handler used to
treat the bare form as a **no-op** (no `penalize`, no failover), so the gateway **stayed on the
momentarily-throttled account and 429-looped every caller** — each cup's `claude` CLI then
retry-looped into a **$0 hang** (alive, no model call) while the six other accounts sat idle (the
"ownerhandle10 stuck-loop", 2026-06-17). Fixed in `gateway.ts`: a bare 429 now gets a SHORT bounded
penalty (`BARE_429_FAILOVER_BACKOFF_MS`, \~15 s — tuned to the transient duration, NOT the multi-hour
unified reset) **and fails over** (`pool.onExhausted`), so the next request rotates to a fresh
account. Tell: `/healthz` `upstream429` climbs while `failovers` stays flat, the active `accountId`
never changes, and the 429 body is the bare `message:"Error"` form. **`x-should-retry: true` ⇒ this
is not a wall — retry / fail over, don't conclude exhaustion.**

**4. The PERSISTED penalty false-pause (a transient 429 → a 16-HOUR fleet-wide lockout).** The worst
one, and it SURVIVES RESTARTS. The governor's pause lives in `harness_shared.agent_rate_budget` (one row
per `bucket_key`, `paused_until` epoch-ms — `agent-governor-pg-store.ts`), SHARED by every operator + gym
process. When a `429` is classified `accountWide && !retryable` (the usage-cap path in
`resilience/retry.ts`), the handler calls `governor.penalize({ resetAt })` with `resetAt` = the
account's **rolling-window** reset (Claude Max 5h/**7d**). `recordPenalty` honored that reset FULLY
(no `maxPauseMs`), so a single transient 429 pinned the **account-blind** `anthropic:opus` (+ `sonnet` +
`haiku`) bucket to a reset boundary **\~16 h out** — locking the WHOLE fleet out of opus with **rpm 0/45,
$0, zero in-flight**, while `api.anthropic.com` direct-probes returned **200** (5h util 0.48 *allowed*,
7d 0.79 *allowed*). The tells: `dev:rate_governor_status` shows `paused:true` with `pausedUntil` a round
hour many hours out + `usage.calls 0 / $0`; the pause is identical across `:3070` and `:3170` (it's the
shared PG row); and a process restart does **NOT** clear it (the row reloads on boot — this is why
"restart the gateway" alone failed on 2026-06-17). A **rolling-utilization** window recovers
continuously, so sitting on its multi-hour reset is always wrong — `recordHeaders` already re-probes a
rejected unified window at `ROLLING_WINDOW_REPROBE_MS` (2 min); `penalize()` was the gap. **Fixed**
(`resilience/governor.ts`): `penalize()` auto-caps the pause at `ROLLING_WINDOW_REPROBE_MS` for a
subscription account (detected via `state.unified`), and bakes that cap into `opts` so the cross-process
PG write inherits it (the persisted row never carries `unified`, so an in-memory-only cap would still
write 16 h). **To CLEAR a live one** (no verb does it — `accounts:reset-rate` explicitly skips live
governor buckets, and they otherwise self-expire only at `paused_until`):
`UPDATE harness_shared.agent_rate_budget SET paused_until = 0, pace_delay_ms = 0 WHERE paused_until > <now_ms>`
— scoped to the future-paused rows; the next `acquire` reads it fresh, fleet-wide, no restart needed.

**5. The mid-turn death MISCLASSIFIED as a host fault (the GENUINE all-accounts throttle that never
shows up as a 429).** Faults 1–4 are config/routing faults where idle capacity exists. This is the one
case where the pool *is* (transiently) all-throttled at once — AND the only one that never reaches the
debugger as a rate-limit string at all, so it slips past this whole doc's framing. The shape: a blueprint
spawn (mug/worker) is recorded **`infra_loss: "<label> returned HTTP 200 but the agent produced no turn
(ok=false, exitCode=1, timedOut=false, outLen=18) — launcher host dead/unstable; recorded failed, not
retried (host stability is the fix)"`** (`durable-spawn.ts`, the HTTP-200-but-no-turn classifier). The
label sends you hunting a phantom host bug — **the host is fine.** The flight-recorder transcript
(`~/.papercusp/flight-recorder/unlabeled-claude-cfg-spawn-*/.../<sid>.jsonl`) shows the agent **ran
normally**: its **1st** gateway call succeeded (real cache-creation tokens, a tool call), it got the first
`tool_result` — then the process **exited 1 with EMPTY stderr mid-turn** on its **2nd** call. The gateway
route log at that timestamp (`PAPERCUSP_GATEWAY_ROUTE_LOG=1`) explains it. Two storm shapes trigger the
same death: (a) an all-accounts **429 storm** — `sustainedly limited … no-fresh-account` +
`all accounts transiently throttled on <model> → wait Nms`; or (b) the **dominant** one — a **transport-STALL
storm** (`upstream fetch STALLED (aborted) … no activity for Nms`), which does **NOT** increment
`upstream429`, so the death can land in a window that looks 429-calm (`upstream429` flat). The
1st call slipped through a calm window; the 2nd hit the storm; the in-request **stall-absorb** budget
(`PAPERCUSP_GATEWAY_REQUEST_ABSORB_MS`, \~120 s) ran out → the `claude` CLI got an error and died, producing
only its bootstrap log lines (stripped by `extractAgentOutput`) → `outLen` ≈ 0. Tell: `spawned_agents`
rows for blueprint roles all `failed` with the `infra_loss … no turn … host dead/unstable` string and
**wildly varying `duration_ms`** (a few hundred ms to many minutes — the absorb hold), while the host's
own services are healthy and the gateway `/healthz` `aimd.pressure` oscillates (calm when you check, but
the route log shows storms at the death timestamps). Unlike 1–4 this genuinely is capacity — but it's
**transient** (the pool recovers; `pressure` returns to 0 with a growing `cleanStreak`), so the fix is the
same as always: **add accounts** (owner-authority) so `no-fresh-account` stops happening — NOT "stabilize
the host," and NOT "wait for a multi-hour reset." A reserved/pinned account (`x-papercusp-account` +
excluded from `selectSpawnAccount` rotation) gives a single workload a lane isolated from the fleet storm.

**6. The residual bare-burst that smoothing can't fix — a CLOUDFLARE EDGE per-IP throttle, not the account
rate.** After the account-rate fixes (RPM smoothing — spreads each account's per-minute allowance so it
can't fire as a sub-minute burst; `inference-gateway-stability-ownership-2026-06-23` P-002), a bare-burst
429 storm can *persist at a low per-account rate* (\~3.5 upstream-calls/min/account, **13× under** the
`DEFAULT_FLOORS.anthropic` 45/min floor) with **no util headers** across all accounts. Smoothing is a NO-OP
here (at \~17 s natural spacing its 1333 ms pace floor never binds) — because this is **not** the account
budget at all. The gateway already tags the provenance; read it in journald
(`journalctl --user -u papercup-inference-gateway.service`):
`upstream 429 → internal retry … on '<acct>' [429-shape=bare-burst x-should-retry=true retry-after=-ms
util5h=- util7d=-] [bare-burst-origin server=cloudflare cf-ray=…-EWR org=…]`. **`server=cloudflare` +
`cf-ray` + absent `util5h/util7d`** = the 429 was generated at the **Cloudflare EDGE** (a per-IP/colo
throttle), not by Anthropic's account-budget limiter (which would set `anthropic-ratelimit-unified-*`). Tell:
the bursts cluster on the SAME accounts whose **egress proxies are failing** (`/stats`
`egressFailsByAccount` high, `egressCircuitOpens` climbing) and on a couple of `cf-ray` colos (e.g. LAX/EWR)
— i.e. it is keyed to the (flaky Rayobyte) **egress IPs**, not the account. The P-002 rate-pacer structurally
cannot reduce it, and the rotation-retry then **fans it out** (a bare-burst rotates 400 ms onto a fresh
account and re-fires un-paced → `upstreamCallsPerRequest`≈2; `bareBurstRotateSuppressed` shows the G1 damping
working but only once ≥half the pool is out). The fix is **egress-IP**, not account-rate: treat a
`server=cloudflare` bare-burst as a per-egress-IP throttle → cool/rotate the **egress IP**, fix/replace the
flaky proxy, and/or a per-egress-IP rate cap. Reproduce + measure any fix with the vitest rig
(`inference-gateway/load-test-rig.ts` → `runGatewayBurstRig`, reports `upstream429`/`failovers`/
`bareBurstRotateSuppressed`/`upstreamCallsPerRequest`).

> **⚠ Before you treat a header-less bare-burst as the egress-IP throttle, rule out its LOOK-ALIKE: missing
> Claude-Code framing** ([max-oauth-first-system-block-must-be-claude-code-identity](/internal/docs/agent-insights/max-oauth-first-system-block-must-be-claude-code-identity)).
> A raw-SDK / litellm / un-framed in-process caller gets the SAME header-less 429 (and `server=cloudflare` +
> `cf-ray` do NOT decide it — both modes can carry them). **Discriminator: framing is DETERMINISTIC** (\~100%
> of that caller's requests, on any IP, even a 1-token call at 0 load) — **the edge/egress throttle is BURSTY
> and load-correlated** (low overall rate, clusters under concurrency, its rate tracks per-IP volume; a
> whole-account `BARE-429 CIRCUIT` pause on a single-egress-IP account at util≪1 is THIS fault). Fastest
> test: flip an un-framed caller to framed — if that fixes it, it was framing; if a single framed request
> 200s while the fleet 429s under burst, it's the egress IP (this fault).

## The diagnostic recipe (do this BEFORE concluding a limit)

* **`dev:rate_governor_status`** — is the paused bucket the **global** `anthropic:opus`
  (fault #1) or a specific `@account`? Are other `@account` buckets unpaused?
* **`accounts:status`** — which accounts have headroom (`utilization`, `pausedUntil:0`,
  `sustainedlyLimited:false`)? If several are idle, you are **not** capacity-gated.
* **`harness_shared.spawned_agents.error_message`** for the failing spawn — `exceeded max
  wait` (governor, fault #1) vs `account 'X' paced/paused` vs `session limit`.
* **The cup's `/proc/<pid>/environ`** — `PAPERCUSP_ACCOUNT_ID`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_CUSTOM_HEADERS: x-papercusp-account` — which account/gateway did it **actually**
  use?
* **The gateway `/healthz`** (`:8788`) — its `accountId` + `unified.rejected`: is it stuck
  serving one exhausted account? Watch `upstream429` vs `failovers` (fault #3: 429s climb,
  failovers flat). For fault #5, `aimd.pressure`/`cleanStreak` oscillate — calm when you poll, but
  the **route log** shows `no-fresh-account` storms at the death timestamps.
* **A blueprint spawn recorded `infra_loss … no turn … host dead/unstable`?** (fault #5) Do NOT trust
  the "host" label. Open the flight-recorder transcript (`~/.papercusp/flight-recorder/…/<sid>.jsonl`):
  if the agent ran normally then stopped **mid-turn** (1st call OK, died on the 2nd), it's the gateway
  storm, not the host — cross-check the gateway route log at that timestamp.
* **`operator_rate_limit_config` (get)** — the fleet-wide `maxSimultaneousAgents` cap. If it's
  pinned LOW (e.g. **1**, the floor), the operator serializes governed spawns one-at-a-time —
  throughput looks "rate-limited" but it's a **config throttle**, not a quota wall, and with
  `cap == concurrencyFloor` the operator's own AIMD has no room to adapt. Often a leftover from an
  earlier firefight.

## The two governor processes — pace lives in BOTH, AIMD only in one

There are **two** governor singletons in **two** processes, and they are not the same:

* **Operator** (`:3070`/`:3170`): `initRateLimitConfig()` installs the finite
  `maxSimultaneousAgents` cap → the **AIMD adaptive concurrency** (rate-limit-layer-v2 D-005:
  multiplicative-decrease on `penalize`, additive-increase after clean streaks) IS active here.
* **Gateway** (`:8788`, `bin.ts → startGatewayService`): **never** calls `initRateLimitConfig` /
  `setGlobalConcurrencyCap`, so its global gate has no finite cap → fleet-wide **AIMD is DORMANT in
  the gateway**; only the *static* per-account governor runs there (`maxConcurrent: 3`, `rpm: 45`,
  `recordResponse` util-pacing, `penalize` pause). ⚠ You can't just install the operator's cap into
  the gateway: the operator cap is **agent-concurrency**; the gateway gate is **per-request
  concurrency** — copying `cap=1` would throttle the gateway to one in-flight HTTP request.
  Instead (2026-06-17) the gateway became a **resilient retrying proxy** — the practical fix that
  matters more than AIMD: on a throttle it doesn't just forward the error (cups have a tiny CLI retry
  budget that exhausts → `$0` fail), it **internally retries across the pool before responding**
  (`INTERNAL_RETRY_MAX_ATTEMPTS`): a transient/bare 429 → pace + rotate + short backoff; a **529** →
  short backoff; a **usage/session CAP** → `peekBody` the non-200 body (`classifyHttpError` → its meter
  is invisible in headers, util can read 0 on a capped account) → pause-to-reset + rotate to a healthy
  account (the cup classifies `usage_limit` as a no-retry wall, so the gateway MUST route around it
  itself). Net: a cup egresses opus through heavy 429 churn (seen: 497 upstream-429 / 409 failovers on
  one run) and still completes.

## The fix levers

* **Flags ON:** `papercusp-inference-gateway` + `papercusp-inference-gateway-multi-account`
  must both be enabled for per-account routing + per-account governor keying (fixes #1).
* **Pool all accounts in the gateway** (not just 1–2) so the `x-papercusp-account` header can
  route to any of them and it never falls back to one exhausted account (fixes #2).
* **Gateway resilient retry** (2026-06-17, `gateway.ts`) — internally retries/rotates across the pool
  on every throttle shape (bare-429, transient-429, 529, usage/session cap via `peekBody`) so a cup
  never sees a wall it won't retry (fixes #3 + the session-cap case).
* **SPAWN-side governor must not veto what the gateway can serve** (`dbos/orchestrator-runner.ts`,
  2026-06-17). A SECOND governor gates spawn ADMISSION (per-account bucket, `PAPERCUSP_AGENT_GOVERNOR=1`):
  when that bucket was paused past `maxWait` it failed the spawn `$0` with **"agent governor: rate-limit
  pause exceeded max wait"** — even with five idle accounts. Fix: when gateway egress is configured
  (`extraEnv.ANTHROPIC_BASE_URL` set), **proceed** and let the gateway's failover route to a healthy
  account instead of hard-failing. Tell: a cup dies in under 1s, `$0`, that exact `error_message`.
* **Not every bench `$0` is rate-limit** — the su-independent driver's `collectTask`
  (`external-bench/su-independent-backlog.ts`) used to read the diff/cost IMMEDIATELY after
  `placeFifoBatch` with no wait → empty diff + `$0` + `infra-failed` while the cup was STILL running
  (orphaning a live opus cup). Fix: poll `spawned_agents.status` to terminal before extracting (the
  real-Mug arm's DRIVER polls-until-drained; this arm didn't). Tell: cup `status=running` with a
  fresh heartbeat + climbing gateway requests, yet the launcher already recorded `infra-failed`.

## If you BUILD on the LLM

Build it **on the account-routing system** — route through the inference gateway / account
pool and let it spread load across accounts. **Never hardcode a single credential or assume
one account**; that is precisely how you manufacture a true rate/usage limit out of a system
that has plenty of headroom.

## See also

* \[\[llm-429-check-the-transport-not-the-account]] — the sibling flavor: a path-specific
  bucket (raw-OAuth vs claude-code CLI) in the llm-testing lane.
* The shared **`ACCOUNT_ROUTING_NOTE`** clause (orchestrator `prompt-build.ts`, re-exported
  to operator-core's `renderAccountRoutingNote`) now primes **every** agent prompt — the
  spawned-cup base, the operator-launched-role base, and the su playbooks — with this.
