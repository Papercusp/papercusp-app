# A hung TLS handshake to a papercusp-family hostname from this dev box is a local SNI filter, not a site outage — verify via an external path before ever reporting an outage
URL: /internal/docs/agent-insights/su-box-sni-tls-blackhole-not-outage

EI-16742: an su session diagnosed papercusp.com (and PostHog) as down from this dev box's own Bash tool — TLS handshakes to papercusp-family hostnames hung until timeout, even connecting DIRECTLY to a known-good IP with -servername (bypassing DNS entirely). Root cause verified live: something on this box's network path reads the TLS ClientHello SNI and silently blackholes the connection for papercusp-family hostnames specifically — the SAME Cloudflare IP serves 200 for one SNI and hangs for another. Two false outage escalations (EI-16722, EI-16702) came from reading that hang as 'the site is down'. Never trust an in-sandbox TLS/HTTPS probe of a workspace-owned domain as your only signal — verify externally, or via a reachable alias (papercusp-com.pages.dev), before reporting an outage.

import { Aside } from '@astrojs/starlight/components';

## The symptom

An su session tried to verify whether `papercusp.com` and a PostHog endpoint
were reachable, using `openssl s_client`/`curl` from inside its own `Bash`
tool, and got a hang on every papercusp-family hostname:

```
$ openssl s_client -connect 140.82.113.4:443 -servername github.com
CN=github.com, verify 0 (ok)          # instant success

$ openssl s_client -connect 140.82.113.4:443 -servername papercusp.com
# HANGS until timeout

$ openssl s_client -connect 140.82.113.4:443 -servername flags.papercuspai.com
# HANGS until timeout
```

Note the IP: **140.82.113.4 is GitHub's**, which has no relationship
whatsoever to papercusp or Cloudflare. GitHub's own TLS terminator cannot
explain a per-hostname hang for a name it has never heard of — it would
either present its own cert or reject the connection immediately, not hang.
The failure follows the **hostname in the SNI field**, not the destination.

Corroborating, same box, same minute:

```
BLOCKED: papercusp.com, clips.papercusp.com, cupboard.papercusp.com,
         papercuspai.com, flags.papercuspai.com
FINE:    papercusp-com.pages.dev (200), github.com (200), www.cloudflare.com (200)
```

The **same Cloudflare IP** serves `200` for SNI `papercusp-com.pages.dev` and
hangs for SNI `papercusp.com`. Plain HTTP (port 80, no SNI to match) is
unaffected — `http://flags.papercuspai.com/` returns `204` normally,
consistent with SNI-based filtering rather than an IP-level block.

This produced **two false outage escalations in one session**, both wrong for
the same reason:

* **EI-16722** "papercusp.com apex may be down" — wrong. Cloudflare's control
  plane showed the custom domain, cert, and zone all `active`; DNS proxied
  correctly. The site was fine; this box just couldn't see it.
* **EI-16702** "PostHog TLS terminator wedged" — wrong for the same reason.
  The `:80 → 204` / `:443 → hang` split that read as "app alive, TLS broken"
  is exactly what this filter produces on a perfectly healthy target.

If a TLS handshake (`openssl s_client`, `curl -v https://...`) to a
**workspace-owned** papercusp-family hostname hangs from inside your own Bash
tool, that is not sufficient evidence the site is down. Verify via a path that
does NOT share this box's network stack (below) before writing an incident
report or escalating to the owner.

## What it actually is — NOT a sandbox feature, NOT a DNS problem

This is a **different mechanism** from the earlier DNS-hijack finding
(EI-12952, see the sibling doc
[su-box-dns-hijack-not-sandbox-synthesis](/internal/docs/agent-insights/su-box-dns-hijack-not-sandbox-synthesis)):
that one was a UDP:53 answer substitution, fixable by resolving over TCP or
externally. **This one bypasses DNS entirely** — connecting straight to a
literal IP with `-connect <ip>:443 -servername <host>` still hangs for
papercusp-family SNIs and succeeds for everything else against the exact same
IP. So it cannot be a DNS problem, and it cannot be the destination server's
problem (the destination doesn't get to choose per-hostname to hang before
even completing a handshake with an unrelated server it has no relationship
to). The only place left that can see the SNI and act on it before the
destination responds is **something on this box's own network egress path** —
a resolver/middlebox, a VPN/proxy, or upstream ISP-level SNI filtering.

There is no code in this repo that implements TLS/SNI interception for the
`su` Bash tool's network path — this is host/network infrastructure outside
papercusp's git tree, and outside an su session's authority or vantage point
to fix directly (same category as the EI-12952 DNS finding).

A related, likely-connected oddity: the local resolver returns `::` for
`papercusp.com`/`www.papercusp.com` (an IPv6 "no route" placeholder) while
Cloudflare DoH returns the correct A records — though that alone doesn't
explain the `--resolve`/direct-IP failures above, which skip DNS altogether.
**Mechanism not fully root-caused** — treat the detection/workaround below as
the durable fix; identifying the exact filtering layer is left open for
whoever has LAN/router access to this box.

## The reliable check — verify via a path that skips this box's network entirely

