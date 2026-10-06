/**
 * ungraded-filings-watchdog.ts — the GRADING backstop for the routed-idea ledger
 * (su-ideate-learning-substrate-2026-07-10 P-006; widened to every producer origin by
 * agent-review-filing-rail-and-class-aggregation-2026-09-05 P-001).
 *
 * ⚠ RECIPIENT, POST-RETIREMENT (blender-su-grade-integration-2026-08-11 P-012): the
 * prose below says "the Mug" throughout because that WAS the recipient when this was
 * written. The Mug/Kettle tier is retired. Delivery now goes through the nudge LADDER
 * (`deliverScoutNudge` → nudge-recipient.ts), whose rung 2 prefers the Blender steward
 * (a GRADE-mode su bound to the active Blender goal) over a merely-recent one. Read
 * every "nudge the Mug" below as "nudge the ladder's chosen recipient"; the deciders,
 * deadlines and debounce semantics are unchanged. The Mug-shaped NAMES that survive in
 * the API (`shouldNudgeMug`) are historical, not a claim about who gets the nudge.
 *
 * THE STARVATION (the gap this closes): agents ORIGINATE filings onto the routed-idea
 * ledger — `improvements:capture` from an su ideation pass (`origin='su-ideate'`), the
 * Scout corpus (`origin='scout'`), agent review (`origin='agent-review'`) — and the
 * whole learning substrate (grader-feedback priming, per-lens win-credit, the P-005
 * grade→revise wake) runs on those rows being GRADED (blender:grade-idea). But nothing
 * MAKES grading happen: triage only grades when it happens to look, so filings sit with
 * human_grade NULL indefinitely and the loop never gets its teaching signal.
 *
 * ⚠ P-001 — WHY THIS FILE NO LONGER NAMES AN ORIGIN ANYWHERE. It used to. The sweep was
 * `suIdeateUngradedSweep()` and its SELECT said `origin = 'su-ideate'`, which meant the
 * one rail that MAKES grading happen acted on a NARROWER population than the census in
 * `ungraded-scope.ts` that defines "ungraded" for everyone else. Measured 2026-09-02
 * (EI-22180311569503146): the rail covered 22 of 1,675 actionable rows, while
 * `agent-review` — 1,397 actionable and 27 arrivals in a single 24h window, the largest
 * and most active producer — had no consumer at all, and zero grades were recorded
 * workspace-wide in a day. `ungraded-scope.ts` had always promised that "a new origin is
 * INCLUDED by default, over-counting rather than silently vanishing"; that promise was
 * true of the COUNT and false of the RAIL.
 *
 * Adding `origin = 'agent-review'` beside the old literal would have closed the measured
 * gap and left the defect: the fourth producer would strand the same way. So the sweep is
 * driven from the per-origin contract the scope module exports
 * (`readActionableUngradedFilings` — per-origin epoch floors, terminality,
 * `shadow-variant` exclusion), and this file contains no origin literal and no
 * `human_grade` predicate of its own. It is deliberately no longer in that module's
 * SANCTIONED exception list. A producer that starts filing tomorrow is swept tomorrow,
 * with no edit here.
 *
 * PER-ORIGIN DEBOUNCE, ONE SOURCE. Each origin gets its OWN nudge and its own debounce
 * slot via `claimWatchdogFire`'s `scopeKey` (the mechanism built for exactly this: one
 * sub-condition among several sharing a source). The `WatchdogSource` union stays a
 * single `'su-ideate-ungraded'` — a historical NAME, not a population claim — precisely
 * so a new origin does not require editing a closed union either. Widening the union
 * per-origin would have re-created the enumeration this item removes, one file over.
 *
 * FLOOD GUARDS (D-013, now per-origin): the sweep only ever nudges rows at/after their
 * OWN producer's epoch floor, and each fire names at most UNGRADED_BATCH_CAP filings
 * (oldest first). agent-review's 1,397-row backlog therefore arrives as bounded batches
 * on the debounce clock, not as one flood — and `limitPerOrigin` on the read means one
 * large producer cannot starve the others out of a tick.
 *
 * Non-terminal check: the ledger's own `outcome` CACHE column (won | lost | pending,
 * NULL until a refresh sweeps the row — P-003/P-016). 'won'/'lost' rows are excluded
 * (the artifact already decided; the outcome IS the signal); NULL is treated as
 * non-terminal on purpose — better to nudge a grade on a row the cache hasn't caught
 * up with (a grade on a decided idea still feeds win-credit) than to starve the loop
 * waiting for a sweep. Same fail-soft shape as the template: pure deciders split
 * from the PG sweep, env-tunable threshold with a `<=0` kill switch, per-pot+origin
 * debounce over `hive_watchdog_fires`, never throws into the routines tick.
 * DEFAULT-SAFE: no stale ungraded filing ⇒ nothing happens.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import {
  listBlenderMaintenanceScopes,
  listBlenderMaintenanceWorkspaceIds,
} from '../pot/started';
import { resolveMugOwner } from '../pot/placement-watchdog';
import { deliverScoutNudge } from './nudge-recipient';
import { claimWatchdogFire, recentWatchdogFires } from '../pot/watchdog';
import {
  DEFAULT_UNGRADED_EPOCH_POLICY,
  SU_IDEATE_UNGRADED_EPOCH_MS,
  countActionableUngradedOlderThan,
  countActionableUngradedOutsideScopes,
  countRoutedByOriginSince,
  epochMsForOrigin,
  groupFilingsByOrigin,
  readActionableUngradedFilings,
  type UngradedEpochPolicy,
  type UngradedFilingRow,
} from './ungraded-scope';

// ── tunables (env-overridable, like scoutDraftReviewStaleSec) ─────────────────

/** How long a filing may sit ungraded (human_grade still NULL, artifact non-terminal)
 *  before the backstop nudges triage to grade it. Default 7d; env-tunable via
 *  PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC; `<=0` DISABLES the whole sweep (kill switch).
 *
 *  ⚠ The ENV NAME is historical and deliberately unchanged by P-001. It is an
 *  operator-facing key, not an origin selector: renaming it would silently drop any
 *  live override at the moment the rail widened, which is the one effect here that
 *  cannot be noticed by reading the code. */
