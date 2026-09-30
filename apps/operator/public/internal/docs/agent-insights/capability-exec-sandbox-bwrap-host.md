# Capability exec sandbox (CAPABILITY_EXEC_SANDBOX) — the bwrap host setup, fail-open design, and the fail-closed mask bug
URL: /internal/docs/agent-insights/capability-exec-sandbox-bwrap-host

>-

## What it is

`capability:bash` / `capability:git` run real subprocesses **in the operator
(Hono host) process** — which is **outside** the per-spawn agent OS sandbox
(claude's bwrap+socat) that contains a fleet agent's *native* Bash. So the B-18
fleet cutover (`FLEET_CAPABILITY_ONLY`), which routes the fleet off native Bash
onto the gated `capability:*` tools, would move execution from a *sandboxed* to
an *unsandboxed* context. `CAPABILITY_EXEC_SANDBOX` re-applies an OS sandbox to
that operator-side exec path.

Source of truth: `buildCapabilitySandboxCommand()` in
`packages/operator-core/lib/agent-tools/capability/exec-sandbox.ts` (pure, decides
binary+argv); spawned by `spawnShell()` in `bash-jobs.ts`. Default-ON as of
2026-06-23 (WI-608) after end-to-end validation; the plan is
`agent-capability-confinement-2026-06-13` (P-022 / D-008 / P-033).

Three modes, picked at spawn time, all **FAIL-OPEN**:

| mode               | when                                     | confines                                                                                                                                   |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `srt` (preferred)  | `srt` on PATH + bwrap works              | fs (cwd-writable, ro root) + credential masking + **domain-allowlist egress** (its socat proxy + own netns) — full parity with native Bash |
| `bwrap` (fallback) | bwrap works, srt absent                  | fs + credential masking; egress shared (or `--unshare-net` via the deny-all knob)                                                          |
| `raw`              | flag OFF **or** bwrap can't sandbox here | nothing (today's behavior)                                                                                                                 |

**FAIL-OPEN** (`capabilityBwrapWorks()` returns false, or a flag-IO error)
means the command runs unwrapped rather than failing — so arming this can never
brick a host without a working bwrap. (Contrast the *fleet* sandbox, which is
fail-LOUD — see "See also".)

## The bwrap host setup (Ubuntu 24.04) — the part that is NOT in the repo

bwrap needs to create an unprivileged user namespace and write `/proc/self/uid_map`.
On Ubuntu 24.04 `kernel.apparmor_restrict_unprivileged_userns=1` shunts *unconfined*
bwrap into the restrictive `unprivileged_userns` AppArmor profile, which `audit deny
capability` strips the caps it needs → **`bwrap: setting up uid map: Permission
denied`**, and `capabilityBwrapWorks()` returns false (fail-open to raw).

The surgical fix — give `/usr/bin/bwrap` its OWN profile that keeps it unconfined
but explicitly grants `userns`, so it is NOT redirected into the restrictive
profile. `srt` (`@anthropic-ai/sandbox-runtime`) execs `/usr/bin/bwrap`, so this one
profile covers **both** paths. Install `/etc/apparmor.d/bwrap`:

```
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
```

Then `sudo apparmor_parser -r -W /etc/apparmor.d/bwrap`. It is **persistent** —
`apparmor.service` (enabled) reloads `/etc/apparmor.d/*` at boot. Verify:
`/usr/bin/bwrap --ro-bind / / --proc /proc --dev /dev --die-with-parent /bin/true`
exits 0; `srt -c 'id'` runs.

> Blunt alternative (weakens the whole box): `sudo sysctl
> kernel.apparmor_restrict_unprivileged_userns=0`. Prefer the per-binary profile.

This also un-breaks any OTHER bwrap-based sandbox on the host (the per-spawn fleet
sandbox is fail-LOUD, so it was opting out / unsandboxed on a userns-restricted box).

## The fail-CLOSED mask bug (fixed in WI-608)

bwrap **cannot create a mount point under the read-only `/` bind**: a `--tmpfs <missing-dir>` gives `Can't mkdir …: Read-only file system` and a `--ro-bind
/dev/null <missing-file>` gives `Can't create file at …`, and **either aborts the
whole command** (exit 1). The credential mask binds `~/.ssh ~/.aws ~/.gnupg ~/.config/gcloud ~/.papercusp ~/.npmrc`; on a host merely lacking one of these
(e.g. `~/.config/gcloud`), the bwrap-fallback path fail-CLOSED — it killed *every*
`capability:bash`. The fix: **skip a mask target that does not exist** (injectable
`maskExists`, default `existsSync`). A path with no file has no secret to hide, and
the read-only home means the command can't create one mid-run, so skipping is safe.
This is exactly the class of bug argv-only tests miss and end-to-end validation finds.

## How to validate (on a bwrap-capable host)

1. **Unit** (host-independent argv): `exec-sandbox.test.ts`.
2. **Real exec** (skips where bwrap can't sandbox, e.g. CI):
   `npx vitest run --config vitest.integration.config.ts
   lib/agent-tools/capability/exec-sandbox.integration.test.ts` — proves cwd
   writable, `/tmp` ephemeral, creds masked, missing-mask skipped, ro root,
   `--unshare-net` drops the netns (read interfaces from `/proc/net/dev`, NOT
   `/sys/class/net` — `/sys` is bound from the host and shows host interfaces even
   under `--unshare-net`).
3. **Live** through the running operator (:3170 staging — restart it first, no
   hot-reload): drive `capability:bash` over MCP and confirm `ls -A ~/.ssh | wc -l`
   reads `0` (host has the real keys). The superuser MCP door is
   `http://localhost:3170/api/mcp?superuser=1&workspace=<ws>` with `Authorization:
   Bearer <~/.papercusp/superuser-token>` — **both** the `workspace` param
   (scoped-superuser clamp) and the bearer are required, or you get
   `scoped_superuser_workspace_unresolved` / `superuser_invalid_bearer`.

## See also

* [Fleet OS sandbox](/internal/docs/agent-insights/fleet-os-sandbox) — the *per-spawn*
  claude/codex/omp sandbox (a different code path, `orchestrator/invoke.ts`,
  fail-LOUD). The credential-mask list here is kept in parity with its
  `FLEET_SANDBOX_DENY_READ` (asserted by a test).
* Plan `agent-capability-confinement-2026-06-13` (P-022 / D-008 / P-033) — the
  full design: srt-preferred exec sandbox, the egress-parity decision, the
  three confinement-hole fixes (D-012).
