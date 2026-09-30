/**
 * Hive-evaluation EFFICIENCY metrics (HE-05, P-031) — "did the Hive do it EFFICIENTLY?".
 *
 * The crux (D-003): EVERY efficiency metric is PAIRED with its failure-mode counterpart, because
 * a metric in isolation games — low-communication is achieved by bees that don't coordinate and
 * collide; high-parallelism by spawning useless bees; cheap by doing less. So each "win" is only
 * meaningful alongside its pair staying low: low-communication ↔ low collisions/rework;
 * high-parallelism ↔ low useless-bee rate. The {@link EfficiencyMetrics.pairings} field makes the
 * couplings explicit so HE-06 credits an efficiency win ONLY when its paired failure stays low.
 *
 * Pure — over an injected {@link RunBehavior} the live run's collectRunData extracts from the EKG
 * (`coordShare`/`locksShare` per session), `computeHiveThroughput` (utilization/completed),
 * `coord_event_log` (comms volume), `claim_audit` (collisions), and the gym cost instrumentation
 * (owner-gated, P-051). HE-06 composes these UNDER the outcome gate (D-002).
 */

/** The raw behavioral substrate of one run (extracted by collectRunData). */
export interface RunBehavior {
  /** Sampled bees-busy counts across the run (parallelism-utilization numerator). */
  beesBusySamples: number[];
  /** The run's bee cap (the utilization denominator). */
  beeCap: number;
  /** ms during which work was READY (deps satisfied) but bees sat idle — idle-while-ready. */
  idleWhileReadyMs: number;
  /** Coordination messages emitted during the run (communication volume). */
  coordMessages: number;
  /** Items the Hive actually completed — the per-item denominator. */
  completedItems: number;
  /** Bees spawned over the run. */
  beesSpawned: number;
  /** Bees that produced NO completed work — the useless-bee pair for parallelism. */
  uselessBees: number;
  /** Claim conflicts / collisions — the failure pair for low communication. */
  collisions: number;
  /** Validator bounces + re-placements + abandoned claims — rework/thrash. */
  rework: number;
  /** Lock-wait time (the EKG `locks` contention category), ms. */
  lockContentionMs: number;
  /** Total tokens spent on the run. */
  totalTokens: number;
  /** Real USD spent on the run. */
  costUsd: number;
  // ── Per-wake Queen cache efficiency (queen-brief-cache P-011 / D-014) ──
  // The frozen-prefix cache (Win-1). Raw token totals across the run's Queen wakes, from
  // mugWakeEfficiency() (pot/mug-wake-efficiency.ts) over agent_usage_samples role='mug'.
  /** Tokens served from the prompt cache across the run's Queen wakes. */
  queenCacheReadTokens: number;
  /** Tokens written INTO the cache (the frozen-prefix creation cost). */
  queenCacheCreationTokens: number;
  /** Uncached prompt input tokens across the Queen wakes. */
  queenInputTokens: number;
  /** Number of Queen wakes (runs) in the window. */
  queenWakes: number;
  /** Sum of the Queen's assistant turns across wakes that reported a turn count (Win-2 round-trips —
   *  the precomputed brief, B-03, should cut the deterministic survey round-trips per wake). */
  queenTurns: number;
  /** Wakes that REPORTED a turn count (the avg-turns denominator). The subprocess wake path captures
   *  claude `num_turns`; an in-process stateless call reports none — so this can be < queenWakes. */
  queenWakesWithTurns: number;
  // ── Per-bee warm-inject carry efficiency (bee-context-efficiency P-015 / D-006) ──
  // The bee analog of the Queen per-wake metrics. A long-lived bee processes MANY warm-injected
  // tasks on ONE resumed claude session (`claude --resume`), re-reading its grown transcript every
  // turn — so cache_read on a non-first wake ≈ the dead prior-task context carried into this task.
  // Raw token totals across the run's bee wakes, from beeWakeEfficiency() (hive/bee-wake-efficiency.ts)
  // over agent_usage_samples role='bee', grouped by session_id (migration 279).
  /** Σ cache_read on the NON-FIRST wakes of each bee session — the resumed-transcript carry (the
   *  waste the fresh-context warm-inject fork drops; D-011 measured ~97% of a long bee's prompt). */
  beeCarriedReadTokens: number;
  /** Σ cache_read across all bee wakes (part of the carry-share denominator). */
  beeCacheReadTokens: number;
  /** Σ cache_creation across all bee wakes. */
  beeCacheCreationTokens: number;
  /** Σ uncached input across all bee wakes. */
  beeInputTokens: number;
  /** Warm-injects = non-first bee wakes (totalWakes − sessions). 0 ⇒ no bee ever warm-injected, so
   *  the carry sub-score is SKIPPED (the queenWakes>0 gate analog — a run with no warm-inject carry
   *  is not scored on a 0 it never earned). */
  beeWarmInjects: number;
}