export function ungradedFilingsStaleSec(): number {
  const n = Number(process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC ?? 604_800);
  return Number.isFinite(n) ? n : 604_800;
}

export interface UngradedFilingsConfig {
  enabled: boolean;
  effectiveThresholdSec: number;
  overrideSource: 'default' | 'environment' | 'invalid-environment-fallback';
  overrideEnv: 'PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC';
  rawOverride: string | null;
  /** P-001: the whole per-origin floor POLICY, not one origin's floor. A single
   *  `epochMs` on a multi-origin rail is not a summary — it is a wrong answer to
   *  "which line was drawn here" for every origin but one. */
  policy: UngradedEpochPolicy;
  /** The batch FLOOR (UNGRADED_BATCH_CAP). WI-10004412: the cap a fire actually uses is
   *  sized per origin per tick from its arrival rate (`ungradedBatchCapFor`) and is
   *  reported on each sweep result as `batchCap` / `arrivalsInWindow`. The name is kept
   *  because persisted run summaries (watchdog/status.ts) already carry it. */
  batchCap: number;
}

/** The effective configuration readback used by the sweep and watchdog:status.
 * Keeping this next to the tunable prevents diagnostic code from independently
 * re-implementing the default/override/kill-switch rules and drifting again. */
export function ungradedFilingsConfig(): UngradedFilingsConfig {
  const raw = process.env.PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC ?? null;
  const parsed = raw == null ? Number.NaN : Number(raw);
  const effectiveThresholdSec = ungradedFilingsStaleSec();
  return {
    enabled: effectiveThresholdSec > 0,
    effectiveThresholdSec,
    overrideSource:
      raw == null ? 'default' : Number.isFinite(parsed) ? 'environment' : 'invalid-environment-fallback',
    overrideEnv: 'PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC',
    rawOverride: raw,
    policy: DEFAULT_UNGRADED_EPOCH_POLICY,
    batchCap: UNGRADED_BATCH_CAP,
  };
}

