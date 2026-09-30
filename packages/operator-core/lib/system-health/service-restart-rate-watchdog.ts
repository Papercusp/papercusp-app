/**
 * service-restart-rate-watchdog (EI-18741922664751805) — alarm on the RATE at
 * which a long-lived operator unit restarts.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `papercup-staging-api.service` (:3170) spent 2026-07-26 restarting ~10x/hour.
 * Nothing alarmed on it. The condition was found by a human reading
 * `journalctl | grep -c 'Started '` by hand, ~4 hours in — and by then the
 * driving defect had ALREADY been fixed (the WI-5710 deferral gate landed
 * 16:24 EDT; the issue was filed 16:54 EDT off a `--since -4h` window that was
 * dominated by pre-fix data, and so mis-attributed the cause). Both halves of
 * that are the same gap: restart rate was not a measured signal, so neither its
 * badness nor its recovery was visible.
 *
 * A restart rate is exactly the shape a detector handles well and a human
 * handles badly: it is invisible per-event (each individual restart looks
 * normal and intentional), it only exists in aggregate, and the aggregate is
 * never in front of anyone.
 *
 * ── Why the threshold is 8/hour ─────────────────────────────────────────────
 * Measured, not guessed (2026-07-27, `Started` events per clock hour on
 * papercup-staging-api.service):
 *   pre-fix  (07-26 12:00-15:00): 10, 10, 9, 9   ← the condition worth alarming on
 *   post-fix (07-26 17:00-07-27 10:00): 1-6, typically 2-4
 * The post-fix steady state is a ~31-minute metronome (~2/hr) set by
 * MAX_STALE_SEC=1800 in sync-staging-checkout.sh, with occasional bursts to 6
 * when several agents call `dev:restart` in one hour. 8 sits above every
 * post-fix observation and below every pre-fix one.
 *
 * NOTE the issue itself suggested ~4/hour. That would have fired on healthy
 * post-fix behaviour twice in the observed 18-hour window. The threshold is a
 * measurement, not a preference — re-measure before moving it.
 *
 * ── Which units, and why dev-api matters MORE than staging ──────────────────
 * A widely-repeated claim held that :3170 restarts reap headless fleet children
 * in the service cgroup. Measured false on 2026-07-27: the fleet children live
 * in `papercup-dev-api.service`'s cgroup (16 procs / 187 tasks), while
 * `papercup-staging-api.service`'s holds only its own main pid. Children started
 * 09:34 survived :3170 restarts at 10:03 and 10:34. Both units are
 * KillMode=control-group, so the kill is real — it just does not reach them
 * from :3170. Which means a restart storm on **dev-api** is the one that would
 * genuinely reap the fleet, and it was equally unmonitored. Both are watched.
 *
 * ── Design notes ────────────────────────────────────────────────────────────
 *  - `managedSetInterval` (never a bare setInterval) — visible in
 *    schedule:inventory, category 'watchdog', like its system-health siblings.
 *  - Runtime gate: FLAGS.SERVICE_RESTART_RATE_WATCHDOG (default ON — flip OFF
 *    at /admin/features; no ad-hoc env boolean per lint:env-feature-gates).
 *  - Dedup is delegated to openEscalation's (dedupKind, subjectSignature)
 *    PG-locked dedup, signed per-unit — so a sustained storm holds ONE open
 *    escalation per unit rather than one per sweep.
 *  - Reads through `readJournal`, which already encodes the journalctl traps
 *    (exit-1-means-clean-window, ENOENT-means-no-systemd, unit-scoping).
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { readJournal, type JournalReadResult } from '../journal-read';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

/** How often to evaluate. Well under the 1h window so a storm is caught early,
 *  well over the ~31min healthy metronome so a single tick never sees a burst. */
export const RESTART_RATE_SWEEP_INTERVAL_MS = 10 * 60_000;

/** The trailing window each sweep measures. */
export const RESTART_RATE_WINDOW = '-1h';

/**
 * Starts-per-window above which we alarm. See the header for the measurement
 * that produced 8; it is not a round number chosen for feel.
 */
export const RESTART_RATE_THRESHOLD_PER_HOUR = 8;

/**
 * Row cap for the journal read. Only needs to exceed the threshold by enough
 * that a truncated read is unambiguously a breach — see `countStarts`.
 */
