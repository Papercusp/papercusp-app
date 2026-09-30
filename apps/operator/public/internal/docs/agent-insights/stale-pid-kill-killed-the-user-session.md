# Stale-PID kills — a recycled PID took down the whole user session
URL: /internal/docs/agent-insights/stale-pid-kill-killed-the-user-session

On 2026-06-12 02:14:57 gnome-shell received an unattributed SIGKILL and the owner's entire GNOME session (plus 21 agent sessions) died instantly. The dev box's PID counter wraps within ~a day under agent load, so any kill aimed at a PID recorded earlier (pid files, captured $!, "the parent of X") can hit an innocent recycled PID. Verify /proc/<pid>/cmdline before every kill of a recorded PID; never kill the parent of a desktop-launched app. auditd now attributes every SIGKILL.

## Symptom

The owner's Ubuntu session "randomly logged out". Forensics: at
2026-06-12 02:14:57 `org.gnome.Shell@wayland.service` died with
`code=killed, status=9/KILL` — an external SIGKILL, not a crash, not the
OOM killer (kernel OOM and systemd-oomd both had zero kill records).
The compositor dying tore down every Wayland client and ended the
session; **21 concurrent agent transcripts all stop at that exact
second** — the agents running in session terminals died as collateral.
The sender was never attributed: raw `kill()` syscalls were not audited
at the time.

## Why this box makes kills dangerous

* **PID wrap is fast here.** The agent fleet churns thousands of
  short-lived processes (vitest workers, tsx, git, Xvfb instances); the
  PID counter was observed wrapping past `pid_max` (4.19M) and back to
  \~1.1M within roughly a day. Any PID recorded "a while ago" may now
  belong to something else entirely.
* **The environment is full of recorded-PID kills**: `kill $(cat
  /tmp/tauri-xvfb*.pid)` cleanups, captured `$!` from hours earlier,
  internal `process.kill(-pid, 'SIGKILL')` group-kill escalations.
  Each is a stale-PID gamble.
* **The parent trap.** A `papercusp-desktop` instance launched from the
  desktop (launcher / terminal in the session) has **PPID =
  gnome-shell**. Any "kill the parent/wrapper to stop the respawn loop"
  logic aimed at it kills the compositor and ends the user's session.
  (`ps -o ppid= -p <tauri-pid>` returning a 2-day-old PID is the tell.)

## Rules

1. **Verify before killing any recorded PID.** A PID from a pid file,
   an earlier tool call, or a captured `$!` from a previous command
   MUST be re-verified in the same command that kills it:

   ```bash
   pid=$(cat /tmp/tauri-xvfb92.pid)
   grep -qa papercusp-desktop /proc/$pid/cmdline 2>/dev/null && kill "$pid"
   ```

   A bare `kill $(cat …pid)` without the cmdline check is a session
   roulette wheel.
2. **Never kill the parent of a desktop-launched process.** If
   `ps -o ppid=` of your target returns a PID you didn't spawn this
   session, inspect it (`/proc/<ppid>/cmdline`) — it may be
   gnome-shell, systemd --user, or another agent's shell.
3. **Process-group kills (`kill -- -<pid>`) only on groups you spawned
   in the same command/script**, never on a stored group id.
4. **SIGTERM first; SIGKILL only after verifying the target again.**
5. **pkill patterns must be narrow** — and remember
   [exit-144-pkill-self-match](/internal/docs/agent-insights/exit-144-pkill-self-match):
   a `pkill -f` whose pattern appears in your own script text kills
   your own shell.

## Attribution is now available

auditd was installed 2026-06-12 with persistent rules
(`/etc/audit/rules.d/50-sigkill.rules`) auditing `kill`/`tkill`/
`tgkill`/`pidfd_send_signal` with signal 9. To name a SIGKILL sender:

```bash
sudo ausearch -k sigkill --start <time>   # sender pid/ppid/comm/exe + target
```

If a session/process dies of SIGKILL again, this gives the culprit in
one command — check it before theorizing.

## Context

The kill happened at the peak of an agent load storm (15-min load avg
46: a `tauri build --bundles appimage`, parallel vitest runs, and the
EI-339 `default-boot` registry-leaking test re-running \~1/min — the
leak got a hard guard in `join-shared-harness.ts` the same day). High
churn is exactly when PID wrap accelerates and stale-PID kills become
likely — be extra careful with kills while the box is loaded.