/** D-013 enablement-epoch floor for su-ideate, re-exported here for its long-standing
 *  importers. DEFINED IN `ungraded-scope.ts`, which owns every origin's floor — the
 *  rail reads the whole policy now and never one origin's constant. */
export { SU_IDEATE_UNGRADED_EPOCH_MS };

/** D-013 batch cap: one fire names at most this many filings (oldest first), so
 *  even a large producer's backlog arrives in triage as a bounded, workable batch.
 *  P-001: applied PER ORIGIN, so one producer cannot consume another's budget. */
export const UNGRADED_BATCH_CAP = 10;

/**
 * WI-10004412 capacity CEILING: the most filings one fire may name. A fixed batch of 10
 * per debounce window was a rail whose best case (every nudge fully graded) still lost
 * to its inflow: measured 2026-09-30, agent-review routed 392 filings in 14 days
 * (~28/day, 78 in the last 2-day window) against 10 per 2 days, about 6x short, so the
 * backlog could only grow. The ceiling is the D-013 flood guard that survives: a batch
 * still has to be a workable unit, and the read below is bounded by it.
 */
export const UNGRADED_BATCH_MAX = 100;

/**
 * PURE capacity model (WI-10004412): size one origin's batch to the filings it routed
 * during the last debounce window, so a recipient that grades each batch keeps the
 * backlog from growing. Floored at UNGRADED_BATCH_CAP (a quiet producer still gets a
 * meaningful batch of its oldest rows) and ceilinged at UNGRADED_BATCH_MAX.
 *
 * `shortfall` is how many arrivals even a fully graded batch cannot absorb. A positive
 * shortfall means the rail cannot keep pace at this cadence; it is reported on the nudge
 * and the sweep result so that state is visible rather than inferred from a growing count.
 * A non-finite or negative arrival count (a failed measurement) yields the floor with
 * zero shortfall: never act on a missing number.
 */
export function ungradedBatchCapFor(arrivalsInWindow: number): { cap: number; shortfall: number } {
  if (!Number.isFinite(arrivalsInWindow) || arrivalsInWindow < 0) {
    return { cap: UNGRADED_BATCH_CAP, shortfall: 0 };
  }
  const arrivals = Math.floor(arrivalsInWindow);
  return {
    cap: Math.min(UNGRADED_BATCH_MAX, Math.max(UNGRADED_BATCH_CAP, arrivals)),
    shortfall: Math.max(0, arrivals - UNGRADED_BATCH_MAX),
  };
}

/**
 * The single `WatchdogSource` every ungraded-filing nudge fires under, whatever its
 * origin. Historical spelling, kept on purpose: `WatchdogSource` is a closed union, so
 * a per-origin source would put the enumeration P-001 removed back into `pot/watchdog.ts`.
 * Origins are separated by `scopeKey` instead — see `ungradedFireScopeKey`.
 */
export const UNGRADED_NUDGE_SOURCE = 'su-ideate-ungraded' as const;

/** The per-origin debounce sub-condition. Derived from the row's own origin, so a new
 *  producer gets its own debounce slot with no edit here. */
export function ungradedFireScopeKey(origin: string): string {
  return `origin=${origin}`;
}

// ── pure deciders (unit-tested with no DB) ────────────────────────────────────

/** One actionable ungraded ledger row (human_grade IS NULL, outcome cache
 *  non-terminal, at/after its OWN origin's epoch floor). */
export type UngradedCandidate = UngradedFilingRow;

/**
 * PURE: which candidate filings are stale enough to nudge — ungraded at least
 * `thresholdMs`, routed at/after THEIR OWN origin's epoch floor, oldest first, capped
 * at `cap` (D-013 batch cap). A `thresholdMs <= 0` (kill switch) selects none. A
 * non-finite timestamp is never selected (don't act blind on a missing clock).
 *
 * P-001: the floor is resolved PER ROW through `epochMsForOrigin`, exactly as
 * `classifyUngraded` resolves it. `epochMs` remains accepted as an explicit UNIFORM
 * override for callers that genuinely mean one line for every origin (tests, and any
 * caller that has already floored its own read).
 */
