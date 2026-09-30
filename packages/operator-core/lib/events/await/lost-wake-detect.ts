/**
 * lost-wake-detect.ts — find awaitable event keys whose LIVE fire-rate is degenerate
 * (EI-10869).
 *
 * `harness_shared.event_awaits` records, for every parked await, whether it settled by
 * `fired_reason='event'` (a real wake) or `'timeout'` (a silent miss). That table is a
 * ready-made oracle for lost emits — and until this module, nothing read it.
 *
 * `release:green:papercusp` (EI-10800) sat at **0 real fires / 88 timeouts** for weeks: the
 * emit *looked* correct in code review (a fire-and-forget dynamic import raced process
 * teardown), but the await log was screaming the whole time. This is the DIRECT ANALOGUE of
 * EI-10609 / `gates/degenerate.ts` ("alert on any gate whose live fire-rate is ~0%/~100%") —
 * same detector shape, a different table: **gates decide; awaits wake. Both are degenerate
 * when their rate pins to an extreme.**
 *
 * ## Why a witness leg is REQUIRED — without it this is a false-positive machine
 *
 * A low real-fire rate is not by itself a bug: a timeout is CORRECT when the awaited
 * condition genuinely never occurred in the window (e.g. `release:deploy-failed` sitting at
 * 15.8% is *good news* — deploys mostly succeed). So a degenerate rate only yields a
 * **suspect**; convicting it requires an INDEPENDENT witness that the underlying condition
 * actually happened during the window while the await log shows (almost) no real fires. A
 * suspect with no declared witness (see {@link LOST_WAKE_WITNESSES}) stays a suspect —
 * reviewable, never auto-paged — exactly the discipline `gates/degenerate.ts`'s `expect`
 * field enforces for the gate-decision table.
 */
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

export type LostWakeVerdict = 'convicted' | 'suspect';

export interface LostWakeRateRow {
  event_key: string;
  fired_event: number;
  fired_timeout: number;
}

export interface LostWakeSuspect {
  eventKey: string;
  fired: number;
  timedOut: number;
  settled: number;
  /** Real-fire rate as a percentage (0–100), rounded to 1 decimal. */
  pctRealFire: number;
}

export interface LostWakeFinding extends LostWakeSuspect {
  verdict: LostWakeVerdict;
  /** The witness that convicted it, when one matched + confirmed. Null for an unconvicted suspect. */
  witness: { name: string; owner: string; evidence: string } | null;
}

export interface FindLostWakesOpts {
  /** Window to judge over, ms. Default 7d — awaits settle slowly (timeout can be long), so a
   *  short window under-samples the low-traffic keys that are exactly the risk case. */
  sinceMs?: number;
  /** Settled awaits (fired_event + fired_timeout) a key needs before its rate means anything.
   *  Below this a key that happened to time out twice is not evidence of anything. Default 5. */
  minSettled?: number;
  /** A real-fire rate at or below this percentage is a suspect. Default 10 — cleanly separates
   *  the known-degenerate keys (0.0/0.0/1.7%) from the known-healthy ones (15.8%+) on live data
   *  (see the module doc's validated table). */
  degenerateRatePct?: number;
  /** Witnesses to run against suspects (injected for tests). Default {@link LOST_WAKE_WITNESSES}. */
  witnesses?: readonly LostWakeWitness[];
}

/** The pure core: given per-key settle-rate aggregates, rank the suspects. No I/O — the
 *  testable half. Healthy keys (rate above the bar, or too few settles to judge) are dropped;
 *  only suspects come back, ordered worst-first. */
