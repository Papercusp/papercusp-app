# Dynamic egress-proxy toggle (and: the opus-429 cause was NOT the egress IP — see the Claude Code system-block doc)
URL: /internal/docs/agent-insights/gateway-cloudflare-per-ip-opus-throttle-egress-toggle

>

## ⚠️ Correction — the opus-429 root cause is NOT in this doc

If you are here because opus / an in-process LLM call is 429-ing or the Scout times out 180s with
"transport death (0 ideas, $0 spent)": **stop — read
[max-oauth-first-system-block-must-be-claude-code-identity](./max-oauth-first-system-block-must-be-claude-code-identity).**
The cause is the missing **Claude Code identifier first `system` block** on Max-OAuth requests, NOT the
egress IPs. This doc's original "Cloudflare per-IP edge throttle on the egress IPs" diagnosis was a
**red herring**, disproven live 2026-06-30:

* box-IP-only (proxies off) did **not** fix opus; the box IP "bare-burst 429'd" too.
* a `claude -p` opus call from the **same box IP** worked → the IP was never the problem.
* the real flip is the system block (opus 200/2.6s with it, timeout/429 without).

The Cloudflare `bare-burst` 429 shape is REAL, but it's how the **stricter Max-OAuth bucket** rejects an
un-framed request — not a per-IP egress throttle.

> **⚠ Scope of the "red herring" (added 2026-06-30 pm — do not over-read it):** that conclusion is only for
> the **UN-framed** case tested here (the Scout in-process opus path). It does **NOT** mean the per-IP egress
> throttle is fictional. For **already-framed** callers (the `claude`-CLI / psu cups, framed since the
> `buildSystemParam` fix) a bare-burst 429 under concentrated opus load **IS** a genuine Cloudflare per-IP
> edge throttle: an account with a single egress IP and no `egressPool` then whole-account-pauses (the
> `BARE-429 CIRCUIT`) because there is no sibling IP to rotate to — the exact reason a heavily-pinned account
> with 18% budget still throws API errors. That is a DISTINCT mode with its own shipped fix (the per-account
> egress-IP pool). The `box-IP-only didn't fix it` test above only disproves the IP theory **for the
> un-framed case** (framing is IP-independent, so of course box-IP still 429'd). Full discriminator (framing
> vs edge-IP): the top callout of
> [max-oauth-first-system-block](./max-oauth-first-system-block-must-be-claude-code-identity) +
> [rate-limit…not-capacity Fault #6](./rate-limit-is-usually-account-routing-not-capacity).

## What's still valid here: the dynamic egress-proxy toggle

This work added a runtime kill-switch in `gateway.ts` to flip between the per-account datacenter proxy
egress pool and box-IP-only (drop every `proxyUrl` entry → egress through the box's own outbound IP).
Useful for genuine egress-IP debugging / IP-reputation work — NOT for opus 429s.

* **Boot default:** env `PAPERCUSP_GATEWAY_DISABLE_PROXY_EGRESS=1` (drop-in on `papercup-inference-gateway.service`).
* **Live flip (no restart):** `POST http://127.0.0.1:8788/admin/egress-mode?proxy=off` (box-IP-only) /
  `?proxy=on` (restore the proxy pool); `GET /admin/egress-mode` reads the mode.
* Implemented via the in-memory `proxyEgressDisabled` flag → `effectiveEgressEntries(account)` filters
  out `proxyUrl` entries. Set the env to persist a flip across a gateway restart.

Also still valid (a genuine routing improvement from this work): the gateway's **absorb-retry now
re-routes a held request to a serviceable account** instead of re-holding the throttled one it first
landed on (search `absorb-retry re-routed` in `gateway.ts`).
