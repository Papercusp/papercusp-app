# claude-code headless permission model (what --allowed-tools / --permission-mode actually do)
URL: /internal/docs/agent-insights/claude-code-headless-permissions

Verified vs claude 2.1.158 — --allowed-tools is NOT a whitelist by itself; only --permission-mode dontAsk makes it one, and even then gating is non-uniform (CronCreate/EnterWorktree bypass it). --disallowed-tools is the hard block. How the fleet spawn is locked down. 2026-07-01 update — the subagent tool renamed Task→Agent, silently breaking the fleet's own deny-list.

## Why this exists

The headless fleet (orchestrator `invoke()` → `claude -p`) needs to run
unattended without (a) hanging on a permission prompt or (b) being able to do
anything destructive. The flag semantics that achieve this are **surprising and
contradict the docs in places** — every claim here was tested empirically against
claude 2.1.158 with external side-effects, because a doc-only read sent an
earlier pass down the wrong path. If you're changing the fleet's permissions
(`claudeMcpArgs` in `libs/papercusp/packages/orchestrator/src/invoke.ts`), read
this first.

## The model (all verified, not assumed)

1. **`--allowed-tools` is NOT a whitelist on its own.** It's a *pre-approval*
   list (don't-prompt-for-these). What an *un-listed* tool does depends on
   `--permission-mode`:
   * Under **`bypassPermissions`** the allow-list is **ignored entirely** —
     everything runs. (Verified: Bash wrote a file with only `Read` allow-listed.)
   * Under **`default`** the tool still *runs*, but `default` applies a
     **sandbox** that blocks filesystem-writes-outside-workdir + network.
     (Verified: a CWD write was blocked.) → `default` breaks file-writing roles;
     do not use it for the fleet.

2. **`--permission-mode dontAsk` makes `--allowed-tools` a true default-deny
   whitelist** — an un-listed *gated* tool is denied, the model is told, and it
   continues (no hang). Unlike `default`, `dontAsk` does **not** sandbox the
   allowed tools, so writes/edits work. **This is the posture the fleet uses.**

3. **`dontAsk` gating is NON-uniform.** A class of session-local / "meta"
   built-ins is **exempt** from the allow-list and runs even when omitted.
   Verified: with the exact fleet allow-list, `CronCreate` still created a job
   and `EnterWorktree` still ran. A `claude -p` spawn carries 250+ tools incl.
   `CronCreate/Delete/List`, `Workflow`, `Enter/ExitWorktree`, `RemoteTrigger`,
   `PushNotification`, `Monitor`, `ScheduleWakeup`, `Task`, `Skill`, `LSP`.
   **The allow-list alone is not a complete boundary.**

4. **`--disallowed-tools` is the hard block.** It removes a tool from the spawn
   entirely ("No such tool exists in this environment"), wins over the allow-list
   AND over `bypassPermissions`, and supports command granularity:
   `Bash(git push:*)` blocks `git push` while `echo` still runs. This is what
   closes the dangerous *exempt* tools (#3) and dangerous Bash *commands*.

5. **The per-role MCP boundary is already server-side**, belt-and-suspenders:
   `tools/list` is surface-filtered by `listMcpProjections(role)`
   (`libs/generic/tooldef/src/tool-projection.ts`) AND call-time-denied by the
   dispatch stack's `role-allowlist` step (`dispatch-stack.ts`, skipped only for
   `gateBypass.role` = superuser). So a fleet worker only ever sees/calls its
   role's MCP tools — `--allowed-tools "mcp__papercusp"` (server wildcard) grants
   exactly that, no per-role enumeration needed.

## What the fleet spawn ships (invoke.ts `claudeMcpArgs`)

```
--mcp-config <cwd>/.mcp.json --strict-mcp-config
--permission-mode dontAsk
--allowed-tools "mcp__papercusp Read Edit Write Bash Glob Grep WebFetch WebSearch"
--disallowed-tools CronCreate CronDelete CronList ScheduleWakeup \
  EnterWorktree ExitWorktree Workflow Task Agent Workflow RemoteTrigger PushNotification \
  Monitor "Bash(sudo:*)" "Bash(git push:*)" "Bash(rtk git push:*)"
--disallowedTools=Task,Agent,Workflow
```

Allow-list is one space-joined arg (claude splits it); deny patterns are
separate argv elements so internal spaces (`Bash(git push:*)`) survive —
`claudeMcpArgs` is the **tail** of `finalArgv` for claude-code, so the variadic
`--disallowed-tools` swallows nothing unintended. Defers the whole posture if the
user set any permission flag in `AGENT_CMD`.

`FLEET_DISALLOWED_TOOLS` (the `--disallowed-tools CronCreate …` list above) no
longer hardcodes `Task` — it spreads the shared `NO_SUBAGENT_TOOLS_DENY = ['Task',
'Agent']` from `no-subagent-deny.ts`, so both tool-name generations are always
covered here too (belt-and-suspenders with the exec-boundary push below).

The trailing `--disallowedTools=Task,Agent` is a **second, independent** deny
emitted at the exec boundary in `invoke()` itself (`noSubagentToolsDenyFlag()`,
single comma-joined token, camelCase flag — distinct from the space-separated
`--disallowed-tools` Layer-A list above), pushed **unconditionally** for every
claude spawn regardless of `userManagesPermissions` / an explicit
`AGENT_CMD`-supplied deny list. It survives because claude *unions* repeated
`--disallowedTools` occurrences rather than the last one winning (verified
live) — see "Update 2026-07-01" below for why it's split out from the rest of
the posture, which an operator-supplied deny list CAN still override.

The allow-list is **per-role** (`fleetAllowedToolsForRole(role)`): most roles
get the kit above, while any role in `FLEET_NO_WRITE_ROLES` drops `Edit`/`Write`
(mechanically enforcing an "API/MCP-only — do NOT use `Write`/`Edit`" prompt
instruction). **Update (2026-06): `FLEET_NO_WRITE_ROLES` is currently EMPTY** —
the former `expert`/`feedback` API-only roles were removed, so no role is cut
today; the mechanism stays for when such a role returns. That's the *only* per-role
built-in cut that's safe from a prompt read (other review/gate roles write
legit output via `Write`). It's a nudge, not a boundary — `Bash` is still
granted, so a shell redirect could write; deeper per-role cuts need a real
fleet-spawn run, not a prompt read. An unknown role gets the full kit.

