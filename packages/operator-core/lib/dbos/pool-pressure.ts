/**
 * pool-pressure.ts — a pre-tick PG-connection-pool-starvation gate for
 * routinesTickImpl, symmetric to event-loop-lag-monitor's loopPressure()
 * (backend-reliability-100pct-2026-07-03 P-006/W4; decisions D-002 + D-003).
 *
 * WHY. routinesTickImpl (routines-workflow.ts) enqueues git-sync then awaits a long
 * SERIAL chain of ~15 PG-touching DBOS.runStep sweeps. Two things can freeze it:
 *   (a) an EVENT-LOOP block — ALREADY shed at the tick top via loopPressure();
 *   (b) PG-POOL STARVATION — the UNGUARDED dimension and the real ~8× Jul 1–2 root
 *       cause. When the shared getOrgPg pool is exhausted (all connections held by
 *       concurrent consumers), every sweep's query BLOCKS on connection acquisition →
 *       the tick balloons/freezes → git-sync (enqueued at the tick top) stalls with it
 *       → silent wedge → the external bghost-watchdog does a full restart.
 * There was no shed/assertion symmetric to loopPressure() for the POOL dimension.
 * This adds one: it makes pool starvation a COUNTED, LOGGED, shed-able signal instead
 * of a silent pile-on→freeze→restart. The bghost-watchdog stays as the backstop; the
 * dead-routine detector (system-health) still catches a sustained freeze — this adds
 * the ATTRIBUTION (why the routines went dead) and prevents the tick from worsening
 * the starvation.
 *
 * HOW WE MEASURE (D-003). postgres.js (3.4.9) does NOT expose live pool queue-depth —
 * its `queries`/`open`/`busy`/`reserved` queues are closure-private; only
 * `options.max` is public. So rather than depend on private internals (which break on
 * any postgres upgrade — a clear anti-pattern), we measure the ONE thing that actually
 * starves the tick: how long a trivial acquire+`SELECT 1` takes. Under a healthy pool
 * it returns in a few ms; under a starved pool the probe's own query queues behind the
 * backlog and the latency (or a timeout) IS the starvation signal — a strictly better
 * signal for THIS failure mode than a raw queue-depth number, using only the public API.
 *
 * FAIL-SOFT throughout: any probe error is treated as 'ok' — absence of a clean signal
 * must never cause shedding (the same rule loopPressure() follows when no monitor is
 * running). Telemetry, never a crash.
 *
 * LOOP-DELAY CONTAMINATION (WI-10001531 — why the raw probe is NOT the signal).
 * The (a)/(b) split above claims the two dimensions are independent. They are not:
 * instrument (b) is contaminated by condition (a). `now() - start` spans an `await`,
 * so on a CPU-bound main thread the delta is dominated by SCHEDULER latency, not by
 * pool acquisition — the probe charges event-loop delay to Postgres. Measured on the
 * bg-host 2026-09-16: probe readings up to 8191ms against this module's own 3000ms
 * `Promise.race` timeout (arithmetically impossible from I/O — the timer itself fired
 * 5.2s late), while pg_stat_activity showed every one of the process's 43 connections
 * `idle`, zero active backends host-wide, and the same `SELECT 1` answered in 16ms
 * from another process. Concurrently: `[event-loop-lag] high loop delay — host is
 * CPU-bound on the main thread { p95Ms: 1568.7, p99Ms: 2336.2 }` — p99 loop delay
 * ALONE exceeds CRITICAL_PROBE_MS. Downstream, evaluateRoutineDispatchEpoch collapsed
 * every queue's admission window to 1 and routinesTick withheld each due routine
 * WITHOUT advancing next_fire_at, degrading all 69 git-sync slugs ~12x (WI-10001527).
 *
 * So we report pool latency NET of the scheduler delay the probe's own await absorbed
 * (`poolLatencyNetOfLoopDelayMs`). This is a SIGNAL repair, deliberately not a guard
 * relaxation: the dispatch window and the EI-11171 critical-routine floor are unchanged.
 * Discounting is safe precisely because dimension (a) keeps its OWN guard — loopPressure()
 * still sheds at the tick top — so a blocked loop is still shed, once, for the right
 * reason, instead of twice under two names.
 */

