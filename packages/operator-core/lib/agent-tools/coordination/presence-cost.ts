/**
 * presence-cost.ts — token-cost measurement + budgets for the coord:presence
 * roster snapshot (presence-v2-2026-06-14 P-012).
 *
 * Presence stores MAXIMAL (D-001) but READS lean + hive-scoped (D-002), so the
 * read shape — not the projection — is the token-billed surface. The snapshot a
 * per-token-billed LLM consumer pays for must stay an INLINE GLANCE: small
 * enough that the harness keeps it in the prompt instead of persisting it to a
 * scratch file that re-reads on every later turn (D-004's lever #2 — tool-result
 * size compounds over the session). The READ budget is what gates the default
 * field set; the underlying projection stays maximal.
 *
 * MEASUREMENT (real, this dev box, trailing 7d, from
 * `harness_shared.tool_invocations.output_size` — the serialized result length
 * the generic dispatch records for every tool, `dispatch-stack.ts:976`
 * `outputSize = r.outputSize ?? JSON.stringify(r.content).length`):
 *
 *   coord:presence scope    calls   p50        p90        avg
 *   --------------------    -----   --------   --------   --------
 *   hive (explicit)            17     182 B      195 B     ~4 KB
 *   default (no scope)        229    28 KB      66 KB      ~30 KB
 *   workspace                  81    67 KB     123 KB      ~69 KB
 *   all                         4    66 KB     137 KB      ~84 KB
 *
 * So at HIVE SCALE the default read IS an inline glance (p50 182 B ≈ 46 tokens —
 * the design holds). The large reads are the SU/operator callers who have NO
 * hive → fall back to WORKSPACE scope on a multi-effort dev box (the D-002
 * artifact: many unrelated efforts in one workspace), plus the deliberate
 * `workspace`/`all` admin opt-in views (28 active + a long stale roster). Those
 * are bounded by the lean field set + the admin opt-in, NOT by the hive path —
 * no default-field trim is warranted (P-012).
 *
 * This module is the CI-enforced ceiling on the CONTROLLABLE lean shape: a
 * per-agent lean row and a hive-scale snapshot. `presence-cost.test.ts` asserts
 * both stay under budget so a future field addition can't silently turn the
 * hive-scaled glance into a file-persist. The weekly token report (P-016) is the
 * complementary OBSERVABILITY layer — it watches the real read VOLUME
 * (call-count + result-size, week-over-week) so a regression on the workspace /
 * admin paths can't land silently either.
 */

import { toStableRosterRow, type RosterRow } from './presence-payload';

/**
 * Rough chars→tokens divisor. Anthropic tokenization averages ~3.5–4 chars/token
 * for JSON-ish English; 4 is the conventional estimate (the same heuristic the
 * token-usage-reduction audit used). This is an ESTIMATE for budgeting, not an
 * exact token count — the budgets carry headroom to absorb the slop.
 */
export const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Hive scale (D-002): a Hive = a few swarms (machines) × a few agents each = a
 * SMALL roster. 12 is a generous upper bound for "a hive's worth of agents" — a
 * snapshot of this many lean rows is the worst case the default read should face.
 */
export const PRESENCE_HIVE_SCALE_AGENTS = 12;

/**
 * Per-agent budget for the lean `toStableRosterRow` (identity + state +
 * lastActiveSecAgo). A real heavy row (a long intent sentence + a handful of
 * files/claims) measures ~150–250 tokens; 600 leaves room for legitimately long
 * intents while still tripping on a structural regression (a new array/prose
 * field roughly doubling the row).
 */
export const PRESENCE_LEAN_ROW_TOKEN_BUDGET = 600;

/**
 * Snapshot-level "stays an inline glance, not a file-persist" ceiling. ~6000
 * tokens ≈ 24 KB — comfortably under the harness's tool-result file-persist
 * threshold, and well above a realistic hive-scale lean snapshot (~12 agents ≈
 * 2.5–3 K tokens). A hive-scaled default read that exceeds this has regressed
 * out of "inline glance" territory.
 */
export const PRESENCE_INLINE_GLANCE_TOKEN_BUDGET = 6000;

/** The inline-glance budget expressed in characters/bytes (the unit
 *  `tool_invocations.output_size` records), for the P-016 report note. */
export const PRESENCE_INLINE_GLANCE_BYTES = PRESENCE_INLINE_GLANCE_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;

export interface PresenceCost {
  /** Serialized JSON length in characters (≈ UTF-8 bytes for ASCII payloads). */
  chars: number;
  /** Estimated tokens (chars / APPROX_CHARS_PER_TOKEN, rounded up). */
  tokens: number;
}

/** Estimate tokens from a character/byte count (the dispatch records chars). */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / APPROX_CHARS_PER_TOKEN);
}

/** Serialized length of any value; 0 if it can't be stringified (defensive). */
export function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Measure the serialized cost (chars + estimated tokens) of any value. */
export function measurePresenceCost(value: unknown): PresenceCost {
  const chars = serializedLength(value);
  return { chars, tokens: estimateTokens(chars) };
}

/** Cost of a single roster row as the coord:presence read emits it (the lean
 *  `toStableRosterRow` projection — identity + state + lastActiveSecAgo). */
export function presenceRowCost(row: RosterRow): PresenceCost {
  return measurePresenceCost(toStableRosterRow(row));
}

/** Cost of a full assembled snapshot object (the exact JSON the tool returns). */
export function presenceSnapshotCost(snapshot: unknown): PresenceCost {
  return measurePresenceCost(snapshot);
}
