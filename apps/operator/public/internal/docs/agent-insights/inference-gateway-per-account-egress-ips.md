# Provisioning per-account egress IPs for the inference gateway (the per-IP → per-account capacity lever)
URL: /internal/docs/agent-insights/inference-gateway-per-account-egress-ips

Each Claude Max subscription can egress from its OWN outbound IP, so Anthropic's per-IP opus throttle becomes per-ACCOUNT — rotation actually works and aggregate RPM scales ~Nx with N accounts. The code is wired end-to-end (account-pool egress → resolver → gateway undici dispatcher); the owner provides the IPs/proxies. This is the step-by-step: provision N egress IPs (bound source IP or HTTP forward proxy), register each account's egress, restart the gateway, and verify per-account routing at three levels (unit test → socket → echo).

Anthropic enforces a meaningful slice of the opus rate limit **per source IP**. So when
N subscriptions all share one egress IP, the per-IP throttle caps the *whole pool* — the
extra accounts buy little headroom, and the "router is broken, accounts sit unused"
symptom recurs under concurrent opus load.

**Give each account its own egress IP and the per-IP throttle becomes per-account.**
Rotation/failover across accounts now multiplies real capacity (≈ N× aggregate RPM for N
accounts), instead of N accounts queueing behind one IP's limit. This is the single
biggest capacity lever for the consumer-Max basis.

## What is already wired (you do NOT need to write code)

The per-account egress dispatcher is wired end-to-end — `egress` flows from registration
to the actual upstream socket:

1. **Type + persistence** — `AccountEgress { proxyUrl?, localAddress? }` on each
   `ClaudeAccount` (`packages/operator-core/lib/deployment/account-pool.ts`),
   persisted in the single-row JSONB pool `harness_shared.operator_account_pool`.
2. **Registration** — the `accounts:register` MCP tool takes an `egress` object.
3. **Resolution** — `resolveAccountPool` / `resolveBoundAccount`
   (`inference-gateway/account-resolver.ts`) carry `egress` onto each resolved account.
4. **Launch** — `launch.ts` threads `egress` into each failover-pool entry.
5. **Egress** — per upstream attempt the gateway builds (and caches per-account) an
   **undici dispatcher** and passes it to the upstream `fetch`
   (`gateway.ts` → `dispatcherFor`):
   * `proxyUrl` (`http(s)://`) → `new ProxyAgent(proxyUrl)`
   * `localAddress` → `new Agent({ connect: { localAddress } })`
   * the dispatcher is keyed `<accountId>|<proxyUrl>|<localAddress>`, so each account
     gets its **own** dispatcher (one stable egress IP per account) and a failover that
     rotates the account rotates the dispatcher too.

Wiring is covered by unit tests in `inference-gateway/gateway.test.ts`
("per-account egress isolation…") and `account-resolver.test.ts`
("carries each account egress through…").

**The owner provides the IPs/proxies** (owner-gated infra, like the credentials
themselves). Everything below is "plug the IPs in".

## Choose a provisioning approach

Both forms are natively supported. Pick by what infra you have.

### A. Bound source IPs (`localAddress`) — simplest when the host has N public IPs

The box already has multiple public egress IPs (e.g. several elastic IPs / a /29 on the
NIC). Bind each account's upstream socket to a different one. No proxy process to run.

* Pro: zero extra infra, lowest latency, no proxy to babysit.
* Con: all IPs must terminate on (or route out of) **this** host; you need N genuinely
  distinct *public* egress IPs, not N private addresses that NAT to one public IP.

### B. HTTP / HTTPS forward proxies (`proxyUrl`) — when the IPs live elsewhere

Run (or rent) N forward proxies, each exiting from a different public IP, and point each
account at its own. The gateway routes that account's upstream through it via HTTP
CONNECT (undici `ProxyAgent`).