import { currentLoopLag, type LoopLagSample } from '../event-loop-lag-monitor';

export type PoolPressure = 'ok' | 'elevated' | 'critical';

/** acquire+`SELECT 1` latency (ms) bands. elevated ⇒ the pool is contended; critical ⇒
 *  starved, shed the tick. Env-tunable so a small embedded-pg host can be stricter.
 *  (Mirrors event-loop-lag-monitor's ELEVATED/CRITICAL_P95_MS shape.) */
export const ELEVATED_PROBE_MS = Math.max(1, Number(process.env.PAPERCUSP_POOL_ELEVATED_MS) || 250);
export const CRITICAL_PROBE_MS = Math.max(
  ELEVATED_PROBE_MS + 1,
  Number(process.env.PAPERCUSP_POOL_CRITICAL_MS) || 2000,
);
/** Hard ceiling on the probe itself — a probe that can't finish in this budget IS
 *  critical (the pool is fully starved). Kept ≥ CRITICAL so a timeout ⇒ critical, and
 *  it bounds the cost the probe adds to an (already-degraded) tick. */
export const PROBE_TIMEOUT_MS = Math.max(
  CRITICAL_PROBE_MS,
  Number(process.env.PAPERCUSP_POOL_PROBE_TIMEOUT_MS) || 3000,
);

/** Pure band classification from an acquire+`SELECT 1` latency (ms). Exported for
 *  tests. Non-finite ⇒ 'ok' (no clean signal ⇒ never shed). Mirrors
 *  classifyLoopPressure exactly. */
export function classifyPoolPressure(
  probeMs: number,
  elevatedMs: number = ELEVATED_PROBE_MS,
  criticalMs: number = CRITICAL_PROBE_MS,
): PoolPressure {
  if (!Number.isFinite(probeMs)) return 'ok';
  if (probeMs >= criticalMs) return 'critical';
  if (probeMs >= elevatedMs) return 'elevated';
  return 'ok';
}

/**
 * The scheduler delay a SINGLE probe's `await` may be charged with, from the live
 * loop-delay window. p99 deliberately — NOT max: one outlier block would otherwise
 * zero out the pool signal for every probe in the same 10s window (over-correcting
 * into permanent blindness), while p50 under-corrects so far it leaves the defect in
 * place (measured p50 20-25ms against p95 1568ms). p99 is the tail a single sample
 * realistically lands in. Returns 0 when there is no monitor or no usable number, so
 * absence of a loop signal leaves the raw probe untouched — today's behaviour exactly.
 */
export function attributableLoopDelayMs(lag: LoopLagSample | null): number {
  if (!lag) return 0;
  const p99 = lag.p99Ms;
  if (!Number.isFinite(p99) || p99 <= 0) return 0;
  return p99;
}

/** `rawMs` net of the scheduler delay the probe's own await absorbed. Clamped at 0 —
 *  a negative "pool latency" is meaningless. Pure; exported so the boundary is pinned
 *  without real timers or a real pool. */
export function poolLatencyNetOfLoopDelayMs(rawMs: number, lag: LoopLagSample | null): number {
  if (!Number.isFinite(rawMs)) return rawMs;
  return Math.max(0, rawMs - attributableLoopDelayMs(lag));
}

/** Reading the loop monitor must never be able to fail the probe (fail-soft rule). */
function safeReadLoopLag(read: () => LoopLagSample | null): LoopLagSample | null {
  try {
    return read();
  } catch {
    return null;
  }
}

// The most recent probe's latency (ms) + when it ran (epoch ms) — for the same-process
// health fold / tests. 0 until the first probe runs. `_lastProbeMs` is the CORRECTED
// (net-of-loop-delay) value every consumer classifies on; the raw reading and the
// delay discounted from it are retained beside it so a shed stays attributable —
// without them a corrected 'ok' is indistinguishable from a genuinely idle pool.
let _lastProbeMs = 0;
let _lastProbeAt = 0;
let _lastProbeRawMs = 0;
let _lastLoopDelayMs = 0;
export function lastPoolProbeMs(): number {
  return _lastProbeMs;
}
export function lastPoolProbeAt(): number {
  return _lastProbeAt;
}
/** The uncorrected acquire+`SELECT 1` wall-clock of the last probe (telemetry only —
 *  never classify on this: it is the contaminated number). */
