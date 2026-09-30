/**
 * Poll-suspect periodic alarm (EI-7428) — the ANNOUNCE half of the EI-7029
 * poll-detector guard. `flagPollSuspects` (dev-data.ts) already computes the
 * poll-suspect list, but it is READ-TIME-ONLY: it only fires when an agent
 * calls `dev:telemetry`. The statusline double-call storm (~200k wasted MCP
 * calls/day) sat visible-but-unnoticed in that very rollup for WEEKS — the
 * guard as shipped would not have self-announced it either, since nobody
 * looked. This module is the periodic half: an hourly in-process sweep
 * (wired into in-process-periodic.ts, category 'global-sweep') that runs the
 * SAME detector proactively and toasts (surfaced via `notifications:recent`
 * and the /dev Telemetry tab banner) any suspect not already alerted in the
 * last 24h.
 *
 * Dedup state is a plain in-memory Map<tool_name, lastAlertTs> — EPHEMERAL is
 * fine here (a bg-host restart re-alerting once is an acceptable cost; this
 * mirrors the other periodic monitors' fail-open/best-effort posture — see
 * storage-growth-alarm.ts / disk-space-alarm.ts for the sibling pattern this
 * follows). A durable dedup table would be over-engineering for an
 * at-most-once-per-24h announcement.
 */
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { escalateAlarm } from './alarm-attention';
import { notifySyncInvalidate } from './sync-sse';
import { flagPollSuspects, telemetryRollup, type PollSuspect } from './dev-data';

const TOAST_RING_BUFFER = 2000;

/** Re-alert window: a suspect already announced within this long stays quiet. */
export const POLL_SUSPECT_ALERT_DEDUPE_MS = 24 * 3600_000;
const POLL_SUSPECT_ESCALATION_TITLE = 'Poll-suspect detected';

/** Rollup lookback for each scan tick — short enough to catch a fresh storm quickly,
 *  long enough that a single slow hour doesn't dilute a genuinely sustained rate. */
export const POLL_SUSPECT_SCAN_WINDOW_HOURS = 3;

/**
 * Pure alert-decision: which suspects are NEW (never alerted, or alerted more
 * than `dedupeMs` ago). Unit-testable without a clock/DB/Map mutation — the
 * caller stamps `lastAlertedAt` for the returned suspects AFTER a successful
 * toast, so a failed emit correctly retries next tick instead of silently
 * marking a never-announced suspect as seen.
 */
export function pickNewAlerts(
  suspects: PollSuspect[],
  lastAlertedAt: ReadonlyMap<string, number>,
  now: number,
  dedupeMs: number = POLL_SUSPECT_ALERT_DEDUPE_MS,
): PollSuspect[] {
  return suspects.filter((s) => {
    const last = lastAlertedAt.get(s.tool_name);
    return last === undefined || now - last >= dedupeMs;
  });
}

/** Build the toast body for a batch of newly-alerted suspects. Pure. */
export function formatPollSuspectToast(suspects: PollSuspect[]): {
  level: string;
  message: string;
  description: string;
} {
  const lines = suspects
    .map(
      (s) =>
        `• ${s.tool_name}: ${s.calls_per_hour}/hr aggregate, ${s.callers} caller(s) ` +
        `(~${s.calls_per_caller_per_hour}/hr each)`,
    )
    .join('\n');
  return {
    level: 'warning',
    message: `Poll-suspect alert — ${suspects.length} tool(s) polling-shaped`,
    description:
      `These tools sustain a polling-shaped call rate (EI-7029 guard — expect an ` +
      `SSE/event subscription or a cached read instead):\n${lines}\n\n` +
      `Review in /dev → Telemetry.`,
  };
}

/** Build the human-facing escalation for a fresh detector result. The detector
 * already applies both sustained aggregate and per-caller thresholds; the
 * explicit per-alarm policy here is one attention ping per 24 hours. */
export function formatPollSuspectEscalation(suspects: PollSuspect[]): { title: string; body: string } {
  return {
    title: POLL_SUSPECT_ESCALATION_TITLE,
    body: `A polling-shaped tool pattern needs remediation. ${formatPollSuspectToast(suspects).description}`,
  };
}