export const RESTART_RATE_READ_LIMIT = 200;

/** The long-lived operator units whose restart rate is meaningful. */
export const RESTART_RATE_WATCHED_UNITS = [
  'papercup-dev-api.service',
  'papercup-staging-api.service',
] as const;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'service-restart-rate-watchdog',
  ownerLabel: 'system · service restart rate',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** What one sweep concluded about one unit. */
export interface RestartRateReading {
  unit: string;
  /** Starts observed in the window, or null when the journal could not be read. */
  starts: number | null;
  /** True when `starts` is a FLOOR (the read hit the row cap), not an exact count. */
  atLeast: boolean;
  /** Set when the count is not trustworthy — the reason it is not. */
  unreadable: string | null;
}

export interface RestartRateAlert {
  unit: string;
  starts: number;
  atLeast: boolean;
  threshold: number;
}

/**
 * PURE — turn one journal read into a trustworthy start count.
 *
 * Two traps, both of which produce a convincing "0 restarts, all healthy" if
 * mishandled:
 *
 *  1. `entries.length` IS NOT THE COUNT. `collapseConsecutive` merges runs of
 *     consecutive identical (unit, message) lines, and successive
 *     `Started <unit>...` messages are byte-identical — so a unit that restarted
 *     40 times in a row collapses to ONE entry with repeat:40. Counting entries
 *     would report 1. `matched` is the pre-dedup line count and is the only
 *     correct field here.
 *  2. AN UNREADABLE JOURNAL IS NOT AN EMPTY ONE. `journalAvailable:false` (no
 *     systemd at all) and `journalError` both yield zero entries, and a
 *     `unitsUnknown` hit means the unit NAME is wrong — all three read as a
 *     perfectly quiet service. Each is reported as `unreadable`, never as 0.
 *
 * `matched` is bounded by limit+1, so a truncated read gives a FLOOR rather
 * than a total — which is sufficient here, because any floor at the row cap is
 * far above any plausible threshold.
 */
export function countStarts(unit: string, result: JournalReadResult): RestartRateReading {
  if (!result.journalAvailable) {
    return { unit, starts: null, atLeast: false, unreadable: 'no systemd journal on this host' };
  }
  if (result.journalError) {
    return { unit, starts: null, atLeast: false, unreadable: `journal read failed: ${result.journalError}` };
  }
  if (result.unitsUnknown.includes(unit)) {
    return { unit, starts: null, atLeast: false, unreadable: 'systemd does not know this unit (wrong name?)' };
  }
  return { unit, starts: result.matched, atLeast: result.truncated, unreadable: null };
}

/** PURE — does this reading breach the threshold? Unreadable never alarms. */
export function evaluateReading(
  reading: RestartRateReading,
  threshold: number = RESTART_RATE_THRESHOLD_PER_HOUR,
): RestartRateAlert | null {
  if (reading.starts === null) return null;
  if (reading.starts <= threshold) return null;
  return { unit: reading.unit, starts: reading.starts, atLeast: reading.atLeast, threshold };
}

export interface RestartRateSweepDeps {
  readStarts: (unit: string) => Promise<RestartRateReading>;
  escalate: (alert: RestartRateAlert) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  units: readonly string[];
  threshold: number;
}

async function defaultReadStarts(unit: string): Promise<RestartRateReading> {
  const result = await readJournal({
    units: [unit],
    since: RESTART_RATE_WINDOW,
    // systemd's own start line. Anchored so a log line that merely mentions the
    // word "started" cannot inflate the count.
    grep: '^Started ',
    scope: 'user',
    limit: RESTART_RATE_READ_LIMIT,
  });
  return countStarts(unit, result);
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.SERVICE_RESTART_RATE_WATCHDOG, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — stay quiet rather than spam.
    return false;
  }
}

