/**
 * cell-tenure.ts — P-008's PURE half (state-plane-interest-and-hardening-2026-08-21,
 * per D-012). The PG read, the once-per-window record and the log line live in
 * `agent-plane-measurement-sweep.ts`; this module is composition only, mirroring the
 * split that module's header describes for `agent-plane-measurement.ts`.
 *
 * ── WHAT THIS IS THE COUNTERPART TO ─────────────────────────────────────────
 *
 * The ADMISSION rule — "a read with 0 calls in 30 days is never promoted"
 * (agent-insights/state-read-inventory-which-reads-become-cells) — keeps the registry
 * from swallowing every read. It has no exit: a cell admitted once stays registered
 * forever, whether or not anyone ever reads it. This is the TENURE half: a periodic
 * cut-or-keep verdict on cells already in the registry.
 *
 * ── WHY "0 READS ⇒ CUT" IS WRONG, AND WHY THAT IS NOT A HYPOTHETICAL ────────
 *
 * P-008 names `testing.census.population` and `testing.coverage.floor` as its first
 * subjects. Both were registered 2026-08-18 (commit 92db953012). Implemented
 * literally against a 14-day window on 2026-08-21, the rule's very first act is to
 * recommend cutting two THREE-DAY-OLD cells, because 11 of the window's 14 days
 * predate their existence. The rule would have been wrong about 100% of its own
 * named subjects on day one.
 *
 * Three independent reasons a zero here is not evidence of dormancy:
 *
 *  1. AGE. Youth and dormancy produce an identical zero. Telemetry cannot separate
 *     them, because a cell that was never read leaves no first-seen row to date it
 *     from — which is why {@link CellSpec.registeredOn} has to be DECLARED.
 *
 *  2. OBSERVABILITY. `tool_invocations` is pruned to 14 days
 *     (`DEFAULT_RETENTION_TARGETS` in telemetry-retention-action.ts). A window that
 *     reaches past retention reads absent history as absent demand. Note the
 *     admission rule's own doc says "0 calls in 30 days" AND "retention is about 30
 *     days"; that parenthetical was measured 2026-07-27 and is now STALE, so a
 *     tenure rule that inherited the literal 30 would query 16 days of guaranteed
 *     emptiness and count it as evidence.
 *
 *  3. DELIVERY PATH. `state:read` is not the only way a cell's value reaches an
 *     agent. `dev:pipeline_position` returns a `plane` block of ready re-read
 *     handles, P-001's `deriveCellReread` folds a handle into subscription fires,
 *     and orient folds several values outright — none of which produce a
 *     `state:read` row. A cell whose value is being delivered by a BETTER path
 *     looks, from here, exactly like a cell nobody wants. This is why the verdict
 *     is a cut-CANDIDATE and never an automatic cut: reason 3 makes a confident
 *     automatic cut unsound in principle, not merely risky.
 *
 * ── THE SHAPE OF THE MISTAKE THIS FILE IS BUILT AROUND ─────────────────────
 *
 * `metricVerdict` in agent-plane-measurement.ts carries a warning worth repeating:
 * the obvious hand-rolled ternary silently relabels "nothing was measured" as a
 * pass, and it "reappeared IMMEDIATELY in the first consumer written after the fix".
 * `0 reads → cut` is that same collapse with the polarity flipped — it relabels
 * "nothing was measured" as a FINDING. So the ternary is not left for callers to
 * rebuild: {@link composeCellTenure} is the only place a verdict is decided, and
 * {@link isCutCandidate} / {@link isStructuralCellZero} are the only branches.
 */

/**
 * Retention of `harness_shared.tool_invocations`, in days.
 *
 * MIRRORS `DEFAULT_RETENTION_TARGETS` (`{ category: 'tool-invocations',
 * retention_days: 14 }`) in harness/routines/telemetry-retention-action.ts —
 * mirrored rather than imported to keep this module free of the routines layer.
 * `cell-tenure.test.ts` asserts the two agree, so a retention change cannot
 * silently widen the observable window here.
 */
