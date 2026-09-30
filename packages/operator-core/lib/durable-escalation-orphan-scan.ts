/**
 * Detects DURABLE ESCALATION ROWS whose resolve path appears to be gated on
 * in-process state (EI-19339499404613652).
 *
 * ## The class
 *
 * A recovery path gated on IN-PROCESS state cannot resolve a DURABLE artifact
 * filed by a PREVIOUS process. The row (an `engineer_issues` escalation)
 * survives the restart; the "should I resolve it?" decision (a module-scoped
 * in-memory latch) does not. Process A alarms and files the row -> A exits ->
 * B starts with the flag false -> the condition clears -> B's recovery branch
 * is never entered -> the row stays open forever, asserting a fault that ended
 * days ago. Known sites: WI-6997 (outbox-drain `drain_*` latch), WI-7011 (all
 * three replication-liveness axes). Both were found only by hand.
 *
 * ## Why this does NOT use a re-file cadence
 *
 * The originating item proposed: flag open rows whose `max(created_ts)` is
 * older than N x the emitter's known re-file cadence. Measured against the
 * live ledger on 2026-08-31 that rule MISFIRES, and in the direction that
 * costs the most:
 *
 *   `system:spec-triad` holds 143 open rows, 109 of them older than 7 days.
 *   An age rule reports every one as evidence of a memory-gated resolve path.
 *   They are nothing of the kind — the rows say "Write the spec triad for plan
 *   X". They are WORK REQUESTS, which clear when an agent does the work, not
 *   self-clearing conditions with an automatic resolve path. Their median open
 *   age (325h) sits INSIDE the emitter's own p95 close time (336h): for that
 *   emitter, being open for weeks is normal.
 *
 * A cadence also has to be configured per emitter and hand-maintained, which
 * is the drift this repo's derived-truth ladder exists to avoid.
 *
 * ## What this uses instead: each emitter's OWN close-time distribution
 *
 * Self-calibrating and derived, never declared. An emitter that has closed
 * 87,897 rows at a p95 of 0.00h has DEMONSTRATED what its resolve path does
 * when it works; open rows far beyond that are anomalous against the emitter's
 * own behaviour rather than against a number someone typed. The same absolute
 * age is damning for one emitter and unremarkable for another, and only the
 * per-emitter distribution can tell them apart.
 *
 * ## What a verdict does and does not claim
 *
 * `orphan-suspect` is an ACCUSATION TO ROUTE, never a close. Silence means
 * "recovered" OR "no longer observed", and only the first justifies resolving
 * — so this module deliberately exposes no auto-close and no "safe to close"
 * flag. That matches the orphan-sweep docs' standing warning against blanket
 * time-based closes.
 *
 * The two non-findings are load-bearing and must never collapse into a pass:
 *
 *   - `no-resolve-path-observed` — the emitter has closed NOTHING, ever. There
 *     is no distribution to calibrate against. That is a distinct and often
 *     more serious finding, not an orphan claim.
 *   - `insufficient-close-sample` — too few closes to calibrate. Explicitly
 *     UNDETERMINED. Reporting these as clean would be the exact failure this
 *     detector is aimed at: a measurement that measured nothing, rendered as a
 *     confident green (workspace fact `guard-rail:absence-needs-its-population`).
 *
 * ## Scope caveat carried from WI-7011 — do not remove
 *
 * Rehydration only retires a row for a subject still being SAMPLED. A dead
 * pot's log is never merged again, so its probe never runs and its row stays
 * open. That residue belongs to the staleness sweep and is NOT a defect in the
 * emitter's resolve path. This module cannot distinguish "recovered" from "no
 * longer sampled" from the ledger alone, so `orphan-suspect` names a
 * population to triage, and `why` says so in words rather than implying a
 * proven root cause.
 */

/** One durable escalation row as the ledger holds it. */
export type EscalationRow = {
  /** The filing emitter, e.g. `system:replication-liveness`. */
  emitter: string;
  /** Row id, echoed back on findings so a caller can go read it. */
  id: string;
  createdAtMs: number;
  /** `null` when the row is still open. */
  closedAtMs: number | null;
};

