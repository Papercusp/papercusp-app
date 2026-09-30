/**
 * The real `ResidueLivenessProbe` — the /proc reads that tell a dead-window scope
 * holding a live SERVICE apart from one holding abandoned residue
 * (EI-19418147529720290).
 *
 * It lives outside `terminal-residue-census.ts` on purpose. That module is pure
 * with respect to its injected `CgroupFs` — no clock, no subprocess, no readlink —
 * and its tests depend on that. Socket ownership needs `readlink` on every fd in
 * `/proc/<pid>/fd`, and age needs the boot clock, so putting either in the census
 * would either widen `CgroupFs` (stranding every fixture that implements it) or
 * quietly give the module a dependency on real time.
 *
 * ── WHY LISTENING SOCKETS ARE THE DISCRIMINATOR ─────────────────────────────
 *
 * Measured 2026-08-03: `vte-spawn-6bcb8b08` was window-dead and held 61% of all
 * memory attributed to residue. It was the staging operator — `:3170/api/health`
 * returned 200 and its node pid owned four LISTEN sockets. Nothing else about the
 * scope distinguished it from an orphan: not age (it was days old), not process
 * count, not command name. "Is someone able to connect to this?" did.
 *
 * ── WHAT THIS DELIBERATELY GETS WRONG, AND WHY ──────────────────────────────
 *
 * TCP only. `/proc/net/unix` is not consulted, and that is a choice rather than an
 * omission: on this box essentially every process holds a unix socket (dbus alone
 * accounts for hundreds), so including them would mark almost everything a
 * "service" and collapse the signal to a constant. TCP LISTEN is rare enough to
 * carry information.
 *
 * The cost is over-protection, and it is visible in real output. On the same scan,
 * a 16.9-day-old **abandoned Android emulator** (its `netsimd` holds a port) and a
 * stray 8.3-day-old `python3 http.server` both classify as `live-service-held`.
 * Both are junk; neither will be reported as stale. That is the error direction we
 * want — a missed reclaim candidate costs some memory, whereas pointing an operator
 * at a running service costs an outage — but it means `deadStale` is a FLOOR on
 * what is abandoned, never the whole of it, and a surface must not imply otherwise.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

import type { ResidueLivenessProbe } from './terminal-residue-census';

/** `/proc/net/tcp` connection state for LISTEN. */
const TCP_LISTEN = '0A';

/**
 * Socket inodes currently in LISTEN, from both address families.
 *
 * Reading the tables once and matching by inode is what keeps this affordable:
 * the alternative — asking per pid — would re-read a ~1000-line table for every
 * process on a box with 3000+ of them.
 */
function listeningInodes(): Set<string> {
  const out = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try { text = readFileSync(table, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      // sl local_address rem_address st ... uid timeout inode
      if (f.length < 10 || f[3] !== TCP_LISTEN) continue;
      const inode = f[9];
      if (inode && inode !== '0') out.add(inode);
    }
  }
  return out;
}

/**
 * Every pid owning at least one LISTEN socket.
 *
 * Fails SOFT and in the safe direction: an unreadable `/proc/<pid>/fd` (a process
 * that exited mid-scan, or one owned by another user) contributes nothing, so the
 * pid simply is not marked as a service. The census then leaves its scope
 * `indeterminate` rather than calling it stale — a missed service costs a wrong
 * label, and this way the wrong label is never the dangerous one.
 */
function pidsOwningListeners(): Set<number> {
  const inodes = listeningInodes();
  const out = new Set<number>();
  if (inodes.size === 0) return out;

  for (const entry of safeReadDir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    for (const fd of safeReadDir(`/proc/${pid}/fd`)) {
      let target: string;
      try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) { out.add(pid); break; }
    }
  }
  return out;
}

function safeReadDir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

