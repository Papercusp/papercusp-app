/**
 * presence-tier1.ts — the cheap per-agent "Tier-1" enrichment for coord:presence
 * (presence-v2-2026-06-14 P-003). These near-free scalars (~5-15 tokens/agent)
 * turn the roster from "who's alive" into "who's doing what, blocked on what,
 * safe to assign/wake":
 *   - lastActiveSecAgo — seconds since GENUINE activity, distinct from the
 *     keepalive-polluted heartbeat. P-011: derived from the FRESHER of two
 *     under-reporting sources — coord_presence.last_active_at (D-003, bumps only on
 *     papercusp tool dispatch, so it misses native-tool/streaming work) and the
 *     freshest assistant-authored session_turn_parts row (sees everything the
 *     transcript sees, but rides the ingest pipeline). Provenance is emitted as
 *     lastActiveSource; flag PRESENCE_TURN_PARTS_FRESHNESS is the kill-switch.
 *   - intentStale      — derived: TRUE when lastActiveSecAgo is past the staleness
 *     threshold, so a reader knows the agent's declared intent / lane is NOT being
 *     actively progressed even though its process still heartbeats (stale-ownership-
 *     activity-truth: the 60s supervisor beat keeps a parked/idle psu host "alive",
 *     so a heartbeat-only read makes peers/Queen think abandoned work is handled).
 *   - claimedItems     — the agent's plan-item lane (plan_item_claims).
 *   - claimCount       — unified occupancy across plan-item and work-item claims.
 *   - model            — its model tier (spawned_agents.model_tier).
 *   - awaitingEvent(+key/note) — is it parked on an events:await (blocked-on)?
 *   - wakeMode         — auto/manual.
 *
 * STORE MAXIMAL, READ MINIMAL (D-001): each source is ONE batch query keyed by
 * the roster's ownerIds, so enriching N agents is a constant ~4 reads, not 4N.
 * agentRole + hive_slug already ride the coord_presence row (P-002), so they need
 * no join here. Heavier Tier-2/3 detail (lock queue, await bodies) stays behind
 * include_detail (P-011, Phase 5). The pure halves (computeLastActiveSecAgo /
 * mergeTier1) are unit-tested; fetchPresenceTier1 is the IO seam.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getDefaultWakeMode, getWakeModeOverridesFor, type WakeMode } from './wake-mode';
import { planItemRef } from '../../issue-blocks-merge';
import { ISSUE_TERMINAL_STATUSES } from '../../work-item-blocking';
import { TERMINAL_STATUSES as FEATURE_TERMINAL_STATUSES } from '../../dbos/frontier-readiness';

/**
 * A held work-item stops occupying its plan item once it is DONE — in either family.
 * The union of the two canonical terminal sets is deliberately family-agnostic: the
 * alternative is joining `item_kind` to pick a set, and the only rows that would
 * decide differently are cross-family impossibilities (an issue at `passed`, a
 * feature at `resolved`). Erring toward "terminal" there under-fires one coupling
 * edge; erring the other way FABRICATES one, which is the worse failure for a signal
 * whose whole point is that it be trustworthy when it speaks.
 *
 * ⚠ IMPORTED, NEVER RE-LITERALLED. A local `['resolved','closed']` copy of exactly
 * these sets is what made plan-item coverage read closed work as unworked for months
 * after the status unification (EI-18129037155166784) — the copy did not move when
 * the alias layer started persisting `done`/`dropped`.
 */
const WORK_ITEM_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  ...ISSUE_TERMINAL_STATUSES,
  ...FEATURE_TERMINAL_STATUSES,
]);