export function selectUngradedFilings(
  candidates: readonly UngradedCandidate[],
  opts: {
    now: number;
    thresholdMs: number;
    epochMs?: number;
    policy?: UngradedEpochPolicy;
    cap?: number;
  },
): UngradedCandidate[] {
  if (opts.thresholdMs <= 0) return []; // kill switch
  const policy = opts.policy ?? DEFAULT_UNGRADED_EPOCH_POLICY;
  const uniformFloor = typeof opts.epochMs === 'number' && Number.isFinite(opts.epochMs) ? opts.epochMs : null;
  const cap = opts.cap ?? UNGRADED_BATCH_CAP;
  return candidates
    .filter((c) => {
      if (!Number.isFinite(c.routedAtMs)) return false;
      const floor = uniformFloor ?? epochMsForOrigin(policy, c.origin);
      return c.routedAtMs >= floor && opts.now - c.routedAtMs >= opts.thresholdMs;
    })
    .sort((a, b) => a.routedAtMs - b.routedAtMs)
    .slice(0, Math.max(0, cap));
}

/**
 * PURE: should this (pot, origin) get a grading nudge this tick? Only when there IS a
 * stale ungraded filing and we have not already fired within the debounce window (a
 * filing that stays ungraded across many 30s ticks nudges at most once per window).
 */
export function shouldNudgeMug(args: { staleCount: number; alreadyFiredRecently: boolean }): boolean {
  return args.staleCount > 0 && !args.alreadyFiredRecently;
}

// ── the PG sweep ──────────────────────────────────────────────────────────────

/** Read this pot's actionable ungraded candidates across EVERY producer origin.
 *  Delegates to the scope module's contract — the population decision is not this
 *  file's to make (P-001). Unlike the draft watchdog's harness_plans read there is no
 *  workspace subtlety here: the ledger row carries the pot's REAL workspace_id +
 *  harness_slug (the capture bridge stamps both), which is exactly what
 *  listBlenderMaintenanceScopes hands the sweep. */
export async function readUngradedFilings(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  opts: { limitPerOrigin?: number; policy?: UngradedEpochPolicy } = {},
): Promise<UngradedCandidate[]> {
  return readActionableUngradedFilings(sql, {
    workspaceId,
    harnessSlug: installSlug,
    policy: opts.policy ?? DEFAULT_UNGRADED_EPOCH_POLICY,
    // Bounded by the capacity CEILING, not a separate literal: a read narrower than the
    // largest batch would silently cap every batch at the read size instead.
    limitPerOrigin: opts.limitPerOrigin ?? UNGRADED_BATCH_MAX,
  });
}

export interface UngradedSweepResult {
  workspaceId: string;
  installSlug: string;
  /** Which producer this result is about; '*' for whole-sweep infrastructure results. */
  origin: string;
  outcome: 'nudged' | 'skipped' | 'error';
  /** Coverage of the registry-backed Blender population evaluated by this tick. */
  evaluatedWorkspaceCount: number;
  evaluatedScopeCount: number;
  /** Number of stale filings eligible for this backstop's action. */
  eligibleBacklogCount: number;
  staleCount: number;
  reason: string;
  /** WI-10004412: the per-origin batch cap this tick used (ungradedBatchCapFor) and the
   *  arrival count it was sized from. Present on per-origin results only; '*' rows
   *  describe sweep infrastructure and have no batch. `arrivalsInWindow` is null when
   *  the arrival read failed and the cap fell back to the floor. */
  batchCap?: number;
  arrivalsInWindow?: number | null;
}

/**
 * Fire ONE grading nudge naming the stale ungraded filings for a SINGLE origin. It
 * NEVER writes a grade — the recipient still judges (and per D-012 must not be the
 * author).
 *
 * Delivery is the WI-963 two-half shape the draft watchdog converged on: the
 * event-key wake to the resolved Mug owner is BEST-EFFORT (that owner id is often a
 * fresh-per-wake session already ended by sweep time), so we ALSO durably park an
 * `@role:mug`-addressed coord message — the slot mug-brief-launch.ts drains into
 * EVERY future Mug wake's brief regardless of which owner id it boots under. The
 * durable park is the reliable half; the wake is the bonus.
 */
