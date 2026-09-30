# Gateway pins are cache-affinity COMMITMENTS and tiers come from headers — the two traps that made pinned agents crawl or error
URL: /internal/docs/agent-insights/gateway-pin-and-tier-semantics

Two root causes behind 'pinned agents get API errors / 15-minute first turns despite available usage' (2026-07-01): (1) a spawn path that omits x-papercusp-priority drops the session into the default admission band — tier 5 — whose cap can be 1, serializing every first turn; the gateway now infers su/cup from the x-papercusp-owner prefix, but ALWAYS label spawns. (2) The soft-pin yield used to divert a pinned owner off its 97%-cache-hit account on load alone (inflight=1 was enough); it now yields ONLY when the pin is UNSERVICEABLE (paused / window-exhausted / all IPs cooled) and returns on recovery — diagnose with gateway:owner_report before blaming quota.

## Trap 1 — a headerless spawn lands in tier 5 (cap can be 1) and the whole cohort serializes

Admission tiers come from the `x-papercusp-priority` header
(`DEFAULT_GATEWAY_PRIORITY_MAP`: mug/interactive=1, su=2, cup=3, gym=4,
`default`=5). A launch path that never sets the header drops EVERY session it
spawns into the bottom band. On 2026-07-01 the interactive PSU pin path
(`bootstrap-su.ts`) did exactly that: ten pinned sonnet sessions → tier 5 →
per-tier cap **1** → 26-deep queue draining one first-turn (\~45 s each) at a
time → "15-minute first turns" that read like account trouble but were pure
admission starvation. Symptom fingerprint: `/stats` shows `byTier` with
everything queued in tier 5 while tiers 1–4 sit empty, and the journal fills
with `proxy handler crashed: aborted` (starved clients giving up).

Defenses now in place — keep both honored:

* `effectivePriorityLabel()` (gateway.ts) infers `su`/`cup` from the
  `x-papercusp-owner` id prefix when the priority header is absent, so an
  owner-bearing session can never fall to the default band again.
* The PSU pin/auto paths thread `priority: 'su'` explicitly. **Any NEW spawn
  path must set the priority label** (see `resolveSpawnGatewayEnv`'s `role`
  threading) — inference is the safety net, not the design.

In-process LLM callers (`gatewayLlmEnv`) send NEITHER header and legitimately
ride the default band — that is intentional (batch work), but it means the
default band's cap is shared by all of them.

## Trap 2 — soft-pin yield on load threw away the prompt cache

A pin exists for per-credential prompt-cache affinity (a warm session is
\~97% cache-read). The 2026-06-29 "load-aware" yield diverted a soft-pinned
request whenever a sibling looked lighter by more than a 0.5 credit — one
in-flight request (`key≈1.4`) or 84% utilization at inflight=0 was enough.
Every divert = a cold-cache first turn on the wrong account, which costs far
more than the queueing it saved, and to the owner it reads as "my pinned agent
is erroring / slow for no reason".

Since 2026-07-01 a soft pin yields **only when `keyOf() === Infinity`** —
governor/egress/rate-hint paused, 5h/7d window exhausted or rejected, or every
pooled egress IP cooled. Merely-busy pins queue + pace on their own governor.
Real saturation still degrades gracefully: 429 → escalating pause → keyOf =
Infinity → yield, and per-request re-evaluation returns traffic the moment the
pause lifts. A yielded response carries `x-papercusp-pin-yielded: <pin>-><served>` so the divert is a structured signal, never silent.

## Diagnose with data, not vibes

* `gateway:owner_report { agent: <owner-id> }` (or
  `GET :8788/admin/owner-report?owner=…`) — that agent's requests/ok/429s/
  sheds/stalls/pin-yields + recent events + last-routed account. No argument →
  top erroring owners. This answers "is it quota, transport, admission, or
  routing?" in one call.
* A rate-window 429 with `util5h≥1.0` and an hours-long, monotonically
  decreasing retry-after in the journal's `[429-shape=…]` suffix is a REAL
  account cap — pinning N sessions to one account can genuinely exhaust its 5h
  window; no gateway fix routes around that. Spread the cohort instead.

## The egress kill-switch — and the two look-alike transport failures

`gateway:egress_mode { proxy:'off' }` (or `curl :8788/admin/egress-mode?proxy=off`)
drops ALL datacenter-proxy egress and routes every account through the box's own
IP, live. The boot default is the `PAPERCUSP_GATEWAY_DISABLE_PROXY_EGRESS`
service env (drop-in `egress-proxy.conf`), so a durable flip needs BOTH. Flipped
off 2026-07-01 (Rayobyte squids at 11–66% transport-fail). Two traps learned
the hard way:

* **The default-parameter leak.** `dispatcherFor(account, eg = account.egress)` —
  passing an explicit `undefined` entry re-triggers the default, so proxy-only
  accounts kept dialing their squids in "off" mode. The kill-switch is now
  guarded INSIDE `dispatcherFor` (the chokepoint); never re-implement it at a
  call site.
* **"fetch failed" on DIRECT egress is usually DNS, not Anthropic.** Clustered
  same-second failures across DIFFERENT accounts = the box's shared resolution
  path, not any account/proxy. Fingerprint: `systemd-resolved` logging "Using
  degraded feature set UDP/TCP for DNS server `<router>`". The router resolver
  degrading caused box-wide ENOTFOUND bursts (green-checkpoint GitHub failures,
  interactive-session API errors). `FallbackDNS=1.1.1.1 9.9.9.9 8.8.8.8` is set
  in `/etc/systemd/resolved.conf.d/papercusp-fallback-dns.conf`.
* **Box-ip-only concentrates ALL egress on one IP** — expect the Cloudflare
  per-IP bare-burst rate to rise (watch `upstream429` + the
  `[bare-burst-origin …]` journal suffix). If it climbs, selectively re-enable
  the healthy squids (`proxy:'on'` — per-IP cooldowns route around the bad
  ones) rather than living with the per-IP squeeze.

## Related hardening (same plan)

Idle egress routes are health-probed proactively (45 s cadence) and circuit-
opened BEFORE live traffic burns on a dead squid (`proactiveEgressProbe` in
`/stats`). Mid-stream stalls end SSE responses with a structured
`overloaded_error` event instead of a socket reset. The stall-waker's auto-ESC
un-wedge never injects keystrokes into the desktop window the human is
FOCUSED on (Esc-Esc opens the Claude Code rewind picker — the accidental
conversation-restore failure), while unfocused fleet windows stay
auto-recoverable.