/** One D-003 pairing: an efficiency metric and the failure-mode that must stay low to credit it. */
export interface MetricPairing {
  metric: number;
  pairedFailure: number;
  pairName: string;
}

export interface EfficiencyMetrics {
  /** Mean bees-busy ÷ cap over the run (high = good parallelism). */
  parallelismUtilization: number;
  idleWhileReadyMs: number;
  /** coordMessages ÷ completedItems (low = good — but ONLY if collisions stay low, D-003). */
  communicationOverhead: number;
  /** collisions ÷ completedItems — the failure pair for low communication. */
  collisionRate: number;
  /** uselessBees ÷ beesSpawned — the failure pair for high parallelism. */
  uselessBeeRate: number;
  /** rework ÷ completedItems (validator bounces, re-placements, abandoned claims). */
  reworkRate: number;
  /** Lock-wait time (ms). */
  lockContentionMs: number;
  /** USD per completed item. */
  costPerItemUsd: number;
  /** Tokens per completed item. */
  tokensPerItem: number;
  /** Share of Queen prompt tokens served from cache (Win-1): cacheRead ÷ (cacheRead +
   *  cacheCreation + input). Higher = the frozen-prefix cache is paying off — but ONLY good
   *  if reworkRate stays low (a high ratio from reusing STALE state is the gaming mode, D-003). */
  cacheHitRatio: number;
  /** Total Queen prompt tokens ÷ wakes — per-wake prompt cost. */
  tokensPerWake: number;
  /** Mean assistant turns per Queen wake (Win-2: the precomputed brief should pull this DOWN over
   *  time — fewer deterministic survey round-trips). LOWER is better. null when no wake reported a
   *  turn count — the round-trip sub-score is then SKIPPED, not scored 0. ONLY good if reworkRate
   *  stays low (fewer turns by SKIPPING work, not by being briefed, surfaces as rework, D-003). */
  avgQueenTurns: number | null;
  /** Queen wakes observed in the window. 0 ⇒ no queen-efficiency data, so the queen sub-scores are
   *  SKIPPED (a run with no Queen samples is not penalized for a 0 cache ratio it never earned). */
  queenWakes: number;
  /** Share of bee PROMPT tokens that are resumed-transcript carry — the bee analog of the Queen
   *  cache metric, but INVERTED: beeCarriedRead ÷ (beeCacheRead + beeCacheCreation + beeInput).
   *  LOWER is better — the carry is dead prior-task transcript re-read every turn (D-011); the
   *  Phase-1 fresh-context warm-inject fork drops it, so the before/after win is VISIBLE here rather
   *  than asserted (D-006). 0 when no bee prompt tokens were seen. ONLY good if reworkRate stays low
   *  (a low carry bought by dropping LIVE working state mid-task surfaces as rework/redo, D-003). */
  beeCarryShare: number;
  /** Mean carried-read tokens per warm-inject — observability (the bee analog of tokensPerWake).
   *  null when no warm-inject occurred. */
  beeAvgCarriedPerWarmInject: number | null;
  /** Bee warm-injects observed (non-first wakes). 0 ⇒ the bee carry sub-score is SKIPPED (the
   *  queenWakes gate analog — a run with no warm-inject carry is not penalized for a 0 it never earned). */
  beeWarmInjects: number;
  /** The D-003 couplings made explicit — HE-06 credits each win only if its pair stays low. */
  pairings: {
    lowCommunication: MetricPairing;
    highParallelism: MetricPairing;
    cacheEfficiency: MetricPairing;
    /** Win-2 round-trips: low turns/wake is only credited if rework stays low (same staleness
     *  failure mode as cacheEfficiency). `metric` is 0 when no wake reported a turn count. */
    roundTrip: MetricPairing;
    /** Bee warm-inject carry: a low carry share is only credited if rework stays low — a carry drop
     *  bought by dropping live working state mid-task surfaces as redo/bounces (same staleness
     *  failure mode as the queen wins). `metric` is the carry share. */
    beeCarry: MetricPairing;
  };
}

