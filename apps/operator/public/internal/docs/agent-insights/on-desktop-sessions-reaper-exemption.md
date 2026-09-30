# "On-desktop" sessions — reaper hard-exemption + presence flag
URL: /internal/docs/agent-insights/on-desktop-sessions-reaper-exemption

A session whose OS window is currently open on the user's screen (derived live via wmctrl + adv_sessions.window_id) is "on the desktop". Such sessions are HARD-EXEMPT from every idle-session-reaper slice (the user kept losing windows they were looking at to the live-idle terminate), and coord:presence + /adv/sessions now expose an `onDesktop` flag so you can "assign these to the agent on the desktop".

## The problem

The idle-session reaper is armed in production (both `papercusp-idle-session-reaper`
**and** the destructive `papercusp-idle-session-reaper-terminate` default to `true`).
Slice 2 (live-but-idle terminate) Ctrl-C → SIGKILLs any *alive* session that has
done no genuine activity for 4h — **including a session the user has open on screen
but hasn't typed in**. The owner kept losing windows they were actively watching.

## What "on the desktop" means (owner decision 2026-06-29)

A session is **on the desktop** iff its OS window is *currently present* — a live
`wmctrl -lp` enumeration of open windows, matched against the launch-recorded
`adv_sessions.window_id` (with the unique `[adv:<id>]` window-title tag and the
recorded pid as fallbacks). Purely **derived** — no new column, no migration,
recomputed each read. A minimized window still counts (it's still a window).

This deliberately covers the **console / terminal-window** launch population
(`console-launch.ts` opens a real terminal emulator and stores its `window_id`).
It does **not** cover the operator web / Tauri PTY *panel* (that attaches over a
PTY WebSocket with no OS window) — by design; the owner chose the OS-window
definition over a viewer-attach heartbeat.

`desktop-window-liveness.ts` is the whole mechanism:

* `parseWmctrlList` / `selectOnDesktopSessions` — **pure**, unit-tested without an
  X server.
* `listOpenWindows` — wmctrl spawn, **async `execFile`** (NOT `spawnSync` — this
  runs on the single `:3070` operator loop via the presence path; a blocking spawn
  on a hung X server would freeze the operator), short-TTL cached.
* `gatherOnDesktopSessions()` → `{ owners, sessionIds, advSessionIds }`, the three
  keyings the callers need, short-TTL cached, **best-effort → empty** on any
  failure.

**Box-local + fail-safe:** wmctrl talks to *this* host's X server, so a headless
fleet box returns no windows → nothing is on the desktop → the reaper/presence
behave exactly as before. Every failure path yields empty sets, so a hiccup can
only **over-protect** (skip a reap) or omit the flag — never crash a read/sweep and
never cause an *extra* kill.

## The exemption (hard, all slices)

In `idle-session-reaper.ts` the on-desktop owners/sessionIds are folded in:

* **Slice 1** (dead-process ghost reap): `gatherOnDesktopSessions().owners` ∪ the
  protected set → an on-desktop owner is never a "ghost" however long its heartbeat
  lapsed. Counted as `keptOnDesktop` in the result + routine log.
* **Slice 2** (live-idle terminate): on-desktop owners ∪ the *busy* set → an
  on-desktop session is never in the terminate cohort, however idle.
* **Slice 3** (zombie `--resume` reap): `planZombieReap(procs, ended, onDesktop)`
  excludes on-desktop session ids — belt-and-braces atop the existing
  foreground-TTY spare in `discoverResumeProcs` (a console terminal's claude proc
  is already foreground), covering minimized/backgrounded edge cases.

The pure plan functions are unchanged — the sets they receive just get bigger — so
the slice-1/2/3 unit tests still hold; new tests cover the exclusions.

## Surfacing (so you can target it)

* **`coord:presence`** — every local roster row carries `onDesktop` (LIVENESS lane
  in `presence-payload.ts`, so it never churns the byte-stable \[coord+N] delta
  channel), and `summary.onDesktop` is the count. To act on *"the agent on the
  desktop / on my screen"*, filter rows where `onDesktop:true`. Federated rows are
  `null` (their windows live on their home box).
* **`/adv/sessions`** — each row gets `onDesktop`; the UI shows a `🖥 desktop` chip.

## Gotchas

* It's **live**: close the window and the session drops out of `onDesktop` within
  the TTL, and normal reaping resumes — that's intended (hard-exempt only *while*
  on the desktop).
* A false-positive pid match only **over-protects** (safe). The reliable keys are
  `window_id` and the `[adv:<id>]` title tag.