export function judgeLostWakeSuspects(rows: readonly LostWakeRateRow[], opts: FindLostWakesOpts = {}): LostWakeSuspect[] {
  const minSettled = opts.minSettled ?? 5;
  const degenerateRatePct = opts.degenerateRatePct ?? 10;
  const out: LostWakeSuspect[] = [];
  for (const r of rows) {
    const settled = r.fired_event + r.fired_timeout;
    if (settled < minSettled) continue; // too few settles to mean anything — say nothing.
    const pctRealFire = Math.round((r.fired_event / settled) * 1000) / 10;
    if (pctRealFire > degenerateRatePct) continue; // healthy.
    out.push({ eventKey: r.event_key, fired: r.fired_event, timedOut: r.fired_timeout, settled, pctRealFire });
  }
  out.sort((a, b) => a.pctRealFire - b.pctRealFire || b.settled - a.settled);
  return out;
}

/**
 * A witness: independent evidence that an event key's underlying condition actually occurred
 * during the window, so a degenerate rate can be PROMOTED from suspect to convicted rather than
 * merely reported. `check` returning `null` means the witness could not run (missing table,
 * unexpected key shape) — treated exactly like "no witness declared": stays a suspect.
 */
export interface LostWakeWitness {
  name: string;
  /** Who owns the emitting code path — surfaced in the finding so triage knows where to look. */
  owner: string;
  matches(eventKey: string): boolean;
  check(sql: Sql, eventKey: string, sinceMs: number): Promise<{ occurred: boolean; evidence: string } | null>;
}

/** Clock-skew allowance when testing whether a verdict instant falls inside an await's parked
 *  window. The pipeline_event and the emit are written by the same tick but different code
 *  paths, so their timestamps can differ by a little. Biased toward CONVICTING (it widens the
 *  window), because missing a real lost wake is the costlier error. Live-measured as
 *  insensitive: 0s/30s/120s all yield the same verdict on the papercusp gate keys. */
const OVERLAP_TOLERANCE_SEC = 30;

/** Awaits that were actually parked across a verdict instant, below which the overlap rate is
 *  not evidence of anything (the small-sample guard, mirroring `minSettled`). */
const MIN_OVERLAPPED_AWAITS = 3;

/** Of the awaits parked across a verdict instant, the percentage that must have MISSED it to
 *  convict. EI-10800's real defect measured 100% (0 woke / 88 missed); a healthy gate key
 *  measures 5.9% (16 woke / 1 missed), so 50 separates them with a wide margin. */
const CONVICT_LOST_PCT = 50;

/**
 * The green-checkpoint gate-verdict witness (EI-10800's own class): `release:green[:<pipeline>]`
 * and `green-checkpoint:red[:<pipeline>]` are backed by `harness_shared.pipeline_events`
 * (kind='green_checkpoint'), an INDEPENDENT append-only log written by the same tick that emits
 * the awaited event — but by a different code path (`recordCheckpointVerdict` /
 * `appendPipelineEvent`, not `emitAwaitedEvent`). A green/red pipeline_events row in the window
 * with none of the corresponding awaits firing by 'event' is exactly EI-10800's shape: the
 * verdict was PRODUCED but the wake was LOST.
 *
 * ## Why this checks TEMPORAL OVERLAP and not mere occurrence (EI-20323150675466298)
 *
 * The sentence above is the correct inference, but until this fix the code did not implement
 * it: `check` asked only "did ≥1 verdict row exist ANYWHERE in the window?" and convicted on
 * `true`. That is a window-level EXISTENCE test, and it convicts every run, forever, for any
 * gate key that greens at all while sitting under `degenerateRatePct` — because an awaiter only
 * wakes if the gate resolves DURING its own parked window. Measured live on papercusp: the gate
 * greened 33× in 7 days while awaiters parked a MEDIAN of 6.1 min, so 450 of 454 timeouts had
 * no verdict in their window at all. Those are CORRECT timeouts, and the false conviction burned
 * seven agent sessions and re-filed itself after each close.
 *
 * So the denominator is the fix: judge only the awaits actually parked ACROSS a verdict instant.
 * Two exclusions matter — a `payload_filter` await is bound to a specific candidateSha and is
 * SUPPOSED not to wake on a different candidate's green (WI-5685 / EI-12457), and a cancelled
 * await was retired rather than missed. Counting either as a lost wake reintroduces the bug.
 *
 * ⚠ The instants MUST come from `pipeline_events`, never from the await log's own event-fired
 * rows: in EI-10800's true-positive shape NOTHING fired by event, so an await-derived instant
 * set is EMPTY and the overlap test would silently acquit the very defect this exists to catch.
 */
