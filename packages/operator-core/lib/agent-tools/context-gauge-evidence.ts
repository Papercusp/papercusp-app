/**
 * context-gauge-evidence — the count-evidence contract for the per-turn context gauge
 * (EI-23761864550626068).
 *
 * WHY THIS EXISTS. The gauge line `context: N/L (P%)` is the most-read number in the
 * fleet and it drives the most expensive IRREVERSIBLE agent action (a self-compaction
 * respawn), yet it carried none of the epistemic furniture `fleet:status`
 * (`countEvidence`) and `state:read` (`status:'unknown'` + `assessment`) attach to every
 * other measured number: no exactness, no method, no denominator provenance.
 *
 * WHAT THE NUMBER ACTUALLY IS (read from the writers, not assumed):
 *   - numerator: `compaction-usage.ts` `anchorTokens()` =
 *     floor((bytes of the live transcript since the last compaction boundary
 *            − image − tool-result-duplicate − snapshot excess) / 4).
 *     It is a BYTES/4 HEURISTIC over the JSONL transcript, NOT provider-reported token
 *     usage. Its older comments call the sync reader "exact"; it is exact only about
 *     the byte count, never about tokens.
 *   - denominator: the soft compaction limit, mirrored by the compaction watchdog's
 *     2-minute sweep into `context-usage-cache.ts` from `coord_presence.compaction_limit`.
 *     The watchdog is the cache's single writer, so the limit is only as fresh as the
 *     last sweep, and `config:set-compaction-limit` can report ok while the sweep still
 *     holds the previous value — which is why the denominator's recordedAt is exposed.
 *
 * This module is PURE (no DB, no cache import) so it is unit-testable without the tool
 * graph, mirroring inbox-context-usage.ts. The qualifier is appended ONLY to the loud /
 * critical bands: those are the lines that demand an irreversible action, so they are
 * where an unqualified estimate does damage; the quiet band stays the bare fact so the
 * per-turn token cost of the common case is unchanged.
 */

import {
  contextGaugeBand,
  contextUsagePct,
  renderBandedContextGauge,
  type ObservedPromptFloor,
} from './coordination/tools/inbox-context-usage';

/** The one measurement method the annotator's numerator uses today. */
export const CONTEXT_GAUGE_ESTIMATE_METHOD = 'transcript-bytes/4' as const;

export interface ContextGaugeEvidence {
  /** What is being measured. */
  metric: 'context-tokens-vs-soft-compaction-limit';
  unit: 'tokens';
  /**
   * `estimate` — the numerator is a heuristic, not a provider-measured count. There is
   * deliberately no `exact` member: a reading that CAN be exact must come from a
   * different, provider-usage-backed builder, never by flipping this flag.
   */
  exactness: 'estimate';
  method: typeof CONTEXT_GAUGE_ESTIMATE_METHOD;
  /** Where the numerator is produced — so a reader can open the writer. */
  numeratorWriter: 'compaction-usage.anchorTokens';
  denominator: {
    value: number;
    /** Where the limit is mirrored from. */
    source: 'watchdog-cache(coord_presence.compaction_limit)';
    /** When the watchdog last wrote this limit into the cache; null when unknown. */
    recordedAt: number | null;
    /** `now − recordedAt`; null when recordedAt is unknown. */
    ageMs: number | null;
  };
  /**
   * True when a gateway-observed prompt floor (a REAL provider-measured input size) is
   * present beside the estimate, i.e. the reader has a measured lower bound to compare
   * against. False means the percent rests on the heuristic alone.
   */
  corroboratedByObservedFloor: boolean;
  /** How to compare two readings — the rule `fleet:status` countEvidence also states. */
  comparisonRule: string;
}

export interface BuildContextGaugeEvidenceInput {
  limit: number;
  /** Epoch ms the limit was last recorded by the watchdog; null/undefined when unknown. */
  limitRecordedAt?: number | null;
  now?: number;
  observedPromptFloor?: ObservedPromptFloor | null;
}

export function buildTranscriptEstimateGaugeEvidence(
  input: BuildContextGaugeEvidenceInput,
): ContextGaugeEvidence {
  const now = input.now ?? Date.now();
  const recordedAt =
    typeof input.limitRecordedAt === 'number' && Number.isFinite(input.limitRecordedAt)
      ? input.limitRecordedAt
      : null;
  return {
    metric: 'context-tokens-vs-soft-compaction-limit',
    unit: 'tokens',
    exactness: 'estimate',
    method: CONTEXT_GAUGE_ESTIMATE_METHOD,
    numeratorWriter: 'compaction-usage.anchorTokens',
    denominator: {
      value: input.limit,
      source: 'watchdog-cache(coord_presence.compaction_limit)',
      recordedAt,
      ageMs: recordedAt == null ? null : Math.max(0, now - recordedAt),
    },
    corroboratedByObservedFloor: input.observedPromptFloor != null,
    comparisonRule:
      'Two gauge readings are comparable only as a trend within ONE session; a single large jump ' +
      'is not evidence a tool call cost that many tokens (the numerator is bytes/4 over the ' +
      'transcript, so image / tool-result / snapshot payloads move it by a different ratio than ' +
      'text). Do not derive per-tool token costs from gauge deltas.',
  };
}

function formatAge(ageMs: number): string {
  const s = Math.round(ageMs / 1000);
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

/**
 * The short qualifier appended to a loud/critical line. Names the method (so the number
 * is not read as provider usage), whether a measured floor corroborates it, and the
 * denominator's age (so a limit that did not take effect is visible at the read).
 */
export function renderGaugeEstimateQualifier(evidence: ContextGaugeEvidence): string {
  const age =
    evidence.denominator.ageMs == null
      ? 'limit age unknown'
      : `limit recorded ${formatAge(evidence.denominator.ageMs)} ago`;
  const floor = evidence.corroboratedByObservedFloor
    ? 'a provider-observed input floor is shown'
    : 'no provider-measured corroboration';
  return ` [estimate: ${evidence.method}, not provider usage; ${floor}; ${age}]`;
}

/**
 * `renderBandedContextGauge` plus the estimate qualifier on the loud/critical bands.
 * Same null contract: returns null below the quiet band. The quiet band is returned
 * unchanged on purpose (see module header).
 */
export function renderBandedContextGaugeWithEvidence(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
  selfCompactionAvailable: boolean | null,
  fleetWindDownLoopEndAuthorized: boolean | null,
  observedPromptFloor: ObservedPromptFloor | null,
  evidence: ContextGaugeEvidence | null,
): string | null {
  const line = renderBandedContextGauge(
    contextTokens,
    compactionLimit,
    selfCompactionAvailable,
    fleetWindDownLoopEndAuthorized,
    observedPromptFloor,
  );
  if (line == null || evidence == null) return line;
  const band = contextGaugeBand(contextUsagePct(contextTokens, compactionLimit));
  if (band !== 'loud' && band !== 'critical') return line;
  return line + renderGaugeEstimateQualifier(evidence);
}
