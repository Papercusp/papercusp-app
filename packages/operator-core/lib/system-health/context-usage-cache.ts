/**
 * context-usage-cache — a volatile, in-process cache of each live session's context
 * usage, so the ambient gauges (agent-managed-compaction D-009) read it with ZERO
 * per-call DB cost.
 *
 * SINGLE WRITER: the compaction-compliance-watchdog, which already estimates every
 * limit-carrying session's context size on its 2-min sweep and caches it on
 * coord_presence.context_tokens (PG-canonical). On the SAME pass it mirrors that
 * (owner → tokens/limit) here, in-process. READERS: the P-013 result-annotator (a
 * banded gauge on every papercusp-su MCP tool result) and the P-015 hook-side gauge.
 *
 * NOT durable state — coord_presence is canonical (storage-policy: PG-by-default). This
 * is purely a hot-path read cache of a slowly-moving value (refreshed every 2 min), the
 * same in-process-Map class as the watchdog's own overLimitOwners / forceCompactedOwners
 * dedup sets. Entries STALE OUT ({@link CONTEXT_USAGE_STALE_MS}) so a session the watchdog
 * stopped tracking (ended / limit cleared) can't leave a phantom gauge on the wire.
 */

/** Beyond this age an entry is treated as absent — a few missed watchdog passes (2-min
 *  cadence) tolerated, but a long-gone session never keeps rendering a stale gauge. */
export const CONTEXT_USAGE_STALE_MS = 6 * 60_000;

interface Entry {
  tokens: number;
  limit: number;
  observedPromptFloor?: { tokens: number; observations: number };
  at: number;
}

const cache = new Map<string, Entry>();

/** Watchdog write: mirror one owner's freshly-estimated usage. `now` is injectable for tests. */
export function recordContextUsage(
  ownerId: string,
  tokens: number,
  limit: number,
  now: number = Date.now(),
  observedPromptFloor?: { tokens: number; observations: number } | null,
): void {
  if (!ownerId || !Number.isFinite(tokens) || !Number.isFinite(limit) || limit <= 0) return;
  const measured =
    observedPromptFloor &&
    Number.isFinite(observedPromptFloor.tokens) &&
    observedPromptFloor.tokens >= 0 &&
    Number.isInteger(observedPromptFloor.observations) &&
    observedPromptFloor.observations > 0
      ? {
          tokens: Math.floor(observedPromptFloor.tokens),
          observations: observedPromptFloor.observations,
        }
      : undefined;
  cache.set(ownerId, { tokens, limit, ...(measured ? { observedPromptFloor: measured } : {}), at: now });
}

/** Respawn invalidation: a carry-respawn/recycle keeps the coord ownerId but
 *  replaces the transcript, so the cached estimate describes the DEAD
 *  predecessor — a fresh successor would render its ~near-limit gauge and could
 *  be nudged into an immediate pointless re-cut. Clearing beats a stale serve:
 *  the gauge renders nothing until the next watchdog pass measures the real
 *  (tiny) successor transcript. */
/**
 * EI-23761864550626068: when the watchdog last wrote this owner's (tokens, limit) pair —
 * the denominator's calibration time. Kept as a SEPARATE accessor (not a new field on
 * `getContextUsage`'s result) so existing exact-shape assertions on that result are
 * undisturbed. Honors the same staleness rule: an expired entry reads null.
 */
export function getContextUsageRecordedAt(
  ownerId: string,
  now: number = Date.now(),
): number | null {
  const e = cache.get(ownerId);
  if (!e || now - e.at > CONTEXT_USAGE_STALE_MS) return null;
  return e.at;
}

export function clearContextUsage(ownerId: string): void {
  cache.delete(ownerId);
}

/** Reader: the owner's cached usage, or null when absent / staler than the TTL. */
export function getContextUsage(
  ownerId: string,
  now: number = Date.now(),
): {
  tokens: number;
  limit: number;
  observedPromptFloor?: { tokens: number; observations: number };
} | null {
  const e = cache.get(ownerId);
  if (!e) return null;
  if (now - e.at > CONTEXT_USAGE_STALE_MS) {
    cache.delete(ownerId);
    return null;
  }
  return {
    tokens: e.tokens,
    limit: e.limit,
    ...(e.observedPromptFloor ? { observedPromptFloor: { ...e.observedPromptFloor } } : {}),
  };
}

/* ── P-013 flag mirror ──────────────────────────────────────────────────────
 * The result-annotator (P-013) is on a SYNC dispatch hot path but FLAGS.CONTEXT_GAUGE
 * is an async read. So the compaction watchdog (already async, 2-min cadence) reads the
 * flag each pass and mirrors it here; the annotator reads the mirror synchronously. A
 * flip therefore takes effect within one sweep (~2 min), with zero per-call flag cost and
 * no new timer. Starts ENABLED so the default-ON gauge works from process start, before
 * the first watchdog pass. */
let gaugeEnabled = true;

/** Watchdog write: mirror the current FLAGS.CONTEXT_GAUGE value. */
export function setContextGaugeEnabled(enabled: boolean): void {
  gaugeEnabled = enabled;
}

/** Annotator read: is the banded gauge currently enabled? */
export function isContextGaugeEnabled(): boolean {
  return gaugeEnabled;
}

/** Test seam. */
export function resetContextUsageCacheForTests(): void {
  cache.clear();
  gaugeEnabled = true;
}
