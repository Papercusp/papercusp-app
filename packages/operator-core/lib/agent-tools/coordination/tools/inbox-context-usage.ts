/**
 * inbox-context-usage — the per-turn context-usage signal prepended to the coord
 * injection block (agent-managed-compaction P-007 + WI-1795).
 *
 * A pure presentation helper, deliberately split OUT of the coord:inbox handler so
 * its threshold-gating is unit-testable without the tool's DB dependency graph.
 */

/** agent-managed-compaction (WI-1795, owner-requested 2026-07-03): at/above this
 *  %-of-soft-limit the context-usage line stops being a bare FACT and names the
 *  ACTION — call session:request-compaction. Below it, low-% turns stay clean (just
 *  the `context: N/M (P%)` fact). The soft `compactionLimit` sits below the true
 *  model window, so 85% of it is a genuine "wrap up + compact soon" signal, not a panic. */
export const COMPACTION_HINT_PCT = 85;

/** Route-bound evidence used to distinguish total prompt pressure from working room. */
export interface ObservedPromptFloor {
  tokens: number;
  observations: number;
}

/** Provenance for the numerator used by the live inbox gauge. */
export type ContextGaugeReadingSource = 'live-transcript-bytes/4' | 'watchdog-cache';

/** The live transcript estimate wins; the watchdog value is used only when it cannot be read. */
export function contextGaugeReadingSource(
  liveContextTokens: number | null | undefined,
): ContextGaugeReadingSource {
  return liveContextTokens == null ? 'watchdog-cache' : 'live-transcript-bytes/4';
}

/**
 * A conservative lower bound on conversation room. The observed floor can
 * include first-turn conversation content, so it may overstate the fixed prefix;
 * subtracting it therefore understates (never over-promises) usable runway.
 */
export function usableRunwayFromObservedPromptFloor(
  compactionLimit: number | null | undefined,
  observedPromptFloor: ObservedPromptFloor | null | undefined,
): number | null {
  if (
    !compactionLimit ||
    !observedPromptFloor ||
    !Number.isFinite(observedPromptFloor.tokens) ||
    observedPromptFloor.tokens < 0 ||
    !Number.isInteger(observedPromptFloor.observations) ||
    observedPromptFloor.observations < 1
  ) return null;
  return Math.max(0, Math.floor(compactionLimit - observedPromptFloor.tokens));
}

function renderContextFact(
  contextTokens: number,
  compactionLimit: number,
  pct: number,
  observedPromptFloor?: ObservedPromptFloor | null,
  readingSource?: ContextGaugeReadingSource,
): string {
  const runway = usableRunwayFromObservedPromptFloor(compactionLimit, observedPromptFloor);
  const measured = runway == null || !observedPromptFloor
    ? ''
    : `; observed-input floor ${Math.floor(observedPromptFloor.tokens)} (${observedPromptFloor.observations} sample${observedPromptFloor.observations === 1 ? '' : 's'}), conservative usable runway ${runway}`;
  const source = readingSource === 'live-transcript-bytes/4'
    ? '; count source: live transcript-size estimate (bytes/4)'
    : readingSource === 'watchdog-cache'
      ? '; count source: watchdog-cached estimate'
      : '';
  return `context: ${contextTokens}/${compactionLimit} (${pct}%)${measured}${source}`;
}

/**
 * The rounded percent-of-soft-limit for a session, or null when it can't be computed
 * (no limit / no estimate). Split out (flush-to-proceed-stretch-discipline P-002) so the
 * context-usage line AND the flush-freshness gate key on ONE pct computation instead of
 * each re-deriving it — a single source for "how full am I", identical rounding.
 */
export function contextUsagePct(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
): number | null {
  if (!compactionLimit || contextTokens == null) return null;
  return Math.round((contextTokens / compactionLimit) * 100);
}

/**
 * WI-1795 (owner-requested 2026-07-03): render the context-usage signal prepended to the
 * coord injection each turn. Below {@link COMPACTION_HINT_PCT} it's a bare
 * `context: N/M (P%)` FACT; at/above it, the line also NAMES THE ACTION
 * (call `session:request-compaction`). This line is the ONE surface guaranteed in front of
 * the agent at the compaction decision moment — and a fact with no affordance is why agents
 * stall at the threshold and NARRATE "ending the turn so a compaction runs" instead of
 * CALLING the tool that compacts (the affordance half of a two-part fix; the behavioral half
 * is on the agent). Returns null when usage can't be computed (no limit / no estimate).
 */
