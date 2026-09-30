/**
 * orient-ideate-hint.ts — the coord:orient IDEATE-mode "overdue" fold
 * (su-ideate-learning-substrate-2026-07-10 P-011).
 *
 * When a caller's active modes include 'ideate', orient folds ONE cheap line
 * telling them whether they are OVERDUE to run an ideate pass. The verdict is
 * keyed on OBSERVATION COUNT, never elapsed days (D-015, owner 2026-07-10): a
 * session that has accumulated enough raw signal (turn-end lane:observation rows)
 * since its last pass — OR whose su-ideate-routed ideas have all resolved — is
 * "overdue", regardless of how long ago the last pass ran. Elapsed time is
 * INFORMATIONAL only (`lastPassAgoMs`); it never drives the verdict, so a healthy
 * idle session is not nagged just because a day passed.
 *
 * The decision REUSES the pure Scout cadence gate {@link shouldRunScoutCycle}
 * with an su-shaped {@link ScoutCadenceState}: friction = observations-since,
 * frictionThreshold = {@link suIdeateObsThreshold}, and every TIME floor zeroed so
 * the gate fires purely on the observation-count / ideas-drained triggers — never
 * the min-interval or heartbeat clocks. `fire` ⇔ overdue.
 *
 * Cost: gated to ideate-active callers only, fail-soft (the caller wraps this in
 * try/catch), and bounded to a small number of INDEXED reads — the last su-ideate
 * tick (scout_ticks_ws_origin_idx, migration 571), the caller's observation-lane
 * rows, and the su-ideate idea-queue drain status. All three reuse existing typed
 * seams rather than a hand-tuned join: the observation lane is a TAG edge, so a
 * raw count query would duplicate the tag-store internals — the reuse keeps the
 * fold maintainable while each underlying read stays indexed + bounded.
 */
import { shouldRunScoutCycle, type ScoutCadenceState } from '../../../scout/cadence';
import { readLastRanTickAtMs } from '../../../scout/tick-ledger';
import { readIdeaQueueStatus } from '../../../scout/routed-ledger';
import { countObservationFilingsSince } from '../../../harness/improvements/read-items';

/** The su-ideate origin tag on the shared scout ledgers (migration 571, P-010). */
const SU_IDEATE_ORIGIN = 'su-ideate';

/**
 * Observations-since threshold at/above which an ideate pass is OVERDUE (D-015).
 * Blueprint-tunable via `PAPERCUSP_SU_IDEATE_OBS_THRESHOLD`; default 10. A
 * non-positive / non-finite override falls back to the default (never disables
 * the bar — 0 would make every ideate-active session read "overdue" always).
 */