/** Seconds since boot, the clock `/proc/<pid>/stat` field 22 is measured against. */
function uptimeSec(): number | null {
  try {
    const v = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

const CLOCK_TICKS_PER_SEC = 100;

/**
 * EI-20369673282334981 — which agent session's shell LAUNCHED this process.
 *
 * `PAPERCUSP_SID` is exported into every agent session's shell environment and is
 * therefore INHERITED by anything that session starts, at any depth. That makes a
 * dead-window process attributable to a session id, which can then be resolved
 * against the presence oracle — the exact reasoning a human applied by hand on the
 * :4015 incident (the launching session `su-f0c6fa5e…` had ended and no longer
 * existed in coordination) before reaping it.
 *
 * Measured on this box 2026-08-13: 52 of 200 readable `/proc/<pid>/environ`
 * carried it. The other 148 carried nothing — a systemd unit, a pre-operator
 * bootstrap, anything the owner started by hand. So `null` is the MAJORITY answer
 * and means only "no opinion"; it is never evidence that a process is unowned.
 *
 * `/proc/<pid>/environ` is NUL-separated and readable only for our own uid; an
 * unreadable one fails soft to `null` for the same reason the socket scan does.
 */
export function owningSessionId(pid: number): string | null {
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return null; }
  return parseOwningSessionId(raw);
}

const SID_VAR = 'PAPERCUSP_SID=';

/**
 * PURE half of `owningSessionId`, split out so the parsing is testable without a
 * real `/proc` — the same reason this whole module sits outside the census.
 *
 * `raw` is the NUL-separated `environ` blob. Entries are whole `NAME=VALUE` pairs,
 * so a NAME-anchored prefix match is both exact (it cannot be fooled by a variable
 * whose name merely ENDS with `PAPERCUSP_SID`) and safe for values containing `=`,
 * which a `split('=')` would truncate.
 */
export function parseOwningSessionId(raw: string): string | null {
  for (const entry of raw.split('\0')) {
    if (!entry.startsWith(SID_VAR)) continue;
    const v = entry.slice(SID_VAR.length).trim();
    // An EMPTY value is "not set", not a session named ''. Exported-but-blank is a
    // real shape (`export PAPERCUSP_SID=` in a partially-initialised shell), and
    // returning '' would attribute the process to a session that does not exist.
    return v || null;
  }
  return null;
}

export function pidAgeMs(pid: number, uptime: number | null): number | null {
  if (uptime === null) return null;
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  // `comm` (field 2) is parenthesised and may itself contain spaces AND parens, so
  // the fields after it can only be found from the LAST ')'. Splitting the whole
  // line on whitespace mis-indexes every subsequent field for such a process.
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const after = stat.slice(close + 2).split(' ');
  const startTicks = Number(after[19]); // field 22 overall = starttime
  if (!Number.isFinite(startTicks)) return null;
  const ageSec = uptime - startTicks / CLOCK_TICKS_PER_SEC;
  return ageSec >= 0 ? ageSec * 1000 : null;
}

/**
 * Build a probe. `knownLivePids` is supplied by the caller — the census must not
 * reach into a database, but a caller that already holds the enrolled-task pids
 * (the reconcile tick does) should pass them so an enrolled agent session is never
 * labelled stale merely for holding no socket.
 */
export function nodeResidueLivenessProbe(knownLivePids?: ReadonlySet<number>): ResidueLivenessProbe {
  // Both scans are memoised for the probe's lifetime: one census pass asks about
  // the same pids repeatedly, and a probe is built per tick, so this is a snapshot
  // of one instant rather than a value that shifts underneath a single census.
  let listeners: Set<number> | null = null;
  const uptime = uptimeSec();
  // Attribution is asked ONLY about pids in dead-window scopes (a handful), never
  // about every process on the box, so it is a per-pid read rather than a scan —
  // and memoised because one census pass asks about the same pid more than once.
  const sids = new Map<number, string | null>();
  return {
    listeningPids: () => (listeners ??= pidsOwningListeners()),
    knownLivePids: knownLivePids ? () => knownLivePids : undefined,
    owningSessionId: (pid) => {
      if (!sids.has(pid)) sids.set(pid, owningSessionId(pid));
      return sids.get(pid) ?? null;
    },
    pidAgeMs: (pid) => pidAgeMs(pid, uptime),
  };
}