export type EmitterVerdict =
  /** Demonstrated resolve path, and open rows far beyond its own p95. */
  | 'orphan-suspect'
  /** Has never closed a single row — no distribution exists to calibrate. */
  | 'no-resolve-path-observed'
  /** Too few closes to calibrate. UNDETERMINED — never read this as clean. */
  | 'insufficient-close-sample'
  /** Calibrated, and every open row sits inside the emitter's own norm. */
  | 'within-own-norm';

export type AnomalousRow = { id: string; ageHours: number };

export type EmitterFinding = {
  emitter: string;
  verdict: EmitterVerdict;
  closedCount: number;
  openCount: number;
  /** null whenever the sample was too small to calibrate. */
  p95CloseHours: number | null;
  /** null whenever `p95CloseHours` is null. */
  thresholdHours: number | null;
  /** Open rows past `thresholdHours`, oldest first. Empty unless orphan-suspect. */
  anomalousOpen: AnomalousRow[];
  /**
   * Rows whose recorded close PRECEDES their own creation. Excluded from the
   * distribution rather than clamped: a negative duration is a ledger defect
   * in its own right (the shape measured in WI-1713046, where archive-served
   * rows carried `closed_at` ~1.9s before `created_at`), and silently
   * treating it as a fast close would flatten the very p95 this calibrates on.
   */
  incoherentClosedCount: number;
  why: string;
};

export type ScanOptions = {
  nowMs: number;
  /**
   * Minimum closes before a p95 is trusted. Below this the emitter is
   * UNDETERMINED, never clean.
   */
  minCloseSample?: number;
  /** An open row is anomalous past `p95 * thresholdMultiple`. */
  thresholdMultiple?: number;
  /**
   * Floor for the threshold, in hours. Load-bearing: an emitter that closes
   * essentially instantly has a p95 of 0.00h, and `0 * anything` is 0 — which
   * would flag every row it has ever filed, including ones opened seconds ago.
   */
  minThresholdHours?: number;
};

export type ScanReport = {
  findings: EmitterFinding[];
  /** Emitters seen with zero open rows — nothing to accuse, reported for census. */
  emittersWithNoOpenRows: string[];
  /**
   * TOTAL rows considered. A caller must be able to tell "scanned 40,000 rows
   * and found nothing" from "scanned nothing", because those two produce an
   * identical empty `findings` and only one of them is reassuring.
   */
  rowsScanned: number;
  emittersScanned: number;
};

export const DEFAULT_MIN_CLOSE_SAMPLE = 20;
export const DEFAULT_THRESHOLD_MULTIPLE = 3;
export const DEFAULT_MIN_THRESHOLD_HOURS = 1;

const MS_PER_HOUR = 3_600_000;

/**
 * Linear-interpolated percentile, matching Postgres `percentile_cont` so a
 * finding computed here and a hand-run SQL cross-check cannot disagree on the
 * boundary case.
 */
