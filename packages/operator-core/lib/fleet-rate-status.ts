/**
 * Fleet rate-limit read-model (rate-limit-layer-v2) — the single shape the desktop top-bar
 * (`<FleetRateControl>`) AND the TUI overview AND the `operator:rate_limit_config` MCP tool all
 * read. Assembles, in one place:
 *   - config: the user's editable knobs (maxSimultaneousAgents, concurrencyFloor) — D-004
 *   - fleet: the live fleet-wide cap + total in-flight + effective concurrency — D-004 / D-005
 *     (`liveAgents` is the real fleet-wide agent count from coord_presence — EI-18106936190883400 —
 *     distinct from `inFlight`, which only counts rate-GOVERNED dispatches)
 *   - buckets: per (provider, modelClass) governor state (paused/until, rpm/itpm/otpm headroom)
 *   - usage: token throughput + usage% (where a provider limit is known) + recent $spend — D-002
 *
 * Degrades gracefully: usage% only appears for header-bearing paths (the subscription CLI exposes
 * no ceiling), so the surface shows real numbers where they exist and omits a fabricated percent.
 */
import { snapshotGovernors, globalConcurrencySnapshot, effectiveConcurrencySnapshot } from '@papercusp/papercusp-shared/agent';
import { getCachedRateLimitConfig, type RateLimitConfig } from './rate-limit-config';
import { summarizeUsage, type UsageSummary } from './agent-usage-telemetry';
import { loadAccountPool } from './deployment/account-pool-store';
import { summarizeOpusBudget, type OpusBudgetStatus } from './opus-budget-governor';
import { readOpusBudgetPolicy } from './opus-budget-policy';
import { listPresence, PRESENCE_STALE_MS } from './agent-tools/coordination/presence';
import { activeWorkspaceId } from './workspace-registry';

export interface FleetRateBucket {
  key: string;
  provider: string;
  modelClass: string;
  limitModel: 'subscription' | 'apiKey';
  paused: boolean;
  pausedUntil: string | null;
  msUntilReset: number;
  paceDelayMs: number;
  inFlight: number;
  maxConcurrent: number;
  window: {
    rpm: { used: number; limit: number | null };
    itpm: { used: number; limit: number | null };
    otpm: { used: number; limit: number | null };
  };
}

export interface FleetRateStatus {
  ok: true;
  now: string;
  config: RateLimitConfig;
  fleet: {
    /** The user's hard cap (maxSimultaneousAgents). */
    cap: number;
    /** Current total agents in flight across all RATE-GOVERNED buckets only — a
     *  su/fleet CLI agent that never went through a governed dispatch (the
     *  overwhelming majority of this fleet) is invisible here. See `liveAgents`
     *  for the real fleet-wide count. */
    inFlight: number;
    /** AIMD effective concurrency under the cap (D-005); equals cap until AIMD adapts down. */
    effective: number;
    /** Floor the effective concurrency never drops below (D-005). */
    floor: number;
    /** Real fleet-wide live-agent count (EI-18106936190883400) — every non-stale
     *  coord_presence row for the active workspace, NOT just rate-governed
     *  dispatches. This is what "how many agents are actually running" should
     *  read; `inFlight` stays governor-scoped for saturation math. */
    liveAgents: number;
  };
  buckets: FleetRateBucket[];
  usage: UsageSummary;
  /** Fleet opus-budget pacing state (B-GW-4): aggregate 5h opus pressure + which criticality classes
   *  are shedding their opus → sonnet to stay under the ceiling. `null` if the pool is unreadable. */
  opusBudget: OpusBudgetStatus | null;
}

/** Assemble the live read-model. `windowMs` bounds the usage/$spend lookback (default 1h). */
export async function buildFleetRateStatus(windowMs = 60 * 60 * 1000): Promise<FleetRateStatus> {
  const now = Date.now();
  const cfg = getCachedRateLimitConfig();
  const global = globalConcurrencySnapshot();
  const eff = effectiveConcurrencySnapshot();
  const buckets: FleetRateBucket[] = snapshotGovernors().map((b) => {
    const s = b.state;
    const windowActive = now - s.windowStart < 60_000;
    return {
      key: b.key,
      provider: b.provider,
      modelClass: b.modelClass,
      limitModel: b.limitModel,
      paused: s.pausedUntil > now,
      pausedUntil: s.pausedUntil > now ? new Date(s.pausedUntil).toISOString() : null,
      msUntilReset: s.pausedUntil > now ? s.pausedUntil - now : 0,
      paceDelayMs: s.paceDelayMs,
      inFlight: s.inFlight,
      maxConcurrent: s.limits.maxConcurrent,
      window: {
        rpm: { used: windowActive ? s.reqInWindow : 0, limit: s.limits.rpm ?? null },
        itpm: { used: windowActive ? s.inTokInWindow : 0, limit: s.limits.itpm ?? null },
        otpm: { used: windowActive ? s.outTokInWindow : 0, limit: s.limits.otpm ?? null },
      },
    };
  });
  const usage = await summarizeUsage(windowMs).catch(() => emptyUsage());
  // Fleet opus-budget pacing state (B-GW-4) — best-effort: an unreadable pool surfaces null, never throws.
  const opusBudget = await loadAccountPool()
    .then(async (pool) => summarizeOpusBudget(pool, now, await readOpusBudgetPolicy()))
    .catch(() => null);
  // EI-18106936190883400: the real fleet-wide agent count — a cheap first-pass over
  // presence rows (mirrors assemblePresenceSnapshot's own cheap split), never the
  // expensive full roster/wakeability-join assembly. Best-effort: a presence-store
  // read failure must not break the whole status assembly.
  const liveAgents = await listPresence({ workspaceId: activeWorkspaceId() })
    .then((rows) => rows.filter((r) => now - new Date(r.heartbeatAt).getTime() < PRESENCE_STALE_MS).length)
    .catch(() => 0);
  return {
    ok: true,
    now: new Date(now).toISOString(),
    config: cfg,
    fleet: {
      cap: Number.isFinite(global.cap) ? global.cap : cfg.maxSimultaneousAgents,
      inFlight: global.inFlight,
      effective: eff.effective ?? (Number.isFinite(global.cap) ? global.cap : cfg.maxSimultaneousAgents),
      floor: cfg.concurrencyFloor,
      liveAgents,
    },
    buckets,
    usage,
    opusBudget,
  };
}

function emptyUsage(): UsageSummary {
  return { windowMs: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, spendUsd: 0, buckets: [] };
}