async function defaultEmitToast(t: { level: string; message: string; description: string }): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors storage-growth-alarm / disk-space-alarm).
  void (async () => {
    const stale = await db
      .select({ id: tl.id })
      .from(tl)
      .orderBy(desc(tl.createdAt))
      .offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

export interface PollSuspectScanDeps {
  /** Injectable for tests — defaults to a live cross-workspace telemetryRollup + flagPollSuspects. */
  loadSuspects?: () => Promise<PollSuspect[]>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
  /** Injectable for tests — defaults to the module-level production dedup map. */
  lastAlertedAt?: Map<string, number>;
  /** Injectable clock for tests. */
  now?: () => number;
  dedupeMs?: number;
  /** Injectable for tests — defaults to the shared attention-notify rail. */
  escalate?: (t: { title: string; body: string }) => Promise<void>;
  /** Injectable for tests — the persistent cross-restart cooldown floor. */
  recentlyEscalated?: () => Promise<boolean>;
}

/** Module-level dedup state for the production wiring (one process, one map — see
 *  the module doc comment on why ephemeral/in-memory is an accepted trade-off here). */
const productionLastAlertedAt = new Map<string, number>();

/**
 * One scan pass: pull the live poll-suspect list, toast the NEW ones (not
 * alerted in the last `dedupeMs`), stamp them alerted. Never throws —
 * observability is best-effort, mirroring the other periodic monitors
 * (storage-growth-alarm, disk-space-alarm).
 */
export async function runPollSuspectScanOnce(
  deps: PollSuspectScanDeps = {},
): Promise<{ checked: number; alerted: PollSuspect[] }> {
  const loadSuspects =
    deps.loadSuspects ??
    (async () => {
      const { entries } = await telemetryRollup({
        workspaceIds: null,
        transports: null,
        hours: POLL_SUSPECT_SCAN_WINDOW_HOURS,
      });
      return flagPollSuspects(entries, POLL_SUSPECT_SCAN_WINDOW_HOURS);
    });
  const emitToast = deps.emitToast ?? defaultEmitToast;
  const lastAlertedAt = deps.lastAlertedAt ?? productionLastAlertedAt;
  const now = deps.now ?? Date.now;
  const dedupeMs = deps.dedupeMs ?? POLL_SUSPECT_ALERT_DEDUPE_MS;
  const escalate = deps.escalate;
  const recentlyEscalated = deps.recentlyEscalated;

  let suspects: PollSuspect[] = [];
  try {
    suspects = await loadSuspects();
  } catch (err) {
    console.warn(
      `[poll-suspect-alarm] scan skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { checked: 0, alerted: [] };
  }

  const nowMs = now();
  const fresh = pickNewAlerts(suspects, lastAlertedAt, nowMs, dedupeMs);
  if (fresh.length > 0) {
    try {
      await emitToast(formatPollSuspectToast(fresh));
      for (const s of fresh) lastAlertedAt.set(s.tool_name, nowMs);
    } catch (err) {
      console.warn(
        `[poll-suspect-alarm] toast emit failed (non-fatal, retries next tick): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The detector already requires a sustained two-axis polling shape. Keep
    // its 24h announcement policy, but deliver it on the attention rail too so
    // a closed UI cannot hide a persistent waste/cost regression.
    await escalateAlarm(
      {
        ...formatPollSuspectEscalation(fresh),
        cooldownMs: POLL_SUSPECT_ALERT_DEDUPE_MS,
        source: 'poll-suspect-alarm',
      },
      { notify: escalate, recentlyEscalated },
    );
  }
  return { checked: suspects.length, alerted: fresh };
}

// ── Timer-registration scan (P-010: stop-discarded-dedup-and-audit-server-
// polling-2026-07-26) — the SAME "alarm on something new" shape as the
// agent-tool-call detector above, applied to server-side timers instead.
//
// This plan's own audit (Lanes C1-C4, WI-6089) hand-classified every timer
// that existed as of 2026-07-26 into must-sample / timeout-reaper / violation
// per D-004, and found exactly one violation (system-health, already being
// fixed under a separate lane). That classification is a SNAPSHOT — it goes
// stale the moment a new `managedSetInterval`/`PeriodicCheck` lands without
// anyone re-running the manual audit. P-011 will add a REQUIRED declared
// classification at registration time (turning this from a detector into a
// hard gate); until that lands, the best available signal is "has this exact
// timer NAME ever been seen before" — the identical shape `pickNewAlerts`
// already uses for tool_name, just keyed on timer name instead of a rate
// threshold (a timer's "rate" is its fixed interval, known at registration,
// not something that needs a statistical threshold the way agent-driven tool
// calls do).

/** One timer/managedSetInterval registration, as read from the schedule inventory. */
export interface TimerRegistration {
  name: string;
  /** schedule-inventory `source`: 'in-process' | 'managed' | 'external-process'. */
  source: string;
}

/**
 * Pure: which of `current` have a `name` NOT in `knownNames`. Order-preserving,
 * name is the sole identity (schedule-inventory names are process-global and
 * unique — verified across all 104 timers audited for this plan).
 */
export function pickNewTimerRegistrations(
  current: TimerRegistration[],
  knownNames: ReadonlySet<string>,
): TimerRegistration[] {
  return current.filter((t) => !knownNames.has(t.name));
}

/** Build the toast body for newly-seen timer registrations. Pure. */
export function formatTimerRegistrationToast(newOnes: TimerRegistration[]): {
  level: string;
  message: string;
  description: string;
} {
  const lines = newOnes.map((t) => `• ${t.name} (source: ${t.source})`).join('\n');
  return {
    level: 'warning',
    message: `New server-side timer(s) — ${newOnes.length} unclassified`,
    description:
      `These timers were never present in a prior scan and have not been classified per D-004 ` +
      `(must-sample / timeout-reaper / violation — stop-discarded-dedup-and-audit-server-polling-2026-07-26):\n` +
      `${lines}\n\n` +
      `A VIOLATION recomputes derived state from a store that already emits change events, on a clock, ` +
      `regardless of whether anyone is consuming it — everything else (no publisher exists, or the passage ` +
      `of time IS the trigger) is legitimate. Review in /dev → Telemetry, or via schedule:inventory.`,
  };
}

export interface TimerRegistrationScanDeps {
  /** Injectable for tests — defaults to collectScheduleInventory() filtered to the
   *  operator-scoped ephemeral-timer sources ('in-process' | 'managed' | 'external-process').
   *  'dbos' and 'routines' (the DURABLE tier) are deliberately excluded — C4's audit (WI-6094)
   *  found that tier is architecturally declared scheduled work, not a poll-shaped surface, and
   *  recommended it stay out of this audit's scope rather than be treated as unaudited residue. */
  loadCurrentTimers?: () => Promise<TimerRegistration[]>;
  /** Injectable for tests — defaults to a SELECT over known_timer_registrations. */
  loadKnownNames?: () => Promise<Set<string>>;
  /** Injectable for tests — defaults to an upsert into known_timer_registrations (also used
   *  for the first-run seed, so a seed and a real "mark now known" share one code path). */
  persistKnownNames?: (rows: TimerRegistration[]) => Promise<void>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate (same sink as
   *  the poll-suspect scan above). */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

async function defaultLoadCurrentTimers(): Promise<TimerRegistration[]> {
  const { collectScheduleInventory } = await import('./schedule-inventory');
  const rows = await collectScheduleInventory();
  return rows
    .filter((r) => r.source === 'in-process' || r.source === 'managed' || r.source === 'external-process')
    .map((r) => ({ name: r.name, source: r.source }));
}

async function defaultLoadKnownNames(): Promise<Set<string>> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<{ name: string }[]>`SELECT name FROM harness_shared.known_timer_registrations`;
  return new Set(rows.map((r) => r.name));
}

async function defaultPersistKnownNames(rows: TimerRegistration[]): Promise<void> {
  if (rows.length === 0) return;
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // Row-at-a-time ON CONFLICT DO NOTHING — this table only ever gains a handful of
  // rows per scan (a brand-new timer name is rare by construction), so a bulk
  // multi-row VALUES clause would be premature complexity here.
  for (const r of rows) {
    await sql`
      INSERT INTO harness_shared.known_timer_registrations (name, source)
      VALUES (${r.name}, ${r.source})
      ON CONFLICT (name) DO NOTHING`;
  }
}

/**
 * One scan pass: diff the LIVE timer-registration set against the durable
 * known-name set. An EMPTY known set means this is the first run ever (or a
 * fresh install) — seed it silently with everything currently present (this
 * plan's own 104-timer audit already classified all of it; a mass "new timer"
 * toast storm on first boot would just be noise). Afterward, any name not in
 * the known set is genuinely new since the last scan and gets toasted +
 * folded into the known set (so it alerts exactly once, never on every tick —
 * same "alert once, not every tick" contract as the sibling poll-suspect scan,
 * except permanent rather than time-deduped: a timer, once classified by a
 * human reading the toast, does not need to re-alert unless renamed). Never
 * throws — best-effort, mirroring every other periodic monitor in this file.
 */
export async function runTimerRegistrationScanOnce(
  deps: TimerRegistrationScanDeps = {},
): Promise<{ checked: number; alerted: TimerRegistration[]; seeded: boolean }> {
  const loadCurrentTimers = deps.loadCurrentTimers ?? defaultLoadCurrentTimers;
  const loadKnownNames = deps.loadKnownNames ?? defaultLoadKnownNames;
  const persistKnownNames = deps.persistKnownNames ?? defaultPersistKnownNames;
  const emitToast = deps.emitToast ?? defaultEmitToast;

  let current: TimerRegistration[] = [];
  let known: Set<string>;
  try {
    [current, known] = await Promise.all([loadCurrentTimers(), loadKnownNames()]);
  } catch (err) {
    console.warn(
      `[timer-registration-scan] scan skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { checked: 0, alerted: [], seeded: false };
  }

  if (known.size === 0) {
    // First run ever (or table truncated) — seed silently, no alarm.
    try {
      await persistKnownNames(current);
    } catch (err) {
      console.warn(
        `[timer-registration-scan] seed write failed (non-fatal, retries next tick): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { checked: current.length, alerted: [], seeded: true };
  }

  const fresh = pickNewTimerRegistrations(current, known);
  if (fresh.length > 0) {
    try {
      await emitToast(formatTimerRegistrationToast(fresh));
      await persistKnownNames(fresh);
    } catch (err) {
      console.warn(
        `[timer-registration-scan] toast/persist failed (non-fatal, retries next tick): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { checked: current.length, alerted: fresh, seeded: false };
}
