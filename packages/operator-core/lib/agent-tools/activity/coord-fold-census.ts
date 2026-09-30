/**
 * THE COORD-FOLD CENSUS — the instrument P-005 exists to install
 * (observation-and-recall-surface-honesty-2026-08-16, D-001).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `hook-bundle.ts` states its own design intent plainly: "A quiet run still
 * performs one cheap MAX(id) generation read per heartbeat, but performs O(1)
 * inbox/glance hydrations until coordination state actually changes."
 *
 * Nothing records whether that holds. The fold's `changed` outcome is computed,
 * acted on, and discarded — so the optimization's own effectiveness is
 * UNOBSERVABLE. Two filings sit on that blind spot, and both had to reason from
 * proxies because the direct number does not exist:
 *
 *   · EI-20582609088583997 — the generation is `MAX(coord_event_log.id)`
 *     WORKSPACE-GLOBAL, so any agent's event invalidates every other agent's
 *     cursor. Measured 8.5 coord events/min (mean gap 7.03s) against 2,361
 *     folding calls/hr. Its own "Confidence" section is explicit that the
 *     resulting quiet-fold ratio is an INFERENCE from those two numbers, and
 *     names the absent counter as "itself part of the problem".
 *   · EI-20582634380032313 — the fold averages 2,985ms server-side against the
 *     client's 4,000ms wall (`posttooluse-activity-report.sh` HTTP_TIMEOUT=4),
 *     so a share of hydrations are computed and then discarded; the client never
 *     reaches its `write_cursor`, so the next call re-pays the same work.
 *
 * D-001 gates both fixes on this census: the coord fold runs SYNCHRONOUSLY in a
 * hook on every tool call for every agent in the fleet, and a wrong
 * "optimization" there does not fail loudly — it silently drops coordination
 * delivery. So the ratio gets MEASURED before that hook path is touched, never
 * inferred.
 *
 * ── WHY IT SHIPS ON `tool_invocations.metadata_json` ────────────────────────
 *
 * Same reasoning as the dead-derived-signal census (`coord/derived-signal-census.ts`),
 * and deliberately the same channel: no new table, no migration, no new write
 * path. The fold's enclosing `activity:report` call ALREADY writes a
 * `tool_invocations` row; `ctx.metadata` rides that row, so the instrument costs
 * zero extra queries and zero extra latency on the exact hot path whose latency
 * is under investigation. An instrument that added a synchronous INSERT per fold
 * would be measuring a path it had itself made slower.
 *
 * The row it lands on already carries `coord_owner_id`, `invoked_at` and
 * `duration_ms`, indexed by `(coord_owner_id, invoked_at DESC)` — which is
 * exactly the key set both open questions need, for free.
 *
 * ── HOW TO READ IT (P-006 / P-007 both start here) ──────────────────────────
 *
 * The whole point is the RATIO, so EVERY fold is censused, including the quiet
 * ones. A census that recorded only the expensive folds could not report the one
 * thing it exists to report.
 *
 *   -- the headline: how often does the gate actually open, and why?
 *   SELECT metadata_json->'coordFold'->>'reason'                          AS reason,
 *          count(*)                                                       AS folds,
 *          round(avg((metadata_json->'coordFold'->>'foldMs')::numeric))    AS avg_fold_ms,
 *          round(avg((metadata_json->'coordFold'->>'hydrateMs')::numeric)) AS avg_hydrate_ms,
 *          count(*) FILTER (
 *            WHERE (metadata_json->'coordFold'->>'inboxAdvanced')::boolean) AS inbox_advanced
 *     FROM harness_shared.tool_invocations
 *    WHERE tool_name = 'activity:report'
 *      AND workspace_id = '<workspace>'
 *      AND invoked_at > now() - interval '1 hour'
 *      AND metadata_json ? 'coordFold'
 *    GROUP BY 1 ORDER BY folds DESC;
 *
 * Two readings that need care, because each is a confident-wrong-answer trap:
 *
 *  1. `inboxAdvanced` IS NOT "the fold was worth it". It says the INBOX leg
 *     delivered new mail to THIS owner. The fold also replaces `glance`, whose
 *     inputs (presence, fleet state) move for reasons that have nothing to do
 *     with this owner's mail. So `changed AND NOT inboxAdvanced` is the
 *     population a per-owner INBOX gate would have skipped — an upper bound on
 *     P-006's saving, never a count of wasted work. Read it as a bound and say
 *     so; the field is named for what it measures rather than for the verdict it
 *     is tempting to read off it.
 *
 *  2. The DISCARD rate (P-007) is not a field — it is a window function over
 *     consecutive folds by the same owner, and it needs both generations, which
 *     is why `reqGen` and `gen` are both recorded rather than just `changed`:
 *
 *       a client that RECEIVED the bundle sends back the `gen` we returned;
 *       a client that TIMED OUT re-sends its previous `reqGen` unchanged.
 *
 *     So `reqGen[i] = reqGen[i-1] AND reqGen[i] <> gen[i-1]`, ordered by
 *     `invoked_at` per `coord_owner_id`, is the fold whose result the client
 *     never received — the self-sustaining loop EI-20582634380032313 describes,
 *     measured directly instead of inferred from a mean against a wall.
 */

