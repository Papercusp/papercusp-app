# Fleet spawn sandbox — host setup & dependencies
URL: /internal/docs/agent-spawning/sandbox

The default-on OS sandbox around fleet agent spawns — what it enforces per backend, what the host must provide (bwrap/socat/srt, AppArmor profile), and how to diagnose failures with fleet:sandbox_deps.

Fleet agent spawns run inside an OS sandbox, **on by default**
(`fleetSandboxEnabled()` in `libs/papercusp/packages/orchestrator/src/invoke.ts`;
plan `fleet-spawn-sandbox-2026-06-01` P-013/D-015). Opt a host out with
`PAPERCUSP_FLEET_SANDBOX=0` (or `false`/`off`), read per spawn — but note the
`:3070` host has no hot-reload, so a default change takes effect on the next
operator restart.

## What the sandbox enforces

Policy is decided by trusted orchestrator code inside `invoke()` — never from
agent-supplied input, so an agent cannot weaken its child's sandbox
(`fleetSandboxSettingsForRole`):

* **Filesystem** — cwd + the allow-listed package-manager cache root
  (`~/.cache/papercusp-fleet-sandbox` — without it `npm/pip/cargo install`
  fails `EROFS`, D-013/P-014) are writable. The bare writable dir isn't
  enough on its own: the orchestrator also redirects each ecosystem's cache
  env (`npm_config_cache`/`YARN_CACHE_FOLDER`/`PIP_CACHE_DIR`/`CARGO_HOME`/
  `GOCACHE`/`GOMODCACHE` + `XDG_CACHE_HOME`) into a per-project,
  `sha256(cwd)`-keyed subdir of that root (`fleetSandboxCacheEnv`) — the
  redirect, not just the writable dir, is what avoids the install-time
  `EROFS`. Credential paths (`FLEET_SANDBOX_DENY_READ`) are unreadable. The
  sandbox does **not** cover the Read/Edit tools, so most of those same
  credential paths are also denied via permission rules
  (`FLEET_SANDBOX_DENY_RULES`) — but the two sets aren't identical: e.g.
  `~/.npmrc` is hidden from sandboxed Bash via `denyRead` yet has no Read/Edit
  deny rule, and the `Edit` rules cover only ssh/aws/papercusp.
* **Network** — deny-all egress except the registry allowlist
  (`resolveFleetAllowedDomains()`: the base list of package
  registries/CDNs adjusted by two env knobs).
  `PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS` appends extra hosts to the base;
  `PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS=1` is the lockdown that blocks
  **all** sandboxed-Bash egress (emits `[]`) for a security-hardened
  deployment and wins over the append var.
* **Fail-loud** — `failIfUnavailable: true` and
  `allowUnsandboxedCommands: false`: a host missing the sandbox dependencies
  fails spawns loudly instead of silently running unsandboxed. Opting out is
  an explicit env decision, never a silent degradation.

Per backend (`backendUsesSrt`): **claude-code** uses its native sandbox via
injected settings; **codex** and **omp** are both contained by wrapping the
whole process in `srt` (`@anthropic-ai/sandbox-runtime`) — codex's native
workspace-write sandbox cancels MCP (D-009) and omp has no usable native
sandbox, so the wrap is external (`buildFleetSrtSettings` /
`wrapSpawnWithSrt`, fail-loud if `srt` is absent for either backend). D-019
(superseding D-010) extended the codex wrap to omp and verified it
end-to-end (startup + model-reach); all three fleet backends are now handled
under default-on. omp's egress allowlist is operator (localhost/127.0.0.1) +
model + registries; a cloud-model omp adds its model host via
`PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS`.

## Host dependencies

| Dependency                | Platform      | Needed for                                                                                                        | Required?             |
| ------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------- |
| `bwrap` (bubblewrap)      | Linux         | claude-code sandbox filesystem/userns layer                                                                       | yes                   |
| `socat`                   | Linux         | the sandbox's network-proxy leg (egress allowlist)                                                                | yes                   |
| bwrap AppArmor profile    | Ubuntu 24.04+ | only when `kernel.apparmor_restrict_unprivileged_userns=1` — without the profile, bwrap is denied user namespaces | yes (when restricted) |
| `srt` on PATH             | Linux/macOS   | codex + omp containment (claude-code unaffected) — fail-loud for either backend when the sandbox is enabled       | advisory              |
| Seatbelt (`sandbox-exec`) | macOS         | ships with the OS                                                                                                 | yes (built-in)        |
| —                         | Windows       | no native support; run spawns under WSL or opt out                                                                | —                     |

**Containers:** inside docker/podman, nested user namespaces are often
unavailable — the full bwrap sandbox may fail to start. The deliberate
weakening for that deployment shape is claude's `enableWeakerNestedSandbox`
option; the dep-check *reports* the condition but never auto-weakens (a
policy call, not a default).

## Diagnosing: `fleet:sandbox_deps`

The formal dep-check is `checkFleetSandboxHostDeps()`
(`libs/papercusp/packages/orchestrator/src/sandbox-deps.ts`), exposed as the
read-only **`fleet:sandbox_deps`** tool. It returns per-check verdicts with
remedies — bwrap/socat presence, the AppArmor userns sysctl + profile pairing,
container detection, srt, platform support — plus whether the sandbox is
currently enabled. First stop when fleet spawns fail at startup on a new host
or frame.

```text
fleet:sandbox_deps {}
→ { ok: true, report: { platform, supported, enabled, container, ok, checks: [{ name, ok, required, detail, remedy? }] } }
```

The top-level `ok` is a constant tool-success flag; the verdict you care about
is `report.ok` (all required checks pass on a supported platform). `supported`
flags whether the sandbox covers this platform at all.

Typical remedies it emits: `sudo apt install bubblewrap socat`, install the
distro bwrap AppArmor profile (or
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`),
`npm install -g @anthropic-ai/sandbox-runtime`, or — for a host that genuinely
can't sandbox — `PAPERCUSP_FLEET_SANDBOX=0`.

## Known limits

* **cwd is always writable** in claude's sandbox (`allowWrite` only *adds*
  paths); per-role write tightening lives at the allowed-tools layer, not the
  sandbox.
* **Per-role egress narrowing** is the planned per-role axis (e.g. a research
  role needing web access vs a worker needing none); today the egress floor
  is uniform across roles.
* **Zero-byte `package.json` self-heal** — claude's protected-file masking can
  leave a 0-byte `package.json` in a cwd that had none, which is invalid JSON
  and bricks every later Node/Bun spawn there with `ERR_INVALID_PACKAGE_CONFIG`.
  The orchestrator auto-heals exactly this case (an existing, exactly-0-byte
  `package.json` → `{}`) in the live spawn path (`healSandboxZeroByteManifest`)
  before it can break later spawns.
* All three fleet backends are now contained under default-on (claude-code
  native, codex + omp via the srt-wrap, D-019). The only residual is an
  omp/ollama tool-schema 400 — an omp bug, unrelated to containment.

## Related

* [Spawning overview](/internal/docs/agent-spawning/overview)
* [Allowlist & caps](/internal/docs/agent-spawning/allowlist-and-caps)
* [Spawn limits](/internal/docs/agent-spawning/limits)