export async function fireGradingNudge(
  workspaceId: string,
  mugOwner: string | null,
  stale: readonly UngradedCandidate[],
  staleSec: number,
  harnessSlug: string | null = null,
  origin: string = stale[0]?.origin ?? 'unknown',
  capacity: { arrivalsInWindow: number | null; shortfall: number } = { arrivalsInWindow: null, shortfall: 0 },
): Promise<void> {
  const days = Math.max(1, Math.round(staleSec / 86_400));
  const shown = stale.slice(0, 5);
  const list = shown
    .map((s) => `• ${s.ideaId}${s.title ? ` — ${s.title}` : ''} (${s.routedRef})`)
    .join('\n');
  const more = stale.length > shown.length ? `\n…and ${stale.length - shown.length} more.` : '';
  const pace =
    capacity.arrivalsInWindow == null
      ? ''
      : ` ${origin} routed ${capacity.arrivalsInWindow} new filing(s) in the last ${days}d; this batch is sized ` +
        `to keep pace with that inflow.` +
        (capacity.shortfall > 0
          ? ` ⚠ CAPACITY SHORTFALL: ${capacity.shortfall} arrival(s) exceed the ${UNGRADED_BATCH_MAX}-filing batch ` +
            `ceiling, so this rail cannot keep pace even if every batch is graded.`
          : '');
  const summary =
    `${origin} grading backstop: ${stale.length} ${origin}-originated filing(s) ungraded > ${days}d.${pace} ` +
    `Grade each via blender:grade-idea { ideaId, grade, feedback } — grades feed the originator's ` +
    `priming + lens win-rates, and a grade of 3 or lower with feedback wakes the originator to ` +
    `revise. Grading them (or their artifacts reaching a terminal state) stops this nudge.\n\n` +
    `${list}${more}`;
  // P-034: routed, not Mug-only — see nudge-recipient.ts. This watchdog exists BECAUSE
  // "nothing MAKES grading happen"; a nudge that dead-ends restores exactly that gap.
  await deliverScoutNudge({
    workspaceId,
    mugOwner,
    summary,
    payload: {
      kind: 'su-ideate-ungraded',
      origin,
      ideaIds: stale.map((s) => s.ideaId),
      refs: stale.map((s) => s.routedRef),
      staleDays: days,
      arrivalsInWindow: capacity.arrivalsInWindow,
      capacityShortfall: capacity.shortfall,
    },
    source: UNGRADED_NUDGE_SOURCE,
    body: `${list}${more}`,
    harnessSlug,
    // WI-10004412: inject-only delivery meant the rail never started a turn for anyone
    // (13 fires/30d, each to a different recency-fallback su, the same 10 rows every
    // time). Wake the recipient when grading is its declared posture (the Blender steward
    // or a GRADE-mode su); a recency-fallback su still gets the message as an FYI.
    wakeSu: 'grading-posture',
  });
}

/**
 * The ungraded-filings backstop sweep. For each STARTED pot, for EVERY producer origin
 * present in the ungraded population: find filings ungraded past the deadline
 * (per-origin epoch-floored, batch-capped — D-013), and (debounced per pot+origin)
 * nudge the live recipient to grade them. Never throws — a watchdog that crashes its
 * host guards nothing. DEFAULT-SAFE: no stale ungraded filing ⇒ no nudge. Kill switch:
 * PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC <= 0.
 */