/**
 * Schema tag on the emitted record, so a reader can tell this census apart from
 * other metadata and a future shape change is detectable rather than silent.
 *
 * ⚠ BUMP THIS WHEN A FIELD'S MEANING CHANGES, not only when a field is added or
 * removed. A rename reds something; a redefinition reds nothing — which is
 * exactly the case a version tag has to catch. A window spanning an unbumped
 * redefinition silently averages two different measurements.
 */
export const COORD_FOLD_CENSUS_VERSION = 2;

/** The key this census is published under inside `tool_invocations.metadata_json`. */
export const COORD_FOLD_CENSUS_KEY = 'coordFold';

/**
 * Why the generation gate read as it did.
 *
 * `no-client-generation` is split out from `generation-mismatch` deliberately.
 * A first call after a fresh context or an operator restart has no cursor to
 * match and is LEGITIMATELY expensive — it is not evidence of the global-gate
 * defect. Folding the two together would inflate exactly the number P-006 turns
 * on.
 */
export type CoordFoldReason =
  | 'quiet'
  | 'owner-irrelevant'
  | 'generation-mismatch'
  | 'force-resync'
  | 'no-client-generation'
  | 'glance-only';

/** One fold's observation on one `activity:report` call. */
export interface CoordFoldCensus {
  v: number;
  /** Did the gate OPEN — i.e. was the expensive hydration path taken? */
  changed: boolean;
  /** Which branch of the gate produced `changed`. */
  reason: CoordFoldReason;
  /** Both surfaces assembled AND the cursor staged. */
  complete: boolean;
  /** Whole-fold wall time. */
  foldMs: number;
  /** The generation + cursor read that DECIDES the gate. 0 is a real reading. */
  gateMs: number;
  /**
   * Everything the gate PROTECTS AGAINST — the watermark read, the inbox+glance
   * hydration and the cursor stage — so `gateMs + hydrateMs` accounts for the
   * whole fold with no silent remainder. Exactly 0 on the quiet path, which is
   * the saving the optimization claims to deliver.
   */
  hydrateMs: number;
  /** Generation the CLIENT sent. `null` = it held none. */
  reqGen: string | null;
  /** Generation RETURNED to the client. */
  gen: string;
  /** The inbox floor MOVED — new mail actually reached THIS owner. See caveat 1. */
  inboxAdvanced: boolean;
  /** Rows the inbox surface carried; `null` when the leg did not run or failed. */
  inboxTotal: number | null;
  /**
   * Did the GLANCE leg run on this fold?
   *
   * Before the legs were split, this was redundant with `changed` — one gate
   * opened both surfaces, so glance ran exactly when the fold was expensive.
   * It is no longer derivable: a `glance-only` fold has `changed === false`
   * (the INBOX gate stayed shut, correctly) while still paying a hydration.
   * Without this field such a fold would read as `quiet` with a non-zero
   * `hydrateMs`, i.e. the instrument would contradict itself on the very path
   * the split introduces.
   */
  glanceHydrated: boolean;
}