export function lastPoolProbeRawMs(): number {
  return _lastProbeRawMs;
}
/** The loop delay discounted from the last probe. > 0 means the raw reading was
 *  partly scheduler latency, so a 'critical' raw that classified 'ok' is explained. */
export function lastPoolProbeLoopDelayMs(): number {
  return _lastLoopDelayMs;
}

// Cumulative count of ticks shed for pool starvation, THIS process. Same-process only
// (the tick runs in the bg-host; the health panel — usually a different worker — uses
// its own probe band, not this counter, so it stays honest cross-process).
let _poolShedCount = 0;
export function poolShedCount(): number {
  return _poolShedCount;
}
/** Record + return the new shed count. Called by routinesTickImpl on a critical shed. */
export function recordPoolShed(): number {
  return ++_poolShedCount;
}

/** The default probe: a trivial `SELECT 1` on the shared org-admin pool — the SAME pool
 *  routinesTickImpl's sweeps use, so its acquisition latency is exactly what the tick
 *  would pay. Imported lazily to keep this module free of a load-time db dependency. */
async function defaultProbe(): Promise<unknown> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql`SELECT 1`;
}

/**
 * Time an acquire+`SELECT 1` against the org pool, bounded by `timeoutMs`. Returns the
 * measured latency (ms) and publishes it to lastPoolProbeMs()/At().
 *   - TIMEOUT (pool can't service a trivial query in the budget) ⇒ returns ≥ CRITICAL
 *     so it always classifies 'critical' (even when a small test `timeoutMs` makes the
 *     raw elapsed sub-critical).
 *   - FAST error (a non-starvation failure — pool ended, bad query, etc.) ⇒ returns the
 *     small elapsed ⇒ 'ok' ⇒ don't shed; the tick's own steps will surface that error.
 * Fully fail-soft — never throws. `runProbe`/`now`/`timeoutMs` are injectable for tests.
 */