export function percentileCont(sortedAscending: readonly number[], fraction: number): number {
  if (sortedAscending.length === 0) throw new Error('percentileCont: empty input');
  if (sortedAscending.length === 1) return sortedAscending[0]!;
  const rank = fraction * (sortedAscending.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAscending[lower]!;
  const weight = rank - lower;
  return sortedAscending[lower]! * (1 - weight) + sortedAscending[upper]! * weight;
}

/**
 * Classify every emitter present in `rows` against its OWN close-time
 * distribution. Pure: no clock, no database — `nowMs` is supplied so a test
 * can pin it and a caller can scan a historical snapshot.
 */
export function scanDurableEscalations(
  rows: readonly EscalationRow[],
  options: ScanOptions,
): ScanReport {
  const minCloseSample = options.minCloseSample ?? DEFAULT_MIN_CLOSE_SAMPLE;
  const thresholdMultiple = options.thresholdMultiple ?? DEFAULT_THRESHOLD_MULTIPLE;
  const minThresholdHours = options.minThresholdHours ?? DEFAULT_MIN_THRESHOLD_HOURS;
  const { nowMs } = options;

  const byEmitter = new Map<string, EscalationRow[]>();
  for (const row of rows) {
    const list = byEmitter.get(row.emitter) ?? [];
    list.push(row);
    byEmitter.set(row.emitter, list);
  }

  const findings: EmitterFinding[] = [];
  const emittersWithNoOpenRows: string[] = [];

  for (const [emitter, emitterRows] of [...byEmitter.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const open = emitterRows.filter((r) => r.closedAtMs === null);
    if (open.length === 0) {
      emittersWithNoOpenRows.push(emitter);
      continue;
    }

    const closed = emitterRows.filter((r) => r.closedAtMs !== null);
    const coherentDurations: number[] = [];
    let incoherentClosedCount = 0;
    for (const row of closed) {
      const durationMs = row.closedAtMs! - row.createdAtMs;
      if (durationMs < 0) {
        incoherentClosedCount += 1;
        continue;
      }
      coherentDurations.push(durationMs / MS_PER_HOUR);
    }
    coherentDurations.sort((a, b) => a - b);

    const openWithAge = open
      .map((r) => ({ id: r.id, ageHours: (nowMs - r.createdAtMs) / MS_PER_HOUR }))
      .sort((a, b) => b.ageHours - a.ageHours);

    const base = {
      emitter,
      closedCount: coherentDurations.length,
      openCount: open.length,
      incoherentClosedCount,
    };

    if (coherentDurations.length === 0) {
      findings.push({
        ...base,
        verdict: 'no-resolve-path-observed',
        p95CloseHours: null,
        thresholdHours: null,
        anomalousOpen: [],
        why:
          `${emitter} has ${open.length} open row(s) and has never closed one, so it has ` +
          'no demonstrated resolve path to calibrate against. This is a distinct finding, ' +
          'not an orphan claim — the resolve path may never have run at all.',
      });
      continue;
    }

    if (coherentDurations.length < minCloseSample) {
      findings.push({
        ...base,
        verdict: 'insufficient-close-sample',
        p95CloseHours: null,
        thresholdHours: null,
        anomalousOpen: [],
        why:
          `${emitter} has closed only ${coherentDurations.length} row(s), below the ` +
          `${minCloseSample} needed to calibrate a p95. UNDETERMINED — this is not a clean ` +
          'verdict, and its open rows have been neither cleared nor accused.',
      });
      continue;
    }

    const p95CloseHours = percentileCont(coherentDurations, 0.95);
    const thresholdHours = Math.max(p95CloseHours * thresholdMultiple, minThresholdHours);
    const anomalousOpen = openWithAge.filter((r) => r.ageHours > thresholdHours);

    findings.push({
      ...base,
      verdict: anomalousOpen.length > 0 ? 'orphan-suspect' : 'within-own-norm',
      p95CloseHours,
      thresholdHours,
      anomalousOpen,
      why:
        anomalousOpen.length > 0
          ? `${emitter} closes rows at a p95 of ${p95CloseHours.toFixed(2)}h across ` +
            `${coherentDurations.length} closes, but ${anomalousOpen.length} of its ` +
            `${open.length} open row(s) exceed ${thresholdHours.toFixed(2)}h (oldest ` +
            `${anomalousOpen[0]!.ageHours.toFixed(1)}h). Route for triage: silence past an ` +
            'emitter\'s own resolve norm is consistent with a cleared condition whose ' +
            'resolve never ran, AND with a subject that is no longer sampled. Do not close ' +
            'on this signal alone.'
          : `${emitter} closes rows at a p95 of ${p95CloseHours.toFixed(2)}h and every one ` +
            `of its ${open.length} open row(s) sits inside ${thresholdHours.toFixed(2)}h. ` +
            'Being open this long is normal for this emitter.',
    });
  }

  return {
    findings,
    emittersWithNoOpenRows,
    rowsScanned: rows.length,
    emittersScanned: byEmitter.size,
  };
}

/** Findings a caller should act on, in the order worth reading. */
export function actionableFindings(report: ScanReport): EmitterFinding[] {
  const rank: Record<EmitterVerdict, number> = {
    'orphan-suspect': 0,
    'no-resolve-path-observed': 1,
    'insufficient-close-sample': 2,
    'within-own-norm': 3,
  };
  return report.findings
    .filter((f) => f.verdict !== 'within-own-norm')
    .sort(
      (a, b) =>
        rank[a.verdict] - rank[b.verdict] ||
        (b.anomalousOpen[0]?.ageHours ?? 0) - (a.anomalousOpen[0]?.ageHours ?? 0),
    );
}
