# Server-side terminal spawns must prefer process-per-window to reliably run a command
URL: /internal/docs/agent-insights/server-side-terminal-prefer-process-per-window

On a real desktop box the headless operator's client-server terminal (gnome-terminal → gnome-terminal-server via the D-Bus factory) can open a window but silently NOT run the command — force a process-per-window emulator (preferProcessPerWindow) for command-execution reliability.

## Symptom

A server-side terminal spawn (`capability:terminal`, `capability:launch-agent`,
`fleet:launch-on-plan`) reports **ok + a window opens on the owner's seat**, but:

* the arbitrary command never runs (`echo … > /tmp/x` opens a gnome-terminal but
  the file is never created — **EI-11543**), or
* a resumed/forked psu session comes up in the window and **dies within seconds**
  (**EI-11578**).

Meanwhile the *same* command in an **xterm** works fine, so the display and the
desktop session are healthy — the defect is in the terminal *mechanism*, not the
seat.

## Root cause

The headless operator (a systemd `--user` service) spawns terminals via
`spawnConsole` (`console-spawn.ts`). When a live desktop session is detected
(`desktopSessionDetected`), it prefers the owner's **standard client-server
terminal** — `gnome-terminal`, which is a thin client that hands the window off
to `gnome-terminal-server` over the D-Bus factory (WI-4718 restored this so the
owner sees their normal window).

That client-server / factory path is **unreliable for command execution** from
the server-side spawn on a real box:

* the factory can silently **drop the `-- CMD` handoff** — the window is created
  but with a default shell, no command (EI-11543);
* `gnome-terminal-server`'s **pty/env handoff kills a reattached psu managed-pty
  host** (EI-11578).

**Process-per-window emulators** (`xterm` / `alacritty` / `kitty` / `wezterm`)
have no factory: the launched binary *is* the window, binds `DISPLAY` directly,
and `exec`s the command itself — so the command always runs and the pty survives.

## The rule

If a server-side spawn's contract is **"run this command and it must actually
run"**, force the process-per-window ordering with
`spawnConsole({ preferProcessPerWindow: true })`. `resolveTerminalPreference`
then returns `false` even on a detected desktop session, and `findLinuxTerminal`
picks a process-per-window emulator.

Already applied:

* `capability:terminal` — arbitrary-command windows (EI-11543).
* `capability:launch-agent` resume/fork — `preferProcessPerWindow: isResume`
  (EI-11578).

The window is still visible on the owner's seat **with fleet colors** — the OSC
color/title prelude is part of the one-liner and works identically in xterm.

Do *not* reach for this on a fresh non-resume agent launch that genuinely wants
the owner's standard gnome-terminal and does not depend on the fragile handoff;
the knob is for the "the command/pty MUST survive" cases.

## Debugging notes

* `capability:bash` runs inside a PID/mount-namespaced bwrap sandbox with **no
  host X / D-Bus** — you cannot reproduce a live gnome-terminal desktop spawn
  from there (Xvfb can't create `/tmp/.X11-unix` sockets; the dbus socket bind is
  blocked). Reason from the code + the working reference spawner instead.
* The **working reference** is the Rust desktop spawner
  `papercusp-desktop/src-tauri/src/native_console.rs` — it runs *inside* the GUI
  session, so its gnome-terminal invocation gets the correct DISPLAY/DBUS
  directly and does not exercise the headless-resolution fragility.