/** Compute the efficiency metrics for one run. Pure + deterministic. */
export function computeEfficiencyMetrics(b: RunBehavior): EfficiencyMetrics {
  const parallelismUtilization =
    b.beeCap > 0 && b.beesBusySamples.length > 0
      ? b.beesBusySamples.reduce((a, c) => a + c, 0) / b.beesBusySamples.length / b.beeCap
      : 0;
  // A run that completed NOTHING still gets finite per-item ratios (its outcome gate fails anyway,
  // so HE-06 zeroes its efficiency credit) — guard the divide so the metric is never NaN/Infinity.
  const denom = b.completedItems > 0 ? b.completedItems : 1;
  const communicationOverhead = b.coordMessages / denom;
  const collisionRate = b.collisions / denom;
  const uselessBeeRate = b.beesSpawned > 0 ? b.uselessBees / b.beesSpawned : 0;
  const reworkRate = b.rework / denom;
  // Queen cache efficiency (P-011). Prompt-token share served from the frozen-prefix cache.
  const queenPromptTokens = b.queenCacheReadTokens + b.queenCacheCreationTokens + b.queenInputTokens;
  const cacheHitRatio = queenPromptTokens > 0 ? b.queenCacheReadTokens / queenPromptTokens : 0;
  const tokensPerWake = b.queenWakes > 0 ? queenPromptTokens / b.queenWakes : 0;
  // Queen round-trip efficiency (P-010 Win-2). Mean turns over wakes that REPORTED a turn count;
  // null (not 0) when none did, so a window with no turn data is scored as "no signal", not "ideal".
  const avgQueenTurns = b.queenWakesWithTurns > 0 ? b.queenTurns / b.queenWakesWithTurns : null;
  // Bee warm-inject carry efficiency (P-015). Share of bee prompt tokens that are resumed-transcript
  // carry (LOWER = fresher). Reproduces beeWakeEfficiency.carryShareOfPrompt over the run's bee wakes.
  const beePromptTokens = b.beeCacheReadTokens + b.beeCacheCreationTokens + b.beeInputTokens;
  const beeCarryShare = beePromptTokens > 0 ? b.beeCarriedReadTokens / beePromptTokens : 0;
  const beeAvgCarriedPerWarmInject = b.beeWarmInjects > 0 ? b.beeCarriedReadTokens / b.beeWarmInjects : null;
  return {
    parallelismUtilization,
    idleWhileReadyMs: b.idleWhileReadyMs,
    communicationOverhead,
    collisionRate,
    uselessBeeRate,
    reworkRate,
    lockContentionMs: b.lockContentionMs,
    costPerItemUsd: b.costUsd / denom,
    tokensPerItem: b.totalTokens / denom,
    cacheHitRatio,
    tokensPerWake,
    avgQueenTurns,
    queenWakes: b.queenWakes,
    beeCarryShare,
    beeAvgCarriedPerWarmInject,
    beeWarmInjects: b.beeWarmInjects,
    pairings: {
      lowCommunication: { metric: communicationOverhead, pairedFailure: collisionRate, pairName: 'collisionRate' },
      highParallelism: { metric: parallelismUtilization, pairedFailure: uselessBeeRate, pairName: 'uselessBeeRate' },
      // High cache reuse is only credited if rework stays low — a high ratio achieved by reusing
      // STALE state (not re-deriving current frontier) surfaces as re-placements/bounces (D-003).
      cacheEfficiency: { metric: cacheHitRatio, pairedFailure: reworkRate, pairName: 'reworkRate' },
      // Same staleness failure mode for the round-trip win: fewer turns by SKIPPING work, not by
      // being briefed, shows up as rework. `metric` 0 when no wake reported a turn count.
      roundTrip: { metric: avgQueenTurns ?? 0, pairedFailure: reworkRate, pairName: 'reworkRate' },
      // Low bee carry is only credited if rework stays low — a carry drop bought by dropping live
      // working state mid-task (not preserving it across a clean re-spawn) surfaces as redo (D-003).
      beeCarry: { metric: beeCarryShare, pairedFailure: reworkRate, pairName: 'reworkRate' },
    },
  };
}