**No-push** is *really* enforced by a spawn-env-scoped pre-push hook
(`gitConfigNoPushEnv` injects `core.hooksPath` via `GIT_CONFIG_*` into the spawn
env only — the shared checkout's config and the user's/other agents' pushes are
untouched). The `Bash(git push:*)` deny is the evadable backstop (`git -C … push`,
aliases, `&& git push` slip past command-string matching; the hook does not).

## Honest limits (the deny-list alone is not a sandbox)

**Update (`fleet-spawn-sandbox-2026-06-01`, P-013/D-015): there is now a
DEFAULT-ON sandbox layered on top of this deny-list** — claude-code's OWN
built-in sandbox (Linux bubblewrap + socat egress proxy; macOS Seatbelt),
injected via `--settings`, opt-out with `PAPERCUSP_FLEET_SANDBOX=0`. It closes
the two gaps the deny-list cannot: it hides credential dirs
(`FLEET_SANDBOX_DENY_READ` — `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`,
`~/.papercusp`, `~/.npmrc`) from sandboxed Bash and confines egress to an
allow-listed set of package registries (`resolveFleetAllowedDomains()`;
strip-all with `PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS=1`). The bullets below
describe the **deny-list layer in isolation** — i.e. the posture *before* that
sandbox, which is now the default container for those reads/egress.

* **Credential reads are not closed by the deny-list** — the allow-listed `Read`
  tool reaches any path. **Network egress is not closed by the deny-list** —
  `WebFetch` is allow-listed. True containment of those needs a network/fs
  sandbox, not a deny-list — which is what the default-on sandbox above now is.
* **Worktree isolation is conditional** — `invoke.ts` falls back to
  `ctx.projectDir` (the shared main checkout) when there's no feature-worktree,
  so "the worker is contained in a worktree" is not universally true.
* Per-role *tightening* of the built-in dev kit (e.g. deny `Write` to read-only
  roles) is deliberately NOT done — it needs per-role real-spawn verification
  because withholding a needed built-in silently breaks a role mid-pipeline.

## Update 2026-07-01: `Task` → `Agent` — the fleet's own deny-list was a silent no-op

This doc's own advice ("don't trust the docs here, re-verify") caught a real regression.
The subagent-launch built-in was named `Task` when this doc's model was verified against
claude 2.1.158 (`FLEET_DISALLOWED_TOOLS` denied `'Task'` accordingly). On claude 2.1.198 the
**same tool is named `Agent`** — self-reported by the model, and confirmed live:

```
claude -p "spawn a subagent that writes a marker file" \
  --permission-mode dontAsk --allowedTools "... Agent" --disallowedTools "Task"
# marker file WAS created — denying 'Task' did nothing; the fleet's guard was a no-op.

claude -p "spawn a subagent that writes a marker file" \
  --permission-mode dontAsk --disallowedTools "Agent"
# → "Agent exists but is not enabled in this context." — correctly blocked.
```

So every headless fleet worker had been able to fan out via the (renamed) subagent tool
despite `FLEET_DISALLOWED_TOOLS` explicitly intending to block it — the deny-list looked
complete (the entry was right there) but matched nothing. Fixed by carrying **both** names
in one shared source, `libs/papercusp/packages/orchestrator/src/no-subagent-deny.ts`
(`NO_SUBAGENT_TOOLS_DENY = ['Task', 'Agent']`), reused by `FLEET_DISALLOWED_TOOLS` (fleet/
orchestrator spawns) and mirrored into `psu-launcher.mjs`. Denying a tool name that doesn't
exist in a given CLI build is a no-op, never an error, so carrying both names costs nothing
and survives either generation.

