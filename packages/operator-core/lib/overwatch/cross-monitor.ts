/**
 * overwatch/cross-monitor — the OVERWATCH-liveness leg of who-watches-the-watcher
 * (overwatch-role-2026-06-15 B-09, D-004).
 *
 * Overwatch can stall exactly like the Queen did (the opus-pacing stall,
 * 2026-06-15). D-004's answer: each role carries the OTHER's liveness, so neither
 * silently dies. The two legs live in different places, by ownership:
 *
 *   - QUEEN-liveness (is the Queen alive, for overwatch's brief + the Health tab)
 *     is owned by the SHARED `computeSystemHealth` model (D-006 — one health
 *     aggregation, two consumers): `SystemHealth.crossMonitor.queenAlive`, which
 *     B-03 maps onto the OverwatchBrief and `detectAnomalies` turns into
 *     `queen-dark`. B-09 does NOT build a parallel queen-liveness gatherer.
 *
 *   - OVERWATCH-liveness (is overwatch alive) is THIS module's job — the "reverse
 *     leg" B-03 deferred to B-09. It reads overwatch's own wake channel
 *     (`overwatchLivenessCheck`, ./liveness) and feeds TWO consumers:
 *       · the shared model — `computeSystemHealth` fills
 *         `crossMonitor.overwatchAlive` from `isOverwatchAlive` (was a `null`
 *         stub); that flows to the Health tab AND back into the OverwatchBrief.
 *       · the QUEEN's wake brief — `queen-brief-launch.ts` reads
 *         `overwatchAliveForQueen`; a dark overwatch surfaces there as a critical
 *         "ESCALATE" line (she cannot relaunch it — structural, D-002).
 *
 * "Alive" is deliberately CONSERVATIVE (favours not-alarming — a confused system
 * must not thrash, D-002):
 *   - NOT expected to run (overwatch flag off / not started, B-07) ⇒ vacuously
 *     alive — nothing to be dark;
 *   - armed (a wake scheduled) ⇒ alive — it WILL fire, and the liveness watchdog
 *     re-arms a stalled one, so `armed` already absorbs a normal stall;
 *   - never woken yet ⇒ alive (starting, not dead);
 *   - DARK = expected AND no wake armed AND last activity older than the dark
 *     threshold — the genuine "stalled past its own backstop" case D-004 targets.
 */
import { getFlag } from "@papercusp/flags/server";
import { FLAGS } from "@papercusp/flags";
import { getOrgPg } from "@papercusp/db-org";
import { overwatchLivenessCheck } from "./liveness";
import { getOverwatchStarted } from "./control-state";

/** The cross-monitor "dark" threshold in seconds — env-tunable, hard min 60s.
 *  Generous by design: the liveness watchdog re-arms a stalled overwatch well
 *  before this, so crossing it means overwatch AND its backstop both went silent
 *  (default 30 min). */
export function crossMonitorDarkSec(): number {
  const n = Number(process.env.PAPERCUSP_OVERWATCH_DARK_SEC ?? 1800);
  return Number.isFinite(n) && n >= 60 ? n : 1800;
}

/** The conservative dark predicate. `expected` = the role is supposed to be
 *  running right now. */
function isDark(
  expected: boolean,
  live: { armed: boolean; staleForMs: number | null },
  darkMs: number,
): boolean {
  if (!expected) return false; // not running ⇒ nothing to be dark
  if (live.armed) return false; // a wake is scheduled ⇒ alive
  if (live.staleForMs === null) return false; // never woken yet ⇒ starting, not dead
  return live.staleForMs > darkMs;
}

/** Is overwatch expected to be running right now? Only when its flag is ON
 *  (B-10/D-009) AND its control bit is started (B-07's `kettle:start`).
 *  Exported for EI-9794 (autoloop fire-staleness alarm, liveness-alarm.ts) —
 *  the SAME conservative "is it supposed to be running" predicate `isOverwatchAlive`
 *  uses, reused rather than re-derived, so the two checks never drift apart. */
export async function overwatchExpected(
  workspaceId: string,
  installSlug: string,
): Promise<boolean> {
  try {
    if (!(await getFlag(FLAGS.OVERWATCH, "system"))) return false;
    return await getOverwatchStarted(workspaceId, installSlug);
  } catch {
    return false; // unknown ⇒ not-expected ⇒ vacuously alive (never false-dark)
  }
}

/**
 * Is overwatch alive — as the SHARED model records it (`boolean | null`, matching
 * `SystemHealth.CrossMonitor.overwatchAlive`). `null` = not computable / not in
 * play (flag off / not started) — the "not computed" signal, never a false dark.
 * `computeSystemHealth` calls this to replace its `overwatchAlive: null` stub.
 * Fail-soft → null.
 */
export async function isOverwatchAlive(
  workspaceId: string,
  installSlug: string,
  opts: { now?: number; darkMs?: number } = {},
): Promise<boolean | null> {
  try {
    if (!(await overwatchExpected(workspaceId, installSlug))) return null;
    const { sql } = getOrgPg();
    const live = await overwatchLivenessCheck(sql, installSlug, {
      now: opts.now,
      workspaceId,
    });
    return !isDark(true, live, opts.darkMs ?? crossMonitorDarkSec() * 1_000);
  } catch {
    return null;
  }
}

/**
 * Overwatch's liveness AS THE QUEEN'S BRIEF CONSUMES IT (the reverse leg). Returns
 * `undefined` when overwatch is NOT in play so the Queen's brief omits the
 * cross-monitor line entirely (no noise about a role that isn't running). When it
 * IS in play, returns the liveness bool — `false` is the dark signal telling the
 * Queen to ESCALATE. Thin adapter over `isOverwatchAlive` (null → undefined).
 */
export async function overwatchAliveForQueen(
  workspaceId: string,
  installSlug: string,
  opts: { now?: number; darkMs?: number } = {},
): Promise<boolean | undefined> {
  const alive = await isOverwatchAlive(workspaceId, installSlug, opts);
  return alive === null ? undefined : alive;
}