export interface PresenceTier1 {
  /** Seconds since genuine activity (last_active_at), or null if never/unknown. */
  lastActiveSecAgo: number | null;
  /** Derived: TRUE when genuine activity is staler than INTENT_STALE_SEC, so the
   *  agent's declared intent / lane should be read as NOT actively progressing
   *  (its process may still heartbeat). null when activity is unknown. */
  intentStale: boolean | null;
  /** Plan-item ids the agent currently holds (its lane). */
  claimedItems: string[];
  /** Unified occupancy count across the independent plan-item and work-item
   *  claim domains. This count projection does not merge work-item ids into
   *  `claimedItems`, whose contract remains the plan-item lane. */
  claimCount?: number;
  /** Unified work-item ids held by this owner; used only to classify a dead
   *  process as `suspect` until claim cleanup finishes. Not emitted in the
   *  compact presence payload. */
  workItemClaims?: string[];
  /** PLAN-QUALIFIED refs (`<plan_slug>#<item_id>`, {@link planItemRef}) of the plan
   *  items this owner occupies through a held, NON-TERMINAL work-item carrying a
   *  `payload.plan_item` stamp — the plan-item lane the fleet actually records
   *  (EI-20200393414409502).
   *
   *  ⚠ WHY THIS EXISTS BESIDE `claimedItems`, WHICH LOOKS LIKE IT ALREADY ANSWERS IT.
   *  `claimedItems` comes SOLELY from `plan_item_claims`, and that surface is ~6x less
   *  used here than work-item claims: measured 2026-08-11, 5 agents held a live
   *  plan-item claim while 31 held work-items, and ZERO plans had the two co-holders
   *  `blocks-me` needs — so the relation reported a permanent, error-free zero for the
   *  whole 14-day census window while 6 plans had co-located agents and blocked items.
   *  Deriving occupancy from the stamp is what makes that signal reachable at all.
   *
   *  OMITTED (not `[]`) when the owner occupies nothing, so `pick` drops it from the
   *  emitted row and the common case costs zero payload bytes.
   *
   *  Refs are FULLY QUALIFIED on purpose: a bare `P-003` is plan-local, so comparing
   *  one across plans couples two agents over an identifier collision. Qualifying them
   *  is also what lets a peer count as "on my plan" through work it holds there even
   *  when it declares a different `currentPlanSlug`. */
  claimedPlanItemRefs?: string[];
  /** Model tier the agent runs on (opus/sonnet/haiku…), or null. */
  model: string | null;
  /** True iff the agent is parked on an events:await (blocked-on). */
  awaitingEvent: boolean;
  /** The event key it awaits, if any. */
  awaitingEventKey: string | null;
  /** The await note (why it's blocked), if any. */
  awaitingNote: string | null;
  /** Effective wake mode (auto/manual). */
  wakeMode: WakeMode;
  /** P-011 (goal-mode-design-intent-hardening-2026-08-16): the freshest
   *  assistant-authored transcript part (session_turn_parts.ts, speaker='assistant')
   *  within {@link TURN_PART_FRESHNESS_WINDOW_SEC}, as an ISO string. Activity
   *  evidence the coord activity path cannot see — native client tools and mid-turn
   *  streaming never dispatch through papercusp, so last_active_at lags them
   *  (~4min measured live). Absent when no recent part exists or the
   *  PRESENCE_TURN_PARTS_FRESHNESS flag is off. Derivation INPUT only: mergeTier1
   *  strips it before the join spread, so the raw timestamp never rides an emitted
   *  row (the PRESENCE_DROPPED_FIELDS discipline). */
  turnPartLastAt?: string;
}

/** The join-derived half of the enrichment (everything except the record-derived
 *  lastActiveSecAgo + its derived intentStale). */
export type PresenceTier1Joins = Omit<PresenceTier1, 'lastActiveSecAgo' | 'intentStale'>;

/** Pure unified occupancy projection; both independent claim lanes contribute. */
export function deriveUnifiedClaimCount(
  planItemClaims: readonly string[] | null | undefined,
  workItemClaims: readonly string[] | null | undefined,
): number {
  return (planItemClaims?.length ?? 0) + (workItemClaims?.length ?? 0);
}

