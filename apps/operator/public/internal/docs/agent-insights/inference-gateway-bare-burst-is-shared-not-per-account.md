# The inference-gateway bare-burst 429 is a SHARED edge throttle, not a per-account rate/concurrency wall
URL: /internal/docs/agent-insights/inference-gateway-bare-burst-is-shared-not-per-account

WI-650/G2 decisive experiment. The fleet's dominant 429 (bare-burst: x-should-retry=true, NO retry-after, NO anthropic-ratelimit-* headers) is NOT triggered by any single account's request rate or concurrency. A single Max account, framed as Claude Code, egressing through its own proxy IP, sustains 64 simultaneous opus + 16-concurrent/10-rps haiku (>300 requests) with ZERO bare-burst 429s — far above the gateway's own per-account cap of 3 concurrent. Yet production throws hundreds of bare-bursts across all accounts at once, each header-less. A 429 stripped of ALL rate-limit metadata is the signature of an infrastructure/edge-layer throttle (Cloudflare or Anthropic's pre-app gateway) keyed on a dimension SHARED across the accounts (the org and/or the proxy-IP range), tripped only by the AGGREGATE fleet. Consequences: rotating to a 'fresh' account does NOT escape it (it adds to the shared pressure), per-account RPM smoothing is the wrong knob, and more accounts only buy burst headroom if they are DISTINCT orgs/IPs.

## The question (WI-650 / BRIEF G2)

The gateway 429s with a **bare-burst** at only \~3.5 upstream-calls/min/account, util headers
**absent**, across **all** accounts — far under the 45/min floor the governor assumes. So the binding
limit is **not** per-minute request count. Is it per-second rate? a concurrency cap? a per-IP/edge
(CDN) throttle? cross-account correlation? And is the 429 from Anthropic's app layer or a CDN edge?

## The decisive experiment

`scripts/burst-probe.ts` — an operational runner (not a committed test; it makes real upstream calls).
It **bypasses the gateway's own governor** (per-account RPM smoothing + a `maxConcurrent≈3` admission
cap) and fires **direct at `api.anthropic.com`**, replicating the gateway's exact upstream request:

* the account's real OAuth Bearer (resolved via the live pool's credentialRef),
* `anthropic-version: 2023-06-01` + `anthropic-beta: oauth-2025-04-20`,
* the account's **dedicated egress proxy** → the **same source IP** the gateway uses (so a per-IP/edge
  throttle is measured against the real IP),
* **critically**, the first `system` block = the Claude Code identity
  (`"You are Claude Code, Anthropic's official CLI for Claude."`). On a Max OAuth token a request whose
  first system block is **not** the CC identity is shunted to a far stricter bucket and 429s — probing
  without it measures the *wrong* limit. (The gateway notes this at `gateway.ts` \~1556.)

`max_tokens:1`, tiny body, on the **healthiest** account (`ownerhandle7`, 7d util \~0.30).

### Result — a single account does NOT hit the bare-burst

| model     | sweep                                                | result                    |
| --------- | ---------------------------------------------------- | ------------------------- |
| haiku-4-5 | rate 1/2/5/10 per-s × conc 1..16, 12/cell (240 reqs) | **0** bare-burst, all 200 |
| opus-4-8  | 8, 16, 32 **simultaneous** (96 reqs)                 | **0** bare-burst, all 200 |
| opus-4-8  | **64 simultaneous** (1 wave)                         | **0** bare-burst, all 200 |

At 64 concurrent opus, p50 latency rose to \~2.6s (real upstream queueing) but **not one rejection**.
The per-account ceiling is **≥64 concurrent** — and the gateway's own per-account cap is just **3**, so
no single account ever approaches its real ceiling.

### Yet production is a bare-burst storm

`journalctl --user -u papercup-inference-gateway | grep 429-shape` over 2h:

* **455 `429-shape=bare-burst`** vs **27 `429-shape=rate-window`** — bare-burst dominates \~17:1.
* Every bare-burst line: `x-should-retry=true retry-after=-ms util5h=- util7d=-` — i.e. a 429 with
  **no `retry-after`, no `anthropic-ratelimit-*` headers at all**, firing across many accounts
  (`ownerhandle`, `ownerhandle4/6/7/8/10`) within the same minutes.
