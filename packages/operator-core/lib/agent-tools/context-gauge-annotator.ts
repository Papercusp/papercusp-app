/**
 * context-gauge-annotator — the PURE result annotator for Papercusp's banded
 * context-usage gauge (agent-managed-compaction-2026-07-01 P-013 / D-009 L1).
 *
 * Split out of the registration side-effect (context-gauge-wiring.ts) so the annotator
 * logic is unit-testable WITHOUT pulling in the `@papercusp/agent-mcp` bootstrap graph —
 * the same pure/presentation split as inbox-context-usage.ts. It imports the
 * `ResultAnnotator` type only (`import type`, fully erased), so at runtime it depends on
 * just identity + the in-process cache + the renderer.
 *
 * Behaviour: resolve the caller's coord identity → read its usage from the cache the
 * compaction watchdog populates (ZERO per-call DB) → render the banded line → append it
 * to the envelope (a text block + `_meta._contextGauge`). Self-gates to nothing for an
 * unattributable ctx, an untracked owner, a below-quiet-band percent, a disabled flag, or
 * a result that already carries a `context:` line (coord:inbox — never double-render).
 */

import type { ResultAnnotator } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type ResolveIdentityCtx } from './coordination/identity';
import {
  CONTEXT_GAUGE_LOUD_PCT,
  contextUsagePct,
} from './coordination/tools/inbox-context-usage';
import {
  buildTranscriptEstimateGaugeEvidence,
  renderBandedContextGaugeWithEvidence,
} from './context-gauge-evidence';
import {
  getContextUsage,
  getContextUsageRecordedAt,
  isContextGaugeEnabled,
} from '../system-health/context-usage-cache';
import { currentContextTokensSyncForOwner } from '../compaction-usage';
import { selfCompactionAvailability } from '../events/await/psu-pty-discovery';

/** The tool-result shape, derived from the annotator signature (no extra import). */
type AnnotatedResult = Parameters<ResultAnnotator>[0];

/** A rendered `context: N/L (X%)` usage line already present in the result (coord:inbox). */
const CONTEXT_LINE_RE = /context: \d+\/\d+ \(\d+%\)/;

function resultCarriesContextLine(result: AnnotatedResult): boolean {
  return (
    result.content?.some((c) => c.type === 'text' && CONTEXT_LINE_RE.test(c.text)) ?? false
  );
}

export const contextGaugeAnnotator: ResultAnnotator = (result, ctx) => {
  if (!isContextGaugeEnabled()) return result;
  let ownerId: string;
  try {
    ownerId = resolveAgentIdentity(ctx as unknown as ResolveIdentityCtx).ownerId;
  } catch {
    return result; // unattributable ctx (system / in-process call) — no gauge
  }
  const usage = getContextUsage(ownerId);
  if (!usage) return result; // owner not tracked (no limit known) — no gauge
  // WI-4154: tokens come from the transcript's CURRENT state (anchored sync read;
  // cost = the append delta), never from the watchdog's point-in-time cache, which
  // went stale across every compaction boundary. The cache entry supplies only the
  // LIMIT. A read that can't complete synchronously (first sight of this owner in
  // this process / oversized delta) kicks a background seed and renders NOTHING
  // this call — never a possibly-stale number; the next call reads the anchor.
  const tokens = currentContextTokensSyncForOwner(ownerId);
  if (tokens == null) return result;
  const pct = contextUsagePct(tokens, usage.limit);
  const selfCompactionAvailable =
    pct != null && pct >= CONTEXT_GAUGE_LOUD_PCT ? selfCompactionAvailability(ownerId).available : null;
  // EI-23761864550626068: the numerator above is `anchorTokens` = transcript bytes/4, a
  // heuristic — never provider-measured usage — so this gauge carries an explicit
  // count-evidence contract (`_meta._contextGaugeEvidence`) and, on the loud/critical bands
  // that demand an irreversible respawn, an inline estimate qualifier.
  const evidence = buildTranscriptEstimateGaugeEvidence({
    limit: usage.limit,
    limitRecordedAt: getContextUsageRecordedAt(ownerId),
    observedPromptFloor: usage.observedPromptFloor ?? null,
  });
  const line = renderBandedContextGaugeWithEvidence(
    tokens,
    usage.limit,
    selfCompactionAvailable,
    null,
    usage.observedPromptFloor ?? null,
    evidence,
  );
  if (!line) return result; // below the quiet band — silent
  if (resultCarriesContextLine(result)) return result; // don't double-render (coord:inbox)
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), _contextGauge: line, _contextGaugeEvidence: evidence },
    content: [...result.content, { type: 'text' as const, text: line }],
  };
};
