# :3170 connection refusals during staging sync — diagnose the coordinated restart path
URL: /internal/docs/agent-insights/staging-3170-flaps-every-5min-via-auto-sync-timer

The staging sync timer can trigger a coordinated :3170 restart when server code changes; SPA-only advances skip it and active clients can defer the sync. The current script uses dev:restart with its drain/coalesce path and verifies the exact served staging SHA.

## Symptom

A session actively using the staging operator (`http://127.0.0.1:3170`) — a
`verdict` browser session, a raw `curl`, a health probe — gets a clean 200,
then moments later `ERR_CONNECTION_REFUSED` / `net::ERR_CONNECTION_REFUSED` /
a raw `fetch failed` against the exact same URL, with no code change and no
one having deliberately requested a restart. The staging sync timer can request
a coordinated `dev:restart` automatically, so a sync-triggered cutover may occur
without anyone invoking the tool interactively. The port can recover a few
seconds later. Easy to misdiagnose as load, a memory-watchdog recycle, or a
regression in whatever you were just testing.

## Root cause

`:3170` (`papercup-staging-api.service`) is NOT a static long-running process
that only restarts when a human/agent asks. Since **isolated-staging-tier-
2026-06-21**, it runs from an **isolated checkout** (`papercusp-staging`, a
sibling of the main `papercup`/`papercusp` tree — see the branch-discipline
note in the root CLAUDE.md about never editing sibling worktrees), which
**`papercup-staging-sync.timer`** auto-fast-forwards to the latest *committed*
`staging` HEAD on its own schedule:

```
OnActiveSec=5min                 # first fire
OnUnitInactiveSec=5min           # then 5min after each run FINISHES
```

Its driven service, `papercup-staging-sync.service`, runs
`apps/operator/bin/release/sync-staging-checkout.sh`, which:

1. No-ops if `staging` HEAD hasn't moved since the checkout's last sync (cheap
   git compare).
2. Otherwise fast-forwards the isolated checkout + rebuilds the SPA (reusing
   `setup-release-checkout.sh`, same machinery as a real release cutover).
3. **In the original 2026-07-19 implementation, it ran a plain
   `systemctl --user restart papercup-staging-api.service`** — a genuine
   SIGKILL-then-restart cycle, measured as a \~10-13s hard-down window and
   confirmed at the time via `journalctl --user -u papercup-staging-api.service`:

   ```
   Stopping papercup-staging-api.service ...
   papercup-staging-api.service: Main process exited, code=killed, status=9/KILL
   papercup-staging-api.service: Failed with result 'signal'.
   Stopped papercup-staging-api.service ...
   Started papercup-staging-api.service ...          # ~10-13s later
   ```

In the original report, frequent fleet commits made the timer advance the
checkout and attempt a server restart on many consecutive ticks. The timer's
5-minute cadence is an explicit owner tradeoff (freshness vs. thrash), not by
itself a bug. The subsequent WI-5710 gates made the decision depend on changed
server paths and live clients: SPA/docs/tests-only advances skip the process
restart, and a live client can defer the whole sync up to the configured stale
ceiling.

The original implementation also used a raw `systemctl --user restart`, which
violated the repository's restart policy and bypassed `dev:restart`'s resource
drain and coalesce cooldown. That finding was valid for the 2026-07-19 code but
is no longer the current behavior. The current coordinated path is documented
below; it preserves those restart controls and has no raw-restart fallback.

## Fix (EI-13221)

