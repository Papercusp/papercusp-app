/**
 * throughput.ts — pot THROUGHPUT instrumentation
 * (queen-autonomous-execution-2026-06-13, B-11 / P-050).
 *
 * The Mug pot loop places ranked work onto cups; this module measures how
 * WELL it runs and records a durable per-tick snapshot in
 * `harness_shared.pot_throughput_ticks` (migration 261), surfaced on the
 * Learning tab's "Throughput" sub-view (resolver `learning.potThroughput`).
 *
 * Two layers, mirroring the scout tick-ledger split:
 *   - **pure math** (`computePotThroughput`, `detectThroughputBreaches`) — the
 *     metric derivation + the FB-21 audit-as-sensors breach predicate, both
 *     deterministic over a plain snapshot, unit-tested with zero PG. THESE are
 *     also the deterministic half of the B-11/P-051 loop-contract invariants.
 *   - **the production edge** (`recordPotThroughputTick`, `readPotThroughputTicks`)
 *     — the thin PG seam. Best-effort by contract: a tick must never break the
 *     30s routinesTick it rides (observability never fails the loop it watches).
 *
 * The six throughput signals (B-11): frontier depth, placements/wake,
 * cups-busy-vs-cap, stuck count, mean-time-to-complete, and the question-rung
 * distribution (how many cup questions self-resolved vs reached the owner). The
 * last is the surface for a signal the question-ladder (B-10/B-17) feeds later —
 * an empty map today, present so the chart lights up the moment rungs flow.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { trackDetached } from '../detached-imports';

// ── tunables ─────────────────────────────────────────────────────────────────

/** A running cup is "stuck" once its heartbeat is older than this (mirrors the
 *  nursery alias-liveness 10-min window, mig 225). Env-overridable. */
export function stuckThresholdMs(): number {
  const n = Number(process.env.PAPERCUSP_POT_STUCK_SEC ?? process.env.PAPERCUSP_POT_STUCK_SEC ?? 600);
  return (Number.isFinite(n) && n >= 60 ? n : 600) * 1_000;
}

/** How far back the tick reads spawn rows to compute MTTC / placements (the
 *  per-tick window is then carved from this by `lastTickAtMs`). Default 6h. */
export function throughputReadWindowMs(): number {
  const n = Number(process.env.PAPERCUSP_POT_THROUGHPUT_WINDOW_SEC ?? process.env.PAPERCUSP_POT_THROUGHPUT_WINDOW_SEC ?? 21_600);
  return (Number.isFinite(n) && n >= 300 ? n : 21_600) * 1_000;
}

// ── pure inputs / outputs ────────────────────────────────────────────────────

/** One cup spawn row, reduced to the fields the metrics need (epoch-ms). */
export interface PotSpawnSnapshot {
  /** running | done | failed | cancelled | reaped (spawned_agents.status). */
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  /** spawned_agents.duration_ms when recorded; else derive from started/finished. */
  durationMs: number | null;
  /** spawned_agents.heartbeat_at (mig 174); null when never stamped. */
  heartbeatAtMs: number | null;
}

/** The cheap snapshot the metrics derive from — all reads the tick already does. */
export interface PotThroughputInput {
  nowMs: number;
  /** Ready work waiting for placement (todo feature-family items) — queue depth. */
  frontierDepth: number;
  /** Fleet ceiling (maxSimultaneousAgents / SAFETY_CEILING). */
  ceiling: number;
  /** Live running cup spawns right now. */
  running: number;
  /** Recent cup spawn rows within the read window. */
  spawns: PotSpawnSnapshot[];
  /** Previous tick's timestamp, for placements-since / completed-since. null on first tick. */
  lastTickAtMs: number | null;
  /** A running cup is stuck when its heartbeat is older than this. */
  stuckThresholdMs: number;
  /** Question-rung counts {rung -> count}; empty until the ladder feeds it. */
  questionRungs?: Record<string, number>;
}

/** The derived per-tick throughput metrics (the row, UI-shaped). */
export interface PotThroughputMetrics {
  frontierDepth: number;
  cupsBusy: number;
  cupsCap: number;
  /** running / ceiling, clamped 0..1; 0 when ceiling is 0. */
  utilization: number;
  /** Cups newly placed since the previous tick (placements-per-wake proxy). */
  placements: number;
  /** Cups that finished (status='done') in the window. */
  completed: number;
  /** Mean duration (ms) over cups that finished in the window; null when none. */
  mttcMs: number | null;
  /** Running cups whose heartbeat is older than the stuck threshold. */
  stuckCount: number;
  /** {rung -> count}: cup questions resolved at each rung (empty until B-10/B-17). */
  questionRungs: Record<string, number>;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1 ? 1 : n;
}