/** Pure: seconds since lastActiveAt (clamped ≥0), or null when unset/unparseable. */
export function computeLastActiveSecAgo(lastActiveAt: string | null, nowMs: number): number | null {
  if (!lastActiveAt) return null;
  const t = Date.parse(lastActiveAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/** Staleness threshold (seconds) past which a declared intent / lane is read as
 *  NOT actively progressing. A psu host's supervisor beat refreshes heartbeat_at
 *  every 60s while the OS process lives — independent of genuine work — so a
 *  parked/idle session reads as a live owner forever on a heartbeat-only check
 *  (stale-ownership-activity-truth). last_active_at (mig 277) bumps ONLY on real
 *  activity; this threshold is how stale that may get before "who's on what"
 *  stops trusting the declared intent. Default 30m; env-overridable. */
export const INTENT_STALE_SEC = (() => {
  const v = Number(process.env.PAPERCUSP_INTENT_STALE_SEC ?? 30 * 60);
  return Number.isFinite(v) && v > 0 ? v : 30 * 60;
})();

/** P-011: lookback for the transcript-freshness leg. A part older than this cannot
 *  flip an intentStale verdict (threshold INTENT_STALE_SEC) in either direction, so
 *  the query stays bounded on the ingested_at index (the table's only time index)
 *  instead of scanning the ~600k-row corpus. 2× the staleness threshold, floored at
 *  1h so a tiny env override never starves the leg. */
export const TURN_PART_FRESHNESS_WINDOW_SEC = Math.max(2 * INTENT_STALE_SEC, 3600);

/** Which activity source produced the emitted lastActiveSecAgo reading (P-011). */
export type LastActiveSource = 'presence' | 'turn-parts';

/**
 * Pure: combine the two activity sources into the freshest defensible reading.
 * Both UNDER-report (last_active_at misses native-tool/streaming work; turn parts
 * ride an ingest pipeline with its own lag), neither over-reports — an assistant
 * part at ts=T proves the agent produced output at T — so max() is a strictly
 * better lower bound than either alone. Tie goes to 'presence': the transcript
 * leg only claims the reading when it strictly improves it.
 */
export function deriveLastActive(
  recordLastActiveAt: string | null,
  turnPartLastAt: string | null | undefined,
  nowMs: number,
): { lastActiveSecAgo: number | null; lastActiveSource: LastActiveSource | null } {
  const rec = recordLastActiveAt == null ? NaN : Date.parse(recordLastActiveAt);
  const tp = turnPartLastAt == null ? NaN : Date.parse(turnPartLastAt);
  const recOk = !Number.isNaN(rec);
  const tpOk = !Number.isNaN(tp);
  if (!recOk && !tpOk) return { lastActiveSecAgo: null, lastActiveSource: null };
  const useTurnParts = tpOk && (!recOk || tp > rec);
  const t = useTurnParts ? tp : rec;
  return {
    lastActiveSecAgo: Math.max(0, Math.round((nowMs - t) / 1000)),
    lastActiveSource: useTurnParts ? 'turn-parts' : 'presence',
  };
}

/** Pure: is a declared intent STALE — genuine activity older than the threshold?
 *  null when activity is unknown (lastActiveSecAgo null → can't judge). Exported so
 *  the boundary is unit-tested without PG. */
export function computeIntentStale(
  lastActiveSecAgo: number | null,
  thresholdSec: number = INTENT_STALE_SEC,
): boolean | null {
  if (lastActiveSecAgo == null) return null;
  return lastActiveSecAgo > thresholdSec;
}

/** Re-exported from `../../format/relative-time`, where the pure formatters
 *  live. It moved because THIS module imports `getOrgPg`: a browser component
 *  needing the one pure function would otherwise have pulled Postgres into the
 *  SPA bundle. Re-exported rather than relocated-and-updated at every call site
 *  so existing importers (and this module's own test) stay untouched. */
export { formatIdleAge } from '../../format/relative-time';

/** How much older `intentAgeSec` may run past `lastActiveSecAgo` before the gap
 *  itself counts as drift (EI-8988) — a busy agent (fresh lastActiveSecAgo) whose
 *  declared intent TEXT hasn't been touched in a while. Deliberately smaller than
 *  INTENT_STALE_SEC: intentStale answers "is this agent idle"; intentDivergent
 *  answers "is this agent active but possibly on undeclared work" — a narrower,
 *  earlier-firing signal. Default 15m; env-overridable. */
export const INTENT_DIVERGENCE_SEC = (() => {
  const v = Number(process.env.PAPERCUSP_INTENT_DIVERGENCE_SEC ?? 15 * 60);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60;
})();

/**
 * Pure: does the declared intent TEXT look stale relative to the agent's own
 * genuine activity — i.e. it's doing real work (lastActiveSecAgo fresh) but the
 * intent string hasn't been re-declared in a while (intentAgeSec old)? This is
 * the "declared-vs-derived divergence" EI-8988 asks for: a useful drift signal
 * distinct from intentStale (which only fires when the agent is ALSO idle).
 * null when either side is unknown (can't judge a federated/never-active peer).
 */
export function computeIntentDivergent(
  intentAgeSec: number | null,
  lastActiveSecAgo: number | null,
  thresholdSec: number = INTENT_DIVERGENCE_SEC,
): boolean | null {
  if (intentAgeSec == null || lastActiveSecAgo == null) return null;
  return intentAgeSec - lastActiveSecAgo > thresholdSec;
}

/** P-011: is the transcript-freshness leg on? Fail-soft to OFF (skip the leg, keep
 *  the presence-only derivation) when flag infra is unavailable — early boot and
 *  unit tests must not fail the roster over an enrichment leg. */
async function turnPartFreshnessEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.PRESENCE_TURN_PARTS_FRESHNESS, 'system');
  } catch {
    return false;
  }
}

/**
 * IO seam: one batch query each for claims / model / active-awaits + the
 * wake-mode overrides, all keyed by ownerId. Returns the join-derived
 * enrichment per owner. ownerIds should be the LOCAL roster (federated `fed:…`
 * ids never match these local tables, so passing them just wastes a comparison).
 */