1. **`sync-staging-checkout.sh`** now skips its own restart when the unit's
   current MainPID already started less than `PAPERCUSP_STAGING_SYNC_RESTART_GRACE_SEC`
   (default 45s) ago — most likely a peer's `dev:restart` (or the previous
   tick) already cycled it, so restarting again would just double the outage
   for no freshness benefit. Fail-soft: any probe hiccup falls through to the
   normal restart (matches `probeServiceStart`'s own contract).
2. **`dev:service_health`** (`packages/operator-core/lib/agent-tools/dev/service_health.ts`)
   gained `overlaySystemdRestartRecency` — for every `systemd-user` supervised
   unit, it live-probes `secondsSinceStart` (the same OS ground-truth
   `dev:restart`'s coalesce check already trusts, `systemd-service-probe.ts`)
   and, when the unit started in the last `RECENT_RESTART_WINDOW_SEC` (20s),
   attaches a `recentRestartNote` explaining a concurrent connection-refused
   is very likely that restart, not an outage. This closes a real blind spot:
   `staging-api` isn't in the HTTP-probed `HEALTH_ENDPOINTS` rotation and its
   restarts (being timer-driven, not down-then-up transitions the reconciler's
   own flap counter observes) never tripped `flapState` either — before this
   fix, NOTHING in `dev:service_health` reflected this unit's actual restart
   cadence at all.
3. Documented the independent restart cadence + the diagnostic path in
   `repo-conventions.mdx`'s two-port section (previously silent on it — the
   section described only the deliberate human/agent restart path).

## Current coordinated-restart contract (2026-10-01)

The current `sync-staging-checkout.sh` requests `dev:restart` through `ptool`
against the staging operator at `http://127.0.0.1:3170`, with
`target: "staging"`, `confirm: true`, `authorize: true`, and a bounded
`git_sync_drain_sec` (default 45 seconds, clamped to the oldest supported
operator schema). This follows the normal `dev:restart` resource-drain and
coalesce path. The sync script downgrades its checkout lock to shared before the
request and holds it through readiness verification.

The restart can close the HTTP stream that carried the ptool response, so the
script verifies a changed systemd MainPID and the exact target source SHA from
`:3170` health. Once that proof exists, it terminates only the ptool client; it
does not repeat the restart mutation. A pre-dispatch refusal or invalid result
fails loudly. A recognized transient git-sync barrier/collision refusal may
defer to the next tick while the served build is younger than
`PAPERCUSP_STAGING_SYNC_MAX_STALE_SEC` (default 1800 seconds); it fails loudly
at the ceiling. There is no raw `systemctl restart` fallback.

`apps/operator/lib/release/sync-staging-checkout.test.ts` covers this contract,
including the coordinated `dev:restart` arguments and the absence of a raw
restart invocation. Use that focused suite as the recurrence guard when this
path changes.

## Root-cause fix (WI-5710, 2026-07-26) — the branch moving is not the code changing

EI-13221 above made the flap *diagnosable* and skipped the redundant
double-restart, but left the cadence itself intact: `:3170` still restarted on
essentially every tick. Measured 2026-07-26, hours apart from the original
report and still reproducing exactly: restarts at 15:38:06 / 15:44:47 /
15:50:36 / 15:56:51 / 16:02:55 / 16:08:49 — 42 `Started|Stopping` journal
entries in 90 minutes.

The actual defect is a **proxy that stopped being true at scale**. The script's
only gate was `target != current` — "the `staging` branch moved" used as a
stand-in for "the code the running process holds changed". That was a perfectly
reasonable proxy when commits were human-paced. Under a fleet where git-sync
auto-commits the whole tree every \~3min, the proxy decoupled from the thing it
proxied, and it degraded *silently* — it still "worked", just wastefully. When
something fires far more often than the condition it is supposed to track,
suspect the proxy, not the trigger.

Two gates now stand between "the branch moved" and "kill the process":

1. **Relevance** (`paths_require_restart`). The SPA needs no restart at all:
   `apps/operator/bin/host-spa.ts` serves the dist **from disk per request**
   (`existsSync` + `serveFile` per asset; `index.html` read per request with
   `cache-control: no-store`), so once `--build-spa` has run the new SPA is
   already live. An SPA/docs/tests-only advance therefore rebuilds and **skips
   the restart entirely**. The allowlist is deliberately conservative and its
   **fail-safe direction is load-bearing**: a restart is required *unless every*
   changed path is provably inert, so an unknown or newly-added path shape falls
   through to a restart. Never invert it — "skip unless known-server" would mean
   a new server directory silently stops being picked up.
2. **Live-session deferral** (`staging_live_client_count` +
   `current_commit_age_sec`). When a restart *is* required but someone is
   actually connected to `:3170`, the **entire sync** defers — not just the
   restart. Advancing the checkout while keeping the old process would serve a
   NEW SPA against an OLD server, and that skew is worse than a few minutes of
   staleness; pinning the whole checkout leaves the live session on a fully
   consistent build. Bounded by `PAPERCUSP_STAGING_SYNC_MAX_STALE_SEC`
   (default 1800s) so a permanently-attached client can never freeze `:3170`
   indefinitely.

**Expected effect, stated honestly.** Gate 1 alone is *not* the win it first
looks like. Measured over 200 real staging commits with a 6-minute timer
simulation: `restart=113, skip=12` — only \~10% of ticks are SPA/docs-only,
because `libs/papercusp` submodule bumps and `packages/operator-core` edits are
genuinely constant. (An earlier estimate of \~85% was wrong; it classified
individual commits rather than the multi-commit span a real tick diffs.) The
real reduction comes from gate 2: an idle `:3170` still restarts promptly, while
an in-use one is left alone until it goes idle or hits the ceiling — turning
"every \~6min unconditionally" into "when it's free, or at worst every 30min".

Full zero-downtime restart (SO\_REUSEPORT generation overlap, the item's option
A) remains the eventual end state for the residual ceiling-forced restarts, but
is deliberately *not* built here — with the stale-chunk 404s already fixed by
`dist-chunk-retention-default-2026-07-26` and the cadence cut by these gates,
that architectural change no longer pays for itself.

Behaviour is locked by `apps/operator/lib/release/sync-staging-checkout.test.ts`,
including structural guards that the shipped script calls the gates and orders
deferral before the checkout advance.

## The tell

If you hit a connection-refused against `:3170` and it clears on its own
within \~15s: call `dev:service_health` and look at the `staging-api`
supervision entry's `secondsSinceStart` / `recentRestartNote` before treating
it as a real outage, a memory-watchdog recycle, or evidence your own change
broke something.

If instead `:3170` seems to be serving **stale** code, check the sync journal
for a `deferring sync` line — that is gate 2 holding the checkout because a
client is connected. It clears when clients disconnect or at the staleness
ceiling. For an intentional restart, use `dev:restart { target: 'staging' }`;
it coordinates the service drain and coalesces recent restarts, and can report a
busy staging-sync barrier rather than bypassing it with raw systemd.
