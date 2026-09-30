/**
 * task-manager/terminal-window — is a terminal WINDOW still open?
 *
 * `scope-class` exempts every `vte-spawn-*.scope` as "a human's terminal window —
 * the window is the unit of control, not the ledger". That is right while the window
 * is OPEN. It is wrong the moment the human closes it: the scope survives as long as
 * anything inside it is alive, so processes an agent left behind keep inheriting an
 * exemption whose justification has expired. Measured on this box 2026-08-02: 103
 * window scopes, of which 17 had no window left and were holding 123 processes —
 * every one of them classified `exempt/human-terminal`, i.e. invisible to the pane
 * that exists to show exactly this.
 *
 * ── THE SIGNAL ──────────────────────────────────────────────────────────────
 *
 * A window's scope is alive iff it still contains a process whose PARENT is one of
 * the terminal application's own processes. GNOME Terminal forks the shell from its
 * server process into a fresh scope, so while the window lives the shell's ppid
 * points back at the server. When the window closes the shell dies with it and any
 * survivors are orphaned onto pid 1 or the systemd user manager — so the link to the
 * application is exactly what "the window is gone" destroys.
 *
 * The "application's own processes" are read from the slice itself: every child of
 * the terminal app slice that is NOT a window scope. Deriving the set that way keeps
 * this structural — it never names `gnome-terminal-server`, so it does not rot the
 * day the unit is renamed, and it matches the rule this subsystem already follows
 * (properties of how systemd accounts for a process, never a process-name list).
 *
 * Verified against the independent signal the plan originally proposed — parsing the
 * scope's systemd `Description`, which embeds the VTE child pid, and probing that pid
 * for liveness. The two agree on 103 of 103 scopes. This one needs no `systemctl`
 * subprocess per scope, and in 86 of 86 live scopes the matching process is the FIRST
 * pid in `cgroup.procs` (the shell is the oldest), so the loop below short-circuits
 * after a single read on the common path.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────
 *
 * Two cheaper-looking formulations were measured and rejected:
 *
 *   "the scan already has ppids — just look for a child of the terminal server in the
 *   rows it collected." The scan's foreign pass is signature-filtered to processes
 *   under the repo root, and 82 of 86 window shells are a bare `bash`, which does not
 *   match. Every live window would have reported no terminal-server child and been
 *   downgraded to `unaccounted` — 86 of the owner's open terminals, confidently
 *   mislabelled. Hence the probe reads the scope's own `cgroup.procs` directly rather
 *   than reusing the filtered rows.
 *
 *   "a window is dead iff every process in it is orphaned onto pid 1 / the user
 *   manager." Agrees on only 97 of 103 — it misses 6 genuinely-dead scopes whose
 *   survivors still have a live parent inside the same scope.
 *
 * ── UNKNOWN IS NOT DEAD ─────────────────────────────────────────────────────
 *
 * Every failure path returns `null`, and `classifyScope` treats null as "still
 * exempt". This asymmetry is the point: the cost of a false DEAD is telling the
 * reaper this subsystem is growing toward that the owner's live terminal is
 * unaccounted residue, which is the one failure the plan's D-010 refused to risk.
 * The cost of a false ALIVE is a process staying hidden one more scan. Fail toward
 * not-killing.
 */

import { parseCgroupProcs, type CgroupFs } from './cgroup-read';
import { isTerminalWindowScope } from './scope-class';
import { linuxPpidFromProcStat } from '../process-identity';

/**
 * The terminal application's own pids — every child of the app slice that is not
 * itself a window scope. An empty set means we could not identify the application
 * (a different desktop, an unreadable slice), which must read as UNKNOWN, never as
 * "no window is alive".
 */
export function readTerminalAppPids(terminalSliceAbs: string, fs: CgroupFs): Set<number> {
  const pids = new Set<number>();
  for (const name of fs.readDir(terminalSliceAbs)) {
    if (isTerminalWindowScope(name)) continue;
    const abs = `${terminalSliceAbs}/${name}`;
    if (!fs.isDir(abs)) continue;
    for (const pid of parseCgroupProcs(fs.readFile(`${abs}/cgroup.procs`) ?? '')) pids.add(pid);
  }
  return pids;
}

/**
 * `true` the window is open, `false` it has been closed, `null` we could not tell.
 *
 * Null on every degraded input — no identifiable application, an empty or unreadable
 * scope, no `/proc` entry we could parse — so a probe failure can never manufacture a
 * dead window.
 */
export function terminalWindowAlive(
  scopeAbsDir: string,
  appPids: Set<number>,
  fs: CgroupFs,
): boolean | null {
  if (appPids.size === 0) return null;

  const pids = parseCgroupProcs(fs.readFile(`${scopeAbsDir}/cgroup.procs`) ?? '');
  if (pids.length === 0) return null;

  let observed = 0;
  for (const pid of pids) {
    const stat = fs.readFile(`/proc/${pid}/stat`);
    if (!stat) continue;
    const ppid = linuxPpidFromProcStat(stat);
    if (ppid === null) continue;
    observed++;
    if (appPids.has(ppid)) return true;
  }
  // Only a verdict if we actually managed to look at something.
  return observed > 0 ? false : null;
}