export async function ungradedFilingsSweep(opts: { now?: number } = {}): Promise<UngradedSweepResult[]> {
  const results: UngradedSweepResult[] = [];
  const staleSec = ungradedFilingsStaleSec();
  if (staleSec <= 0) return results; // kill switch
  const policy = DEFAULT_UNGRADED_EPOCH_POLICY;
  try {
    const scopes = await listBlenderMaintenanceScopes();
    if (scopes.length === 0) {
      const workspaceIds =
        typeof listBlenderMaintenanceWorkspaceIds === 'function'
          ? listBlenderMaintenanceWorkspaceIds()
          : [];
      if (workspaceIds.length === 0) return results;
      const { sql } = getOrgPg();
      const now = opts.now ?? Date.now();
      const staleBeforeMs = now - staleSec * 1_000;
      let eligibleBacklogCount = 0;
      for (const workspaceId of workspaceIds) {
        eligibleBacklogCount += await countActionableUngradedOlderThan(sql, {
          workspaceId,
          policy,
          staleBeforeMs,
        });
      }
      if (eligibleBacklogCount > 0) {
        const reason =
          `${eligibleBacklogCount} eligible stale ungraded filing(s) found in ${workspaceIds.length} workspace(s), ` +
          'but no registered Blender scopes were evaluated';
        console.warn(`[ungraded-filings] ALERT: ${reason}`);
        return [
          {
            workspaceId: '*',
            installSlug: '*',
            origin: '*',
            outcome: 'error',
            evaluatedWorkspaceCount: 0,
            evaluatedScopeCount: 0,
            eligibleBacklogCount,
            staleCount: eligibleBacklogCount,
            reason,
          },
        ];
      }
      return results;
    }
    const { sql } = getOrgPg();
    const evaluatedWorkspaceCount = new Set(scopes.map(({ workspaceId }) => workspaceId)).size;
    const evaluatedScopeCount = scopes.length;
    const now = opts.now ?? Date.now();
    const thresholdMs = staleSec * 1_000;
    const days = Math.max(1, Math.round(staleSec / 86_400));
    const windowHours = Math.max(1, Math.round(staleSec / 3_600));
    for (const { workspaceId, installSlug } of scopes) {
      try {
        const candidates = await readUngradedFilings(sql, workspaceId, installSlug, { policy });
        // WI-10004412: the inflow each origin's batch is sized against — filings routed in
        // the last debounce window (the window IS the stale threshold here). A failed read
        // degrades every origin to the floor cap; a capacity estimate must never cost the
        // nudge itself.
        let arrivalsByOrigin: Map<string, number> | null = null;
        try {
          arrivalsByOrigin = await countRoutedByOriginSince(sql, {
            workspaceId,
            harnessSlug: installSlug,
            policy,
            sinceMs: now - thresholdMs,
          });
        } catch (e) {
          console.warn(
            `[ungraded-filings] arrival read failed for ${workspaceId}/${installSlug}; using the floor batch cap: ` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // P-001: one nudge PER ORIGIN. A single mixed-origin fire would name filings
        // from producers with different graders and different deadlines in one
        // message, and would share one debounce slot — so the loudest producer would
        // silence every other one for the whole window.
        for (const [origin, originCandidates] of groupFilingsByOrigin(candidates)) {
          const arrivalsInWindow = arrivalsByOrigin ? (arrivalsByOrigin.get(origin) ?? 0) : null;
          const { cap: batchCap, shortfall } = ungradedBatchCapFor(arrivalsInWindow ?? Number.NaN);
          const stale = selectUngradedFilings(originCandidates, { now, thresholdMs, policy, cap: batchCap });
          if (stale.length === 0) continue;
          const scopeKey = ungradedFireScopeKey(origin);
          // EI-16038: cheap non-atomic pre-check first (avoid the transaction round-trip
          // on the common no-stale-filings tick); the atomic claim below is authoritative.
          const alreadyFiredRecently =
            (await recentWatchdogFires(
              workspaceId,
              installSlug,
              windowHours,
              UNGRADED_NUDGE_SOURCE,
              scopeKey,
            )) > 0;
          if (!shouldNudgeMug({ staleCount: stale.length, alreadyFiredRecently })) {
            results.push({
              workspaceId,
              installSlug,
              origin,
              outcome: 'skipped',
              evaluatedWorkspaceCount,
              evaluatedScopeCount,
              eligibleBacklogCount: stale.length,
              staleCount: stale.length,
              reason: 'debounced',
              batchCap,
              arrivalsInWindow,
            });
            continue;
          }
          // The scopeKey must appear VERBATIM in the reason or the debounce can never
          // match it (scopedFireReason repairs it loudly; don't rely on the repair).
          const reason =
            `[${scopeKey}] ${stale.length} ${origin} filing(s) ungraded > ${days}d: ` +
            stale.slice(0, 5).map((s) => s.ideaId).join(', ');
          // EI-6777/EI-16038: claim the atomic debounce slot (closes the race the old
          // recentWatchdogFires+recordFire pattern had, and backs off geometrically once
          // this exact reason has repeated) BEFORE nudging — only the winner nudges.
          const claimed = await claimWatchdogFire({
            workspaceId,
            installSlug,
            source: UNGRADED_NUDGE_SOURCE,
            windowHours,
            reason,
            wakeAt: null,
            scopeKey,
          });
          if (!claimed) {
            results.push({
              workspaceId,
              installSlug,
              origin,
              outcome: 'skipped',
              evaluatedWorkspaceCount,
              evaluatedScopeCount,
              eligibleBacklogCount: stale.length,
              staleCount: stale.length,
              reason: 'debounced (raced or backed off)',
              batchCap,
              arrivalsInWindow,
            });
            continue;
          }
          const mugOwner = await resolveMugOwner(sql, workspaceId, installSlug);
          await fireGradingNudge(workspaceId, mugOwner, stale, staleSec, installSlug, origin, {
            arrivalsInWindow,
            shortfall,
          });
          results.push({
            workspaceId,
            installSlug,
            origin,
            outcome: 'nudged',
            evaluatedWorkspaceCount,
            evaluatedScopeCount,
            eligibleBacklogCount: stale.length,
            staleCount: stale.length,
            reason,
            batchCap,
            arrivalsInWindow,
          });
        }
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          origin: '*',
          outcome: 'error',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: 0,
          staleCount: 0,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // WI-10002098: the coverage probe runs on EVERY tick, NOT only when there are no
    // scopes at all. Gated on `scopes.length === 0` it could only ever catch TOTAL
    // blindness, so a PARTIAL miss was undetectable by construction — which is how 249
    // workspace-global `scout` rows sat unreachable for a month while every registered
    // partition graded normally and current (EI-23811029152367526). Zero alarms fired,
    // because `scopes.length` was never 0.
    for (const workspaceId of Array.from(new Set(scopes.map((s) => s.workspaceId)))) {
      const harnessSlugs = scopes
        .filter((s) => s.workspaceId === workspaceId)
        .map(({ installSlug }) => installSlug);
      try {
        const uncovered = await countActionableUngradedOutsideScopes(sql, {
          workspaceId,
          harnessSlugs,
          policy,
          staleBeforeMs: now - thresholdMs,
        });
        if (uncovered === 0) continue;
        const reason =
          `${uncovered} eligible stale ungraded filing(s) in ${workspaceId} are not reachable ` +
          `by any of its ${harnessSlugs.length} registered Blender scope(s) — no grader can see them`;
        console.warn(`[ungraded-filings] ALERT: ${reason}`);
        results.push({
          workspaceId,
          installSlug: '*',
          origin: '*',
          outcome: 'error',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: uncovered,
          staleCount: uncovered,
          reason,
        });
      } catch (e) {
        // A probe that THREW must never read as "fully covered". Collapsing a failed
        // measurement into silence is the same defect one layer up: it is exactly how a
        // coverage gap stays invisible while the sweep reports a healthy tick.
        results.push({
          workspaceId,
          installSlug: '*',
          origin: '*',
          outcome: 'error',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: 0,
          staleCount: 0,
          reason: `coverage probe failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[ungraded-filings] sweep failed: ${reason}`);
    // Preserve the fail-soft routinesTick contract while making an outer
    // infrastructure failure observable in this DBOS step's durable output.
    // Before this, scope discovery/getOrgPg failures collapsed to [], which was
    // indistinguishable from a healthy sweep with no eligible filings.
    results.push({
      workspaceId: '*',
      installSlug: '*',
      origin: '*',
      outcome: 'error',
      evaluatedWorkspaceCount: 0,
      evaluatedScopeCount: 0,
      eligibleBacklogCount: 0,
      staleCount: 0,
      reason,
    });
  }
  return results;
}
