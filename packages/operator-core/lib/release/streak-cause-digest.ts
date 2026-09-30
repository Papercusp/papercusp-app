/**
 * Gate-stall CROSS-STREAK cause digest — the decision half (WI-42118, ruling
 * green-main-fast-2026-08-25 D-022(d)).
 *
 * ## The defect this fills
 *
 * Both gate-stall escalation bodies are snapshots of the ALERTING TICK.
 * `gateStallEscalationBody()` carries that one tick's `failingTests`; the human
 * `notifyAttention` leg carries no failing tests at all. So a 43-red / 5-day streak and a
 * streak three ticks old produce the same sentence, and neither answers the question a
 * responder actually has: **is this ONE unfixed break, or is the failing set churning?**
 *
 * That distinction drives OPPOSITE responses, which is what makes it worth computing:
 *   - STABLE   → the same test fails every verdict. One real regression. Go fix it.
 *   - CHURNING → a different set each verdict. Infrastructure or flake. Do NOT chase
 *                individual tests; the named files are symptoms, not the fault.
 *   - SILENT   → the reds name nothing at all. The alarm is about the GATE (it is not
 *                producing verdicts), not about the code.
 *
 * ## Why this DERIVES rather than accumulates (derived-truth ladder, rung 1)
 *
 * `gate_health.failingTests` is a whole-key replace holding only the current tick, and
 * growing it into a rolling history would be a second copy of a truth the append-only
 * event log already owns. `harness_shared.pipeline_events` (kind `green_checkpoint`)
 * already persists per-tick `detail.failingTests` — see `buildCheckpointDetail` in
 * `release-actions.ts`, which has written it since P-003 precisely so "WHY the gate was
 * red survives the per-tick metadata overwrite". The digest is computed from that log.
 *
 * ## ⚠ The trap: most ticks in a long streak are NOT verdicts
 *
 * Measured on papercusp over the live 43-red streak, the majority of `green_checkpoint`
 * rows are `skipped-locked`, `repair-in-progress`, `cancelled`, `migrations-pending` or
 * `repair-staging-mismatch` — statuses that name ZERO failing tests because they never
 * judged any code. A digest that counted rows would read those empty sets as the failing
 * set changing, and report CHURNING for a streak that is dead STABLE.
 *
 * So verdict-bearing-ness is NOT decided here from a status string. The caller classifies
 * each tick with the SAME `classifyGateStallStatus()` the streak counter itself uses, and
 * passes the result as {@link StreakTick.verdictBearing}. That is deliberate: it makes it
 * impossible for the digest's notion of "a red" to drift from `consecutiveReds`' notion of
 * one. A `'record-only'` tick (a proven-stale candidate) is likewise not a verdict — it
 * establishes nothing about the code, exactly as it establishes nothing for the streak.
 *
 * ## Honesty rules
 *
 * A trend needs at least two samples. One naming tick reports `unknown`, never `stable` —
 * a single red cannot distinguish an unfixed break from a one-off flake, and claiming it
 * could is the failure mode this whole digest exists to remove.
 */

/** One `green_checkpoint` pipeline event, reduced to what the digest reads. */
export interface StreakTick {
  /** ms epoch — the event's `created_at`. */
  atMs: number;
  /**
   * Did this tick produce a verdict ABOUT THE CODE? Supplied by the caller from
   * `classifyGateStallStatus(status, pinMoved, retriage) === 'red'` so the digest and the
   * streak counter can never disagree about what a red is. See the module docblock.
   */
  verdictBearing: boolean;
  /** `detail.failingTests` for this tick (already capped at 20 by the writer). */
  failingTests: readonly string[];
}

export type StreakStability =
  /** every naming verdict named the same set — one unfixed break. */
  | 'stable'
  /** a persistent core plus tests that come and go. */
  | 'mixed'
  /** no test common to all naming verdicts — infrastructure or flake. */
  | 'churning'
  /** reds happened, but not one of them named a failing test. */
  | 'silent'
  /** too few naming verdicts to establish a trend (0 reds, or exactly 1 sample). */
  | 'unknown';

export interface StreakCauseDigest {
  stability: StreakStability;
  /** verdict-bearing ticks in the window. */
  redTicks: number;
  /** verdict-bearing ticks that named at least one failing test. */
  namingTicks: number;
  /** verdict-bearing ticks that named NOTHING (the "red with nothing to fix" class). */
  silentRedTicks: number;
  /** named by EVERY naming tick — the unfixed core. */
  persistent: string[];
  /** named by some naming ticks but not all. */
  intermittent: string[];
  /** ms between the first and last NAMING tick, or null with fewer than two. */
  spanMs: number | null;
  /**
   * The counts above were computed over a CAPPED fetch and are therefore FLOORS, not totals.
   * Repo rule: a caller's row limit bounds row lists only — an aggregate derived from a
   * capped fetch must say so ON THE AGGREGATE, or a bounded measurement reads as a confident
   * number. The rendered `line` hedges itself when this is set.
   */
  truncatedByLimit: boolean;
  /** one line, ready to paste into an alarm body. */
  line: string;
}

