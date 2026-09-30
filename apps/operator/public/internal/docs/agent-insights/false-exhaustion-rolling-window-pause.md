# False exhaustion — a Max rolling-window rejection must NOT pause to the full reset
URL: /internal/docs/agent-insights/false-exhaustion-rolling-window-pause

Claude Max 5h/7d budgets are ROLLING-utilization windows that recover continuously — the `*-reset` is when the window fully clears, NOT when you can next send. Pausing a rejection (or a usage_limit) to that full multi-hour reset goes stale ("opus paused until 09:10 with zero pressure") and cascades into the account-pool reporting FALSE exhaustion + arming a paid scale-out. Fix = bounded re-probe + utilization-based exhaustion, both self-healing.

## Symptom

`dev:rate_governor_status` shows a governor bucket (e.g. `anthropic:opus`, `limitModel:
subscription`) `paused` hours into the future with **zero current rate pressure**, and
`accounts:status` reports an account `available:false` / `sustainedlyLimited:true` off a
**single** `penaltyCount:1` — even though the live gateway `/healthz` shows that account is
serving fine (`unified.rejected:false`, utilization \< 1). The owner sees "the account won't be
limited, why does it say exhausted?" It recurs every few hours.

## Root cause

A **Claude Max subscription budget is a ROLLING-utilization window** (5h + 7d). It recovers
*continuously* as old usage ages out, so the `anthropic-ratelimit-unified-*-reset` header is when
the window *fully clears*, **not** when you can next send — you can usually retry far sooner. Three
code paths treated a rejection as "pause until the full reset," which on a multi-hour window is
both over-conservative AND goes stale (it never lifts while paused, because no traffic flows to
bring a fresh header):

1. `recordHeaders` (resilience/governor.ts) — a `unified-*-status: rejected` hard-paused the bucket
   to `resetAt` (hours out).
2. The subprocess penalize (chat-stream.ts) — a CLI turn classified `usage_limit` ("5-hour limit ·
   resets 09:10") penalized the **global** bucket to that far reset.
3. The gateway (inference-gateway/gateway.ts) — on a unified 429 it *also* `penalize()`d to the
   full reset (on top of recordResponse), and it penalized on **529** (transient overload, not a
   rate limit) too.

That stale governor pause then fed the **account-pool projection** via `onGovernorPause` →
`recordAccountPenalty`, and `isSustainedlyLimited` had a `longPauseMs` branch: **a single pause
≥30 min out ⇒ "exhausted"** → `accounts:status` shows false exhaustion and the P-021 auto-scale-out
would provision a **paid** machine off one momentary rejection.

## Fix (D-003 / D-004, `inference-gateway-multi-credential-routing-2026-06-14`)

One principle everywhere: **a rolling-window rejection backs off a BOUNDED re-probe interval, then
re-probes — the next response's utilization is the truth.**

* `ROLLING_WINDOW_REPROBE_MS` (resilience/governor.ts, 2 min). `recordHeaders` bounds a unified
  rejection to `now + ROLLING_WINDOW_REPROBE_MS`; the real `resetAt` is kept on `s.unified` for
  observability + the failover rejoin time only.
* `recordPenalty(s, now, { …, maxPauseMs })` caps a far-future reset. chat-stream passes it for an
  **Anthropic** `usage_limit` (a non-Anthropic hard quota — codex/openai daily/weekly — keeps its
  full reset). The gateway no longer penalizes on 529 or double-penalizes a unified rejection.
* `isSustainedlyLimited` (deployment/account-pool.ts) no longer trips on a lone long pause. It is
  now self-healing: **fresh** unified utilization ≥ `EXHAUSTED_UTIL` (1.0) — which decays back below
  cap as the window recovers — OR a genuine penalty BURST (`sustainedPenaltyThreshold`, 3-in-window).
  `longPauseMs` is deleted. The utilization is the cross-process projection the gateway feeds via
  `recordAccountWindow` (the same projection the drain selector routes by).

## Related fault — a header-PINNED cup hangs at $0 on a paced account (D-005)

Sibling failure, same projection-vs-live-truth gap. The spawn chokepoint pins a cup to an account
(`x-papercusp-account`) chosen by `selectAccountByDrain`, which reads the cross-process BUDGET
projection. That projection **can't see the gateway's live pacing** — its penalty/pause data can lag
hours. So the selector cheerfully pins a cup to a low-utilization account that the gateway is
*currently* pacing/exhausting (observed: ownerhandle4 projection util 0.15 / penalties 2h stale, while the
gateway live-paced it). The gateway strict-honored the pin → no failover → the cup 429-loops into an
indefinite **$0 hang** (alive, zero model calls), while other accounts sit usable.

Fix (gateway.ts proxy, `PINNED_FAILOVER_WAIT_MS`): a pinned request whose account's **live** governor
is paused (pre-check) or can't admit within \~10s **fails over to `pool.active()`** (the failover-walked
healthy account). The pin still holds for the cup's later requests (re-checked each time → it returns
to its per-credential cache once the account recovers). **Cache-affinity yields to liveness.** The fix
is gateway-side ON PURPOSE: only the gateway has the live-pacing truth; a selection-side guard can't
see it. Edge: a bare framing-429 doesn't pause the governor, so the pre-check won't trip — CLI cups
frame themselves (real 429s → covered); a raw-SDK pinned caller could still loop.

## How to diagnose next time

If a subscription bucket is paused with no live pressure, or an account reads exhausted off
`penaltyCount:1`: it's a rolling-window over-pause, not a real cap. Check gateway `/healthz`
`unified.rejected`/`utilization` for the **active** account — if `rejected:false` and util \< 1, the
pause is stale. If instead a *specific* cup hangs at $0 while the fleet is fine, read its
`x-papercusp-account` header + that account's live gateway governor — that's the D-005 pinned-paced
fault. (Both are distinct from the framing-429 storm, where a raw `/v1/messages` on a Max OAuth token
429s unless the first system block is the Claude Code identifier — see that insight.)

Also operational: the gateway loads its account pool **only at boot** (no hot-reload) — after
registering/removing accounts you must restart `papercup-inference-gateway.service` to re-pool, else
it dead-ends on a stale subset. A standing durable improvement would be to hot-reload the pool.