export async function probePoolLatencyMs(
  runProbe: () => Promise<unknown> = defaultProbe,
  now: () => number = Date.now,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  readLoopLag: () => LoopLagSample | null = currentLoopLag,
): Promise<number> {
  const start = now();
  let rawMs: number;
  let timedOut = false;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('pool-probe-timeout')), timeoutMs);
      // Never keep the process alive on the probe's account.
      if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });
    try {
      await Promise.race([runProbe(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    rawMs = now() - start;
  } catch (e) {
    timedOut = e instanceof Error && e.message === 'pool-probe-timeout';
    // A fired timeout means the full budget elapsed on the TIMER's clock. `now()` can
    // read SHORT of it: libuv arms setTimeout from the loop's CACHED time, which lags
    // wall-clock by however long the current loop iteration has been running, so after
    // a synchronous burst setTimeout(20) fires with `Date.now() - start` at 19ms or
    // less. Unfloored, that under-read makes `netMs >= timeoutMs` false on a genuine
    // timeout with NO loop delay, and a starved pool classifies 'ok' (WI-10003256).
    rawMs = timedOut ? Math.max(now() - start, timeoutMs) : now() - start;
  }
  // Discount the scheduler delay this probe's own `await` absorbed (LOOP-DELAY
  // CONTAMINATION in the header). No monitor ⇒ 0 ⇒ the raw reading is unchanged.
  // Read the monitor ONCE: it is a live window, so two reads can disagree and would
  // leave the recorded delay unable to explain the reported value.
  const lag = safeReadLoopLag(readLoopLag);
  _lastProbeRawMs = rawMs;
  _lastLoopDelayMs = attributableLoopDelayMs(lag);
  const netMs = poolLatencyNetOfLoopDelayMs(rawMs, lag);
  // A genuine TIMEOUT means the POOL couldn't service a trivial query within the budget
  // ⇒ force the critical band regardless of the measured elapsed (a small test
  // `timeoutMs` makes the raw elapsed sub-critical). But a timeout the concurrent loop
  // delay ACCOUNTS FOR is a scheduler artifact, not pool starvation — forcing critical
  // there is the double-shed this repair removes, and dimension (a) keeps its own
  // guard. A non-timeout error (fast query failure) is NOT starvation ⇒ small ⇒ 'ok'.
  const poolAttributableTimeout = timedOut && netMs >= timeoutMs;
  _lastProbeMs = poolAttributableTimeout ? Math.max(netMs, CRITICAL_PROBE_MS) : netMs;
  _lastProbeAt = now();
  return _lastProbeMs;
}

/** Live pool-pressure band from a fresh probe. Fail-soft ('ok' on any probe error). */
export async function poolPressure(
  runProbe: () => Promise<unknown> = defaultProbe,
  now: () => number = Date.now,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  readLoopLag: () => LoopLagSample | null = currentLoopLag,
): Promise<PoolPressure> {
  return classifyPoolPressure(await probePoolLatencyMs(runProbe, now, timeoutMs, readLoopLag));
}

/** Test-only: reset the module-global probe + shed state between cases. */
export function __resetPoolPressureForTest(): void {
  _lastProbeMs = 0;
  _lastProbeAt = 0;
  _lastProbeRawMs = 0;
  _lastLoopDelayMs = 0;
  _poolShedCount = 0;
}

/**
 * EI-13108 ask (2): durably record a critical pool-shed event (migration 627,
 * harness_shared.routine_pool_shed_events) so an instrument-staleness consumer
 * can tell "paused by this guardrail" from "dead" during a shed window — the
 * in-memory poolShedCount() above is same-process-only and invisible outside
 * the journal.
 *
 * FIRE-AND-FORGET BY DESIGN: called from routinesTickImpl right after a
 * critical shed, on an already-starved pool — awaiting this insert would pile
 * MORE work onto the exact pool that's starving, worsening the incident this
 * exists to attribute. Never throws; a failed insert is swallowed (best-effort
 * telemetry, never a tick-blocking dependency — mirrors the fail-soft rule the
 * probe itself follows).
 */
async function defaultInsertShedEvent(workspaceId: string, shedCount: number, probeMs: number, host: string): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.routine_pool_shed_events
      (workspace_id, shed_count, probe_ms, host)
    VALUES (${workspaceId}, ${shedCount}, ${Math.round(probeMs)}, ${host})`;
}

async function defaultHostname(): Promise<string> {
  const os = await import('node:os');
  return os.hostname();
}

export function recordPoolShedEvent(
  workspaceId: string,
  shedCount: number,
  probeMs: number = lastPoolProbeMs(),
  // Injectable for tests (mirrors probePoolLatencyMs's `runProbe` pattern); defaults
  // to the real INSERT against the org pool + the real hostname.
  insert: (workspaceId: string, shedCount: number, probeMs: number, host: string) => Promise<void> = defaultInsertShedEvent,
  hostname: () => Promise<string> = defaultHostname,
): void {
  void (async () => {
    try {
      await insert(workspaceId, shedCount, probeMs, await hostname());
    } catch (e) {
      console.warn(`[pool-pressure] recordPoolShedEvent insert failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}

/**
 * Query helper for instrument-staleness consumers: was there a durable
 * critical pool-shed event for `workspaceId` within the last `windowMs`? A
 * true result means "paused by the P-006/W4 guardrail", not "dead" — the
 * caller should treat a stale-looking instrument as shed, not broken, for
 * this window. Fail-soft: any query error returns false (never claims a shed
 * happened on a broken signal; the caller falls back to its normal staleness
 * verdict).
 */
async function defaultQueryShedInWindow(workspaceId: string, windowMs: number): Promise<boolean> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM harness_shared.routine_pool_shed_events
     WHERE workspace_id = ${workspaceId}
       AND at >= now() - (${windowMs}::text || ' milliseconds')::interval
     LIMIT 1`;
  return rows.length > 0;
}

export async function hasPoolShedInWindow(
  workspaceId: string,
  windowMs: number,
  // Injectable for tests; defaults to the real SELECT against the org pool.
  query: (workspaceId: string, windowMs: number) => Promise<boolean> = defaultQueryShedInWindow,
): Promise<boolean> {
  try {
    return await query(workspaceId, windowMs);
  } catch (e) {
    console.warn(`[pool-pressure] hasPoolShedInWindow query failed (non-fatal, treated as no-shed-signal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
