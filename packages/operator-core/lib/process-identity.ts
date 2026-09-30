/**
 * Kernel-backed process identity for any code that is about to trust a PID
 * from durable state. A PID is only an address in the current process table;
 * pairing it with the boot id and process start time turns it into a stable
 * identity for the lifetime of that process.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Linux /proc stat field 22 (starttime), robust to spaces and ')' in comm. */
export function linuxStartTicksFromProcStat(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // Text after comm starts at field 3 (state); starttime is field 22 => index 19.
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}

/**
 * Linux /proc stat field 4 (ppid), robust to spaces and ')' in comm.
 *
 * Same `lastIndexOf(')')` discipline as starttime above, and for the same reason: a
 * naive `split(/\s+/)[3]` reads the wrong field for any process whose comm contains
 * a space or a paren, which on this box includes ordinary shells and editors.
 * Returns null rather than a guess — a wrong ppid would silently mis-answer
 * "is this process still attached to its parent?".
 */
export function linuxPpidFromProcStat(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // Text after comm starts at field 3 (state); ppid is field 4 => index 1.
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = fields[1];
  if (!ppid || !/^\d+$/.test(ppid)) return null;
  const n = Number(ppid);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Linux /proc stat field 5 (pgrp — the process-group id). Same `lastIndexOf(')')`
 * discipline as ppid above. Returns null rather than a guess: a wrong pgrp would
 * widen a group signal to processes the caller does not own.
 */
export function linuxPgrpFromProcStat(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // Text after comm starts at field 3 (state); pgrp is field 5 => index 2.
  const pgrp = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[2];
  if (!pgrp || !/^\d+$/.test(pgrp)) return null;
  const n = Number(pgrp);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Read the process-group id of `pid`. Any read or parse failure returns null, so a
 * caller that would signal the whole group falls back to the single pid.
 */
export function readProcessGroupId(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      return linuxPgrpFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    }
    if (process.platform === 'darwin') {
      const raw = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
      if (!/^\d+$/.test(raw)) return null;
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  } catch {
    // Process exited, permissions changed, or this platform has no safe reader.
  }
  return null;
}

/**
 * Linux /proc stat field 3 (state — R/S/D/Z/T/...), robust to spaces and ')' in comm.
 * Same `lastIndexOf(')')` discipline as starttime/ppid above.
 *
 * This is a DIAGNOSTIC read, never a liveness check: a null return means "could not
 * determine", not "not a real state" and never "dead" — cgroup membership remains the
 * liveness signal. Its purpose is to tell a caller stuck on an unkillable survivor
 * WHY (a zombie can't be reached by any signal; an uninterruptible-sleep process has
 * the signal queued but blocked in the kernel) instead of a bare unexplained count.
 */
export function linuxProcStateFromStat(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // Text after comm starts at field 3 (state) — it's the FIRST token, unlike
  // starttime/ppid above which index past it.
  const state = stat.slice(close + 1).trim().split(/\s+/)[0];
  return state && /^[A-Za-z]$/.test(state) ? state : null;
}

export function linuxProcessIdentityFromStat(bootId: string, stat: string): string | null {
  const boot = bootId.trim();
  const ticks = linuxStartTicksFromProcStat(stat);
  return boot && ticks ? `linux:${boot}:${ticks}` : null;
}

export function normalizePsStartTime(value: string): string {
  return value.trim().split(/\s+/).join(' ');
}

/**
 * Read the current identity of `pid`. Any read or parse failure returns null:
 * destructive callers must fail closed rather than fall back to PID-only.
 */
export function readProcessIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      return linuxProcessIdentityFromStat(
        readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFileSync(`/proc/${pid}/stat`, 'utf8'),
      );
    }
    if (process.platform === 'darwin') {
      const started = normalizePsStartTime(
        execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }),
      );
      return started ? `darwin:${started}` : null;
    }
  } catch {
    // Process exited, permissions changed, or this platform has no safe reader.
  }
  return null;
}
