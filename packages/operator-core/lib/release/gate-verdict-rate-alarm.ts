/**
 * gate-verdict-rate-alarm — P-003 (gate-verdict-liveness-and-repair-reliability-2026-08-31):
 * page on the no-verdict RATE, never the streak.
 *
 * ## Why streak-shaped alarms structurally missed the 74.2h blackout
 *
 * Every pre-existing signal is either a STREAK (consecutiveReds / consecutiveNoVerdict — one
 * verdict of either colour resets it) or a SILENCE clock keyed on ANY recorded row
 * (green-stall-watchdog's verdict-less limb: its `last_verdict_ms` counts every
 * `kind='green_checkpoint'` row, so a stream of RECORDED aborts keeps advancing it). A gate
 * that fires hourly, records an abort most times, and lands the occasional real verdict
 * therefore looks alive to all of them while producing almost no verdicts — "27 fires →
 * 3 verdicts" was reconstructable only from logs. The item's own wording: a red verdict
 * resetting consecutiveNoVerdict must not silence this.
 *
 * ## The two limbs (both gated on the gate being RED — a green gate needs no page)
 *
 *  1. `no-verdict-rate` — over a rolling window (6h), fewer than half the FIRES (P-001
 *     anchor rows, kind='green_checkpoint_fire') produced a verdict-bearing outcome.
 *     Requires a minimum fire count so one aborted fire is not a 100% failure rate.
 *     Pre-anchor installs read fires=0 and skip this limb rather than alarm on noise.
 *  2. `silent-window` — no verdict-BEARING row (VERDICT_BEARING_STATUSES, derived from the
 *     single-homed classifier) has landed for 2x the suite budget. Distinct from the
 *     watchdog's verdict-less limb precisely because recorded aborts do NOT feed this
 *     clock. Requires a verdict to have existed at some point (a fresh install must not
 *     alarm — same rule the watchdog follows).
 *
 * Complements (does not duplicate) gate-audit-hardening's standing-red escalation: that
 * pages on how long the gate has been red; this pages on the gate not RENDERING verdicts
 * while red — opposite failure, opposite fix (repair the verdict path, not the code).
 */
import type { Sql } from 'postgres';
import { GATE_FIRE_KIND, GATE_FIRE_STATUS, VERDICT_BEARING_STATUSES, type GateFireTarget } from './gate-fire-ledger';

/** Rolling window the rate is measured over. */
export const VERDICT_RATE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Minimum fires in the window before the rate limb may alarm — one bad fire is not a rate. */
export const VERDICT_RATE_MIN_FIRES = 3;
/** Alarm when verdicts/fires drops BELOW this fraction ( = ">50% produced no verdict"). */
export const VERDICT_RATE_THRESHOLD = 0.5;
/** The silent-window limb fires past this multiple of the suite budget with no verdict. */
export const SILENT_WINDOW_BUDGET_MULTIPLIER = 2;

export interface VerdictRateWindow {
  /** P-001 anchor rows (kind='green_checkpoint_fire', status='fired') inside the window. */
  fires: number;
  /** Verdict-bearing outcome rows (VERDICT_BEARING_STATUSES) inside the window. */
  verdicts: number;
  /** Newest verdict-bearing row EVER (not window-bounded), epoch ms; null = none recorded. */
  lastVerdictBearingAtMs: number | null;
}

/**
 * One bounded read for everything the evaluation needs. Two aggregates, both riding
 * pipeline_events_slug_kind_created_idx (install_slug, kind, created_at DESC):
 * windowed counts, plus the un-windowed newest verdict-bearing stamp.
 */