* Pro: IPs can live anywhere (other hosts, a proxy provider, datacenter egress IPs).
* Con: a proxy hop + you operate/trust the proxies. Use `https://` proxy URLs (or a
  private network) so the OAuth Bearer never crosses an untrusted plaintext hop.
* Self-hosting one IP per proxy: `tinyproxy`/`squid`, one instance per egress IP, e.g.
  `tinyproxy` with `Bind <egress-ip>` + `Allow 127.0.0.1`.

> **SOCKS is not yet supported.** undici's `ProxyAgent` only speaks HTTP CONNECT. A
> `socks://` / `socks5://` `proxyUrl` is **ignored** (the gateway logs a warning and
> falls back to `localAddress` if set, else the default shared egress) — it will NOT
> silently break the account, but it also won't tunnel. Native SOCKS egress is tracked
> in **WI-284**. Until then use a bound IP or an HTTP proxy.

## Steps

> Run MCP tools as the operator/superuser (the `papercusp-su` server). The gateway's
> workspace is `papercusp-workspace` (`PAPERCUSP_WORKSPACE` in its unit).

### 1. Provision the IPs (owner)

Stand up N distinct public egress IPs as either bound host IPs (A) or forward proxies
(B). Note, per account, the **value** to register: a `localAddress` IP or a `proxyUrl`.

### 2. Register each account's egress

`accounts:register` is idempotent — re-registering an existing id keeps its
credentialRef/bindings/rate state and just updates `egress`. So you can add egress to
already-registered accounts without re-supplying secrets… but `credentialRef` is
required by the tool, so pass the account's current ref (see `accounts:list`).

Bound source IP (approach A):

```
accounts:register {
  id: "ownerhandle6",
  credentialRef: "<its current ref from accounts:list>",
  egress: { localAddress: "203.0.113.21" }
}
```

HTTP forward proxy (approach B):

```
accounts:register {
  id: "ownerhandle6",
  credentialRef: "<its current ref from accounts:list>",
  egress: { proxyUrl: "http://10.0.0.21:3128" }
}
```

Repeat for every account, each with its **own** distinct IP/proxy. Confirm:

```
accounts:list      # each account row now shows its egress
```

### 3. Restart the gateway to pick up the egress

The gateway resolves the account pool **once at startup** and holds it for its lifetime
(a rebind is a restart, by design). An egress change is NOT hot — restart the service:

```bash
systemctl --user restart papercup-inference-gateway.service
# confirm it came back
curl -s http://127.0.0.1:8788/healthz | head -c 200
journalctl --user -u papercup-inference-gateway -n 20 --no-pager   # "up on 127.0.0.1:8788 → account '…'"
```

### 4. Verify per-account routing (three levels)

**Level 1 — wiring (already green, no IPs needed).** The unit tests prove account X →
X's dispatcher and that the resolver carries egress:

```bash
cd packages/operator-core
npx vitest run lib/inference-gateway/gateway.test.ts lib/inference-gateway/account-resolver.test.ts
```

**Level 2 — transport (the live gateway is actually using the egress).**
The route trace is already on (`PAPERCUSP_GATEWAY_ROUTE_LOG=1` in the unit) — it logs
`gw-route: … want=<pin> picked=<account>` at the route-decision point (not necessarily the account
that ultimately served the response), and every response carries
`x-papercusp-routed-account`. To see the **egress IP** in use:

* Bound IP (A): inspect the gateway's upstream sockets — the local source address of
  each established connection to Anthropic should be the account's bound IP:
  ```bash
  GW_PID=$(systemctl --user show -p MainPID --value papercup-inference-gateway.service)
  ss -tnp 2>/dev/null | grep -w "pid=$GW_PID" | grep ':443'   # LocalAddress = the bound egress IP
  ```
* Proxy (B): the per-account proxy's own access log shows that account's CONNECT
  requests arriving (one proxy per account disambiguates which account routed where).

**Level 3 — definitive per-account egress IP (controlled echo, gold standard).**
Because the prod gateway proxies to `api.anthropic.com`, you cannot echo your own IP
through it. Spin up a **throwaway** gateway pointed at an IP-echo upstream, pinned to one
account, and read back the IP it egresses from:

