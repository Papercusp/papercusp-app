# Windows operator goes down and never respawns — the wsl.exe wrapper-child liveness blind spot
URL: /internal/docs/agent-insights/windows-operator-respawn-wrapper-child-liveness

Why the Papercusp Server app left a durably-dead operator un-respawned on Windows (child_exited stayed false because the wsl.exe wrapper outlived the inner node operator), the decide_serve_respawn fix that makes operator reachability the ground-truth signal, and why Linux CI never caught it. WI-3170, 2026-07-06.

**Symptom (owner-reported, live):** *"the windows app is still very unreliable
with the operator going down all the time."* VM forensics (WI-3141) showed the
operator **durably down \~11+ minutes** — `operator.json` recorded a pid that was
not running, **no** `serve.mjs`/`sidecar-main` process existed at all, and the
health probe returned "fetch failed" — while the **Papercusp Server** app that is
supposed to supervise + respawn it was alive the whole time. It was *durably
down*, not "restarting frequently."

If you are debugging a Windows operator that dies and stays dead while the Server
tray app keeps running, this is the page.

## Root cause: on Windows the supervised `Child` is the `wsl.exe` WRAPPER, not the operator

`spawn_serve` (`papercusp-desktop/src-tauri/src/main.rs`) launches the operator
via `make_sidecar_command(via_wsl, …)`. On Windows the operator (`serve.mjs`
node process) runs **inside WSL**, so the `std::process::Child` the supervisor
stores and polls with `try_wait()` is the **`wsl.exe` wrapper process**, not the
node operator itself.

The two liveness facts can therefore diverge:

* `child_exited` (from `try_wait()` on the stored `Child`) = "did the **wsl.exe
  wrapper** exit?"
* `operator_reachable` (an HTTP health probe on the recorded port) = "is the
  **actual operator** answering?"

When the **inner** WSL node operator dies but the **`wsl.exe` wrapper outlives
it** (a very common WSL failure shape — the distro/relay keeps the wrapper up),
`child_exited` stays **`false`** even though the operator is gone.

## The bug: the decider short-circuited to Healthy on `!child_exited`

The old pure decider read (paraphrased):

```rust
// OLD — buggy
if !child_exited || operator_reachable {
    return ServeRespawnAction::Healthy;
}
```

`!child_exited` is **first in the OR**, so when the wrapper outlived the dead
inner operator (`child_exited == false`), the decider returned `Healthy` and
**never consulted `operator_reachable`**. The dead operator was never respawned.
`child_exited` — the signal the whole decision hung on — is simply **not a
reliable operator-liveness signal on Windows/WSL**.

## The fix: operator **reachability** is the ground-truth liveness signal

Respawn when the operator is **unreachable past a debounce, REGARDLESS of
`child_exited`**. `decide_serve_respawn` now (WI-3170):

```rust
fn decide_serve_respawn(
    child_exited: bool,
    shutting_down: bool,
    operator_reachable: bool,
    unreachable_respawn_ready: bool,   // ← new: unreachable past debounce (see gating)
    respawns_in_window: usize,
    max_respawns: usize,
) -> ServeRespawnAction {
    if shutting_down { return ServeRespawnAction::Suppressed; }
    if operator_reachable { return ServeRespawnAction::Healthy; }   // reachable ⇒ healthy, full stop
    if child_exited || unreachable_respawn_ready {
        if respawns_in_window >= max_respawns { return ServeRespawnAction::GiveUp; }
        return ServeRespawnAction::Respawn;
    }
    ServeRespawnAction::Healthy
}
```

Reachability is checked **first and unconditionally**: a reachable operator is
healthy; an unreachable one that has been unreachable long enough is respawned
whether or not the wrapper `Child` has exited.

### Why the debounce is gated (keeps Linux/macOS byte-identical + avoids double-spawn)

`unreachable_respawn_ready` is computed in the supervision loop and armed **only**
when all of:

* `sup_via_wsl` — the Windows/WSL topology where the wrapper-outlives-inner
  divergence exists. On Linux/macOS the stored `Child` *is* the operator, so the
  old `child_exited` path is authoritative and the new path never arms →
  **behavior there is unchanged.**
* `ever_reachable` — the operator came up successfully at least once. This stops
  a **slow cold boot** (operator not reachable *yet*) from being mistaken for a
  death and triggering a competing second spawn.
* unreachable continuously for `SERVE_UNREACHABLE_DEBOUNCE` (15s) — a brief flap
  does not trigger a respawn.

Crash-loop protection is preserved: `MAX_RESPAWNS_PER_WINDOW` (5 / 300s) →
`GiveUp` + `notify_operator_dead`. Shutdown still suppresses respawns.

## Why Linux CI never caught it

The existing WI-2667 decider tests run on Linux CI, where the stored `Child`
**is** the operator — so a dead operator always means `child_exited == true`, and
the buggy `!child_exited` branch is never exercised with a live-wrapper /
dead-inner combination. **The blind spot is structurally invisible to any test
that doesn't model a wrapper `Child` outliving its inner process.** The
regression guard for it is a pure-decider unit test that sets exactly that state:

