/**
 * gates/degenerate.ts — find gates that CANNOT DISCRIMINATE, from their own decisions (EI-10619).
 *
 * Reads `harness_shared.gate_decisions` and applies exactly one rule:
 *
 *   **A gate that DECLARED `expect: 'discriminates'` and produced a ONE-SIDED verdict
 *   distribution over N decisions cannot discriminate. That is a defect.**
 *
 * ## Why the rule is scoped to `discriminates`, and why that is the whole idea
 *
 * The unscoped version of this rule ("a one-sided gate is broken", equivalently
 * `max(value) < threshold` ⇒ unreachable branch) is UNSOUND, and it is unsound in the exact way
 * that killed EI-10609. A healthy gate is routinely one-sided:
 *
 *   - a rate limiter under normal traffic: 100% pass — never tripping is the GOOD case;
 *   - an auth check every caller passes:   100% pass;
 *   - orient's relevance floor (EI-10372): 100% reject — BROKEN.
 *
 * These are OBSERVATIONALLY IDENTICAL. No statistic over (verdict, value, threshold) tells them
 * apart, because the separating fact — *what the gate is for* — is not in the data. So the gate
 * DECLARES it (`expect`), and this detector only judges the gates that claimed to discriminate.
 *
 * `value`/`threshold` therefore EXPLAIN a finding (which direction, and by what margin the
 * threshold sits off-scale); they never detect one. See gates/decision.ts.
 *
 * ## The severest finding is an ABSENCE
 *
 * A gate in the registry that emitted ZERO decisions did not "pass" — it never ran. That is the
 * Shape 3/4 failure (a metric that cannot be nonzero; a check nothing calls), and you cannot find
 * it by looking at the rows you have. Hence {@link GATE_REGISTRY}: the DECLARATION to diff against.
 */
import type { Sql } from 'postgres';
import type { GateExpectation } from './decision';

/**
 * Every gate that declares itself. A gate MISSING from the decision log — but present here — is
 * reported as `never-ran`, which is the most severe verdict this module produces.
 *
 * Registering a gate here is the act that makes its absence LOUD. An unregistered gate is invisible
 * when it goes dark, which is the whole defect class.
 */
export const GATE_REGISTRY: ReadonlyArray<{ gate: string; expect: GateExpectation; owner: string }> = [
  // The consumer-admission gates (lib/memory/recall-admission.ts). Only the FLOOR discriminates:
  // the withhold and the budget may legitimately never fire, and saying so is what keeps this
  // detector free of the false positives that killed EI-10609.
  { gate: 'orient.recall.relevance-floor', expect: 'discriminates', owner: 'memory/recall-admission' },
  { gate: 'orient.recall.queen-loop-withhold', expect: 'guards', owner: 'memory/recall-admission' },
  // P-008: near-duplicate collapse — most recalls have no near-dupes, so never collapsing is
  // HEALTHY (guards), same posture as the withhold and budget below.
  { gate: 'orient.recall.dedup', expect: 'guards', owner: 'memory/recall-admission' },
  { gate: 'orient.recall.char-budget', expect: 'guards', owner: 'memory/recall-admission' },
];

export type DegenerateVerdict =
  /** In the registry, but produced NO decisions in the window — it never ran. The severest state. */
  | 'never-ran'
  /** Declared `discriminates`, rejected 100%. The PASS branch is unreachable (EI-10372's shape). */
  | 'never-admits'
  /** Declared `discriminates`, passed 100%. The gate is vacuous (EI-10562's shape, inverted). */
  | 'never-rejects'
  /** Declared `guards` but fires constantly — mis-declared, OR the system is genuinely degraded. */
  | 'guard-fires-constantly';

export interface DegenerateGate {
  gate: string;
  expect: GateExpectation;
  verdict: DegenerateVerdict;
  decisions: number;
  passes: number;
  rejects: number;
  /** Observed range of the compared value, when the gate recorded one. */
  minValue: number | null;
  maxValue: number | null;
  threshold: number | null;
  /**
   * Why the branch is unreachable, in the gate's own units — e.g. "threshold 0.05 sits ABOVE the
   * entire observed value range (max 0.0328): the pass branch cannot be reached." Null when the
   * gate is categorical (no scalar to compare).
   */
  explain: string | null;
}

export interface FindDegenerateGatesOpts {
  /** Window to judge over. Default 24h. */
  sinceMs?: number;
  /**
   * Decisions a gate must have made before a one-sided distribution means anything. A gate called
   * three times that happened to reject all three is not evidence of anything. Default 30.
   */
  minDecisions?: number;
  /** A `guards` gate rejecting above this fraction is surfaced as mis-declared. Default 0.5. */
  guardFireRate?: number;
  /** Registry to diff against (injected for tests). Default {@link GATE_REGISTRY}. */
  registry?: ReadonlyArray<{ gate: string; expect: GateExpectation; owner: string }>;
}