export interface CoordFoldObservation {
  /**
   * The `changed` the fold ACTUALLY acted on — passed in, never re-derived here.
   * An instrument that recomputed the decision it observes could disagree with
   * the code it is measuring and report the disagreement as data.
   */
  changed: boolean;
  complete: boolean;
  forceResync: boolean;
  reqGen: string | null | undefined;
  gen: string;
  foldMs: number;
  gateMs: number;
  hydrateMs: number;
  inboxAdvanced: boolean;
  inboxTotal: number | null;
  /**
   * The GLANCE leg ran even though the INBOX gate stayed shut. Carried in from
   * the fold for the same reason as `changed`: this labeller observes decisions,
   * it never re-derives them.
   */
  glanceOnly: boolean;
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function emptyToNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Label WHY the gate read as it did.
 *
 * Ordered to match `buildActivityHookBundle`'s own expression
 * (`force_resync === true || request.generation !== generation`): force-resync
 * wins, then an absent client generation, then a genuine mismatch.
 *
 * ⚠ This LABELS a decision that was already made; it does not make one. The
 * `changed` flag is carried in from the fold. `censusCoordFold` asserts the two
 * agree, so a future edit that changes the gate expression without changing this
 * labeller reds a test instead of silently mislabelling a whole window.
 */
export function coordFoldReason(input: {
  changed: boolean;
  forceResync: boolean;
  reqGen: string | null | undefined;
  gen: string;
  glanceOnly?: boolean;
}): CoordFoldReason {
  if (input.forceResync) return 'force-resync';
  const reqGen = emptyToNull(input.reqGen);
  if (reqGen === null) return 'no-client-generation';
  // `glance-only` is a SHUT inbox gate that still hydrated, so it can only
  // displace the two cheap labels — never `generation-mismatch`, which means the
  // inbox leg genuinely ran. Checking it after `changed` keeps that impossible
  // by construction rather than by convention.
  if (reqGen !== input.gen) {
    if (input.changed) return 'generation-mismatch';
    return input.glanceOnly === true ? 'glance-only' : 'owner-irrelevant';
  }
  return input.glanceOnly === true ? 'glance-only' : 'quiet';
}

/**
 * Census one fold. PURE (observation -> record), so every branch is testable
 * with no database, no cursor store and no tool context.
 */
export function censusCoordFold(observation: CoordFoldObservation): CoordFoldCensus {
  const reason = coordFoldReason(observation);
  return {
    v: COORD_FOLD_CENSUS_VERSION,
    changed: observation.changed,
    reason,
    complete: observation.complete,
    foldMs: nonNegativeInt(observation.foldMs),
    gateMs: nonNegativeInt(observation.gateMs),
    hydrateMs: nonNegativeInt(observation.hydrateMs),
    reqGen: emptyToNull(observation.reqGen),
    gen: observation.gen,
    inboxAdvanced: observation.inboxAdvanced === true,
    inboxTotal:
      typeof observation.inboxTotal === 'number' && Number.isFinite(observation.inboxTotal)
        ? Math.max(0, Math.trunc(observation.inboxTotal))
        : null,
    // The glance leg runs on BOTH expensive paths: whenever the inbox gate
    // opened (the legs still hydrate together there) and on a glance-only fold.
    glanceHydrated: observation.changed === true || observation.glanceOnly === true,
  };
}

/**
 * Build the `observe` sink for one tool invocation — the ONE place that knows
 * how this census reaches `tool_invocations.metadata_json`.
 *
 * Returns `undefined` when the ctx carries no metadata channel, so a non-tool
 * caller (a test, a script, an internal re-use) wires nothing rather than
 * throwing.
 *
 * ⚠ THE CAST IS THE DANGEROUS PART, NOT THE CALL. `ctx.metadata` is
 * overwrite-not-merge, last write wins (dispatch-stack.ts:550-552): the
 * accumulator is REPLACED by each call, never merged into. `activity:report`
 * is safe today only because this is its ONLY metadata call (verified against a
 * positive control at install time) — adding a second anywhere on that handler
 * would kill this census with nothing failing, which is indistinguishable from
 * the fold never running. If you need to stamp something else from that
 * handler, extend THIS record; do not add a second `ctx.metadata()` call.
 */
export function coordFoldObserverFor(ctx: unknown): ((census: CoordFoldCensus) => void) | undefined {
  const emit = (ctx as { metadata?: (d: Record<string, unknown>) => void } | null | undefined)?.metadata;
  if (typeof emit !== 'function') return undefined;
  return (census: CoordFoldCensus) => {
    // Fail-soft: an instrument that can break the path it measures is worse than
    // no instrument — and this one sits on the fleet's synchronous hook path.
    try {
      emit({ [COORD_FOLD_CENSUS_KEY]: census });
    } catch {
      /* the census must never fail the fold it measures */
    }
  };
}
