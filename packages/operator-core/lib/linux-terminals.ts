/**
 * linux-terminals — the ONE table of Linux terminal emulators and the args that
 * open a new window in each.
 *
 * This exists because there were two. `console-spawn.ts` and `terminal-spawn.ts`
 * each carried their own copy, and a fix applied to one silently missed the
 * other: EI-19385011811175105 (a spawned terminal inheriting
 * GNOME_TERMINAL_SCREEN opens NO window and exits 0) was fixed in terminal-spawn
 * and had to be fixed again in console-spawn a day later
 * (EI-19407722209410974). The data is now single-sourced so the next such fix
 * cannot land in only half the codebase.
 *
 * ⚠ The SELECTION POLICY itself is defined ONCE, in console-spawn.ts
 * (`pickLinuxTerminal` + `resolveLinuxDesktopEnv`/`resolveTerminalPreference`) —
 * only the raw terminal DATA lives here. Both console-spawn.ts's own spawn path
 * and terminal-spawn.ts's `findTerminal` now call into that same policy (picking
 * client-server-first ONLY when a real desktop session's D-Bus was resolved,
 * WI-4718) rather than each choosing independently — converged by
 * EI-19408594551235977, which is why `terminal-spawn.ts` no longer walks
 * {@link LINUX_TERMINALS_FLAT} in flat order for real selection (it is kept only
 * as the data-parity constant `LINUX_TERMINALS`, pinned below). The two files'
 * SPAWN functions (env injection, display override, liveness probing, …) remain
 * separate — do not assume a fix to one applies to the other without reading it.
 *
 * The split into two groups is load-bearing, not cosmetic — see each comment.
 */

/**
 * CLIENT-SERVER emulators — the user's STANDARD desktop terminals. The launched
 * binary is a thin client that hands the window off to a per-session D-Bus
 * factory / server (gnome-terminal-server, konsole's session app), which opens
 * the window on ITS OWN display, NOT the DISPLAY the client was spawned with
 * (this is also why findDisplayHonoringTerminal excludes them). This is what the
 * owner sees when they open a terminal by hand, so — when a real desktop session
 * is running — it is what "Resume in new terminal" / the "+" button /
 * capability:terminal / fleet:launch-on-plan should open too.
 *
 * These WORK from the headless operator (a systemd --user service) ONLY when the
 * spawn env carries the D-Bus address of the SESSION the server lives on.
 * resolveLinuxDesktopEnv resolves that from the live session (resolveSessionBus —
 * reads it from the running gnome-terminal-server / gnome-shell for the active
 * seat), so gnome-terminal reaches its server and opens the owner's standard
 * window whether the session uses the systemd user bus (/run/user/<uid>/bus, a
 * normal box) or a session-spawned dbus-daemon (/tmp/dbus-*, this dev box — GNOME
 * started its own bus). BEFORE that fix the operator injected a hardcoded
 * /run/user/<uid>/bus that had no server on it, so gnome-terminal's client fell
 * back to a standalone `gnome-terminal.real --wait` that mapped NO window and
 * lingered — the "invisible window" of WI-4711 /
 * resume-in-new-terminal-invisible-window (2026-07-13), which WI-4711 worked
 * around by preferring xterm (why the owner saw "weird" terminals instead of
 * their standard gnome-terminal). Root cause + the corrected fix: WI-4718.
 *
 * (`--wait` keeps gnome-terminal's client alive for the window's lifetime so an
 * adv_sessions row doesn't look "ended" while the terminal is still open.)
 */
export const CLIENT_SERVER_TERMINALS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['gnome-terminal', ['--wait', '--window', '--']],
  ['konsole', ['--new-window', '-e']],
  ['xfce4-terminal', ['--window', '-e']],
];

/**
 * PROCESS-PER-WINDOW emulators — each launched binary IS its own terminal window
 * and binds the injected DISPLAY/XAUTHORITY directly, so it opens on the resolved
 * seat regardless of session / D-Bus / desktop-session state. RELIABLE with no
 * desktop session at all — so they are the FALLBACK when no client-server server
 * can be reached (a bare Xvfb / sandbox stage with no GNOME/KDE session, or a box
 * with no standard terminal installed). This is also the set
 * findDisplayHonoringTerminal uses for the WI-4272 demo-stage displayOverride
 * path, for the same reason (a client-server terminal would open on the seat's
 * server, ignoring the override display).
 */
export const PROCESS_PER_WINDOW_TERMINALS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['wezterm', ['start', '--always-new-process', '--']],
  ['xterm', ['-e']],
];

/**
 * Both groups in the flat order `terminal-spawn.ts` has always walked them:
 * client-server first, then process-per-window. Byte-identical to the literal it
 * replaces, so single-sourcing the data changed no selection — pinned by
 * `linux-terminals.test.ts`.
 *
 * ⚠ Callers that can determine whether a desktop session is actually reachable
 * should NOT use this — they want console-spawn's `pickLinuxTerminal`, whose
 * order is conditional on exactly that (WI-4718). This flat order always tries
 * gnome-terminal first, which ghosts when no D-Bus server can be reached.
 */
export const LINUX_TERMINALS_FLAT: ReadonlyArray<readonly [string, readonly string[]]> = [
  ...CLIENT_SERVER_TERMINALS,
  ...PROCESS_PER_WINDOW_TERMINALS,
];