export async function fetchPresenceTier1(
  ownerIds: string[],
): Promise<Map<string, PresenceTier1Joins>> {
  const out = new Map<string, PresenceTier1Joins>();
  if (ownerIds.length === 0) return out;
  const { sql } = getOrgPg();

  const [claims, workItemClaims, models, awaits, wakeOverrides, wakeDefault, turnParts] = await Promise.all([
    sql<{ owner: string; items: string[] }[]>`
      SELECT owner, array_agg(item_id ORDER BY item_id) AS items
        FROM harness_shared.plan_item_claims
       WHERE owner = ANY(${ownerIds}::text[]) AND expires_ts > now()
        GROUP BY owner`,
    // UNGROUPED on purpose (it used to `array_agg … GROUP BY taken_by`): the rows
    // now carry the `payload.plan_item` stamp too, and the ref is built in TS with
    // `planItemRef` rather than concatenated in SQL. That is the single-sourcing
    // that matters here — the consumer (coupling-derivation) parses the same
    // format, and a `'#'` literal in this query would be a second definition of it
    // free to drift. Roster-bounded and tiny: 63 rows across 36 owners fleet-wide
    // at the time of writing, max 7 per owner.
    sql<
      {
        taken_by: string;
        feature_id: string;
        status: string | null;
        plan_slug: string | null;
        item_id: string | null;
      }[]
    >`
      SELECT taken_by, feature_id, status,
             payload->'plan_item'->>'plan_slug' AS plan_slug,
             payload->'plan_item'->>'item_id'   AS item_id
        FROM harness_shared.work_items
       WHERE taken_by = ANY(${ownerIds}::text[])`,
    sql<{ session_owner: string; model_tier: string | null }[]>`
      SELECT DISTINCT ON (session_owner) session_owner, model_tier
        FROM harness_shared.spawned_agents
       WHERE session_owner = ANY(${ownerIds}::text[])
         AND status IN ('running', 'restarting')
       ORDER BY session_owner, heartbeat_at DESC NULLS LAST`,
    sql<{ subscriber_id: string; event_key: string; note: string | null }[]>`
      SELECT DISTINCT ON (subscriber_id) subscriber_id, event_key, note
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ANY(${ownerIds}::text[])
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())
       ORDER BY subscriber_id, created_at DESC`,
    // Owner-scoped like its siblings (WI-10005228): a PK probe for this roster's
    // owners, not every override ever written.
    getWakeModeOverridesFor(ownerIds),
    getDefaultWakeMode(),
    // P-011: freshest assistant-authored part per owner. workspace_id='default' is the
    // CORPUS namespace literal, deliberately not a tenant id (session-ingest.ts hardcodes
    // it; a tenant predicate here matches zero rows — buildCorpusNamespaceAdvisory).
    // speaker='assistant' only: a machine-INJECTED prompt (loop fire, wake pump) lands as
    // a user part even when the session produces no turn, and must not read as activity.
    // Bounded on ingested_at (the indexed column) while reading ts (the activity instant).
    turnPartFreshnessEnabled()
      .then((enabled) =>
        enabled
          ? sql<{ owner: string; last_part_ts: string | Date }[]>`
              SELECT owner, max(ts) AS last_part_ts
                FROM harness_shared.session_turn_parts
               WHERE workspace_id = 'default'
                 AND owner = ANY(${ownerIds}::text[])
                 AND speaker = 'assistant'
                 AND ts IS NOT NULL
                 AND ingested_at > now() - make_interval(secs => ${TURN_PART_FRESHNESS_WINDOW_SEC})
               GROUP BY owner`
          : ([] as { owner: string; last_part_ts: string | Date }[]),
      )
      // Fail-soft: a corpus hiccup degrades this leg to presence-only, never the roster.
      .catch(() => [] as { owner: string; last_part_ts: string | Date }[]),
  ]);

  const claimsByOwner = new Map(claims.map((r) => [r.owner, r.items ?? []]));
  const workItemClaimsByOwner = new Map<string, string[]>();
  const planItemRefsByOwner = new Map<string, Set<string>>();
  for (const r of workItemClaims) {
    const held = workItemClaimsByOwner.get(r.taken_by);
    if (held) held.push(r.feature_id);
    else workItemClaimsByOwner.set(r.taken_by, [r.feature_id]);
    if (!r.plan_slug || !r.item_id) continue;
    if (r.status != null && WORK_ITEM_TERMINAL_STATUSES.has(r.status)) continue;
    const refs = planItemRefsByOwner.get(r.taken_by);
    if (refs) refs.add(planItemRef(r.plan_slug, r.item_id));
    else planItemRefsByOwner.set(r.taken_by, new Set([planItemRef(r.plan_slug, r.item_id)]));
  }
  // Sorted so the emitted STATE field is byte-stable across reads of an unchanged
  // agent — the delta/etag contract (D-005/D-006) the whole state lane rests on.
  for (const items of workItemClaimsByOwner.values()) items.sort();
  const modelByOwner = new Map(models.map((r) => [r.session_owner, r.model_tier]));
  const awaitByOwner = new Map(awaits.map((r) => [r.subscriber_id, r]));
  // Normalized to ISO here so the join field is a plain string regardless of how the
  // pg client materializes timestamptz (string vs Date differs by client config).
  const turnPartByOwner = new Map<string, string>();
  for (const r of turnParts) {
    turnPartByOwner.set(
      r.owner,
      r.last_part_ts instanceof Date ? r.last_part_ts.toISOString() : String(r.last_part_ts),
    );
  }

  for (const ownerId of ownerIds) {
    const aw = awaitByOwner.get(ownerId);
    const planItemRefs = planItemRefsByOwner.get(ownerId);
    const turnPartLastAt = turnPartByOwner.get(ownerId);
    const claimedItems = claimsByOwner.get(ownerId) ?? [];
    const workItems = workItemClaimsByOwner.get(ownerId) ?? [];
    out.set(ownerId, {
      claimedItems,
      claimCount: deriveUnifiedClaimCount(claimedItems, workItems),
      workItemClaims: workItems,
      // Omitted rather than `[]` when empty: `pick` drops undefined, so a roster of
      // agents occupying nothing pays no payload for the field at all.
      ...(planItemRefs && planItemRefs.size > 0
        ? { claimedPlanItemRefs: [...planItemRefs].sort() }
        : {}),
      model: modelByOwner.get(ownerId) ?? null,
      awaitingEvent: aw != null,
      awaitingEventKey: aw?.event_key ?? null,
      awaitingNote: aw?.note ?? null,
      wakeMode: wakeOverrides.get(ownerId) ?? wakeDefault,
      // Conditional so the field is ABSENT (not undefined) when no recent part exists —
      // exactOptionalPropertyTypes treats those differently, and absent is the contract.
      ...(turnPartLastAt != null ? { turnPartLastAt } : {}),
    });
  }
  return out;
}