/** Coerce a jsonb column to a plain object — tolerant of a client that hands
 *  jsonb back as a string (parse) or a legacy double-encoded scalar. */
function asJsonObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Is a spawn "in this tick's window" (started/finished after the previous tick)?
 *  On the first tick (lastTickAtMs null) the whole read window counts. */
function inWindow(at: number | null, lastTickAtMs: number | null): boolean {
  if (lastTickAtMs == null) return true;
  return at != null && at > lastTickAtMs;
}

/**
 * Derive the throughput metrics from a snapshot — PURE and deterministic (the
 * B-11/P-051 instrumentation contract). No PG, no clock; everything comes from
 * `input`. Robust to the messy real shapes: missing duration falls back to
 * finished−started, missing heartbeat falls back to started_at for staleness.
 */
export function computePotThroughput(input: PotThroughputInput): PotThroughputMetrics {
  const cupsBusy = Math.max(0, Math.trunc(input.running));
  const cupsCap = Math.max(0, Math.trunc(input.ceiling));
  const utilization = cupsCap > 0 ? clamp01(cupsBusy / cupsCap) : 0;

  const placements = input.spawns.filter((s) => inWindow(s.startedAtMs, input.lastTickAtMs)).length;

  const completedSpawns = input.spawns.filter(
    (s) => s.status === 'done' && inWindow(s.finishedAtMs ?? s.startedAtMs, input.lastTickAtMs),
  );
  const durations = completedSpawns
    .map((s) => (s.durationMs != null ? s.durationMs : s.finishedAtMs != null ? s.finishedAtMs - s.startedAtMs : null))
    .filter((d): d is number => d != null && Number.isFinite(d) && d >= 0);
  const mttcMs = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  const stuckCount = input.spawns.filter((s) => {
    if (s.status !== 'running') return false;
    const ref = s.heartbeatAtMs ?? s.startedAtMs;
    return input.nowMs - ref > input.stuckThresholdMs;
  }).length;

  return {
    frontierDepth: Math.max(0, Math.trunc(input.frontierDepth)),
    cupsBusy,
    cupsCap,
    utilization,
    placements,
    completed: completedSpawns.length,
    mttcMs,
    stuckCount,
    questionRungs: input.questionRungs ?? {},
  };
}

// ── FB-21 audit-as-sensors: a breach files through capture ───────────────────

/** A throughput breach worth escalating — filed as an improvement (FB-21). */
export interface PotThroughputBreach {
  kind: 'starvation' | 'stuck';
  title: string;
  body: string;
  severity: 'warn' | 'error';
  /** Stable cross-tick identity so a persistent breach files once, not per tick. */
  watchdogKey: string;
}

export interface PotThroughputBreachContext {
  /** Owner steering maxCups knob for this pot. Null/undefined means no owner cap. */
  ownerMaxCups?: number | null;
  /** System-level spawn cap before owner maxCups lowers it. */
  systemCeiling?: number | null;
}

function positiveInt(n: number | null | undefined): number | null {
  return Number.isFinite(n) && n != null && n > 0 ? Math.trunc(n) : null;
}

function saturatedOnlyByOwnerCeiling(
  metrics: PotThroughputMetrics,
  context: PotThroughputBreachContext | undefined,
): boolean {
  const ownerMaxCups = positiveInt(context?.ownerMaxCups);
  const systemCeiling = positiveInt(context?.systemCeiling);
  return (
    ownerMaxCups != null &&
    systemCeiling != null &&
    ownerMaxCups < systemCeiling &&
    metrics.cupsCap === ownerMaxCups &&
    metrics.cupsBusy >= ownerMaxCups
  );
}

/**
 * The sensor predicate (FB-21): which metrics constitute a breach to escalate.
 * PURE — the orchestrator files whatever this returns. Two breaches, each with
 * its own stable key (cross-tick dedup keeps a standing breach from flooding):
 *   - **starvation**: the fleet is pegged at cap (utilization=1) with ready work
 *     still queued — adding cups is impossible, the backlog can only grow.
 *   - **stuck**: one or more placed cups have a stale heartbeat — placements that
 *     stopped advancing, which the Mug's next idle wake would otherwise miss.
 */