export async function readVerdictRateWindow(
  sql: Sql,
  target: GateFireTarget,
  opts: { windowMs?: number } = {},
): Promise<VerdictRateWindow> {
  const windowMs = Math.max(60_000, opts.windowMs ?? VERDICT_RATE_WINDOW_MS);
  const rows = await sql<{ fires: string | number; verdicts: string | number; last_verdict_ms: string | number | null }[]>`
    SELECT (SELECT count(*)
              FROM harness_shared.pipeline_events
             WHERE workspace_id = ${target.workspaceId}
               AND install_slug = ${target.installSlug}
               AND kind = ${GATE_FIRE_KIND}
               AND status = ${GATE_FIRE_STATUS}
               AND created_at >= now() - make_interval(secs => ${windowMs / 1000})) AS fires,
           (SELECT count(*)
              FROM harness_shared.pipeline_events
             WHERE workspace_id = ${target.workspaceId}
               AND install_slug = ${target.installSlug}
               AND kind = 'green_checkpoint'
               AND status = ANY(${VERDICT_BEARING_STATUSES as string[]})
               AND created_at >= now() - make_interval(secs => ${windowMs / 1000})) AS verdicts,
           (SELECT extract(epoch from max(created_at)) * 1000
              FROM harness_shared.pipeline_events
             WHERE workspace_id = ${target.workspaceId}
               AND install_slug = ${target.installSlug}
               AND kind = 'green_checkpoint'
               AND status = ANY(${VERDICT_BEARING_STATUSES as string[]})) AS last_verdict_ms`;
  const row = rows[0];
  const n = (v: string | number | null | undefined): number => {
    const x = v == null ? NaN : Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  return {
    fires: n(row?.fires),
    verdicts: n(row?.verdicts),
    lastVerdictBearingAtMs:
      row?.last_verdict_ms != null && Number.isFinite(Number(row.last_verdict_ms)) ? Number(row.last_verdict_ms) : null,
  };
}

export interface VerdictRateAlarmInputs {
  nowMs: number;
  /** The gate is currently red (consecutiveReds > 0 or green === false). Both limbs gate on it. */
  gateRed: boolean;
  window: VerdictRateWindow;
  /** The suite's own hard budget (GREEN_CHECKPOINT_SUITE_TIMEOUT_MS at the caller). */
  suiteBudgetMs: number;
  minFires?: number;
  windowMs?: number;
  budgetMultiplier?: number;
}

export interface VerdictRateAlarmVerdict {
  alarmed: boolean;
  reason: 'no-verdict-rate' | 'silent-window' | null;
  /** Human sentence for the page; null when not alarmed. */
  detail: string | null;
}

/** Pure — deterministic from inputs, testable in both directions without a DB. */
export function evaluateVerdictRateAlarm(i: VerdictRateAlarmInputs): VerdictRateAlarmVerdict {
  if (!i.gateRed) return { alarmed: false, reason: null, detail: null };
  const minFires = i.minFires ?? VERDICT_RATE_MIN_FIRES;
  const windowMs = i.windowMs ?? VERDICT_RATE_WINDOW_MS;
  const { fires, verdicts, lastVerdictBearingAtMs } = i.window;
  if (fires >= minFires && verdicts / fires < VERDICT_RATE_THRESHOLD) {
    const hours = (windowMs / 3_600_000).toFixed(0);
    return {
      alarmed: true,
      reason: 'no-verdict-rate',
      detail:
        `only ${verdicts} of ${fires} gate fires over the last ~${hours}h produced a verdict — ` +
        `the gate is firing but mostly NOT rendering judgments while red. This is a verdict-PATH ` +
        `failure, not a failing suite: repair what is killing/aborting runs, do not triage failing tests.`,
    };
  }
  const silentAfterMs = (i.budgetMultiplier ?? SILENT_WINDOW_BUDGET_MULTIPLIER) * i.suiteBudgetMs;
  if (lastVerdictBearingAtMs != null && i.nowMs - lastVerdictBearingAtMs > silentAfterMs) {
    const hrs = ((i.nowMs - lastVerdictBearingAtMs) / 3_600_000).toFixed(1);
    return {
      alarmed: true,
      reason: 'silent-window',
      detail:
        `no verdict (green OR red) has landed in ~${hrs}h — more than ${
          i.budgetMultiplier ?? SILENT_WINDOW_BUDGET_MULTIPLIER
        }x the suite budget — while the gate is red. Recorded aborts do not feed this clock, so this ` +
        `fires even when every dead run leaves a well-formed abort row. Repair the verdict path.`,
    };
  }
  return { alarmed: false, reason: null, detail: null };
}