interface GateRow {
  gate: string;
  expect: GateExpectation;
  decisions: number;
  passes: number;
  rejects: number;
  min_value: number | null;
  max_value: number | null;
  threshold: number | null;
}

/** The pure core: given per-gate aggregates + the registry, decide. No I/O — the testable half. */
export function judgeGates(rows: readonly GateRow[], opts: FindDegenerateGatesOpts = {}): DegenerateGate[] {
  const minDecisions = opts.minDecisions ?? 30;
  const guardFireRate = opts.guardFireRate ?? 0.5;
  const registry = opts.registry ?? GATE_REGISTRY;
  const byGate = new Map(rows.map((r) => [r.gate, r]));
  const out: DegenerateGate[] = [];

  // ABSENCE FIRST — a registered gate with no decisions never ran. You cannot find a missing row
  // by iterating the rows you have, so this loop walks the DECLARATION, not the data.
  for (const decl of registry) {
    const row = byGate.get(decl.gate);
    if (row && row.decisions > 0) continue;
    out.push({
      gate: decl.gate,
      expect: decl.expect,
      verdict: 'never-ran',
      decisions: 0,
      passes: 0,
      rejects: 0,
      minValue: null,
      maxValue: null,
      threshold: null,
      explain: `declared in the gate registry (owner: ${decl.owner}) but emitted NO decisions in the window — it is not running. A gate that never runs is not a gate.`,
    });
  }

  for (const r of rows) {
    if (r.decisions < minDecisions) continue; // too few calls to mean anything — say nothing.

    const base = {
      gate: r.gate,
      expect: r.expect,
      decisions: r.decisions,
      passes: r.passes,
      rejects: r.rejects,
      minValue: r.min_value,
      maxValue: r.max_value,
      threshold: r.threshold,
    };

    if (r.expect === 'discriminates') {
      if (r.passes === 0) {
        out.push({ ...base, verdict: 'never-admits', explain: explainOneSided(r, 'above') });
      } else if (r.rejects === 0) {
        out.push({ ...base, verdict: 'never-rejects', explain: explainOneSided(r, 'below') });
      }
      continue;
    }

    // `guards`: never firing is HEALTHY and is never reported. The only interesting state is a
    // guard that fires constantly — which means it was mis-declared, or the thing it guards is
    // genuinely on fire. Both want a human; neither is the cannot-discriminate defect.
    if (r.rejects / r.decisions > guardFireRate) {
      out.push({
        ...base,
        verdict: 'guard-fires-constantly',
        explain: `declared as a safety limit (guards) but rejected ${r.rejects}/${r.decisions} decisions — either it is mis-declared (it is really a discriminator) or the system it guards is degraded.`,
      });
    }
  }

  return out;
}

function explainOneSided(r: GateRow, side: 'above' | 'below'): string | null {
  if (r.threshold === null || r.min_value === null || r.max_value === null) return null;
  // The threshold sits outside the entire observed range ⇒ the branch is unreachable BY SCALE, not
  // by luck of the data. This is the proof, and it is exactly EI-10372: floor 0.05 against an RRF
  // rank-fusion ceiling of ~0.0328.
  if (side === 'above' && r.threshold > r.max_value) {
    return `threshold ${r.threshold} sits ABOVE the entire observed value range (max ${r.max_value}) across ${r.decisions} decisions — the pass branch is unreachable by scale, not by chance.`;
  }
  if (side === 'below' && r.threshold < r.min_value) {
    return `threshold ${r.threshold} sits BELOW the entire observed value range (min ${r.min_value}) across ${r.decisions} decisions — the reject branch is unreachable by scale, not by chance.`;
  }
  // One-sided, but the threshold IS inside the value range: the scale is fine and the data is
  // genuinely lopsided. Report it, but do not claim a proof we do not have.
  return `verdict was one-sided across ${r.decisions} decisions, but the threshold ${r.threshold} lies INSIDE the observed range [${r.min_value}, ${r.max_value}] — the gate is reachable; the inputs, not the scale, are lopsided. Check the caller before the constant.`;
}

/** Read the window's aggregates and judge them. */
export async function findDegenerateGates(
  sql: Sql,
  opts: FindDegenerateGatesOpts = {},
): Promise<DegenerateGate[]> {
  const sinceMs = opts.sinceMs ?? 24 * 60 * 60 * 1000;
  const rows = (await sql`
    SELECT
      gate,
      MAX(expect)                                            AS expect,
      COUNT(*)::int                                          AS decisions,
      COUNT(*) FILTER (WHERE verdict = 'pass')::int          AS passes,
      COUNT(*) FILTER (WHERE verdict = 'reject')::int        AS rejects,
      MIN(value)                                             AS min_value,
      MAX(value)                                             AS max_value,
      MAX(threshold)                                         AS threshold
    FROM harness_shared.gate_decisions
    WHERE decided_at >= now() - ${`${Math.round(sinceMs / 1000)} seconds`}::interval
    GROUP BY gate
  `) as unknown as GateRow[];
  return judgeGates(rows, opts);
}
