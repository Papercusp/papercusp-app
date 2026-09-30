/**
 * agent-session-progress-census — the residue detector for HEADLESS agent
 * sessions, which the window-based census structurally cannot see
 * (EI-21268871278252116, 2026-08-23 reap: 33 scopes / 118 processes).
 *
 * ── WHY THIS DOES NOT REUSE `terminal-residue-census` ───────────────────────
 *
 * That module is the right detector for its class and this one does not replace
 * it. But it censuses the TERMINAL SLICE and decides liveness with
 * `terminalWindowAlive`, and `scan.ts` gates the whole window probe behind
 * `isTerminalWindowScope(cgroupPath)`. A headless agent session has NO window —
 * it lives in a `pc-<taskId>--<label>.scope`, never a `vte-spawn-*` one — so for
 * this population the window probe returns `not-a-window` and can never observe
 * it dead. The residue is invisible to it BY CONSTRUCTION, not by accident.
 *
 * That blind spot is how 118 processes across 33 scopes accumulated over ~71h
 * while every liveness surface reported healthy.
 *
 * ── WHY LOG MTIME, AFTER THREE INSTRUMENTS GAVE CONFIDENT WRONG ANSWERS ─────
 *
 * The 2026-08-23 investigation tried and falsified three signals before finding
 * one that held. All three are recorded here because each looked authoritative:
 *
 *   • cmdline-tail vs live argv   → claimed 14/21 orphaned. WRONG.
 *   • window-title token match    → claimed 20/21 live. WRONG — generic tokens
 *     ("agent", "resume") matched the inference-gateway, and one codex environ
 *     carried a fleet slug shared by 13 waiters.
 *   • coord_presence.pid join     → FALSE POSITIVE on a LIVE fleet member
 *     holding 97 processes whose log had been written 0 minutes earlier.
 *     `coord_presence.pid` is not the in-scope agent pid.
 *
 * The signal that survived is `task_ledger.log_path` mtime: DIRECT evidence of
 * progress. An agent that is working writes to its log; one that never reached a
 * first turn does not. It needs no cmdline match, no window, and no presence
 * row — which matters because both root causes (booted-but-never-woken, and a
 * `psu-pty-host` CR resubmit loop, WI-41044) never declare `coord_presence` at
 * all. They are sessions that never became agents.
 *
 * ── UNREADABLE IS NOT QUIET (the trap this module refuses to repeat) ─────────
 *
 * A `stat` that fails and a log that is genuinely stale produce the same empty
 * answer, and collapsing them is exactly the false-absence class that cost this
 * investigation hours. `no-log` and `unreadable` are therefore SEPARATE
 * dispositions and are never counted as residue. A caller that cannot tell must
 * say so; `degraded` exists to make an unmeasurable census unusable as evidence
 * rather than quietly reading as a clean zero.
 *
 * ── REPORT-ONLY (D-006 / D-010 / D-016) ─────────────────────────────────────
 *
 * Nothing here terminates anything, and nothing here should gain that power
 * without re-deciding D-010. A quiet log is "this session has not made progress
 * in N hours" — strong evidence, not proof of abandonment. The one reap this
 * evidence has authorised was run by hand, with per-scope log tails preserved
 * first. Consumers must render it as a finding, never as a licence.
 */

import { isLiveOwnedState, type TaskRow } from './types';

/** Ninety minutes: enough for a long tool call plus the 15-minute presence
 * safety window, while bounding the memory cost of a dead headless fleet.
 *
 * The original six-hour calibration was safe but operationally too slow: with
 * 400+ warm agent sessions it left 126 log-silent scopes resident long enough
 * to drive memory+IO PSI and active swap-in. A genuinely live session is still
 * protected independently by a fresh coord_presence heartbeat in the reaper;
 * unreadable/missing logs remain fail-safe and are never classified as quiet. */
export const DEFAULT_QUIET_MS = 90 * 60 * 1000;

/**
 * A task younger than this is never residue, however quiet. A session that has
 * just been spawned legitimately has no log bytes yet, and the boot receipt
 * window alone is ~6s. Without this floor, every healthy launch would appear in
 * the census for its first moments.
 */
export const DEFAULT_MIN_AGE_MS = 15 * 60 * 1000;

export type ProgressDisposition =
  /** Log written within the quiet window — the session is making progress. */
  | 'active'
  /** Log has not been written for longer than the quiet window. RESIDUE CANDIDATE. */
  | 'quiet'
  /** Too young to judge (see {@link DEFAULT_MIN_AGE_MS}). Never residue. */
  | 'too-young'
  /** The row carries no `log_path` at all — nothing to measure. Never residue. */
  | 'no-log'
  /** `log_path` is set but could not be stat'd. NOT quiet — the instrument failed. */
  | 'unreadable';

export interface AgentSessionProgress {
  taskId: string;
  logPath: string | null;
  disposition: ProgressDisposition;
  /** Minutes since the log was last written; null when not measurable. */
  quietMinutes: number | null;
  startedAt: string;
}