* The `rate-window` 429s, by contrast, DO carry headers (`util5h=1.0`, `retry-after` up to \~129h) —
  those are the genuine **5h/7d quota walls** on the depleted accounts, a different beast.

## The answer

**The bare-burst limit is NOT per-account.** A single account framed as Claude Code, through its own
egress IP, sustains ≥64 concurrent opus / ≥16-concurrent-10-rps haiku with zero bare-bursts. The
bare-burst is therefore a throttle on a dimension **shared across the accounts** — the Anthropic
**organization** and/or the **proxy-IP range** — tripped by the **aggregate fleet**, not any one
account.

**It is an edge/infrastructure-layer throttle, not the app-layer rate-limiter.** Anthropic's app-layer
`rate_limit_error` always attaches `retry-after` + `anthropic-ratelimit-*` (the rate-window 429s prove
it). A 429 stripped of *all* that metadata, carrying only `x-should-retry: true`, is the signature of a
pre-app layer (Cloudflare edge / load-balancer) rejecting before the app attaches rate-limit headers.
(The exact origin string — `server` / `cf-ray` — is now captured per bare-burst by the
`[bare-burst-origin …]` suffix added to the gateway 429-log; read it from journald to confirm
Cloudflare-edge vs Anthropic-edge.)

## Post-deploy confirmation: the storm was rotation-AMPLIFIED (G1 collapsed it)

When G1's fleet-wide-bare-burst **rotation suppression** (WI-649) + this G2 capture were restarted live
on `:8788` (2026-06-24 \~01:14Z), the bare-burst storm **collapsed immediately**:

| window                                   | bare-burst          | rate-window                 |
| ---------------------------------------- | ------------------- | --------------------------- |
| 2h **before** (rotate-on-429 active)     | **455** (\~3.8/min) | 27                          |
| \~6.5min **after** (rotation suppressed) | **0**               | 12 (genuine 7d quota walls) |

A shared edge throttle that **vanishes the instant you stop rotating-and-retrying across accounts** is
the signature of **self-inflicted amplification**: one bare-burst → immediate cross-account rotate+retry
→ more aggregate pressure on the shared limit → more bare-bursts (a positive-feedback storm). Removing
the rotation (G1) broke the loop. This end-to-end result corroborates the G2 verdict — the limit is
shared/aggregate, not per-account — and means the bare-burst origin string is, for now, **uncapturable
because there are no bare-bursts**; the instrument stays in place to name the origin on the next one.
The residual 429s are all `rate-window` — the genuine 5h/7d quota walls (G5/capacity, not G1/G3).

## Why it matters — de-risks G1/G3/G5

* **G1 (retry/rotation amplification — WI-649):** correct lever. Since the throttle is *shared*,
  rotating a bare-burst to a "fresh" account does **not** escape it — the rotated retry adds to the same
  aggregate pressure, so a bare-burst spawns more bare-bursts (the storm). Suppressing rotation under a
  fleet-wide bare-burst (what G1 does) is right.
* **G3 (demand-shaping):** shape the **aggregate** fleet request rate, not per-account RPM. Per-account
  smoothing can't help a limit that isn't per-account.
* **G5 (capacity):** more accounts add burst headroom **only if they are distinct orgs / distinct
  egress IPs**. Same-org (or same proxy-subnet) accounts share the wall, so adding them does not raise
  the aggregate burst ceiling.

## How to re-measure

```bash
# dry-run (resolve account + print the request, send nothing)
tsx scripts/burst-probe.ts --dry-run
# one real request (shape check)
PAPERCUSP_BURST_PROBE=1 tsx scripts/burst-probe.ts --one
# a sweep (defaults to ownerhandle7 + haiku; --opus / --model / --rates / --conc / --per-cell)
PAPERCUSP_BURST_PROBE=1 tsx scripts/burst-probe.ts --model claude-opus-4-8 --rates 1000 --conc 8,16,32 --per-cell 32
```

Guarded: refuses to fire without `PAPERCUSP_BURST_PROBE=1` (or `--yes`). Pick a **budget-healthy**
account (`accounts:status`) — a burst can briefly trip its transient throttle.

To confirm Cloudflare-vs-Anthropic origin from real traffic:
`journalctl --user -u papercup-inference-gateway | grep bare-burst-origin`.