export function suIdeateObsThreshold(): number {
  const raw = Number(process.env.PAPERCUSP_SU_IDEATE_OBS_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
}

/** The one-line ideate pacing hint folded into orient when 'ideate' is active. */
export interface IdeateHint {
  /** Caller's lane:observation rows filed SINCE their last su-ideate pass. */
  observationsSince: number;
  /** True when every su-ideate-routed idea has resolved (total > 0, none pending). */
  ideasDrained: boolean;
  /** ms since the last su-ideate pass — INFORMATIONAL ONLY (never drives the verdict); null if a pass never ran. */
  lastPassAgoMs: number | null;
  /** 'overdue' ⇔ observationsSince ≥ threshold OR ideasDrained. */
  verdict: 'overdue' | 'ok';
  /** A short human-readable why. */
  reason: string;
  /** The observation threshold in force (echoed so the caller sees the bar). */
  threshold: number;
}

/** Injectable read seam — unit tests drive the verdict with no PG. */
export interface IdeateHintDeps {
  /** Epoch-ms of the caller's last su-ideate 'ran' tick, or null if a pass never ran. */
  readLastPassMs: (workspaceId: string) => Promise<number | null>;
  /** Count of the caller's lane:observation rows filed strictly after `sinceMs` (all-time when null). */
  countObservationsSince: (ownerId: string, sinceMs: number | null) => Promise<number>;
  /** su-ideate routed-idea queue: total ever + how many still pending. */
  readIdeaQueue: (workspaceId: string) => Promise<{ total: number; pending: number }>;
}

/**
 * Default observation count: read the caller's own lane:observation candidates
 * and count those filed strictly after the last pass. The observation lane is a
 * bounded, per-author reflection stream, so an in-memory filter over the existing
 * typed reader is cheap and avoids duplicating the topic-tag join in this fold.
 */
async function countObservationsSinceDefault(ownerId: string, sinceMs: number | null): Promise<number> {
  // P-008 (db-performance-remediation-2026-07-26): this used to be
  // `readObservationItems({})` — up to 500 full candidates, each carrying `body` and
  // the whole `payload` JSONB — followed by an in-memory `.filter(...).length`. The
  // doc comment above called that "cheap"; measured fleet-wide it was not: this runs
  // on EVERY orient, and together with the identical fold in orient-capture-miss-hint
  // it accounted for ~931k calls at ~825 rows/call — the #2 live consumer of the
  // database. Both predicates are plain indexed column comparisons, so Postgres
  // returns the integer directly.
  return countObservationFilingsSince(ownerId, sinceMs == null ? null : new Date(sinceMs).toISOString());
}

export const defaultIdeateHintDeps: IdeateHintDeps = {
  readLastPassMs: (workspaceId) => readLastRanTickAtMs({ workspaceId, origin: SU_IDEATE_ORIGIN }),
  countObservationsSince: countObservationsSinceDefault,
  readIdeaQueue: (workspaceId) => readIdeaQueueStatus({ workspaceId, origin: SU_IDEATE_ORIGIN }),
};

/**
 * Compute the ideate "overdue" hint for one caller. A pure decision
 * ({@link shouldRunScoutCycle}) over three cheap reads. Deps may throw on a
 * degraded DB — the caller (orient) owns the fail-soft try/catch, so this does
 * not swallow errors itself.
 */
export async function computeIdeateOverdue(
  input: { ownerId: string; workspaceId: string; nowMs?: number },
  deps: IdeateHintDeps = defaultIdeateHintDeps,
): Promise<IdeateHint> {
  const nowMs = input.nowMs ?? Date.now();
  const threshold = suIdeateObsThreshold();

  // Read #1: the caller's last su-ideate pass (the "since" boundary). Reads #2/#3
  // (observations-since — which needs that boundary — and the idea-queue) run in
  // parallel once it's known.
  const lastPassMs = await deps.readLastPassMs(input.workspaceId);
  const [observationsSince, queue] = await Promise.all([
    deps.countObservationsSince(input.ownerId, lastPassMs),
    deps.readIdeaQueue(input.workspaceId),
  ]);
  const ideasDrained = queue.total > 0 && queue.pending === 0;

  // Reuse the pure Scout gate, but ZERO every time floor so the verdict keys
  // purely on observation count / ideas-drained — never elapsed time (D-015).
  // With minInterval/minFrictionInterval/maxInterval all 0 and idleRatio 0, the
  // gate fires iff frictionSignals ≥ frictionThreshold (friction-triggered) OR the
  // idea pipeline drained (ideas-drained). lastRunAtMs feeds only lastPassAgoMs.
  const state: ScoutCadenceState = {
    idleRatio: 0,
    frictionSignals: observationsSince,
    lastRunAtMs: lastPassMs,
    nowMs,
    routedIdeaTotal: queue.total,
    pendingIdeaCount: queue.pending,
  };
  const cadence = shouldRunScoutCycle(state, {
    minIntervalSec: 0,
    minFrictionIntervalSec: 0,
    maxIntervalSec: 0, // disable the heartbeat ceiling — no elapsed-time trigger
    idleThreshold: 2, // idleRatio 0 can never reach this — idle-capacity never fires
    frictionThreshold: threshold,
  });

  const lastPassAgoMs = lastPassMs == null ? null : Math.max(0, nowMs - lastPassMs);
  return {
    observationsSince,
    ideasDrained,
    lastPassAgoMs,
    verdict: cadence.fire ? 'overdue' : 'ok',
    reason: reasonFor(cadence.reason, observationsSince, threshold),
    threshold,
  };
}

/** Render the cadence reason as a short, ideate-flavoured line. */
function reasonFor(cadenceReason: string, observationsSince: number, threshold: number): string {
  const obs = `${observationsSince} observation${observationsSince === 1 ? '' : 's'}`;
  switch (cadenceReason) {
    case 'friction-triggered':
      return `${obs} filed since your last ideate pass (≥ ${threshold}) — run a pass to mine them into ideas`;
    case 'ideas-drained':
      return 'every su-ideate idea you routed has resolved — regenerate: run an ideate pass';
    default:
      return `${observationsSince}/${threshold} observations since your last ideate pass — not yet overdue`;
  }
}
