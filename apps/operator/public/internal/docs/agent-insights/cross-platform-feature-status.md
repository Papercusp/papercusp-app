# Cross-platform feature status — the verified audit
URL: /internal/docs/agent-insights/cross-platform-feature-status

Which shipped features are (and aren't) cross-platform after the 2026-07-05 hardening: the gateway-supervision fix, macOS Keychain credentials, the WSL answer, and the verified CAT1 runtime table.

# Cross-platform feature status — the verified audit (2026-07-05)

Deliverable of plan `cross-platform-hardening-and-agent-ergonomics-2026-07-05` (P-009/P-010/P-011,
WI-3059). Trigger: the packaged **Mac** app had no inference gateway and an agent "agonized" over
Keychain credentials; owner asked *"I thought everything was cross-platform — I need to know about
all features that are not."* This page is the verified answer, from a 72-file systemd-reference
sweep plus code-level verification of every shipped candidate.

## TL;DR

* **The product (Tauri desktop) is cross-platform by architecture.** The Tauri shell spawns + owns
  the operator sidecar on all three platforms and respawns it on crash (`main.rs`
  `decide_serve_respawn`: exit + unreachable ⇒ respawn, capped, suppressed during shutdown).
* **The ONE real shipped gap was inference-gateway supervision** — systemd-only, so packaged
  macOS/Windows simply had **no gateway**. Fixed 2026-07-05 (see below).
* Everything else that references systemd is **dev-box / CI / release-pipeline tooling that never
  ships** (green-checkpoint, deploy-cli, git-sync, bghost-watchdog, the units under
  `apps/operator/scripts/systemd/`). Those are Linux-only **by design** and should stay that way.

## The gateway gap — closed (P-006/P-007/P-008)

Before: `:8788` (paced OAuth egress for the whole fleet) was supervised ONLY by the
`papercup-inference-gateway` systemd `--user` unit → never started on macOS, and not under default
WSL either. Agents silently fell back to direct/default credential routing.

Now (`packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts`, wired in
`apps/operator/bin/host-bootstrap.ts` beside the spawner-sidecar block):

* **Port-probe-first adoption**: if anything already listens on the gateway port (the systemd unit
  on the Linux dev box, a sibling operator), the supervisor ADOPTS it — no double-bind, no
  EADDRINUSE race. systemd is demoted to a Linux-dev optimization, not a dependency.
* **Managed child otherwise**: spawn + respawn-on-crash with exponential backoff (1s→30s cap) and a
  5-crashes-per-5-min circuit breaker — the same shape as `substrate-sidecar-spawn.ts` /
  `spawner-sidecar-spawn.ts` (third clone; extraction to a shared lib is a tracked follow-up).
* **Packaged spawn path**: esbuild bundles everything into `serve.mjs`, so the packaged build
  re-execs itself with `PAPERCUSP_GATEWAY_SIDECAR_MODE=1` (serve.ts diverts to
  `runGatewaySidecarMain()` in `sidecar-main.ts`); dev spawns `npx tsx bin.ts`. Same divert pattern
  as the substrate/spawner sidecars.
* **Gating**: env kill-switch `PAPERCUSP_GATEWAY_SUPERVISE=0` — deliberately NOT `getFlag()` at
  host-boot (flags resolve false when PostHog is unreachable; the stall-waker lesson).

## macOS credentials (P-004 + the `keychain:` channel)

Claude Code on macOS stores its OAuth bundle in the **login Keychain** (service
`Claude Code-credentials`), NOT `~/.claude/.credentials.json`. Two consequences, both handled:

* **Sign-in detection** (`agent-auth-detect.ts` `claudeKeychainSignedIn`): metadata-only probe
  (`security find-generic-password -s <service>` WITHOUT `-w`) — no secret fetch, no unlock prompt,
  fail-safe fallthrough to the file probe.
* **Gateway local-fallback credential** (`credential-store.ts` `keychain:` credentialRef kind +
  `account-resolver.ts` `localLoginCredentialRef()`): when the file bundle is absent on darwin, the
  `local` fallback account resolves to `keychain:Claude Code-credentials`. The resolver is
  **read-only by design** — Claude Code owns the item + its refresh; the gateway re-READS near
  expiry and fails with actionable guidance if the bundle went stale. ⚠ Keychain ACL: the FIRST
  `security -w` read of an item created by another app raises a GUI "allow access" prompt — click
  **Always Allow** once.

✅ **Mac-VM E2E smoke verified (2026-07-06, WI-3080)**: packaged app running, gateway spawns
(`gateway.log`: "up on 127.0.0.1:8788 → account 'local' (local-fallback)", "supervision up in
3241ms — spawned"), `/healthz` 200, `totalRequests`/`egressAttemptsByAccount` confirm a real
served request end-to-end. ⚠ **Still unverified**: this VM has a hand-provisioned
`~/.claude/.credentials.json`, so it resolves the FILE credential channel — `localLoginCredentialRef()`
only takes the `keychain:` path when that file is ABSENT on darwin. The keychain-specific fallback
branch + the "Always Allow" ACL prompt remain unverified live; that needs a fresh-install Mac VM
pass without the file (tracked as a follow-up, not blocking).

## Windows / WSL (the P-010 answer)

The Windows desktop runs the sidecar **under WSL**, where `process.platform === 'linux'` but
systemd is absent by default. The host-bootstrap supervisor block runs there identically: the port
probe finds nothing → it **spawns** the gateway child (bundled re-exec, since the packaged sidecar
is the bundle). A WSL user who has enabled systemd + installed the unit gets adopted via the probe
instead. No WSL-specific code was needed — the gap closed with P-006. Note: service-health's
bg-host code-drift probe (below) is deliberately NOT short-circuited under WSL, since WSL reports
`linux`.

✅ **Windows-VM E2E smoke verified (2026-07-06, WI-3080)**: full boot watched live under the
`papercup-runtime` WSL distro — `serve.mjs --ensure` → embedded PG boots + migrates → operator up
(`operator.json` + `/api/health` 200 over the WSL loopback) → the gateway-sidecar supervisor spawns
with no WSL-specific code and logs "up on 127.0.0.1:8788" in `~/.papercusp/gateway.log`, confirmed
live with `/healthz` 200. Confirms the P-006/007/008 port-probe-first-adoption + managed-child-spawn
shape genuinely works under WSL as claimed above.

## Verified CAT1 runtime table (P-009)

| Surface                                    | Verdict                     | Evidence                                                                                                                                                                                                              |
| ------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host-recycle.ts`                          | ✅ cross-platform            | Mechanism = `process.exit(75)` / `exit(0)` + "supervisor restarts me". Supervisor exists everywhere: systemd `Restart=always` (Linux dev), Tauri `decide_serve_respawn` (packaged, all OSes — exit-code-agnostic).    |
| `memory-watchdog.ts`                       | ✅ cross-platform            | RSS via `process.memoryUsage().rss` (pure Node); recycle uses the same exit mechanism. The RSS high-water systemd drop-in (EI-1613) is Linux-dev tuning only; defaults apply elsewhere.                               |
| `shutdown-state.ts`                        | ✅ cross-platform            | Pure `process.on('SIGTERM'/'SIGINT')` drain latch — POSIX (darwin ✓); Windows runs the sidecar under WSL (= linux signal semantics).                                                                                  |
| `bghost-watchdog.mjs`                      | 🐧 Linux-only **by design** | Dev-box standalone script + unit watching `papercup-bg-host` via `systemctl`/`journalctl`/`/proc/<pid>/environ`. Not imported by `serve.ts`/`host-bootstrap.ts` ⇒ not in the esbuild bundle ⇒ never ships. Not a gap. |
| `service-health.ts` `probeBgHostCodeDrift` | ✅ platform-guarded (P-005)  | Non-Linux returns `{ up:true, present:false, note:'Linux/systemd-only…' }` instead of a failed `systemctl` exec.                                                                                                      |

## The rest of the 72-file systemd sweep

Everything else lives in the dev/CI/release plane and never ships in the desktop bundle:
green-checkpoint + deploy-cli + release-trigger, git-sync routines, the `apps/operator/scripts/systemd/`
units, dev diagnostics (`dev:*` tools), watchdog scripts. **Keep these Linux-only** — porting them
would be effort spent on infrastructure that only ever runs on the Linux dev box.

## Open items

1. **Mac-VM Keychain-fallback smoke** — the supervisor boot + gateway spawn is now verified
   (2026-07-06), but the specific `keychain:` credential branch (file bundle ABSENT) still needs a
   fresh-install Mac VM pass, since the current VM has a hand-provisioned credentials file.
2. ~~Windows-VM equivalent~~ — verified 2026-07-06 (WI-3080): WSL sidecar boots the supervisor,
   gateway reachable, confirmed live.
3. **Sidecar-spawn extraction** — `gateway-sidecar-spawn.ts` is the third copy of the
   spawn/respawn/backoff shape; extract to a shared lib.