export interface AgentSessionProgressCensus {
  measured: number;
  active: number;
  quiet: number;
  tooYoung: number;
  noLog: number;
  unreadable: number;
  /** The residue candidates, longest-quiet first. */
  quietRows: AgentSessionProgress[];
  /**
   * True when enough of the population could not be measured for the counts to
   * be trustworthy. A degraded census must never be reported as a clean result —
   * see the header. Set when `unreadable` exceeds `quiet + active`.
   */
  degraded: boolean;
  degradedReason: string | null;
}

export interface CensusOptions {
  /** Injected for tests; production passes a real `statSync`-backed reader.
   *  MUST return null (never throw, never 0) when the path cannot be read. */
  statMtimeMs: (path: string) => number | null;
  now?: number;
  quietMs?: number;
  minAgeMs?: number;
}

/**
 * Census the live agent-session population for progress.
 *
 * Pure over its inputs: the caller supplies the rows and the mtime reader, so
 * this is unit-testable against a deliberately-wrong control (see the sibling
 * test) rather than only against the live box.
 */
export function censusAgentSessionProgress(
  rows: readonly TaskRow[],
  opts: CensusOptions,
): AgentSessionProgressCensus {
  const now = opts.now ?? Date.now();
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;

  const rowsOut: AgentSessionProgress[] = [];
  let active = 0;
  let quiet = 0;
  let tooYoung = 0;
  let noLog = 0;
  let unreadable = 0;

  for (const row of rows) {
    // Only sessions asserting a live OS process can be residue. A terminal row
    // is already accounted for by whatever closed it.
    if (row.class !== 'agent-session' || !isLiveOwnedState(row.state)) continue;

    const startedMs = Date.parse(row.startedAt);
    const ageMs = Number.isFinite(startedMs) ? now - startedMs : Number.POSITIVE_INFINITY;

    const base = { taskId: row.taskId, logPath: row.logPath ?? null, startedAt: row.startedAt };

    if (ageMs < minAgeMs) {
      tooYoung += 1;
      rowsOut.push({ ...base, disposition: 'too-young', quietMinutes: null });
      continue;
    }

    const logPath = row.logPath?.trim();
    if (!logPath) {
      noLog += 1;
      rowsOut.push({ ...base, disposition: 'no-log', quietMinutes: null });
      continue;
    }

    const mtime = opts.statMtimeMs(logPath);
    if (mtime === null || !Number.isFinite(mtime)) {
      // The instrument failed for this row. Saying "quiet" here would invent
      // residue; saying "active" would hide it. Say neither.
      unreadable += 1;
      rowsOut.push({ ...base, disposition: 'unreadable', quietMinutes: null });
      continue;
    }

    const quietFor = now - mtime;
    const quietMinutes = Math.round(quietFor / 60_000);
    if (quietFor > quietMs) {
      quiet += 1;
      rowsOut.push({ ...base, disposition: 'quiet', quietMinutes });
    } else {
      active += 1;
      rowsOut.push({ ...base, disposition: 'active', quietMinutes });
    }
  }

  const measured = rowsOut.length;
  const degraded = unreadable > active + quiet;

  return {
    measured,
    active,
    quiet,
    tooYoung,
    noLog,
    unreadable,
    quietRows: rowsOut
      .filter((r) => r.disposition === 'quiet')
      .sort((a, b) => (b.quietMinutes ?? 0) - (a.quietMinutes ?? 0)),
    degraded,
    degradedReason: degraded
      ? `${unreadable} of ${measured} agent-session logs were unreadable — more than the ` +
        `${active + quiet} that could be measured. Treat these counts as UNKNOWN, not as a clean census.`
      : null,
  };
}

export type ResidueVerdict = 'ok' | 'exceeded' | 'unknown';

export interface ResidueGuardResult {
  verdict: ResidueVerdict;
  quiet: number;
  threshold: number;
  summary: string;
}

/**
 * The recurrence guard. Turns a census into a pass/fail verdict against a floor.
 *
 * A DEGRADED census returns `unknown`, never `ok`. That asymmetry is the whole
 * point: this guard exists because residue accumulated silently for ~71h behind
 * surfaces that reported healthy, and a guard that answers "fine" when its
 * instrument is broken would reproduce exactly that failure.
 */
export function evaluateAgentSessionResidue(
  census: AgentSessionProgressCensus,
  threshold: number,
): ResidueGuardResult {
  if (census.degraded) {
    return {
      verdict: 'unknown',
      quiet: census.quiet,
      threshold,
      summary: `residue census DEGRADED — ${census.degradedReason ?? 'instrument failure'}`,
    };
  }
  if (census.quiet > threshold) {
    const worst = census.quietRows[0];
    return {
      verdict: 'exceeded',
      quiet: census.quiet,
      threshold,
      summary:
        `${census.quiet} live agent-session task(s) have made no log progress (threshold ${threshold}). ` +
        `Longest quiet: ${worst?.taskId ?? 'n/a'} at ${worst?.quietMinutes ?? 0} min. ` +
        `REPORT ONLY — preserve each log tail before any reap, and never kill by pattern (processes:kill { taskId }).`,
    };
  }
  return {
    verdict: 'ok',
    quiet: census.quiet,
    threshold,
    summary: `${census.quiet} quiet of ${census.measured} live agent-session task(s) (threshold ${threshold}).`,
  };
}
