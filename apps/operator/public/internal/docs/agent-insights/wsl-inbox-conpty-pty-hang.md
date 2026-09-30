# Inbox-WSL wsl.exe hangs forever under ConPTY (wizard pty wedge)
URL: /internal/docs/agent-insights/wsl-inbox-conpty-pty-hang

On pre-Store ("inbox") WSL, wsl.exe spawned under a pseudoconsole wedges at the service handshake — zero output, zero exit, no distro process. Pipes work. How to discriminate it in minutes, plus the 4-bug wizard cluster it hid behind.

## Symptom

The Setup Wizard's **Install Agent Runtime** (and the sign-in / git pty
panes — anything through `InlinePtyTerminal` → `pty_spawn`) sits on
"Installing…" forever on a Windows machine: the xterm pane stays blank,
no `pty-exit` ever fires, and `ps aux` inside the distro shows **no
process was ever started**. The Windows side shows a live
`wsl.exe --distribution papercup-runtime … --exec bash -c "<script>"`
child that never progresses — hours, if you let it.

## Root cause

The machine runs the **inbox WSL** (the Windows-feature version, not the
Store/MSI release — `wsl --version` is not a recognized option there;
that's the tell). Inbox `wsl.exe` wedges at the WSL-service handshake
when its stdio is a **pseudoconsole** (ConPTY — what `portable-pty`
allocates). The identical command spawned with plain pipes works
instantly. Modern Store WSL doesn't have this (VS Code drives wsl under
ConPTY all day).

This is also the same WSL generation behind the UTF-16/`WSL_UTF8`
decode edge (§3-adjacent, see the Windows-VM runbook) — inbox WSL on a
box means assume both.

## How to discriminate it fast (minutes, not hours)

1. `ssh` into the box, `wsl -d <distro> --exec ps aux` → no trace of
   your command = it never started (rules out slow install).
2. Same exact command via **pipes** from Windows-side node:
   `child_process.spawn('wsl.exe', [...], {stdio:'pipe'})` → works =
   rules out args/quoting/env/distro problems in one shot.
3. Drive the app's own `pty_spawn` over CDP (runbook §14) with a
   trivial `echo` → blank + no exit = the ConPTY leg is the variable.
4. `wsl --version` errors → inbox WSL. Done.

Things that look guilty but are NOT: the empty-env theory
(`portable-pty`'s `CommandBuilder` inherits `std::env::vars_os()` —
and wsl.exe runs fine with an empty env block anyway), `--cd` with a
Linux path (valid), multiline `bash -c` scripts through `--exec`
(argv-preserved, fine).

## The fix set (landed 2026-06-12)

* **`pty.rs` watchdog**: a wsl-routed pty with zero bytes AND no exit
  after 20s is killed with a red in-pane explanation telling the user to
  run `wsl --update` from an elevated PowerShell. A silent wedge can no
  longer strand the wizard.
* **`InlinePtyTerminal` got `onSpawnError`** and `StepAgents` /
  `AuthSignInCards` / `StepGit` wire it — spawn failures reset the
  busy state instead of sticking on "Installing…"/"Running…".
* Same click-through also surfaced (separate bugs, same pane):
  **`@oh-my-pi/cli` is a dead npm ref** (`oh-my-pi` unpublished
  2026-05-21) — it 404'd and aborted the whole runtime `npm install`,
  taking codex with it (removed from `buildInstallSpec`); and
  **`detectClaude` never probed `~/.local/bin/claude`** — the official
  `claude.ai/install.sh` target — so even successful installs read as
  "No agent backend yet" (`preflight-binaries.ts` candidate added).

## Resolved: auto-`wsl --update` at onboarding is REJECTED (P-022, validated 2026-06-12)

Tried live on the Windows VM: `wsl --update --web-download` installs
Store WSL 2.7.8 cleanly — and then **WSL cannot start at all** on the
nested-QEMU rig: `wsl: Nested virtualization is not supported on this
machine` + `Wsl/Service/CreateInstance/CreateVm/0x800705b4` on every
distro boot. The inbox WSL runs fine nested; the Store engine refuses
this virtualization profile. Recovery: `wsl --uninstall` (removes the
Store package, reverts to inbox) — distro boots again immediately,
state intact.

Consequences:

* Onboarding must NOT auto-run `wsl --update` — on machines like this
  one it converts a degraded-but-working setup into a fully broken one.
  The shipped mitigation is the pty watchdog + its in-pane
  `wsl --update` hint, which a *real-hardware* user can follow safely.
* On THIS VM, never run `wsl --update`. If someone has: `wsl --uninstall`
  restores the rig.
* Whether Store WSL actually fixes the ConPTY wedge therefore remains
  unverified on this rig (it can't run Store WSL); ecosystem evidence
  (VS Code drives wsl-under-ConPTY broadly on Store WSL) still supports
  the hint's advice for real machines.