export const GREEN_CHECKPOINT_WITNESS: LostWakeWitness = {
  name: 'green-checkpoint-pipeline-events',
  owner: 'apps/operator/lib/release/green-checkpoint.ts',
  matches: (eventKey) =>
    eventKey === 'release:green' ||
    eventKey.startsWith('release:green:') ||
    eventKey === 'green-checkpoint:red' ||
    eventKey.startsWith('green-checkpoint:red:'),
  async check(sql, eventKey, sinceMs) {
    const isGreen = eventKey.startsWith('release:green');
    // `up-to-date` is a recorded checkpoint verdict, but runGreenCheckpoint returns
    // before the release:green emit when the integration head already equals the green
    // pin. It is therefore NOT independent evidence that this awaitable key fired.
    // `advanced-prefix` is included because the partial-green path emits release:green
    // for the clean prefix it promoted.
    const statuses = isGreen ? ['advanced', 'advanced-prefix'] : ['not-green'];
    const suffix = eventKey.includes(':', isGreen ? 'release:green'.length : 'green-checkpoint:red'.length)
      ? eventKey.slice(eventKey.lastIndexOf(':') + 1)
      : null;
    try {
      const { operatorHomeHarnessSlug } = await import('../../harness/operator-home-harness');
      const installSlug = suffix ?? operatorHomeHarnessSlug();
      const windowSec = Math.round(sinceMs / 1000);
      // Leg 1 — the INSTANTS the condition actually resolved at, not merely whether it did.
      const instantRows = (await sql`
        SELECT created_at
        FROM harness_shared.pipeline_events
        WHERE kind = 'green_checkpoint'
          AND install_slug = ${installSlug}
          AND status = ANY(${statuses}::text[])
          AND created_at >= now() - ${`${windowSec} seconds`}::interval
        ORDER BY created_at
      `) as unknown as { created_at: string | Date }[];
      const instants = instantRows.map((r) => r.created_at);
      const n = instants.length;
      if (n === 0) return { occurred: false, evidence: `no ${statuses.join('/')} pipeline_events row for install_slug=${installSlug} in the window` };

      // Leg 2 — of the awaits parked ACROSS one of those instants, how many failed to wake?
      // payload_filter (candidateSha-bound) and cancelled awaits are excluded: neither is a
      // missed wake, and counting them is what made this a false-positive machine.
      const overlapRows = (await sql`
        SELECT count(*) FILTER (WHERE fired_reason = 'event')::int                        AS woke,
               count(*) FILTER (WHERE fired_reason IS NOT NULL AND fired_reason <> 'event')::int AS missed
        FROM harness_shared.event_awaits a
        WHERE a.workspace_id = ${DEFAULT_COORD_WORKSPACE}
          AND a.event_key = ${eventKey}
          AND a.payload_filter IS NULL
          AND a.cancelled_at IS NULL
          AND a.created_at >= now() - ${`${windowSec} seconds`}::interval
          AND coalesce(a.fired_at, a.expires_ts) IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM unnest(${instants}::timestamptz[]) AS t(emit_at)
            WHERE t.emit_at > a.created_at - ${`${OVERLAP_TOLERANCE_SEC} seconds`}::interval
              AND t.emit_at < coalesce(a.fired_at, a.expires_ts) + ${`${OVERLAP_TOLERANCE_SEC} seconds`}::interval
          )
      `) as unknown as { woke: number; missed: number }[];
      const woke = overlapRows[0]?.woke ?? 0;
      const missed = overlapRows[0]?.missed ?? 0;
      const overlapped = woke + missed;
      const verdicts = `${n} ${statuses.join('/')} pipeline_events row(s) for install_slug=${installSlug}`;

      if (overlapped < MIN_OVERLAPPED_AWAITS) {
        return {
          occurred: false,
          evidence: `${verdicts}, but only ${overlapped} unfiltered await(s) were parked across one (<${MIN_OVERLAPPED_AWAITS}) — too few to judge. A timeout whose window contains NO verdict is a correct timeout, not a lost wake.`,
        };
      }
      const pctLost = Math.round((missed / overlapped) * 1000) / 10;
      if (pctLost < CONVICT_LOST_PCT) {
        return {
          occurred: false,
          evidence: `${verdicts}, and of the ${overlapped} await(s) actually parked across one, ${woke} woke by event and ${missed} missed (${pctLost}% lost, under the ${CONVICT_LOST_PCT}% bar) — the wake path is working; the low overall rate is a rare condition, not a lost wake.`,
        };
      }
      return {
        occurred: true,
        evidence: `${verdicts} in the window — and of the ${overlapped} await(s) parked ACROSS one of those verdicts, ${missed} missed it and only ${woke} woke by event (${pctLost}% lost). The verdict was produced independently of the await log, so the wake was lost.`,
      };
    } catch {
      return null; // fail-soft: a missing table / query error is "no witness", never a false conviction.
    }
  },
};

