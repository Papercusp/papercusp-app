# On-desktop session detection: launch-handle capture rots — derive from proc ancestry
URL: /internal/docs/agent-insights/desktop-session-liveness-ancestry

>

## The incident (2026-07-02)

The idle-session reaper (slice 2, live-but-idle termination) SIGKILLed an agent
session the owner had **open in a terminal window on their desktop**
(`bash: line 1: 363488 Killed`). The 2026-06-29 owner decision says exactly this
must never happen: a session with a live OS window is HARD-EXEMPT from every
reap slice.

The exemption code was present and wired — and **had protected zero sessions
since the day it shipped**. Every hourly sweep logged
`0 on-desktop/hard-exempt`, for days, and nothing alarmed.

## Root cause: all three launch-recorded match keys rot

`desktop-window-liveness.ts` originally matched `wmctrl -lp` windows against
launch-recorded `adv_sessions` handles. All three keys were dead:

1. **`window_id`** — recorded only by the console-launch route, which resolves
   the window by its `[adv:N]` title tag within \~5s of spawn. Sessions stopped
   launching through that route (\~2026-05-31); NO row since then has a
   `window_id`. Even when the route runs, the tag race is fragile — see #2.
2. **`[adv:N]` title tag** — the Claude Code TUI **rewrites the terminal title**
   to the current task description ("✳ Fix the thing…"), destroying the tag.
3. **`pid`** — gnome-terminal is a *single-process* emulator:
   `gnome-terminal-server` owns **every** terminal window, so `wmctrl`'s window
   pid is the shared server pid, never the launch pid. `pid` capture also
   stopped entirely \~2026-06-23.

Result: with agent windows visibly open, the on-desktop set was always empty →
the reaper's protected-set fold was a no-op → an idle-4h on-screen session was
a legitimate slice-2 target.

## The fix: derive "on the desktop" from live proc ancestry (WI-1586)

The one handle that cannot rot is the session's **live host pid**: every
interactive psu session publishes `{ownerId, pid, sock}` to
`~/.papercusp/psu-pty/` (self-validating; see `listLiveHosts()` in
`psu-pty-discovery.ts`). A pid is "on the desktop" iff its `/proc` **ancestor
chain reaches a pid that owns an open window**:

```
claude/psu host (363663) ← bash (363649) ← gnome-terminal-server (1357544 — owns the windows)
```

Closing the window SIGHUPs the shell; the host dies or is reparented away from
the terminal-server — so the signal **expires with the window**, needs no
launch-time capture, and survives title rewriting and the shared-emulator-pid
model. Over-matching only ever over-protects (the safe direction for a reaper
exemption).

Implementation: `pidHasWindowAncestor` / `windowOwningPids` /
`isPidUnderOpenWindow` in `desktop-window-liveness.ts`;
`gatherOnDesktopSessions` runs the handle match (leg 1, kept as belt) **and**
the ancestry pass over `listLiveHosts()` (leg 2, load-bearing). Slice-3 zombie
reap additionally checks the *discovered* proc pid's ancestry
(`ZombieReapDeps.pidOnDesktop`) so a leaked proc inside an open window is spared
even with no adv row handle at all.

Verified live: 17/20 live hosts detected on-desktop (the 3 misses are
headless-spawned — correct), `keptOnDesktop 0→11`, slice-2 target list empty.

## The detector failure (fix the guard, not just the bug)

"0 on-desktop/hard-exempt" was in the journal for a month. The broken shape is
mechanically detectable: **open windows + live interactive hosts + zero
protected owners**. The sweep routine (`idle-session-reaper-action.ts`) now runs
an exemption health probe before any destructive slice and logs the three counts
every sweep, warning loudly on that shape. If you see that warning, treat every
kill in the same sweep as suspect.

## Traps for future work here

* **Never key desktop/window logic on window titles or window pids** without
  accounting for TUI title rewriting and single-process emulators.
* **`isOwnerFocusedOnDesktop`** (the stall-waker auto-ESC focus guard) still
  uses the rotted launch handles and is likely a no-op for post-May-31 sessions
  — tracked as **WI-1588**. The ancestry signal is deliberately NOT used there:
  it is presence-grade, not focus-grade (any focused terminal window would match
  every terminal-hosted session via the shared emulator pid, suppressing
  auto-recovery fleet-wide).
* The exemption runs in **papercup-bg-host** (`:3270`, staging tree, has
  `DISPLAY`) — a box/service without `DISPLAY` sees no windows and protects
  nothing, by design (headless fleet boxes).