export function detectThroughputBreaches(
  metrics: PotThroughputMetrics,
  potSlug: string,
  context?: PotThroughputBreachContext,
): PotThroughputBreach[] {
  const breaches: PotThroughputBreach[] = [];
  if (
    metrics.cupsCap > 0 &&
    metrics.utilization >= 1 &&
    metrics.frontierDepth > 0 &&
    !saturatedOnlyByOwnerCeiling(metrics, context)
  ) {
    breaches.push({
      kind: 'starvation',
      severity: 'warn',
      watchdogKey: `governor-starvation:${potSlug}`,
      title: `Pot ${potSlug}: fleet saturated with work still queued`,
      body:
        `All ${metrics.cupsCap} cup slot(s) are busy while ${metrics.frontierDepth} ready ` +
        `item(s) wait for placement. The frontier can only grow until a cup frees a slot — ` +
        `raise the fleet ceiling (rate-limit config) or widen the credential pool (D-006).`,
    });
  }
  if (metrics.stuckCount > 0) {
    breaches.push({
      kind: 'stuck',
      severity: 'error',
      watchdogKey: `orphaned-spawn:${potSlug}:throughput`,
      title: `Pot ${potSlug}: ${metrics.stuckCount} placed cup(s) stuck`,
      body:
        `${metrics.stuckCount} running cup(s) have a stale heartbeat (no progress past the ` +
        `stuck threshold). A stalled placement holds its slot without advancing — it needs a ` +
        `recovery wake or reclaim (the placement watchdog, P-020).`,
    });
  }
  return breaches;
}

// ── the "operating well" yardstick (P-050/P-051) ─────────────────────────────

/**
 * The placement yardstick: how many cups an ideal Mug wake SHOULD place given
 * the ready frontier (N) and free slots (M) — `min(N, M)`. Pure and total. This
 * is the TARGET the behavioral contract (B-07 batch placement) is measured
 * against; today the prompt-driven Mug is scored against it, and the B-11/
 * P-051 contract test asserts a real wake achieves it once B-07 lands.
 */
export function idealPlacements(frontierDepth: number, headroom: number): number {
  return Math.max(0, Math.min(Math.trunc(frontierDepth), Math.trunc(headroom)));
}

/**
 * Is the loop "operating well" this tick? A pure yardstick over the metrics:
 * no stuck placements, and not starved (the fleet has slack OR the frontier is
 * empty). The single boolean the Throughput view's health tone keys off.
 */
export function isOperatingWell(m: PotThroughputMetrics): boolean {
  const starved = m.cupsCap > 0 && m.utilization >= 1 && m.frontierDepth > 0;
  return m.stuckCount === 0 && !starved;
}

// ── the production edge (best-effort PG seam) ────────────────────────────────

/** What the tick wrote (returned for tests / callers; not persisted as-is). */
export interface PotThroughputTickResult {
  recorded: boolean;
  metrics: PotThroughputMetrics;
  breaches: PotThroughputBreach[];
}

interface SpawnRow {
  status: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  duration_ms: string | number | null;
  heartbeat_at: string | Date | null;
}