/** P-011: drop the derivation-input timestamp from a join before spreading it onto an
 *  emitted row (the PRESENCE_DROPPED_FIELDS discipline — raw churning timestamps stay
 *  off the wire). Shared by mergeTier1 and the fleet/hive rosters so no spread site
 *  re-invents it and forgets. */
export function stripTurnPartLastAt(
  join: PresenceTier1Joins | undefined,
): Omit<Partial<PresenceTier1Joins>, 'turnPartLastAt'> {
  const { turnPartLastAt: _dropped, ...rest } = (join ?? {}) as Partial<PresenceTier1Joins>;
  return rest;
}

/**
 * Pure merge: attach the Tier-1 enrichment + derived lastActiveSecAgo to each
 * record. Records with no enrichment entry (e.g. federated peers) get
 * lastActiveSecAgo only; the join fields stay absent.
 */
export function mergeTier1<
  T extends { ownerId: string; lastActiveAt: string | null; intentDeclaredAt?: string | null },
>(
  records: T[],
  joins: Map<string, PresenceTier1Joins>,
  nowMs: number,
): Array<
  T & {
    lastActiveSecAgo: number | null;
    lastActiveSource: LastActiveSource | null;
    intentStale: boolean | null;
    intentAgeSec: number | null;
    intentDivergent: boolean | null;
  } & Partial<PresenceTier1Joins>
> {
  return records.map((r) => {
    const join = joins.get(r.ownerId);
    // P-011: turnPartLastAt is derivation INPUT — stripped so the raw timestamp never
    // rides the row (only the derived scalar + its provenance are emitted).
    const { lastActiveSecAgo, lastActiveSource } = deriveLastActive(
      r.lastActiveAt,
      join?.turnPartLastAt ?? null,
      nowMs,
    );
    const intentAgeSec = computeLastActiveSecAgo(r.intentDeclaredAt ?? null, nowMs);
    return {
      ...r,
      ...stripTurnPartLastAt(join),
      // Derived AFTER the joins spread so neither the record nor a join can shadow it.
      lastActiveSecAgo,
      lastActiveSource,
      intentStale: computeIntentStale(lastActiveSecAgo),
      intentAgeSec,
      intentDivergent: computeIntentDivergent(intentAgeSec, lastActiveSecAgo),
    };
  });
}
