/**
 * gates/decision.ts — a gate's DECISION as an event (EI-10619).
 *
 * ## The constraint this removes
 *
 * `harness_shared.tool_invocations` records what a tool RETURNED. It has no idea what the tool
 * DECIDED on the way there. So every member of the cannot-discriminate class
 * (`agent-insights/prove-it-discriminates-before-it-acts`) is INVISIBLE to it:
 *
 *   - orient's relevance floor admitted NOTHING for weeks → tool status `ok`, 0.6% error rate.
 *   - the datatype dedup gate refused 7 of 7 legitimate declarations → status `ok`, 17/17.
 *   - the harvest selector destroyed 40 records → status `ok`, 1.4% error rate.
 *
 * EI-10609 tried to mine the existing telemetry for these anyway and was falsified outright: 0 of 5
 * known-broken gates detected. The reason was never a bad threshold — **a gate's decision is not an
 * event.** This module makes it one.
 *
 * ## ⚠ WHY `expect` EXISTS, AND WHY THE OBVIOUS DETECTOR IS WRONG WITHOUT IT
 *
 * The tempting rule is "a gate whose verdict distribution has ZERO ENTROPY cannot discriminate"
 * (equivalently: `max(value) < threshold` ⇒ the branch is unreachable). **It is unsound**, and it
 * fails in the exact way that killed EI-10609. A HEALTHY gate can also be perfectly one-sided:
 *
 *   | gate                                   | verdicts     | healthy? |
 *   |----------------------------------------|--------------|----------|
 *   | orient's relevance floor (EI-10372)    | 100% reject  | BROKEN   |
 *   | a rate limiter under normal traffic    | 100% pass    | HEALTHY  |
 *   | an auth check every caller passes      | 100% pass    | HEALTHY  |
 *
 * A broken discriminator and a healthy limit-that-never-trips are OBSERVATIONALLY IDENTICAL over
 * (gate, verdict, value, threshold). No statistic over those four columns separates them, and a
 * detector that tries would light up every safety limit in the system.
 *
 * The separating information is not in the data. It is **what the gate is FOR** — so the gate
 * DECLARES it, at the call site, where the author already knows:
 *
 *   - `discriminates` — this gate's job is to SEPARATE. One-sided over N decisions ⇒ a DEFECT.
 *   - `guards`        — this gate is a safety limit. Never firing is the HEALTHY case; its FIRING
 *                       is the event of interest.
 *
 * That is Rule (b) of the insight doc one level up: you cannot infer intent from behaviour — diff
 * behaviour against the DECLARATION. And unlike the docstring lie that EI-10660 was (a comment
 * claiming callers that did not exist), this declaration is CHECKED against reality every window:
 * a `guards` gate that fires constantly is surfaced as MIS-DECLARED. A declaration with a feedback
 * loop is a different animal from a claim nobody tests.
 *
 * ## Shape
 *
 * Emission is split in two on purpose:
 *   - {@link GateDecision} is a PLAIN VALUE. Gates stay pure — they RETURN their decisions.
 *   - {@link recordGateDecisions} does the I/O, fire-and-forget, and is never load-bearing.
 *
 * A gate that had to `await` a telemetry write to make a decision would be a gate whose decision
 * depends on the telemetry being up. Keep them apart.
 */
import type { Sql } from 'postgres';

/**
 * What the gate is FOR. The one field a statistic cannot recover — see the header.
 *
 * Choose `discriminates` only when a one-sided outcome would genuinely be a BUG. If you find
 * yourself reaching for `discriminates` on a gate that is allowed to never fire, you want `guards`.
 */
export type GateExpectation = 'discriminates' | 'guards';

/** `pass` = the subject got through. `reject` = the gate acted on it (filtered/refused/withheld). */
export type GateVerdict = 'pass' | 'reject';

export interface GateDecision {
  /** Stable dotted id — `<surface>.<gate>`, e.g. `orient.recall.relevance-floor`. */
  gate: string;
  /** What this gate is FOR. Load-bearing: the detector applies its rule ONLY to `discriminates`. */
  expect: GateExpectation;
  verdict: GateVerdict;
  /**
   * The value the gate COMPARED, and what it compared it against. Optional — a gate may be
   * categorical (an exact-key collision has no scalar). These EXPLAIN a degenerate verdict
   * distribution (which direction, and by what margin); they are not the detection rule.
   */
  value?: number | null;
  threshold?: number | null;
  /** What was being decided about (a memory id, a datatype slug) — for triage, not detection. */
  subject?: string | null;
}

/**
 * Insert decisions. NEVER throws, NEVER load-bearing — call WITHOUT awaiting.
 *
 * Warn is a THROTTLE, not a one-shot latch, for the reason `recordRecallStats` documents: a
 * warn-once-then-silence is how a persistent write failure hides — the one line scrolls away and
 * the black-hole is invisible. Re-warn at most once per window, carrying the count swallowed since.
 */
const WARN_WINDOW_MS = 5 * 60_000;
let _lastWarnedAt = 0;
let _suppressedSinceWarn = 0;

export async function recordGateDecisions(sql: Sql, decisions: readonly GateDecision[]): Promise<void> {
  if (decisions.length === 0) return;
  try {
    const rows = decisions.map((d) => ({
      gate: d.gate,
      expect: d.expect,
      verdict: d.verdict,
      value: typeof d.value === 'number' && Number.isFinite(d.value) ? d.value : null,
      threshold: typeof d.threshold === 'number' && Number.isFinite(d.threshold) ? d.threshold : null,
      subject: d.subject ?? null,
    }));
    await sql`
      INSERT INTO harness_shared.gate_decisions ${sql(
        rows,
        'gate',
        'expect',
        'verdict',
        'value',
        'threshold',
        'subject',
      )}
    `;
  } catch (err) {
    _suppressedSinceWarn += 1;
    const now = Date.now();
    if (now - _lastWarnedAt >= WARN_WINDOW_MS) {
      const also = _suppressedSinceWarn - 1;
      console.warn(
        `[gate-decisions] capture failed (${decisions.length} decision(s), first gate='${decisions[0]?.gate}')` +
          (also > 0 ? ` — +${also} more since last warn` : '') +
          `; re-warns at most once/${WARN_WINDOW_MS / 60_000}min:`,
        (err as Error)?.message ?? err,
      );
      _lastWarnedAt = now;
      _suppressedSinceWarn = 0;
    }
  }
}