```bash
# one account at a time; repeat per account and confirm the IPs differ
PAPERCUSP_GATEWAY_PORT=8799 \
PAPERCUSP_WORKSPACE=papercusp-workspace \
PAPERCUSP_ACCOUNT_ID=ownerhandle6 \
ANTHROPIC_BASE_URL_UPSTREAM=https://api.ipify.org \
  npx tsx packages/operator-core/lib/inference-gateway/bin.ts &

curl -s http://127.0.0.1:8799/         # → the egress IP for ownerhandle6 (proxy exit IP or bound IP)
# kill the throwaway gateway when done
```

`api.ipify.org` ignores the injected OAuth headers and returns the source IP as seen at
the far end — so a different IP per account is the end-to-end proof. (Use any echo
endpoint you trust; a self-hosted `/ip` echo avoids a third party.)

## Gotchas

* **Restart is required after an egress change** — the gateway caches the resolved pool
  for its lifetime. Forgetting the restart = your new egress silently does nothing.
* **N genuinely distinct PUBLIC egress IPs.** N private/NAT addresses that all egress
  from one public IP buy you nothing — Anthropic sees the one public IP. Verify with
  Level 3 (different account → different returned IP).
* **One stable IP per account.** The dispatcher is cached per account, so an account's
  cups all share one egress IP (good — that IP carries that account's cache/affinity).
  Don't expect per-request IP rotation *within* an account; rotation is *across*
  accounts.
* **HTTPS proxy URLs (or a private link) for approach B** — an `http://` proxy on an
  untrusted segment would expose the OAuth Bearer on the CONNECT hop.
* **SOCKS is ignored, not honored** (WI-284) — a `socks://` proxyUrl falls back to
  `localAddress`/default egress with a warning in the gateway log.
* **The Claude Code identity framing is already handled** — the gateway injects the
  OAuth Bearer + `oauth-2025-04-20` beta; real `claude` cups frame their first system
  block. (A raw curl straight at Anthropic without that framing hits a bogus instant
  429 — see `rate-limit-is-usually-account-routing-not-capacity`. The echo test above
  goes to ipify, not Anthropic, so it is immune.)
* **Failover still works with egress on** — `dispatcherFor(active)` runs per upstream
  attempt, so when the pool fails over to a healthy account, that account's egress
  dispatcher is used for the retry. Egress and failover compose.

## Dead-proxy circuit breaker (a half-dead egress IP must not wedge the gateway)

Per-account egress adds a new failure mode: **the proxy itself can die.** On 2026-06-20 a
Rayobyte squid (`ownerhandle6` → `216.41.233.249:3128`) went *half-dead* — its TCP port stayed
open but every `CONNECT` **hung \~60s**. That wedged the **whole** gateway into a
watchdog-restart storm, and the cause was subtle:

* The gateway's account health/penalty signal was **429-only**. A dead/hanging proxy makes
  the upstream `fetch` **stall or fail to connect** — a *transport* failure that never
  reaches Anthropic, so it carries **no HTTP status** and (unlike a 429) fed **zero**
  account-health signal.
* So the dead-egress account accrued **no penalty** → the router scored it **"healthiest"**
  → routed the **most** traffic to it **and** overrode session pins onto it ("yields to
  liveness"). Pinning to good accounts didn't help; the dead account kept getting flooded.

**The fix** (`gateway.ts`, the upstream-fetch `catch`): a transport failure on a
**proxy-egress** account now feeds the **same `gov.pausedUntil` lever the 429 hard-cap
uses**, so the existing pin-yield + cross-account selector route around it automatically. A
**consecutive-failure streak** (`EGRESS_FAIL_CIRCUIT_THRESHOLD`, default 3) opens a longer
**circuit** (`EGRESS_CIRCUIT_OPEN_MS`, default 20s — a proxy that **re-opens** within `EGRESS_FLAP_RESET_MS` of its last open is treated as chronic, so its open window **doubles each reopen**, capped at `EGRESS_CIRCUIT_OPEN_MAX_MS`); the request then **rotates + retries**
on a healthy account instead of returning a terminal 502. The streak resets on any upstream
response (so the half-open is natural: the pause expires → the next request re-probes the
account → success closes the circuit, a failure re-opens it), plus an **active half-open
probe** (`egress-probe.ts`) re-tests the proxy and logs/clears the streak on recovery.

* **Scoping matters.** The circuit is **only** armed for accounts that egress through an
  `http(s)` proxy — only those can have a *dead proxy*. A transport failure on a **no-proxy**
  account is an Anthropic/network-side stall (the proxy can't be the fault), so it keeps the
  existing **fast-502** (the cup's CLI retries; AIMD shrinks concurrency) and its healthy
  account is **not** penalized.
* **`pausedUntil` is take-MAX** (the shared governor's `recordPenalty` only ever *extends* a
  pause, never shortens a real 429/usage-cap pause). The half-open probe tracks the **transport**
  pause separately (`egressPauseUntil` / `gov.liftTransportPause`), so on recovery it **lifts that
  pause immediately** and readmits the account — a flapping proxy that recovers in seconds rejoins
  in seconds, not at the full circuit-window expiry (a 2026-06-21 change; before it, a recovered
  account waited the whole window, which kept the only token-healthy accounts out together).
* **Observability:** `GET /stats` → `egressCircuitOpens` counts how many times a proxy hit
  the threshold. A climbing value = a flapping/dead proxy IP (distinct from `upstreamErrors`,
  which also counts Anthropic-side stalls).
* **Diagnose a suspect proxy directly** (bypasses Anthropic + the gateway):
  `curl -sS -x http://<ip>:3128 -m 8 https://api.ipify.org` — a healthy dedicated proxy
  echoes **its own IP**; a dead one times out. (Sweep all N to find the bad one fast.)

Regression coverage: `inference-gateway/gateway-egress-circuit.test.ts` (dead-proxy account
fails over → 200 not 502; N consecutive failures open the circuit + return retryable 503,
never a wedge; a success resets the streak).

> **Don't just `accounts:remove` a dead-proxy account and call it fixed** — that only takes
> effect on the next gateway restart (the pool is resolved at boot), and it's a one-off that
> leaves the trap armed for the next dead IP. The circuit breaker is the durable fix; removal
> is emergency mitigation. To restore the account, either swap in a fresh proxy IP (re-register
> its `egress`) or rely on the circuit breaker to safely auto-handle the flapping one.

### Failure mode: a too-tight recovery-probe timeout false-keeps healthy accounts paused (2026-06-22, WI-389)

The breaker has a second-order failure that presents as **"all accounts throttled,
no-fresh-account"** with **cups hanging at boot (0 invocations)** — and it is NOT capacity:

* The active half-open probe (`egress-probe.ts` → `api.ipify.org`) had a **hardcoded 8s timeout**
  (`EGRESS_PROBE_HTTP_TIMEOUT_MS`). The dedicated proxies, when perfectly healthy, take **1.3-6.1s**
  under box load (one measured at 6.1s — within \~2s of the ceiling). Under load the 8s probe
  **aborts** on a healthy-but-slow proxy → logs `egress probe for '<acct>' STILL DOWN (operation
  aborted)` → the **recovered** account stays circuit-paused instead of being readmitted.
* When several proxies are slow at once (or a restart re-probes them together), the probe
  false-aborts across the pool → the gateway reads **"all accounts throttled / no-fresh-account
  (pausing as before)"** → every inference request parks → a freshly-spawned cup blocks in
  `ep_poll` on its **first** inference and wedges with **0 invocations** (looks like a "corpse").
  Routing was never broken — a `gw-route` to a serviceable account still succeeds in \<1s; the pool
  was *spuriously emptied* by false-negative probes.
* **Confirm it's a false negative, not a dead proxy:** `curl -x http://<ip>:3128 -m 12
  https://api.ipify.org` returns 200 in 1-6s for the "STILL DOWN" account (the probe lied). A
  genuinely dead proxy (real 9s+ timeout) is a *different*, correct circuit-open — don't conflate.

**The fix** (WI-389, `gateway.ts`): make `EGRESS_PROBE_HTTP_TIMEOUT_MS` env-tunable
(`PAPERCUSP_GATEWAY_EGRESS_PROBE_HTTP_MS`) and raise the default **8s → 12s** — kept under
`EGRESS_CIRCUIT_OPEN_MS − EGRESS_PROBE_DELAY_MS` so the probe still fits inside the open window. A
recovered-but-slow proxy now readmits via the probe instead of waiting out (or never clearing) the
circuit.

**Lesson:** a circuit-breaker's **recovery probe must tolerate the real, under-load latency of what
it probes.** A probe timeout tighter than the resource's slow-but-healthy case turns the breaker
from a safety device into a **stuck-open latch** — it false-keeps healthy capacity offline and
starves the pool exactly when load is highest. Size recovery-probe timeouts off the *slow-healthy*
p99, not the fast path.

## Egress IP POOL — rotate WITHIN an account (the per-IP-throttle fix)

> Added 2026-06-30 (`gateway-per-account-egress-ip-pool-2026-06-30`). The singular `egress`
> above gives each account ONE outbound IP. That is not enough when the throttle is a
> **Cloudflare per-IP EDGE throttle** (a `bare-burst` 429 — `429-shape=bare-burst`,
> `server=cloudflare`, `util5h=- util7d=-`, i.e. NO Anthropic ratelimit headers): the IP is
> rate-limited even though the **account budget is fine**. With one IP per account, a
> **hard-pinned** agent has nowhere to go — it waits/429s on its single throttled IP and the
> caller sees "constant API errors on an account with plenty of headroom" (owner-reported for
> a pin to `ownerhandle8`, util7d 0.18).

**The pool.** An account can carry `egressPool: AccountEgress[]` — an ordered list of egress
IPs the gateway **round-robins** the account's upstream across (a per-account cursor). Resolve
the effective list with `egressEntries(account)`: a non-empty `egressPool` wins; otherwise the
singular `egress` is treated as a 1-entry pool; a `{}` entry is a **valid distinct egress** = the
box's default outbound IP (this is how an account gets a second IP for free).

**Per-IP cooldown, not account pause.** When the IP used for an attempt hits a bare-burst 429
or a transport failure, the gateway **cools only that IP** (`ipCooldownUntil`, keyed by the
`egressCacheKey` = `accountId|proxyUrl|localAddress`) and **retries the SAME account/credential
on a sibling IP** — so a hard pin rides its own pool and cache-affinity (which is per-credential,
not per-IP) is preserved. The pre-existing account-level circuit (`gov.pausedUntil` — bare-429
persistence + transport circuit) now fires **only when ALL of an account's IPs are cooled**, so a
0/1-IP account is byte-identical to before. A bare-429 IP-rotate is a routing event
(`internalRetry.ipRotate` → `routedAround`), so it does **not** shrink global AIMD admission.

**Configure it** (same restart-to-apply rule — the gateway resolves the pool at startup + on its
poll):

```
accounts:register { id: "ownerhandle8", credentialRef: "<ref>",
                    egressPool: [ { proxyUrl: "http://216.213.24.64:3128" }, {} ] }   // proxy + box-direct
systemctl --user restart papercup-inference-gateway.service
```

Give each account **a few** IPs (the owner provisions clean ones; 3/account is the target) so a
single IP tripping Cloudflare's per-IP burst ceiling never takes the account out of rotation. Watch
it work: `journalctl --user -u papercup-inference-gateway.service | grep egress-ip-pool` shows the
`rotating to a sibling IP on the SAME account` lines.

## Programmatic provisioning — `egress:*` (B-PROV, WI-288)

> Added 2026-07-13. Everything above still applies for the common case — the owner hands you a
> proxyUrl/localAddress and you `accounts:register{egress}` it directly. This section is the
> AUTOMATION layer on top: `egress:provision/list/release/health`
> (`packages/operator-core/lib/agent-tools/egress/egress.ts`) draw a fresh egress IP from a
> pluggable `EgressProvider` backend (`inference-gateway/egress-providers/`) instead of you
> hand-picking one.

**Backends** (`provider` arg): `'static'` — a fixed owner-supplied IP inventory (`config.entries`);
the realistic near-term backend, since the 8 Rayobyte IPs running in production today were
provisioned exactly this way (manually, then hand-registered). `'rayobyte'` — REST-driven
order/list/label against Rayobyte's API (`config.baseUrl`/`config.apiKeyRef`, default
`env:RAYOBYTE_API_KEY`); **not yet exercised against a live Rayobyte account** — confirm the
`/proxies`, `/proxies/order`, `/proxies/:id/label` endpoint shapes against Rayobyte's current docs
before relying on it, and adjust `rayobyte-provider.ts` / `baseUrl` if they differ. `'brightdata'`
— stub only (the D-001 fallback path; wire it if/when the Rayobyte pool underperforms in the
clean-IP gate).

**One-call provision:**

```
egress:provision {
  provider: "static",
  accountId: "ownerhandle6",
  config: { entries: [{ id: "rayobyte-ip-9", proxyUrl: "http://216.213.24.70:3128" }] }
}
```

This allocates from the provider, writes the account pool (`accounts:register{egress}` equivalent,
tagged `providerId`/`providerAllocationId` so `egress:release`/`egress:health` can route back to the
right provider later), and runs the SAME post-apply verify probe `accounts:test-egress` uses
(`testEgressForAccount`) — so you get proof the dispatcher works *before* the restart below. Pass
`dryRun:true` to allocate + verify without writing the pool.

**The gateway restart requirement is unchanged** — `egress:provision` only writes the pool row +
proves the binding works standalone; the LIVE inference gateway still resolves its account pool once
at boot (see "Restart the gateway" above), so restart it to make the freshly-provisioned egress
actually route production traffic.

`egress:list {provider, config?}` / `egress:release {provider, id, config?, accountId?}` /
`egress:health {provider, id, config?}` round out the surface — `egress:release` with an `accountId`
also clears that account's pool egress IFF it currently points at the released allocation (a
provider/allocation mismatch leaves the pool untouched, so it never clobbers an unrelated manual
edit). Tests: `inference-gateway/egress-providers/*.test.ts` (each backend, fully mocked — no live
network) and `agent-tools/egress/egress.test.ts` (the tool-layer wiring).

## Rollback

Remove an account's egress and restart — it reverts to the default shared egress with no
other change:

```
accounts:register { id: "ownerhandle6", credentialRef: "<ref>", egress: {} }
systemctl --user restart papercup-inference-gateway.service
```

## See also

* `inference-gateway-wedge-admission-slot-squat` — the admission wedge runbook (a
  capacity-pressure symptom this fix relieves).
* `rate-limit-is-usually-account-routing-not-capacity` — a 429 is usually routing, not a
  real cap; per-account egress removes the per-IP confound.
* `llm-429-check-the-transport-not-the-account` — the missing-Claude-Code-framing instant
  429 (don't mistake it for exhaustion when testing egress directly).
* `bg-host-watchdog-false-restart-on-wedged-journald` — the *other* reason a cup dies at boot:
  not an egress-pause wedge (this doc) but a host restart reclaim-killing the in-flight spawn.
  Both present as "cups won't run"; `dev:session_detail` (0 invocations + `ep_poll` ⇒ egress wedge;
  "reclaimed at operator boot" ⇒ host restart) tells them apart.