async function defaultEscalate(alert: RestartRateAlert): Promise<void> {
  const count = `${alert.atLeast ? '≥' : ''}${alert.starts}`;
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `${alert.unit} restarted ${count}x in the last hour (threshold ${alert.threshold})`,
    body:
      `${alert.unit} recorded ${count} systemd "Started" events in the trailing hour, ` +
      `above the ${alert.threshold}/hour threshold.\n\n` +
      `Each restart is a ~10-13s connection-refused window for anything holding a ` +
      `connection to that unit's port. For papercup-dev-api.service it is worse: the ` +
      `headless fleet children run inside THAT unit's cgroup (KillMode=control-group), ` +
      `so a restart storm there reaps live agent processes.\n\n` +
      `Triage:\n` +
      `  1. Confirm and see the cadence:\n` +
      `     journalctl --user -u ${alert.unit} --since -4h | grep 'Started ' \n` +
      `  2. Find what is driving it. For papercup-staging-api.service the usual driver ` +
      `is the papercup-staging-sync.timer:\n` +
      `     journalctl --user -u papercup-staging-sync.service --since -4h | grep -E 'staleness ceiling|restarting'\n` +
      `     A restart preceded by "staleness ceiling reached" is MAX_STALE_SEC ` +
      `(sync-staging-checkout.sh) firing, not the restart-exempt path set.\n` +
      `  3. Check agent-driven restarts: dev:restart calls in harness_shared.tool_invocations.\n\n` +
      `Do NOT "fix" this by inverting the restart-exempt path set in ` +
      `sync-staging-checkout.sh — that file's own comments explain why the fail-safe ` +
      `direction must not be reversed (a new server directory would silently stop ` +
      `being picked up). Background: EI-18741922664751805.`,
    meta: {
      dedupKind: 'service-restart-rate',
      subjectSignature: alert.unit,
      unit: alert.unit,
      starts: alert.starts,
      atLeast: alert.atLeast,
      threshold: alert.threshold,
    },
  });
}

function sweepDeps(overrides: Partial<RestartRateSweepDeps>): RestartRateSweepDeps {
  return {
    readStarts: defaultReadStarts,
    escalate: defaultEscalate,
    flagEnabled: defaultFlagEnabled,
    units: RESTART_RATE_WATCHED_UNITS,
    threshold: RESTART_RATE_THRESHOLD_PER_HOUR,
    ...overrides,
  };
}

/**
 * One sweep across every watched unit. Never throws: a unit that cannot be read
 * is counted as `unreadable` and the rest of the sweep continues, so one broken
 * unit name can never silence the others. Exported for tests.
 */
export async function runRestartRateSweepOnce(
  overrides: Partial<RestartRateSweepDeps> = {},
): Promise<{ alerts: RestartRateAlert[]; unreadable: RestartRateReading[]; skipped: boolean }> {
  const deps = sweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { alerts: [], unreadable: [], skipped: true };

  const alerts: RestartRateAlert[] = [];
  const unreadable: RestartRateReading[] = [];
  for (const unit of deps.units) {
    let reading: RestartRateReading;
    try {
      reading = await deps.readStarts(unit);
    } catch (e) {
      unreadable.push({
        unit,
        starts: null,
        atLeast: false,
        unreadable: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (reading.unreadable !== null) {
      unreadable.push(reading);
      continue;
    }
    const alert = evaluateReading(reading, deps.threshold);
    if (!alert) continue;
    try {
      await deps.escalate(alert);
      alerts.push(alert);
    } catch {
      // Best-effort: the next sweep re-evaluates from the journal (there is no
      // watermark to corrupt), and escalation-side dedup absorbs the retry.
    }
  }
  return { alerts, unreadable, skipped: false };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the service restart-rate watchdog: a recurring process-level sweep.
 * Idempotent. Runtime gate: FLAGS.SERVICE_RESTART_RATE_WATCHDOG (per tick).
 */
export function startServiceRestartRateWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? RESTART_RATE_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'service-restart-rate-watchdog',
    intervalMs,
    () => {
      if (sweeping) return; // never overlap a slow tick
      sweeping = true;
      void runRestartRateSweepOnce()
        .catch((e) => {
          console.warn(
            `[service-restart-rate-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    {
      category: 'watchdog',
      // D-004 (stop-discarded-dedup-and-audit-server-polling-2026-07-26, P-011): each
      // tick reads systemd restart counts via journalctl (readStarts) — no event source
      // exists for "a unit's restart count changed", matching the same shape as this
      // file's 'service-health' sibling in in-process-periodic.ts.
      classification: 'must-sample',
    },
  );
}
