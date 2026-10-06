/**
 * Wall-clock deadlines vs. a freeze (EI-24796665684871321).
 *
 * `processes:freeze` stops a task consuming CPU — it does NOT stop the clock. Every
 * wall-clock deadline a task carries keeps running while its cgroup is frozen, and
 * the thaw is exactly when it trips:
 *
 *   1. the LEDGER deadline — `runtimeMaxSec` becomes systemd `RuntimeMaxSec` and the
 *      row's `deadlineAt`. `capability:bash`'s `timeout` is this one. Exact.
 *   2. an INNER wrapper in the command text — `timeout -k 30 1800 gitnexus analyze`
 *      (GNU timeout) is the same wall-clock hazard but is invisible to the ledger; the
 *      only trace is the command line already stored in `argv`. Heuristic.
 *
 * Measured 2026-10-01 (su-95c6c914, WI-10001405): a ~13 min freeze of an analyzer
 * under `timeout -k 30 1800` left 50s of a 30:00 budget after only ~16 min of real CPU;
 * thaw would have SIGTERMed it mid-write and corrupted the index. The freeze guidance
 * said "relieve pressure without losing work" with no such caveat.
 *
 * This module is PURE (no clock, no I/O of its own): `now` is passed in, so the
 * verdicts are deterministic and `control.ts` stays the only place that touches state.
 * It WARNS rather than refuses on purpose — freeze exists for pressure relief, and a
 * deadline-bearing task under memory pressure is still better frozen than thrashing;
 * what the caller lacked was the information to choose.
 */

/** The ledger's own wall-clock deadline for the task — exact, systemd-enforced. */
export interface LedgerDeadline {
  deadlineAt: string;
  /** Whole seconds left on the deadline, clamped at 0. */
  remainingSec: number;
  /** The deadline has already passed (systemd is about to / already terminated it). */
  expired: boolean;
}

/** A GNU `timeout <duration>` wrapper found in the stored command line. HEURISTIC. */
export interface InnerTimeoutHint {
  /** The declared budget, in seconds. */
  seconds: number;
  /** The matched text, e.g. `timeout -k 30 1800`. */
  matched: string;
}

export interface FreezeDeadlineReport {
  ledgerDeadline: LedgerDeadline | null;
  innerTimeouts: InnerTimeoutHint[];
  /** Human-readable cautions; empty when the task carries no wall-clock deadline. */
  warnings: string[];
}

export interface DeadlineSubject {
  deadlineAt?: string | null;
  startedAt?: string | null;
  argv?: readonly string[] | null;
}

/** On thaw, warn when this little (or less) of the ledger budget remains. */
export const THAW_LOW_BUDGET_SEC = 120;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * `timeout [OPTION] DURATION COMMAND` — GNU coreutils. Options that take a value
 * (`-k`/`--kill-after`, `-s`/`--signal`) are consumed with it so the value is not
 * mistaken for the duration; `--foreground`, `--preserve-status`, `-v` take none.
 * Anchored on a command boundary so `mytimeout 5` and prose like `a timeout of 5`
 * do not match `timeout` mid-word.
 */
const TIMEOUT_WRAPPER =
  /(?:^|[\s;&|(`])((?:\/usr\/bin\/|\/bin\/)?timeout(?:\s+(?:(?:-k|-s|--kill-after|--signal)(?:=|\s+)\S+|-{1,2}[A-Za-z][A-Za-z-]*))*\s+(\d+(?:\.\d+)?)([smhd]?))(?=\s)/g;

/** Bounds the scan so a pathological multi-megabyte command cannot stall a freeze. */
const MAX_SCAN_CHARS = 64 * 1024;

export function findInnerTimeouts(argv: readonly string[] | null | undefined): InnerTimeoutHint[] {
  if (!argv || argv.length === 0) return [];
  const text = argv.join(' ').slice(0, MAX_SCAN_CHARS);
  const out: InnerTimeoutHint[] = [];
  for (const m of text.matchAll(TIMEOUT_WRAPPER)) {
    const value = Number(m[2]);
    const unit = m[3] || 's';
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({ seconds: Math.round(value * (UNIT_SECONDS[unit] ?? 1)), matched: m[1].trim() });
  }
  return out;
}

export function ledgerDeadline(subject: DeadlineSubject, nowMs: number): LedgerDeadline | null {
  if (!subject.deadlineAt) return null;
  const at = Date.parse(subject.deadlineAt);
  if (!Number.isFinite(at)) return null;
  const remainingMs = at - nowMs;
  return {
    deadlineAt: subject.deadlineAt,
    remainingSec: Math.max(0, Math.floor(remainingMs / 1000)),
    expired: remainingMs <= 0,
  };
}

function fmtSec(sec: number): string {
  if (sec < 120) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/**
 * What a freeze (`action:'freeze'`) or thaw (`action:'thaw'`) should tell the caller
 * about wall-clock deadlines the task is carrying. Always returns a report; an empty
 * `warnings` means "carries no wall-clock deadline we can see" — NOT "safe to freeze
 * indefinitely" for the inner-wrapper half, which only sees what the command text says.
 */
export function reportFreezeDeadlines(
  subject: DeadlineSubject,
  nowMs: number,
  action: 'freeze' | 'thaw',
): FreezeDeadlineReport {
  const deadline = ledgerDeadline(subject, nowMs);
  const innerTimeouts = findInnerTimeouts(subject.argv);
  const warnings: string[] = [];

  if (deadline) {
    if (deadline.expired) {
      warnings.push(
        action === 'freeze'
          ? `task's wall-clock deadline (${deadline.deadlineAt}) has ALREADY passed — systemd will terminate it regardless of the freeze; freezing it saves nothing`
          : `task's wall-clock deadline (${deadline.deadlineAt}) passed while it was frozen — it is terminated or about to be, thawing will not rescue it`,
      );
    } else if (action === 'freeze') {
      warnings.push(
        `task has a wall-clock deadline ${deadline.deadlineAt} (${fmtSec(deadline.remainingSec)} left) and the clock KEEPS RUNNING while frozen: a freeze longer than that gets the task terminated by systemd the moment it is thawed (or before) — if the hold must outlast it, kill and re-run instead (processes:kill)`,
      );
    } else if (deadline.remainingSec <= THAW_LOW_BUDGET_SEC) {
      warnings.push(
        `thawed with only ${fmtSec(deadline.remainingSec)} left before its wall-clock deadline (${deadline.deadlineAt}) — frozen time counted against it; expect it to be terminated shortly`,
      );
    }
  }

  if (innerTimeouts.length > 0) {
    const list = innerTimeouts.map((t) => `\`${t.matched}\` (${fmtSec(t.seconds)})`).join(', ');
    warnings.push(
      action === 'freeze'
        ? `command text contains a GNU timeout wrapper — ${list}. HEURISTIC (read from argv; the ledger cannot see it): such a timeout counts wall-clock, so frozen time burns it and it SIGTERMs the payload on thaw, possibly mid-write. Do not freeze a deadline-bearing task for longer than its remaining budget — finish or kill it instead`
        : `command text contains a GNU timeout wrapper — ${list}. HEURISTIC: frozen time counted against it, so it may SIGTERM the payload right after this thaw`,
    );
  }

  return { ledgerDeadline: deadline, innerTimeouts, warnings };
}