**Default-deny everywhere (owner mandate 2026-07-02).** The deny is now applied to *every*
Claude agent, not just fleet/cup sessions:

* **psu** — `suLaunchArgs`, `roleLaunchArgs`, and `resumeArgsFor` all deny by default
  (`...(allowSubagents ? [] : [NO_SUBAGENTS_DENY_FLAG])`). The old default-OFF `--no-subagents`
  opt-OUT + human-keeps-it-by-default carve-out (native-scheduler-lockout D-003) is INVERTED:
  the ONLY way to keep the tool is an explicit opt-IN — `psu --allow-subagents` (a CLI flag),
  the psu picker's **Subagents** toggle (default Disabled), or `fleet:launch-on-plan { allowSubagents: true }`.
  `--no-subagents` is kept as a now-redundant explicit-deny alias.
* **Headless orchestrator spawns** — `invoke.ts` pushes `noSubagentToolsDenyFlag()`
  UNCONDITIONALLY for any claude spawn at the exec boundary (even when the operator manages
  the rest of the permission posture, unlike the scheduler deny's D-004 operator-override
  guard). Safe because claude *unions* repeated `--disallowedTools` occurrences (verified
  live), so it composes with the Layer-A `--disallowed-tools` from `claudeMcpArgs` /
  `FLEET_DISALLOWED_TOOLS`. No headless opt-in — the opt-in is a psu-launch surface only.
* **Wake-executor resumes** — `resumeCommandFor` re-arms `noSubagentToolsDenyFlag()` every
  wake, alongside the scheduler deny: CLI `--disallowedTools` does NOT survive into a resume,
  so without this a woken cup silently regained its subagent tool (the same persistence gap
  the scheduler lockout documents).

**Lesson for the next rename:** a deny-list entry that matches nothing fails *silently* —
there's no error, no warning, just a tool that still works. The only way to know is the
live-side-effect test pattern below, run against the tool you're actually trying to close,
not just the scheduler tools this doc originally checked.

## Update 2026-07-05: `Workflow` — a SEPARATE fan-out tool slipped the guard

`Task`/`Agent` were not the only fan-out surface. A `psu --resume` session with subagents
denied was still able to fan out via **`Workflow`** — a distinct, top-level multi-agent
orchestration tool, not a rename of the subagent-launch tool, so the `Task`/`Agent` deny
never matched it. `no-subagent-deny.ts`'s shared list is now
`NO_SUBAGENT_TOOLS_DENY = ['Task', 'Agent', 'Workflow']`, so `noSubagentToolsDenyFlag()`
(the unconditional exec-boundary deny) and `FLEET_DISALLOWED_TOOLS` (which spreads
`NO_SUBAGENT_TOOLS_DENY`) both close it too — `FLEET_DISALLOWED_TOOLS` already listed
`Workflow` on its own line (Layer-A), so it now appears twice in the rendered
`--disallowed-tools` argv; a repeated deny entry is harmless (same as denying an
absent tool name — a no-op, not an error).

## Update 2026-07-06 (WI-3159): `Bash(rtk git push:*)` — a token-filter hook rewrite evaded the push deny

`Bash(git push:*)` is evaluated against the **post-PreToolUse-hook** `updatedInput` — so
when the `rtk` token-filter hook rewrites the shell command (`git push …` → `rtk git push
…`) before the deny-pattern match runs, the rewritten command no longer starts with `git`
and the `Bash(git push:*)` prefix match never fires (proven live: the non-rewritten
control command was denied correctly, isolating this as pure pattern evasion, not a
broken match). `rtk` is on the dev box `PATH` today (a manual vector), and any fleet
`rtk`-hook rollout would make the evasion automatic. `FLEET_DISALLOWED_TOOLS` now also
denies `Bash(rtk git push:*)`. The repo pre-push hook (per "No-push" above) remains the
real enforcement; this closes the specific `rtk` variant of the documented
command-string evadability — it does not make the Bash-pattern layer exhaustive against
every possible rewrite.

## How to re-verify (don't trust the docs here)

Test against the real CLI with an **external side-effect** (a file on disk, not
just a `tool_use` block in the stream — a denied call still shows an attempt).
Use a pristine `CLAUDE_CONFIG_DIR` (copy in only `.credentials.json`, no
settings) so a stray `settings.local.json` allow-rule can't confound the result.
Pattern that settled it:

```
claude -p "use a shell command to create file X containing Y" \
  --permission-mode dontAsk --allowed-tools "Read" --output-format json
# then check whether file X exists — exists = the tool ran, absent = denied.
```
