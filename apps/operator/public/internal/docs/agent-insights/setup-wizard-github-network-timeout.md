# Setup-wizard "workspace setup failed" is usually a transient api.github.com connect-timeout, not auth
URL: /internal/docs/agent-insights/setup-wizard-github-network-timeout

A valid gh token does NOT mean api.github.com is reachable: git-over-github.com (the credential helper) can succeed while direct API calls to api.github.com time out, because GitHub's edge IPs (140.82.0.0/16) can be intermittently unreachable from a given network while github.com git endpoints work. The dogfood bootstrap records clone/submodule/identity failures as a terminal 'failed', which inside the GitHub-centric setup wizard misleads users into (uselessly) re-authing. EI-3548 added a network_timeout classification + auto-retry so a transient blip self-heals.

import { Aside } from '@astrojs/starlight/components';

When the setup wizard reports **"Setting up Papercusp workspace failed"** (or
the finish-gate "Workspace download failed") right after a GitHub sign-in/reauth,
the cause is almost never credentials. It is a **transient inability to reach
`api.github.com`**.

## The non-obvious part: a valid `gh` token ≠ a reachable GitHub API

These three facts can all be true at once, and were on 2026-06-24:

* `gh auth token` returns instantly and `gh api user` resolves to the right
  login → **auth is fine.**
* `git ls-remote https://github.com/<owner>/<repo>` works → **git-over-HTTPS via
  the credential helper is fine** (it happened to resolve to a reachable edge IP).
* `curl https://api.github.com/` / node `fetch` / `gh api user` **time out** →
  **the GitHub API is unreachable** (DNS handed back an edge IP whose path is
  currently dropping packets).

GitHub serves `github.com` and `api.github.com` from the same anycast range
(`140.82.0.0/16`). When a network path to a *subset* of those IPs is lossy, any
given operation succeeds or times out depending on which IP DNS returns — so it
looks intermittent and IP-specific, not like "GitHub is down" (it isn't —
`curl --resolve api.github.com:443:<reachable-ip>` returns 200).

`curl -4 -m8 https://api.github.com/` hanging while
`curl -4 -m8 --resolve api.github.com:443:140.82.121.6 https://api.github.com/`
returns 200 ⇒ partial edge reachability, not GitHub/auth. Reauth will NOT help.
Check `journalctl --user` for `Connect Timeout Error (api.github.com:443, timeout: 10000ms)` —
if it spans many harnesses/workspaces, it's a shared network condition.

## Why it surfaced as a scary terminal "failed"

The dogfood bootstrap (`bootstrap-papercusp-hive.ts`) records `clone` /
`submodules` `status:'error'` on **any** git/github failure, and the wizard
surfaces that as a terminal failure. Inside a GitHub-centric wizard, a generic
"failed" reads as "your GitHub sign-in didn't take" — so users re-auth, which
cannot fix a packet-level timeout.

## The fix (EI-3548) — classify + auto-retry

* `clone-github.ts` classifies connection failures as **`network_timeout`**
  (checked before auth, since a connect failure is mutually exclusive with a
  `403`/"Authentication failed" that only arrives after a successful connect).
* `useDogfoodBootstrapProgress` exposes **`networkError`**; the finish gate
  **auto-retries with backoff (2s/4s/8s, bounded)** before showing any terminal
  failure, with network-aware copy ("Couldn't reach GitHub — retrying… / not your
  GitHub sign-in"). The banner mirrors this.
* The best-effort Solution-C share substeps (`adoptShare`/`goShare`/
  `shareExisting`, all of which hit the GitHub API) are wrapped so a transient
  timeout **warns** instead of failing an otherwise-complete workspace setup.

Deferred: a shared GitHub-API client with retry + circuit-breaker for the OTHER
`api.github.com` callers (`swarm-join`, `revalidate-repo-coords`,
`pot-directory`) so one bad window doesn't 10s-hang fleet-wide.