function ms(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** EI-13076: the spawns read used to be `.catch(() => [])` — a silently-failing
 *  query (drizzle's transparent date serializer broke the Date param) fed
 *  spawns=[] into EVERY tick for the table's whole history, zeroing
 *  placements/completed/mttc/stuck with no signal anywhere. Fail-soft stays
 *  (a tick must never break routinesTick), but the failure now logs — once per
 *  process per distinct message, so a broken instrument can't be mistaken for
 *  a quiet loop again. */
const _warnedSpawnReadErrors = new Set<string>();
function warnSpawnReadError(e: unknown): SpawnRow[] {
  const msg = e instanceof Error ? e.message : String(e);
  if (!_warnedSpawnReadErrors.has(msg)) {
    _warnedSpawnReadErrors.add(msg);
    console.warn(`[pot-throughput] spawned_agents read FAILED — placements/completed/mttc/stuck will read 0 this tick (further identical errors suppressed): ${msg}`);
  }
  return [];
}

/**
 * Take + persist one throughput tick for a started pot. Best-effort: every PG
 * read/write is guarded, and a failure degrades to `recorded:false` (never
 * throws — the 30s routinesTick must survive a transient DB blip). Files FB-21
 * breach signals through captureImprovement and pushes the Learning tab.
 */
export async function recordPotThroughputTick(opts: {
  potSlug: string;
  workspaceId?: string;
  now?: number;
}): Promise<PotThroughputTickResult> {
  const nowMs = opts.now ?? Date.now();
  const empty: PotThroughputMetrics = {
    frontierDepth: 0,
    cupsBusy: 0,
    cupsCap: 0,
    utilization: 0,
    placements: 0,
    completed: 0,
    mttcMs: null,
    stuckCount: 0,
    questionRungs: {},
  };
  try {
    const { sql } = getOrgPg();
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const windowStart = new Date(nowMs - throughputReadWindowMs());

    // Frontier + headroom + spawns + last-tick, all cheap workspace-scoped reads.
    const { potDemandCheck } = await import('./watchdog');
    const { getSpawnHeadroom } = await import('../fleet/operator-spawn');
    const { potReadyFrontierDepth } = await import('./survey');
    const [demand, headroom, spawnRows, lastRows, frontier] = await Promise.all([
      potDemandCheck(ws).catch(() => ({ demand: false, todoItems: 0, startedPlans: 0 })),
      getSpawnHeadroom(ws).catch(() => ({ ceiling: 0, running: 0, headroom: 0 })),
      sql<SpawnRow[]>`
        SELECT status, started_at, finished_at, duration_ms, heartbeat_at
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${ws} AND child_role = 'cup'
           AND started_at > ${windowStart}`.catch(warnSpawnReadError),
      sql<Array<{ tick_at: string | Date }>>`
        SELECT tick_at FROM harness_shared.pot_throughput_ticks
         WHERE workspace_id = ${ws} AND pot_slug = ${opts.potSlug}
         ORDER BY tick_at DESC LIMIT 1`.catch(() => [] as Array<{ tick_at: string | Date }>),
      // WI-267 + EI-12461: the pot's READY frontier depth (member-scoped; feature-kind,
      // todo, unassigned, not-cursed, AND blocked_by/plan-item-chain satisfied) — NOT the
      // workspace-wide demand.todoItems, and NOT the placeable-SHAPED count either: a
      // dependency-chained wave sat "placeable" for hours of correct zero placement and
      // failed a release scorecard on a phantom stall. The starvation breach gates on what
      // THIS Mug can actually place NOW. Fail-soft ⇒ zeros (a flaky read must never
      // manufacture a false 'saturated with work queued' alarm).
      potReadyFrontierDepth(ws, opts.potSlug).catch(() => ({ ready: 0, blocked: 0, placeableShaped: 0 })),
    ]);

    const spawns: PotSpawnSnapshot[] = spawnRows.map((r) => ({
      status: String(r.status ?? ''),
      startedAtMs: ms(r.started_at) ?? nowMs,
      finishedAtMs: ms(r.finished_at),
      durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
      heartbeatAtMs: ms(r.heartbeat_at),
    }));

    const metrics = computePotThroughput({
      nowMs,
      // WI-267/EI-12461: READY frontier (member-scoped, readiness-satisfied) — was
      // demand.todoItems (workspace-wide), then the placeable-shaped count (blocked
      // lanes included).
      frontierDepth: frontier.ready,
      ceiling: headroom.ceiling,
      running: headroom.running,
      spawns,
      lastTickAtMs: ms(lastRows[0]?.tick_at),
      stuckThresholdMs: stuckThresholdMs(),
    });
    let ownerMaxCups: number | null = null;
    let systemCeiling: number | null = null;
    try {
      const [{ getOwnerSteering }, { spawnConcurrencyCeiling }] = await Promise.all([
        import('../owner-steering'),
        import('../fleet/operator-spawn'),
      ]);
      const steering = await getOwnerSteering(ws, opts.potSlug);
      ownerMaxCups = steering.maxBees ?? null;
      systemCeiling = spawnConcurrencyCeiling();
    } catch {
      // Fail open: a steering read fault must not hide a genuine starvation breach.
    }
    const breaches = detectThroughputBreaches(metrics, opts.potSlug, { ownerMaxCups, systemCeiling });

    await sql`
      INSERT INTO harness_shared.pot_throughput_ticks
        (workspace_id, pot_slug, frontier_depth, placements, cups_busy, cups_cap,
         stuck_count, completed, mttc_ms, question_rungs, detail)
      VALUES
        (${ws}, ${opts.potSlug}, ${metrics.frontierDepth}, ${metrics.placements},
         ${metrics.cupsBusy}, ${metrics.cupsCap}, ${metrics.stuckCount}, ${metrics.completed},
         ${metrics.mttcMs}, ${JSON.stringify(metrics.questionRungs)}::text::jsonb,
         ${JSON.stringify({
           utilization: metrics.utilization,
           stuckThresholdMs: stuckThresholdMs(),
           startedPlans: demand.startedPlans,
           breaches: breaches.map((b) => b.kind),
           // EI-12461 diagnosability: frontier_depth is the READY count; these two say
           // what readiness withheld, so "depth 0 because all blocked" reads at a glance.
           frontierBlocked: frontier.blocked,
           frontierPlaceableShaped: frontier.placeableShaped,
         })}::text::jsonb)`;

    // FB-21 audit-as-sensors: a breach files through capture (best-effort, deduped
    // by watchdogKey so a standing breach files once, not every 30s tick).
    if (breaches.length) {
      const { captureImprovement } = await import('../harness/improvements/capture-core');
      for (const b of breaches) {
        await captureImprovement({
          title: b.title,
          body: b.body,
          kind: 'bug',
          severity: b.severity === 'error' ? 'major' : 'minor',
          scope: `harness:${opts.potSlug}`,
          sourceRole: 'system',
          source: 'su',
          watchdogKey: b.watchdogKey,
          dedupScope: 'open',
          evidenceAt: new Date(nowMs).toISOString(),
          findingClass: `pot-throughput:${b.kind}`,
          foundDuring: 'pot-throughput-tick',
        }).catch((e) => {
          console.warn(`[pot-throughput] breach capture failed (${b.kind}): ${e instanceof Error ? e.message : e}`);
        });
      }
    }

    // Push the Learning tab's Throughput view. Fire-and-forget via lazy import so
    // the PG seam (+ tests) never statically depends on the SSE layer.
    void trackDetached(import('../sync-sse'))
      // Name fixed 2026-07-26: the client + resolver are 'learning.hiveThroughput';
      // 'learning.potThroughput' invalidated a name nobody subscribes to (dead push).
      .then((m) => m.notifySyncInvalidate('learning.hiveThroughput'))
      .catch(() => {});

    return { recorded: true, metrics, breaches };
  } catch (e) {
    console.warn(`[pot-throughput] tick failed (${opts.potSlug}): ${e instanceof Error ? e.message : e}`);
    return { recorded: false, metrics: empty, breaches: [] };
  }
}

// ── read seam (the resolver reads through normalizeThroughputRow) ────────────

/** One throughput tick row, camelCase mirror of the migration-261 columns. */
export interface PotThroughputTickRow extends PotThroughputMetrics {
  potSlug: string;
  tickAt: string;
}

/** The raw migration-261 row shape (snake_case, postgres-typed). */
export interface RawThroughputTickRow {
  pot_slug: string;
  tick_at: string | Date;
  frontier_depth: number | null;
  placements: number | null;
  cups_busy: number | null;
  cups_cap: number | null;
  stuck_count: number | null;
  completed: number | null;
  mttc_ms: string | number | null;
  question_rungs: Record<string, number> | null;
  detail: Record<string, unknown> | null;
}

/**
 * Map one raw tick row into the UI-shaped {@link PotThroughputTickRow}. PURE —
 * shared by the resolver read (learning-pot-throughput-read.ts) so the row
 * contract lives in one place. Utilization prefers the persisted detail value,
 * else re-derives from busy/cap (resilient to a detail-less row).
 */
export function normalizeThroughputRow(r: RawThroughputTickRow): PotThroughputTickRow {
  const cupsBusy = Number(r.cups_busy ?? 0);
  const cupsCap = Number(r.cups_cap ?? 0);
  const mttc = r.mttc_ms == null ? null : Number(r.mttc_ms);
  const detailUtil = asJsonObject(r.detail)?.utilization;
  const rungs = asJsonObject(r.question_rungs);
  return {
    potSlug: String(r.pot_slug ?? ''),
    tickAt: r.tick_at instanceof Date ? r.tick_at.toISOString() : new Date(r.tick_at).toISOString(),
    frontierDepth: Number(r.frontier_depth ?? 0),
    cupsBusy,
    cupsCap,
    utilization:
      typeof detailUtil === 'number' && Number.isFinite(detailUtil)
        ? clamp01(detailUtil)
        : cupsCap > 0
          ? clamp01(cupsBusy / cupsCap)
          : 0,
    placements: Number(r.placements ?? 0),
    completed: Number(r.completed ?? 0),
    mttcMs: mttc != null && Number.isFinite(mttc) ? mttc : null,
    stuckCount: Number(r.stuck_count ?? 0),
    questionRungs: (rungs as Record<string, number> | null) ?? {},
  };
}
