# Fleet OS sandbox (default-on) — what it confines, how to opt out / extend egress, and what breaks
URL: /internal/docs/agent-insights/fleet-os-sandbox

>-

## What it is

Every **claude-code** fleet spawn (orchestrator `invoke()` → `claude -p`) runs
inside claude-code's **own built-in OS sandbox** (Linux bubblewrap + socat
proxy; macOS Seatbelt), injected via `--settings`. It is **default-on** as of
2026-06-01 (plan `fleet-spawn-sandbox-2026-06-01`, P-013). Source of truth:
`fleetSandboxEnabled()` / `fleetSandboxSettingsForRole()` /
`resolveFleetAllowedDomains()` / `fleetSandboxCacheEnv()` in
`libs/papercusp/packages/orchestrator/src/invoke.ts`.

What it confines (the **Bash tool + its children only** — see the boundary note):

* **Filesystem writes** → the cwd (`allowWrite: ['.']`) plus one allow-listed
  package-manager cache dir (`~/.cache/papercusp-fleet-sandbox`). Everything
  else, including `$HOME`, is read-only.
* **Credential reads** → `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`,
  `~/.papercusp`, `~/.npmrc` are `denyRead` (hidden from Bash) **and** denied to
  the `Read`/`Edit` tools via `permissions.deny` (the sandbox does not cover the
  Read/Edit tools — they go through the permission system).
* **Network egress** → allowlisted to package registries (npm/yarn/pypi/crates)
  * GitHub + the common toolchain CDNs (Playwright `cdn.playwright.dev` /
    `playwright.download.prss.microsoft.com`, node-gyp `nodejs.org`). Everything
    else is blocked.
* Subprocess env is scrubbed of cloud creds (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`).

## The boundary that matters

For **claude-code**, the sandbox wraps the **Bash tool and its child processes —
nothing else.** The agent's own **MCP, model, WebFetch and WebSearch**
connections run in claude's main process, **outside** the sandbox, so they are
unaffected (verified live: a papercusp MCP call from inside a sandboxed spawn
reached the server normally).

**codex** is different and needs a different mechanism. codex's *native* sandbox
gates the MCP transport itself — under `-s workspace-write`/`read-only` it
client-cancels MCP tool calls (re-verified on codex 0.135; `network_access`
doesn't help; no MCP-trust knob exists), so codex can't self-sandbox. The way
around (P-015/D-017): run codex with its native sandbox **bypassed**
(`codexSandboxArgs` keeps `--dangerously-bypass-approvals-and-sandbox`, so MCP
works) and wrap the **whole** codex process in **`srt`**
(`@anthropic-ai/sandbox-runtime`: bubblewrap `--unshare-net` + a host-side
allowlisting proxy) via `wrapSpawnWithSrt`. srt confines codex's shell commands
(writes → cwd+cache+CODEX\_HOME, egress → an allowlist of operator + model
endpoints + registries, creds hidden) while codex's MCP+model traffic routes
**through** srt's proxy. One gotcha baked into the impl: srt injects a `no_proxy`
that excludes loopback + RFC1918, which would send the operator MCP directly into
the isolated netns (unreachable) — the wrap clears `no_proxy` inside the srt
shell so it goes through the proxy. So under `PAPERCUSP_FLEET_SANDBOX`, **both
claude-code and codex are contained.**

**omp** (no native sandbox) gets the **same srt-wrap** as codex (D-018/D-019).
Its model + MCP are loopback on this box (ollama / the meridian bridge), the same
loopback-through-srt's-proxy transport codex uses, so its egress allowlist is
operator + localhost + registries; a cloud-model omp adds its host via
`PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS` (omp's provider is deployment-set, so
there's no single host to hardcode like codex's OpenAI). Its writable agent dirs
(`~/.omp` + `PI_CODING_AGENT_DIR` = `<project>/.papercusp/pi-sessions`, which holds
omp's agent/auth/models SQLite DBs) are added to `allowWrite` — miss that and omp
dies at startup with `SQLiteError: attempt to write a readonly database`. Verified
under srt: omp **starts cleanly + reaches its model**. (Caveat unrelated to
containment: omp can't *complete* a tool-using task against **ollama** due to an
omp↔ollama tool-schema bug — `cannot unmarshal bool into ToolFunctionParameters.properties`
— present with or without srt, on every ollama model; needs a tool-capable local
server or a working cloud/meridian provider.) So under `PAPERCUSP_FLEET_SANDBOX`
**all three backends are contained.**

## Knobs (env, read per-spawn from the trusted orchestrator env)

| Env var                                        | Effect                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PAPERCUSP_FLEET_SANDBOX=0` (or `false`/`off`) | **Opt out** — run the fleet unsandboxed (the pre-2026-06-01 behavior).                                                                 |
| `PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS`      | Comma/space-separated hosts **appended** to the base egress allowlist (a private registry, an internal mirror, an extra CDN). Deduped. |
| `PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS=1`    | **Lockdown** — emit `[]` for the allowlist (block ALL sandboxed-Bash egress). Wins over the append var.                                |

Changes take effect on the **next `:3070` operator restart** — the Hono host has
no hot-reload.

## What breaks, and the fix

* **`npm install` / `pip install` / `cargo build` fail `EROFS`** writing
  `~/.npm/_cacache` (etc.). Root cause: package managers cache under `$HOME`,
  which the sandbox makes read-only. **This is already handled** —
  `fleetSandboxCacheEnv()` redirects npm/yarn/pip/cargo/go/XDG caches into a
  per-project subdir of the allow-listed cache root. If you add a new ecosystem
  whose cache lives in `$HOME`, add its cache env var there. (Gotcha for
  reviewers: an isolation test that only writes a file *inside* cwd will pass
  while real installs are broken — always test a **real package install** under
  a write-confining sandbox.)
* **A build/test command hits a host not in the allowlist** → that command's
  egress fails (curl exit 6/7/28/56, HTTP 000). Add the host via
  `PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS`, or (for a known-common toolchain)
  to the base `FLEET_SANDBOX_ALLOWED_DOMAINS`.
* **Host without `bubblewrap`** → the sandbox is `failIfUnavailable: true`, so
  the spawn fails **loudly** rather than silently running unsandboxed. A host
  that genuinely can't sandbox (e.g. a container without user-ns nesting) opts
  out with `PAPERCUSP_FLEET_SANDBOX=0`. (Wiring `enableWeakerNestedSandbox` for
  the containerized case is unbuilt — see the plan's P-011.)

## Threat model (don't oversell it)

Defense-in-depth, **not** a hard boundary. The egress proxy filters by
client-supplied hostname **without** terminating TLS, so a broad allowlist is a
potential domain-fronting exfil channel — keep additions minimal. A Bash
shell-redirect can still write inside cwd. The guarantee is: a sandboxed
claude-code Bash command can't read the listed credential dirs, can't write
outside cwd + the cache dir, and can't reach a non-allowlisted host.

## See also

* [claude-code headless permission model](/internal/docs/agent-insights/claude-code-headless-permissions) — the `--allowed-tools` / `--permission-mode dontAsk` posture the sandbox composes with.
* Plan `fleet-spawn-sandbox-2026-06-01` (decisions D-001..D-015) — the full design + the real-fleet-pass findings.