/** How many test names any one sentence will list before collapsing to "+N more". */
const NAME_LIST_CAP = 5;

function renderNames(names: readonly string[]): string {
  if (names.length <= NAME_LIST_CAP) return names.join(', ');
  return `${names.slice(0, NAME_LIST_CAP).join(', ')} (+${names.length - NAME_LIST_CAP} more)`;
}

function renderSpan(spanMs: number | null): string {
  if (spanMs == null || spanMs <= 0) return '';
  const hrs = spanMs / 3_600_000;
  if (hrs < 1) return ` across ${Math.max(1, Math.round(spanMs / 60_000))}m`;
  if (hrs < 48) return ` across ${hrs.toFixed(1)}h`;
  return ` across ${(hrs / 24).toFixed(1)}d`;
}

/**
 * Reduce a streak's ticks to a cause digest. PURE — no DB, no clock.
 *
 * `ticks` may be in any order and may include non-verdict rows; both are filtered here so
 * a caller can hand over a raw event page unmodified.
 */
export function summarizeStreakCause(
  ticks: readonly StreakTick[],
  /** True when the caller's fetch hit its row cap, so every count here is a FLOOR. */
  truncatedByLimit = false,
): StreakCauseDigest {
  const reds = ticks.filter((t) => t.verdictBearing);
  // Normalise each verdict's failing set: drop blanks, de-duplicate. A tick that named the
  // same file twice must not read as a different set from one that named it once.
  const naming: Array<{ atMs: number; tests: Set<string> }> = [];
  for (const red of reds) {
    const tests = new Set(
      (red.failingTests ?? []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0),
    );
    if (tests.size > 0) naming.push({ atMs: red.atMs, tests });
  }

  const redTicks = reds.length;
  const namingTicks = naming.length;
  const silentRedTicks = redTicks - namingTicks;

  const union = new Set<string>();
  for (const n of naming) for (const t of n.tests) union.add(t);
  const persistent = [...union].filter((t) => naming.every((n) => n.tests.has(t))).sort();
  const intermittent = [...union].filter((t) => !persistent.includes(t)).sort();

  const times = naming.map((n) => n.atMs).sort((a, b) => a - b);
  const spanMs = times.length >= 2 ? times[times.length - 1] - times[0] : null;

  const base = { redTicks, namingTicks, silentRedTicks, persistent, intermittent, spanMs, truncatedByLimit };
  // Every count below is a floor when the fetch was capped, so the sentence must not read
  // as a total. "ALL 12 red verdicts" is a claim about a set; "the 12 most recent" is a
  // claim about a sample, and only one of them survives a window bigger than the cap.
  const all = truncatedByLimit ? 'the most recent' : 'ALL';
  const capNote = truncatedByLimit
    ? ' (window truncated at the row cap — counts are floors, and an older red may name more.)'
    : '';

  if (redTicks === 0) {
    return { ...base, stability: 'unknown', line: 'CAUSE: no verdict-bearing red in this streak to judge from.' };
  }
  if (namingTicks === 0) {
    return {
      ...base,
      stability: 'silent',
      line:
        `CAUSE: UNKNOWN — ${truncatedByLimit ? 'the most recent' : 'all'} ${redTicks} red verdict(s) in this ` +
        `streak named ZERO failing tests. The gate is not reporting WHAT failed, so this alarm is about the ` +
        `GATE, not the code.${capNote}`,
    };
  }
  if (namingTicks === 1) {
    return {
      ...base,
      stability: 'unknown',
      line:
        `CAUSE: only 1 of ${redTicks} red verdict(s) named failing tests (${renderNames([...naming[0].tests].sort())}) — ` +
        `too few samples to tell an unfixed break from a one-off flake.`,
    };
  }

  const span = renderSpan(spanMs);
  const silentNote = silentRedTicks > 0 ? ` (${silentRedTicks} further red(s) named nothing.)` : '';

  if (persistent.length > 0 && intermittent.length === 0) {
    return {
      ...base,
      stability: 'stable',
      line:
        `CAUSE: STABLE — the same ${persistent.length} failure(s) were named by ${all} ${namingTicks} red verdicts${span}: ` +
        `${renderNames(persistent)}. This is one unfixed break, not flake — fix it.${silentNote}${capNote}`,
    };
  }
  if (persistent.length > 0) {
    return {
      ...base,
      stability: 'mixed',
      line:
        `CAUSE: MIXED — ${renderNames(persistent)} failed in ${all} ${namingTicks} red verdicts${span}, ` +
        `alongside ${intermittent.length} test(s) that come and go. Fix the persistent core first; ` +
        `treat the rest as flake until it survives that.${silentNote}${capNote}`,
    };
  }
  return {
    ...base,
    stability: 'churning',
    line:
      `CAUSE: CHURNING — ${namingTicks} red verdicts${span} named ${union.size} distinct failing test(s) with ` +
      `NOTHING common to all. Suspect infrastructure or flake rather than one regression — do NOT chase the ` +
      `individual names.${silentNote}${capNote}`,
  };
}