```
child_exited=false, operator_reachable=false, unreachable_respawn_ready=true
  → expect Respawn      (the case the old code returned Healthy for)
```

(see `serve_respawn_when_operator_unreachable_past_debounce_despite_live_wrapper_child`
in `src-tauri/src/main.rs`). `cargo test` in `src-tauri` covers this plus all the
pre-existing WI-2667 decider cases.

## VERIFIED LIVE on the Windows VM (2026-07-06, WI-3170 P-004)

Confirmed end-to-end on the QEMU Windows VM against the installed Inno full-seed
build (`/api/health` sha `99f2214b3b`). The operator runs inside the
**`papercup-runtime`** WSL distro (NOT the default `Ubuntu`; user `papercup`,
`/home/papercup/.papercusp/operator.json`) — reach it with
`wsl.exe -d papercup-runtime`. Two destructive runs, same Server app (pid 12336)
supervising throughout:

* **Run 1** (`verify-operator-respawn-vm.sh`): killed operator pid 9 + `pkill serve.mjs`
  → Server respawned a healthy operator (fresh pid 8207) in **\~15s**. Exit 0 = PASS.
* **Run 2** (instrumented, per-second trace): killed pid 8207 → `/api/health` **DOWN
  continuously for \~15s** (operator.json emptied) → **recovered at t≈17s** (fresh pid
  9770\).

**Why this proves the debounce path (not the old `child_exited` path):** the
supervision loop polls every **1.5s** (`main.rs` `sleep(from_millis(1500))`). A
`child_exited==true` respawn fires on the *next* poll → recovery in \~3–5s. The
observed \~15s dead-window before respawn is `SERVE_UNREACHABLE_DEBOUNCE` (15s)
elapsing — i.e. `child_exited` stayed **false** (the `wsl.exe` wrapper outlived the
killed inner operator, the exact blind spot) and the new
`unreachable_respawn_ready` arming is what triggered the respawn. The
owner-reported "operator goes down and stays down" symptom is resolved.

> VM gotchas for the next verifier: the operator lives in `papercup-runtime`, not
> the default distro (probing the default shows a listening 16069 socket via the
> shared WSL2 netns but **no** process/operator.json — separate PID+mount ns).
> `tasklist.exe` interop is **off** inside `papercup-runtime`, so read the
> Windows-side `wsl.exe`/Server pids over SSH (`tasklist /FI ...`), not from within
> the distro.

## Co-install guard (only the Server role owns the operator)

VM forensics also found **two** `papercusp-desktop.exe` running — the Server
(pid 3832) *and* a stale old-build GUI (pid 6476). Only the **Server** role may
spawn/own/supervise the operator; a co-installed GUI must never fight it for
ports/PG. This is now pinned by `Role::owns_operator()` (`src-tauri/src/app_role.rs`)

* an `assert!(role.owns_operator())` at the Server serve-spawn gate + the
  `only_server_role_owns_operator` test. (Relates the WI-2902 co-install footgun.)

## Live verification (the unit test is necessary but not sufficient)

The pure decider is unit-tested, but the *integration* behavior — the supervision
loop actually computing `unreachable_respawn_ready` and respawning a real
operator — only runs on Windows/WSL and cannot be exercised on Linux CI. Verify it
on the QEMU VM with `papercusp-desktop/bin/verify-operator-respawn-vm.sh` (run
**inside the VM's WSL**, with a fixed build installed, and coordinate with whoever
owns the VM first — the owner may be live-testing): it reads the live port from
`operator.json`, kills **only** the inner `serve.mjs` (leaving the `wsl.exe`
wrapper + Server alive — the exact blind-spot repro), waits ≤90s, and confirms the
Server respawns the operator within the debounce via `operator.json` port rotation

* `/api/health`.

## Pointers

* Fix: `papercusp-desktop/src-tauri/src/main.rs` (`decide_serve_respawn` + the
  supervision loop's `unreachable_since` / `ever_reachable` / `SERVE_UNREACHABLE_DEBOUNCE`
  state) and `papercusp-desktop/src-tauri/src/app_role.rs` (`owns_operator`).
* Verify script: `papercusp-desktop/bin/verify-operator-respawn-vm.sh`.
* Tracking: **WI-3170**, plan `windows-operator-reliability-2026-07-06`. Relates
  WI-3141 (operator-down forensics), WI-2667 (serve-respawn supervision), WI-2902
  (co-install footgun).
* **General lesson:** whenever a supervised child process is actually a *wrapper*
  (WSL, a shell, a launcher, `sudo`, a container runtime), process-exit
  (`try_wait`/`waitpid`) of the wrapper is **not** liveness of the thing you care
  about. Health-probe the actual service and treat reachability as ground truth;
  use process-exit only as a fast-path hint.