export function renderContextUsageLine(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
  selfCompactionAvailable: boolean | null = null,
  fleetWindDownLoopEndAuthorized: boolean | null = null,
  observedPromptFloor: ObservedPromptFloor | null = null,
  readingSource?: ContextGaugeReadingSource,
): string | null {
  const pct = contextUsagePct(contextTokens, compactionLimit);
  if (pct == null || contextTokens == null || !compactionLimit) return null;
  let line = renderContextFact(contextTokens, compactionLimit, pct, observedPromptFloor, readingSource);
  if (pct >= COMPACTION_HINT_PCT) {
    const windDownLoopEnd =
      pct >= CONTEXT_GAUGE_CRITICAL_PCT &&
      selfCompactionAvailable === false &&
      fleetWindDownLoopEndAuthorized === true;
    line += windDownLoopEnd
      ? ' — near limit: FLUSH durable conclusions NOW; the typed fleet wind-down authorizes loop:end after the checkpoint. Preserve this session; do not call session:end or respawn.'
      : selfCompactionAvailable === false
        ? ' — near limit: FLUSH durable conclusions NOW; self-compaction is unavailable to this session (no supported live psu-pty host), so keep the loop armed and end at a clean stopping point for the next wake.'
        : ' — near limit: CALL session:request-compaction with a focus NOW at a clean stopping point; do not merely describe ending the turn.';
  }
  return line;
}

/* ── Banded ambient gauge (agent-managed-compaction D-009 / P-013 + P-015) ──────
 *
 * The SAME context percent, rendered as a BANDED line for the two ambient-awareness
 * surfaces that a heads-down session (one that never calls a coord tool, so never
 * sees {@link renderContextUsageLine}) still hits: every papercusp-su MCP tool RESULT
 * (P-013, the result-annotator seam) and the native-tool PostToolUse hook (P-015).
 * Bands (owner-proposed, D-009): SILENT below QUIET so the vast majority of low-% turns
 * append NOTHING (zero noise, zero cost); a QUIET bare fact 65–79%; a LOUD ⚠ action line
 * 80–89%; a CRITICAL ⚠ urgent line ≥90%. Thresholds are exported so the client hook +
 * statusline band on ONE definition. */
export const CONTEXT_GAUGE_QUIET_PCT = 65;
export const CONTEXT_GAUGE_LOUD_PCT = 80;
export const CONTEXT_GAUGE_CRITICAL_PCT = 90;

/** The gauge band for a rounded percent: null (silent) below {@link CONTEXT_GAUGE_QUIET_PCT}. */
export type ContextGaugeBand = 'quiet' | 'loud' | 'critical';
export function contextGaugeBand(pct: number | null | undefined): ContextGaugeBand | null {
  if (pct == null) return null;
  if (pct >= CONTEXT_GAUGE_CRITICAL_PCT) return 'critical';
  if (pct >= CONTEXT_GAUGE_LOUD_PCT) return 'loud';
  if (pct >= CONTEXT_GAUGE_QUIET_PCT) return 'quiet';
  return null;
}

/**
 * Render the banded ambient gauge, or null below the QUIET band (silent — the common
 * case, so most calls append nothing). QUIET is a bare fact; LOUD/CRITICAL also NAME the
 * action (session:request-compaction) so the line is an affordance, not just a number —
 * the same fact-vs-affordance split as {@link renderContextUsageLine}. Pure; null when
 * usage can't be computed (no limit / no estimate).
 */
export function renderBandedContextGauge(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
  selfCompactionAvailable: boolean | null = null,
  fleetWindDownLoopEndAuthorized: boolean | null = null,
  observedPromptFloor: ObservedPromptFloor | null = null,
  readingSource?: ContextGaugeReadingSource,
): string | null {
  const pct = contextUsagePct(contextTokens, compactionLimit);
  const band = contextGaugeBand(pct);
  if (band == null || pct == null || contextTokens == null || !compactionLimit) return null;
  const fact = renderContextFact(contextTokens, compactionLimit, pct, observedPromptFloor, readingSource);
  switch (band) {
    case 'quiet':
      return fact;
    case 'loud':
      return (
        `⚠ ${fact} — approaching your soft compaction limit; FLUSH durable conclusions NOW ` +
        `(facts:assert / work_items:checkpoint / loop:checkpoint), then reach a clean stopping ` +
        (selfCompactionAvailable === false &&
        pct != null &&
        pct >= CONTEXT_GAUGE_CRITICAL_PCT &&
        fleetWindDownLoopEndAuthorized === true
          ? `point and call loop:end under the typed fleet wind-down authorization; preserve the session and do not call session:end or respawn.`
          : selfCompactionAvailable === false
          ? `point soon; self-compaction is unavailable to this session (no supported live psu-pty host), so keep the loop armed and end for the next wake.`
          : `point soon and call session:request-compaction with a focus.`)
      );
    case 'critical':
      return (
        `⚠ ${fact} — CRITICAL: at your soft compaction limit. Flush checkpoints/facts if not yet done, ` +
        (selfCompactionAvailable === false && fleetWindDownLoopEndAuthorized === true
          ? `then call loop:end under the typed fleet wind-down authorization; preserve the session and do not call session:end or respawn.`
          : selfCompactionAvailable === false
          ? `then keep the loop armed and end at the nearest stopping point for the next wake; self-compaction is unavailable to this session (no supported live psu-pty host).`
          : `then call session:request-compaction with a focus NOW, at the nearest stopping ` +
            `point — do not merely narrate ending the turn.`)
      );
  }
}