export const LOST_WAKE_WITNESSES: readonly LostWakeWitness[] = [GREEN_CHECKPOINT_WITNESS];

/** Attach a verdict to each suspect by running the first matching witness. Suspects with no
 *  matching witness, or whose witness could not confirm occurrence, stay 'suspect'. */
export async function convictWithWitnesses(
  sql: Sql,
  suspects: readonly LostWakeSuspect[],
  sinceMs: number,
  witnesses: readonly LostWakeWitness[] = LOST_WAKE_WITNESSES,
): Promise<LostWakeFinding[]> {
  const out: LostWakeFinding[] = [];
  for (const s of suspects) {
    const witness = witnesses.find((w) => w.matches(s.eventKey));
    if (!witness) {
      out.push({ ...s, verdict: 'suspect', witness: null });
      continue;
    }
    const result = await witness.check(sql, s.eventKey, sinceMs);
    if (result?.occurred) {
      out.push({ ...s, verdict: 'convicted', witness: { name: witness.name, owner: witness.owner, evidence: result.evidence } });
    } else {
      out.push({ ...s, verdict: 'suspect', witness: null });
    }
  }
  return out;
}

/** Read the window's per-key settle-rate aggregates from `harness_shared.event_awaits`. */
export async function readLostWakeRates(sql: Sql, sinceMs: number): Promise<LostWakeRateRow[]> {
  return (await sql`
    SELECT event_key,
           count(*) FILTER (WHERE fired_reason = 'event')::int   AS fired_event,
           count(*) FILTER (WHERE fired_reason = 'timeout')::int AS fired_timeout
    FROM harness_shared.event_awaits
    WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
      AND fired_at >= now() - ${`${Math.round(sinceMs / 1000)} seconds`}::interval
      AND fired_reason IN ('event', 'timeout')
    GROUP BY event_key
  `) as unknown as LostWakeRateRow[];
}

/** The full pipeline: read → rank suspects → run witnesses → ranked findings (worst-first). */
export async function findLostWakes(sql: Sql, opts: FindLostWakesOpts = {}): Promise<LostWakeFinding[]> {
  const sinceMs = opts.sinceMs ?? 7 * 24 * 60 * 60 * 1000;
  const rows = await readLostWakeRates(sql, sinceMs);
  const suspects = judgeLostWakeSuspects(rows, opts);
  return convictWithWitnesses(sql, suspects, sinceMs, opts.witnesses ?? LOST_WAKE_WITNESSES);
}