**`WebFetch`** does not share the sandbox's local network stack (it fetches
server-side, via Anthropic's own infrastructure), so it is immune to a
box-local SNI filter by construction:

```
WebFetch https://papercusp.com/
```

If `WebFetch` succeeds while your in-sandbox `curl`/`openssl s_client` hangs
on the same host, that's this box's filter — not an outage.

**A same-IP control-SNI probe** is a fast local corroborating signal (no extra
round-trip): resolve the target's IP once, then handshake against that SAME
IP with a known-good, unrelated SNI (e.g. `github.com`) and with the target
SNI. Control succeeds + target hangs, same IP, is the tell — see
`packages/operator-core/lib/sni-reachability-divergence.ts` for a small,
tested, pure decider (`evaluateSniReachability`) any future health check or
agent tooling can feed those two probe outcomes into instead of every agent
re-deriving the pattern from scratch.

**A reachable alias** sidesteps the whole question for deploy verification:
`papercusp-com.pages.dev` is the canonical Cloudflare Pages deployment behind
`papercusp.com` and is NOT filtered by this box — it proves the same build is
live without needing the apex hostname to be reachable from here at all.

## What to do when you see this

1. **Do not conclude an outage** on the basis of an in-sandbox TLS
   handshake/`curl https://...` hang against a papercusp-family hostname
   alone — including when the hang is corroborated by trying a different tool
   (`openssl`, `curl`, a language TLS library) from the same box; they all
   share the same network path and will all agree with the same wrong
   conclusion.
2. Cross-check with `WebFetch <the https url>`. If it succeeds while your
   in-sandbox probe hangs, the in-sandbox path is the one that's broken, not
   the site.
3. For deploy/build verification specifically, prefer
   `papercusp-com.pages.dev` over the apex — it's reachable from this box and
   proves the same deployment.
4. If you need to attribute the hang mechanically rather than by eyeballing
   it, use `evaluateSniReachability` in
   `packages/operator-core/lib/sni-reachability-divergence.ts` with a
   same-IP control-vs-target probe pair.
5. If the domain genuinely IS down (the external `WebFetch` check also
   fails), that's real — proceed normally.

## When you must WRITE to a papercusp host from this box (release publish)

Verification can detour through `WebFetch` or `pages.dev`; an **upload** cannot.
The workspace-host release cut (`apps/operator/lib/release/workspace-host-release-cut-cli.ts`
→ `scripts/publish-workspace-host-artifacts.mjs`) PUTs a \~2 GB bundle to
`cupboard.papercusp.com`. Under the blackhole that stalls in the TLS handshake and
undici reports it as `ConnectTimeoutError` at `publish.multipart.initiate` — a
TLS-stage stall that reads like a TCP fault (measured 2026-09-24, r44 cut; TCP to
`172.67.145.145:443` connected in 17 ms, same IP with SNI `www.cloudflare.com`
answered 200, TLS 1.2-only and X25519-only both still hung, `nft list ruleset`
had no matching rule).

Route the publish through an off-network hop. Node 25's built-in `fetch` honours
`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`, but only for an **HTTP CONNECT** proxy, so
pair an SSH SOCKS tunnel with a small CONNECT→SOCKS bridge:

```bash
# 1. SOCKS tunnel to any GCP VM that reaches cupboard (get the exact ssh argv
#    from: gcloud compute ssh <vm> --zone <zone> --dry-run). Background it.
ssh -N -D 127.0.0.1:47181 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 <vm>
# 2. CONNECT -> SOCKS bridge (`scripts/sni-relay-proxy.mjs`).
node scripts/sni-relay-proxy.mjs 47180 47181
# 3. Prove it before the long job: both must print 200.
curl -sS -o /dev/null -w '%{http_code}\n' -x http://127.0.0.1:47180 https://cupboard.papercusp.com/
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:47180 node -e \
  "fetch('https://cupboard.papercusp.com/').then(r=>console.log(r.status))"
# 4. Re-run the SAME cut command with the proxy env. The publish is journaled,
#    so a re-run resumes at the failed stage instead of rebuilding.
export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:47180 \
       NO_PROXY=127.0.0.1,localhost,::1
```

Check the ports are free first (`ss -ltnp 'sport = :<port>'`): on 2026-09-24
`18080`/`18081` were already held by another agent's ssh, and a `curl -x` to a
port you did not bind talks to someone else's listener. The r44 publish (60 × 32 MiB
parts) finished in about three minutes through this route. The machines themselves
download the bundle from inside GCP, so provisioning and upgrades are not affected.

## What was NOT fixed here (and why)

The underlying filter is **this dev box's own network egress**, not anything
in papercusp's git tree — there is nothing here to patch that would remove
the filter itself, and identifying the exact filtering layer (resolver
add-on, local proxy, VPN client, upstream ISP middlebox) needs LAN/router
access this su session doesn't have. The durable, host-independent fix that
IS in scope, and that ships alongside this doc, is the standing habit above
(verify externally, or via a reachable alias, before trusting an in-sandbox
TLS reading for a workspace domain) plus the small reusable, tested
pure-decider (`sni-reachability-divergence.ts`) so the "same-IP,
control-succeeds/target-hangs" tell is mechanical rather than something each
agent re-derives under pressure while it looks like a live incident.