export const TOOL_INVOCATIONS_RETENTION_DAYS = 14;

/**
 * The trailing window a tenure verdict is computed over.
 *
 * Equal to retention, not the admission rule's nominal 30: a window longer than
 * retention cannot be observed, and an unobservable window is exactly what reason 2
 * above says must never be read as evidence. Widening this REQUIRES widening
 * retention first, or every cell silently becomes `unobservable`.
 */
export const CELL_TENURE_WINDOW_DAYS = TOOL_INVOCATIONS_RETENTION_DAYS;

const MS_PER_DAY = 86_400_000;

export const CELL_TENURE_VERDICTS = [
  /** Adoption OBSERVED — at least one read inside the window. */
  'keep',
  /**
   * 0 reads, old enough to be judged, over a wholly-observed window. The ONLY
   * verdict that suggests removal, and it suggests — see reason 3.
   */
  'cut-candidate',
  /** 0 reads, but the cell is younger than the window. Structural. */
  'too-young',
  /** 0 reads, but the window reaches outside retained telemetry. Structural. */
  'unobservable',
  /** 0 reads and no `registeredOn` declared, so age is unknown. Structural. */
  'tenure-unknown',
] as const;

export type CellTenureVerdict = (typeof CELL_TENURE_VERDICTS)[number];

/**
 * True when the zero means "this was not measured" rather than "this was measured
 * and nobody read it". Deliberately NOT a check for `!== 'keep'`: that is the
 * collapse described in the header, and it would fold `cut-candidate` — a real,
 * measured finding — in with the three zeros that measured nothing.
 */
export function isStructuralCellZero(v: CellTenureVerdict): boolean {
  return v === 'too-young' || v === 'unobservable' || v === 'tenure-unknown';
}

/** The one branch that may lead to removing a cell. */
export function isCutCandidate(v: CellTenureVerdict): boolean {
  return v === 'cut-candidate';
}

/** The registry facts a tenure verdict needs. A projection of `CellSpec`. */
export interface CellTenureSubject {
  cell: string;
  /** `YYYY-MM-DD` (UTC). Absent ⇒ `tenure-unknown`; see CellSpec.registeredOn. */
  registeredOn?: string;
}

/** One window's observed demand for one cell. */
export interface CellReadCount {
  reads: number;
  callers: number;
}

export interface CellTenureLine {
  cell: string;
  reads: number;
  callers: number;
  verdict: CellTenureVerdict;
  /** Whole days between `registeredOn` and now. Null when undeclared/unparseable. */
  tenureDays: number | null;
  /** Days of the window actually covered by retained telemetry. */
  observedDays: number;
  windowDays: number;
  /** One line a reader can act on without reconstructing the rule. */
  why: string;
}

