/**
 * The /proc + signal side of `a11y-bus-sweep`, kept out of that module so the
 * policy there stays pure and unit-testable with no filesystem at all.
 *
 * Every read here is best-effort: a process can exit between `readdir` and any
 * subsequent open, and `/proc/<pid>/environ` is unreadable for processes we do
 * not own. Both surface as `null`, which the policy treats as "do not touch"
 * rather than "no display" — see `selectStaleBuses`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { parseStartTimeTicks, type SweepIo } from './a11y-bus-sweep';

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Boot time in epoch seconds, from /proc/stat's `btime` line. */
function bootTimeSec(): number | null {
  const stat = readOrNull('/proc/stat');
  if (stat === null) return null;
  const match = /^btime\s+(\d+)$/m.exec(stat);
  return match ? Number(match[1]) : null;
}

const CLOCK_TICKS_PER_SEC = 100; // _SC_CLK_TCK is 100 on every Linux target we ship to.

export function nodeSweepIo(logger: (message: string) => void = console.info): SweepIo {
  const boot = bootTimeSec();

  return {
    listPids() {
      try {
        const pids: number[] = [];
        for (const entry of readdirSync('/proc')) {
          const pid = Number(entry);
          if (Number.isInteger(pid) && pid > 0) pids.push(pid);
        }
        return pids;
      } catch {
        return [];
      }
    },

    readCmdline(pid) {
      const raw = readOrNull(`/proc/${pid}/cmdline`);
      // argv is NUL-separated; join with spaces so the argument matchers see a
      // conventional command line.
      return raw === null ? null : raw.replace(/\0/g, ' ').trim();
    },

    readEnviron(pid) {
      return readOrNull(`/proc/${pid}/environ`);
    },

    ageSec(pid) {
      if (boot === null) return null;
      const stat = readOrNull(`/proc/${pid}/stat`);
      if (stat === null) return null;
      const ticks = parseStartTimeTicks(stat);
      if (ticks === null) return null;
      return Math.max(0, Math.floor(Date.now() / 1000) - boot - Math.floor(ticks / CLOCK_TICKS_PER_SEC));
    },

    liveDisplays() {
      // An X server holds /tmp/.X<n>-lock for as long as it is up. This is the
      // same evidence `findFreeDisplayNumber` uses to pick a free display, so
      // the sweep and the provisioner cannot disagree about what is in use.
      const live = new Set<string>();
      try {
        for (const entry of readdirSync('/tmp')) {
          const match = /^\.X(\d+)-lock$/.exec(entry);
          if (match) live.add(`:${Number(match[1])}`);
        }
      } catch {
        /* an unreadable /tmp yields an EMPTY set, which would make every display
           look dead — so the caller must treat a throw here as fatal, not as a
           licence to reap. `sweepHost` below refuses on an empty set. */
      }
      return live;
    },

    kill(pid, signal) {
      process.kill(pid, signal);
    },

    log: logger,
  };
}

/**
 * Run one sweep against the real host.
 *
 * REFUSES when no X display is visible at all. An empty live-display set is
 * exactly what an unreadable /tmp produces, and it is also the one input that
 * makes EVERY bus look reapable — so it must fail closed. A host that genuinely
 * has no desktops also has no a11y buses to sweep, so nothing is lost.
 */
export function sweepHost(
  run: (io: SweepIo) => { scanned: number; reaped: number[]; raced: number[]; kept: number },
  logger?: (message: string) => void,
  /**
   * The io factory, injectable ONLY so the fail-closed refusal below is reachable
   * from a test without a real /proc and /tmp. Production always takes the default.
   * Without this seam the guard that prevents reaping every bus on an unreadable
   * /tmp had no executable coverage at all (WI-42400 measurement).
   */
  makeIo: (logger?: (message: string) => void) => SweepIo = nodeSweepIo,
): { scanned: number; reaped: number[]; raced: number[]; kept: number } | null {
  const io = makeIo(logger);
  if (io.liveDisplays().size === 0) {
    io.log('[a11y-bus-sweep] no X display locks visible — refusing to sweep (fail-closed)');
    return null;
  }
  return run(io);
}