/** Whole days since a `YYYY-MM-DD` date, or null if it does not parse. */
function tenureDaysSince(registeredOn: string | undefined, nowMs: number): number | null {
  if (!registeredOn) return null;
  const t = Date.parse(`${registeredOn}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor((nowMs - t) / MS_PER_DAY);
}

/**
 * The cut-or-keep line for every registered cell.
 *
 * TOTAL and pure. `reads` is keyed by cell id; a cell absent from the map has zero
 * reads, which is the whole point — the map carries only cells that WERE read, so
 * absence is the signal, not a lookup failure.
 *
 * PRECEDENCE for a zero-read cell is `tenure-unknown` → `too-young` →
 * `unobservable` → `cut-candidate`, i.e. the cheapest-to-establish disqualifier
 * first. The order is deterministic but never load-bearing for the ACTION: all
 * three zeros suppress the cut identically and differ only in the explanation they
 * hand the reader.
 *
 * @param observableSinceMs Oldest retained telemetry row, or null when unknown.
 *   Null is treated as "observed nothing" — fail-CLOSED, so a broken or missing
 *   horizon probe can only suppress cuts, never manufacture them.
 */
export function composeCellTenure(input: {
  registered: readonly CellTenureSubject[];
  reads: ReadonlyMap<string, CellReadCount>;
  nowMs: number;
  observableSinceMs: number | null;
  windowDays?: number;
}): CellTenureLine[] {
  const windowDays = input.windowDays ?? CELL_TENURE_WINDOW_DAYS;

  // How much of the window telemetry can actually speak to. Clamped into
  // [0, windowDays]: a horizon older than the window still only buys the window.
  const observedDays =
    input.observableSinceMs == null
      ? 0
      : Math.max(0, Math.min(windowDays, Math.floor((input.nowMs - input.observableSinceMs) / MS_PER_DAY)));
  const windowFullyObserved = observedDays >= windowDays;

  return input.registered.map((subject) => {
    const counted = input.reads.get(subject.cell);
    const reads = counted?.reads ?? 0;
    const callers = counted?.callers ?? 0;
    const tenureDays = tenureDaysSince(subject.registeredOn, input.nowMs);

    const base = { cell: subject.cell, reads, callers, tenureDays, observedDays, windowDays };

    // Adoption observed. Unconditional: a read is a read whatever the window's
    // coverage or the cell's age, so none of the guards below can withhold a KEEP.
    if (reads > 0) {
      return {
        ...base,
        verdict: 'keep' as const,
        why: `${reads} read(s) by ${callers} caller(s) in the last ${observedDays}d`,
      };
    }

    if (tenureDays == null) {
      return {
        ...base,
        verdict: 'tenure-unknown' as const,
        why: 'no registeredOn declared — age unknown, so 0 reads is not evidence of dormancy',
      };
    }

    if (tenureDays < windowDays) {
      return {
        ...base,
        verdict: 'too-young' as const,
        why: `registered ${tenureDays}d ago, younger than the ${windowDays}d window — ${windowDays - tenureDays}d of it predate the cell`,
      };
    }

    if (!windowFullyObserved) {
      return {
        ...base,
        verdict: 'unobservable' as const,
        why: `telemetry covers only ${observedDays}d of the ${windowDays}d window — absent history is not absent demand`,
      };
    }

    return {
      ...base,
      verdict: 'cut-candidate' as const,
      why: `0 reads in ${observedDays}d, registered ${tenureDays}d ago — candidate for removal (confirm no other delivery path first)`,
    };
  });
}

/** Counts by verdict, for the sweep's summary. */
export function summariseCellTenure(lines: readonly CellTenureLine[]): Record<CellTenureVerdict, number> {
  const out = Object.fromEntries(CELL_TENURE_VERDICTS.map((v) => [v, 0])) as Record<CellTenureVerdict, number>;
  for (const line of lines) out[line.verdict] += 1;
  return out;
}

/**
 * The log line. Leads with the cells that are NOT assessable, for the same reason
 * `formatMeasurementLog` leads with what is measurable: a line reading
 * "8 keep, 0 cut" invites the reader to conclude the registry is fully adopted,
 * when two of its cells were simply never judged.
 */
export function formatCellTenureLog(lines: readonly CellTenureLine[]): string {
  const counts = summariseCellTenure(lines);
  const structural = lines.filter((l) => isStructuralCellZero(l.verdict));
  const cuts = lines.filter((l) => isCutCandidate(l.verdict));

  const head =
    `${lines.length} registered · ${counts.keep} keep · ${cuts.length} cut-candidate · ` +
    `${structural.length} NOT-ASSESSED`;

  const detail = [
    ...cuts.map((l) => `${l.cell}=CUT-CANDIDATE(${l.why})`),
    ...structural.map((l) => `${l.cell}=${l.verdict.toUpperCase()}(${l.why})`),
  ];

  return `[cell-tenure] ${head}${detail.length ? ` | ${detail.join(' · ')}` : ''}`;
}
