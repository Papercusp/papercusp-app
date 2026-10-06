/**
 * fleet/assignments — the typed reader over `harness_shared.fleet_assignment`,
 * the canonical "who's on what" view (state-not-chat-fleet-state-2026-06-05,
 * D-002 / P-002).
 *
 * The view is CLAIM-PRIMARY: every claim row (plan-item lease, durable
 * assignment, work-item taken_by) carries its holder's presence LEFT-joined in,
 * so an orphaned claim — a live lease whose holder is absent/stale — survives
 * the read (a presence-primary join would silently drop it; that orphan is the
 * single most important signal). Presence rows ride along (source='presence')
 * as the by-agent backbone so idle agents answer "what is X doing" too.
 *
 * This module is the ONE place that reads the view: the `fleet:assignments`
 * tool and the /api/adv/roster enrichment both come through here. The PG I/O
 * is a thin `listFleetAssignments`; the grouping + smell selectors are pure so
 * they unit-test without PG.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../workspace-id-constant';
import { isActivelyWorked, isReclaimable, type ItemActivity } from '../item-activity';
import { endedRecordedOwnerIds, recordedLiveOwnerIds } from '../adv-sessions';
import { STALE_CLAIM_GRACE_MS } from '../work-items-stale-claims';
export type { PlanItemLaneBlock } from '../scheduler/plan-item-lane-guard';
import type { PlanItemLaneBlock } from '../scheduler/plan-item-lane-guard';

/** A presence row whose workspace is '*' belongs to every workspace's fleet. */
const GLOBAL_WORKSPACE = '*';

export type FleetAssignmentSource =
  | 'presence'
  | 'plan_item_claim'
  | 'plan_item_assignment'
  | 'work_item_claim';

/** One row of the view — one assignment/presence fact. */
export interface FleetAssignmentRow {
  source: FleetAssignmentSource;
  workspaceId: string;
  /** ownerId (su-…) for presence/claims; the agent-NAME for assignments. */
  agentId: string | null;
  agentLabel: string | null;
  agentName: string | null;
  harnessSlug: string | null;
  planSlug: string | null;
  /** P-NNN for plan-item rows. */
  itemId: string | null;
  /** WI-/F-/EI- id for work-item rows. */
  workItemId: string | null;
  itemKind: string | null;
  /** Claim intent / work-item title / presence intent. */
  detail: string;
  status: string | null;
  claimAcquiredTs: string | null;
  claimExpiresTs: string | null;
  /** Lease unexpired (plan-item claims); true for assignment/work rows; null for presence. */
  claimActive: boolean | null;
  livenessMode: string | null;
  lastActivityTs: string | null;
  /** The holder has a coord_presence row at all. */
  holderPresent: boolean;
  /** …and its heartbeat is fresh (PRESENCE_STALE_MS window). */
  holderAlive: boolean;
  holderHeartbeatAt: string | null;
  holderIntent: string | null;
  holderPlanSlug: string | null;
  /** THE signal: an active claim whose holder is DEAD = abandoned work. */
  orphaned: boolean;
  /** THE second signal (agent-activity-liveness-truth P-002, D-001): an active
   *  work-item claim whose holder is ALIVE but the work is NOT advancing — no
   *  item-scoped progress within the STALE_MS window. A claim is not progress.
   *  Mutually exclusive with `orphaned`; null on legs with no progress signal
   *  (plan-item claim/assignment, presence). Both are RECLAIMABLE. */
  stalled: boolean | null;
  /** Last REAL item-scoped progress (a state transition / checkpoint) on the
   *  claimed work-item, or null (no progress recorded / not a work-item claim). */
  lastProgressAt: string | null;
  /** Holder's self-declared plan matches the claim's plan (null when n/a). */
  declaredPlanMatches: boolean | null;
  /** Per-assignee position in the holder's ordered work-list (local-hive P-021).
   *  work-item rows only; null on plan-item/assignment/presence rows. */
  assigneeRank: number | null;
  /** Who set assigneeRank — 'cup' | 'mug' (the propose/dispose audit, D-008). */
  rankWriter: string | null;
  /** named-su-agent-fleets P-005: the holder's named-fleet slug (the SOFT
   *  coord_presence membership label, surfaced by the view via the presence join,
   *  mig 407), or null when the holder is in no fleet / not present. Optional so a
   *  partial test/synthesizer row need not set it; `listFleetAssignments` always does. */
  fleetSlug?: string | null;
  /** named-su-agent-fleets P-005: the holder's role within the fleet
   *  ('leader' | 'member'), or null. */
  fleetRole?: string | null;
}

/**
 * The single derived activity label for one fleet_assignment row (agent-activity-
 * liveness-truth P-005, D-002): the ONE truth every reader uses instead of
 * trusting a claim or a stale "spawned for X" broadcast. Projected straight from
 * the view's already-computed `orphaned`/`stalled` booleans + the progress
 * signal, so it can NEVER drift from the SQL the reconciler reads. This is the
 * view-row expression of {@link classifyItemActivity} (the pure canonical spec);
 * a P-007 test pins the two to agree. "Actively worked" ≡ `progressing` only.
 */
export function deriveActivity(
  r: Pick<FleetAssignmentRow, 'agentId' | 'orphaned' | 'stalled' | 'lastProgressAt' | 'holderAlive'>,
): ItemActivity {
  if (!r.agentId) return 'free';
  if (r.orphaned) return 'dead';
  if (r.stalled) return 'stalled';
  if (r.holderAlive) return r.lastProgressAt ? 'progressing' : 'alive';
  return 'reserved';
}

/**
 * Reconcile the view's HEARTBEAT-derived liveness with the AUTHORITATIVE session
 * state (EI-6374). The `fleet_assignment` view derives `holder_alive`/`orphaned`
 * from `coord_presence.heartbeat_at` freshness ALONE, so a bee that has ENDED —
 * process exited, coord inbox-wake await cancelled — keeps reading `alive` /
 * `progressing` for up to PRESENCE_STALE_MS (the heartbeat lags the exit). That
 * false coverage is exactly what let a dead bee look "covered" while
 * `coord:send {wake:'required'}` reported it `ended` and not wakeable — blocking
 * correct replacement. Given the authoritative ended-owner set (from
 * {@link endedRecordedOwnerIds} — the holder's recorded session has ended),
 * drop the warm-heartbeat liveness on every one of that owner's rows and mark its
 * LIVE claim legs orphaned, so {@link deriveActivity} resolves them to `dead`
 * (reclaimable) — agreeing with `coord:presence`'s `ended` sessionState and the
 * wake path.
 *
 * PURE (rows + set in → rows out) so it unit-tests without PG. A no-op when the
 * ended set is empty. Only DOWNGRADES a currently-alive holder (`holderAlive`
 * true) — it never revives a dead/stalled row and never touches a holder outside
 * the ended set.
 */
export function downgradeEndedHolders(
  rows: FleetAssignmentRow[],
  endedOwnerIds: ReadonlySet<string>,
): FleetAssignmentRow[] {
  if (endedOwnerIds.size === 0) return rows;
  return rows.map((r) => {
    if (!r.agentId || !r.holderAlive || !endedOwnerIds.has(r.agentId)) return r;
    const isClaim = r.source !== 'presence';
    return {
      ...r,
      holderAlive: false,
      // A live claim held by a confirmed-dead session is abandoned → orphaned.
      orphaned: isClaim && r.claimActive !== false ? true : r.orphaned,
    };
  });
}

/**
 * Reconcile the view's heartbeat/presence liveness with the session log in the
 * opposite direction of {@link downgradeEndedHolders}: an agent can be
 * authoritatively LIVE in `adv_sessions` before it has registered coord presence
 * or an inbox-wake await (launch/bootstrap window). In that case the holder is
 * not orphaned; it is recorded-live and still bootstrapping.
 */
export function upgradeRecordedLiveHolders(
  rows: FleetAssignmentRow[],
  recordedLiveOwnerIds: ReadonlySet<string>,
): FleetAssignmentRow[] {
  if (recordedLiveOwnerIds.size === 0) return rows;
  return rows.map((r) => {
    if (!r.agentId || !recordedLiveOwnerIds.has(r.agentId)) return r;
    const isClaim = r.source !== 'presence';
    return {
      ...r,
      holderPresent: true,
      holderAlive: true,
      // A live recorded session may not have coord presence/wakeability yet; its
      // active claims are not abandoned during that bootstrap window.
      orphaned: isClaim && r.claimActive !== false ? false : r.orphaned,
    };
  });
}

/**
 * Reconcile the view's `orphaned` flag against an ALREADY-confirmed liveness
 * verdict from an out-of-band oracle, for holders {@link downgradeEndedHolders}
 * can never key on.
 *
 * `downgradeEndedHolders` only fires for owners in `endedRecordedOwnerIds` —
 * `harness_shared.adv_sessions`, which is keyed by `coord_owner_id` (a psu/su
 * `su-<uuid>` SESSION). A non-session, ROLE-STRING principal (e.g.
 * 'improvement-runner') never gets an `adv_sessions` row at all, so that
 * producer has no key to match even when it is genuinely gone — and the view's
 * OWN `holder_alive`/`orphaned` come from heartbeat freshness alone, which can
 * stay warm well past process death. The result: a confirmed-dead holder's
 * active claim can pass through neither `orphaned` (this reconciler) nor
 * `stalled` (the progress-based leg), invisible to every reclaim reader
 * (EI-18698865231464142 — `fleet:assignments` itself reported
 * `verdict:'dead'`/`sessionState:'ended'` for such a holder while
 * `summary.orphaned_claims:0` and `orphaned:[]`).
 *
 * The caller (fleet:assignments) already resolves the FULLER wakeability-based
 * oracle verdict (`sessionState`, via `deriveVerdict`/`reconcileWakeability`) for
 * every agent, independent of whether it has an adv_sessions row. Passing that
 * settled confirmed-dead set here closes the gap: this function does no
 * liveness derivation of its own — it only propagates a verdict the caller
 * already trusts onto any active claim row that verdict never reached.
 *
 * PURE (rows + set in → rows out) so it unit-tests without PG. A no-op when the
 * set is empty. Only flips `orphaned` true on an active, non-presence claim row
 * that is not ALREADY orphaned or stalled — it never revives a row, never
 * touches a holder outside the set, and never overrides the stall detector.
 */
export function reconcileOrphanedWithVerdicts(
  rows: FleetAssignmentRow[],
  deadOwnerIds: ReadonlySet<string>,
): FleetAssignmentRow[] {
  if (deadOwnerIds.size === 0) return rows;
  return rows.map((r) => {
    if (
      !r.agentId ||
      r.source === 'presence' ||
      r.claimActive === false ||
      r.orphaned ||
      r.stalled ||
      !deadOwnerIds.has(r.agentId)
    ) {
      return r;
    }
    return { ...r, orphaned: true, holderAlive: false };
  });
}

export interface ListFleetAssignmentsOpts {
  /** Scope to a workspace (+ the '*' global rows). null/undefined = all. */
  workspaceId?: string | null;
  /** Match agent_id OR agent_name exactly. */
  agent?: string;
  /** Match plan_slug exactly. */
  plan?: string;
  /** Match harness_slug exactly. */
  harness?: string;
  /** Match fleet_slug exactly (EI-18689331932953939) — "who's on fleet F", the
   *  natural per-fleet scope a fleet leader/member reaches for. */
  fleet?: string;
  /** Drop lapsed plan-item leases (claim_active=false). Default true. */
  activeOnly?: boolean;
  /** Restrict to these plan-item refs (`<plan>#<P-NNN>`). */
  planItemRefs?: readonly string[];
  /** Include every direct claim in this plan alongside linked work-item ids. */
  planItemPlan?: string;
  /** Restrict to these linked work-item ids. */
  workItemIds?: readonly string[];
}

const toIso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

/** Read the canonical view. One query answers every projection. */
export async function listFleetAssignments(
  opts: ListFleetAssignmentsOpts = {},
): Promise<FleetAssignmentRow[]> {
  const { sql } = getOrgPg();
  const activeOnly = opts.activeOnly !== false;
  const rows = await sql`
    SELECT * FROM harness_shared.fleet_assignment
    WHERE ${
      opts.workspaceId != null
        ? // EI-295: the view UNIONs rows from TWO scoping domains — presence
          // stamps the AGENT's workspace (e.g. 'papercusp-workspace'), while
          // plan-item claims stamp the PLAN-STORE scope (resolvePlanScope →
          // DEFAULT_WORKSPACE_ID for operator-scope plans). Filtering the
          // union by the presence workspace alone silently dropped EVERY
          // claim row, so fleet:assignments / the Mug's placement reads /
          // the claim-discipline watcher all ran on claims:0 fleet-wide.
          // Accept the plan-store default alongside the caller's workspace
          // until the workspace axes are unified (federation lane).
          sql`(workspace_id = ${opts.workspaceId} OR workspace_id = ${GLOBAL_WORKSPACE} OR workspace_id = ${DEFAULT_WORKSPACE_ID})`
        : sql`TRUE`
    }
      AND ${opts.agent ? sql`(agent_id = ${opts.agent} OR agent_name = ${opts.agent})` : sql`TRUE`}
      AND ${opts.plan ? sql`plan_slug = ${opts.plan}` : sql`TRUE`}
      AND ${
        opts.harness
          ? opts.agent || opts.plan || opts.fleet
            ? // EI-18683155325549123: `presence`-sourced rows carry harness_slug=NULL
              // BY DESIGN (identity/presence is workspace-scoped, never harness-bound —
              // see the view's presence branch in 430-fleet-membership-append-only-fact.sql).
              // An unconditional `harness_slug = opts.harness` AND'd onto such a read
              // silently zeroed rows whose ONLY signal is presence — exactly a fleet leader
              // or a just-spawned member holding no harness-scoped CLAIM yet. That is not
              // "the fleet is empty"; it is a scope mismatch between an identity signal
              // (harness-agnostic) and a work signal (harness-scoped).
              //
              // EI-21302052245180843 WIDENED this from `agent` to `agent || plan || fleet`.
              // The original fix reasoned that "a bare `{ harness }` listing (no agent) is
              // unaffected" — true, but `{ plan }` and `{ fleet }` are not bare listings and
              // were affected exactly like `{ agent }`. Measured live: `fleet:assignments
              // { plan: 'byoc-cloud-workspaces-gcp-aws-azure-2026-08-22', workspace, harness:
              // 'papercusp' }` returned agents:0 / candidates:0 while the SAME call without
              // `harness` returned ELEVEN live agents, every one carrying that exact
              // plan_slug. The canonical plan-scoped "who is on P" read was falsely empty.
              //
              // Admitting a NULL-harness presence row is safe here precisely BECAUSE another
              // predicate already pins it: the presence branch populates plan_slug (from
              // current_plan_slug) and fleet_slug, both of which are harness-scoped in
              // practice, and those clauses are ANDed alongside this one. A BARE `{ harness }`
              // listing still excludes presence rows — nothing pins them there, so admitting
              // them would leak agents working a different harness (EI-6176).
              sql`(harness_slug = ${opts.harness} OR (source = 'presence' AND harness_slug IS NULL))`
            : sql`harness_slug = ${opts.harness}`
          : sql`TRUE`
      }
      AND ${opts.fleet ? sql`fleet_slug = ${opts.fleet}` : sql`TRUE`}
      AND ${activeOnly ? sql`(claim_active IS DISTINCT FROM false)` : sql`TRUE`}
      AND ${
        opts.planItemRefs !== undefined || opts.planItemPlan !== undefined || opts.workItemIds !== undefined
          ? sql`(
              ${opts.planItemPlan !== undefined
                ? sql`(source = 'plan_item_claim' AND plan_slug = ${opts.planItemPlan})`
                : sql`FALSE`}
              OR
              ${opts.planItemRefs !== undefined
                ? opts.planItemRefs.length > 0
                  ? sql`(plan_slug || '#' || item_id) = ANY(${opts.planItemRefs}::text[])`
                  : sql`FALSE`
                : sql`FALSE`}
              OR
              ${opts.workItemIds !== undefined
                ? opts.workItemIds.length > 0
                  ? sql`work_item_id = ANY(${opts.workItemIds}::text[])`
                  : sql`FALSE`
                : sql`FALSE`}
            )`
          : sql`TRUE`
      }
    ORDER BY source, holder_heartbeat_at DESC NULLS LAST
  `;
  const mapped = rows.map(
    (r): FleetAssignmentRow => ({
      source: r.source as FleetAssignmentSource,
      workspaceId: r.workspace_id as string,
      agentId: (r.agent_id as string | null) ?? null,
      agentLabel: (r.agent_label as string | null) ?? null,
      agentName: (r.agent_name as string | null) ?? null,
      harnessSlug: (r.harness_slug as string | null) ?? null,
      planSlug: (r.plan_slug as string | null) ?? null,
      itemId: (r.item_id as string | null) ?? null,
      workItemId: (r.work_item_id as string | null) ?? null,
      itemKind: (r.item_kind as string | null) ?? null,
      detail: (r.detail as string | null) ?? '',
      status: (r.status as string | null) ?? null,
      claimAcquiredTs: toIso(r.claim_acquired_ts),
      claimExpiresTs: toIso(r.claim_expires_ts),
      claimActive: (r.claim_active as boolean | null) ?? null,
      livenessMode: (r.liveness_mode as string | null) ?? null,
      lastActivityTs: toIso(r.last_activity_ts),
      holderPresent: Boolean(r.holder_present),
      holderAlive: Boolean(r.holder_alive),
      holderHeartbeatAt: toIso(r.holder_heartbeat_at),
      holderIntent: (r.holder_intent as string | null) ?? null,
      holderPlanSlug: (r.holder_plan_slug as string | null) ?? null,
      orphaned: Boolean(r.orphaned),
      stalled: (r.stalled as boolean | null) ?? null,
      lastProgressAt: toIso(r.last_progress_at),
      declaredPlanMatches: (r.declared_plan_matches as boolean | null) ?? null,
      assigneeRank: r.assignee_rank == null ? null : Number(r.assignee_rank),
      rankWriter: (r.rank_writer as string | null) ?? null,
      fleetSlug: (r.fleet_slug as string | null) ?? null,
      fleetRole: (r.fleet_role as string | null) ?? null,
    }),
  );

  // EI-6374: the view's holder_alive/orphaned come from heartbeat freshness ALONE,
  // so a just-ENDED bee (warm heartbeat, but the process has exited) still reads
  // `alive` — falsely "covered", blocking replacement. Reconcile against POSITIVE
  // death evidence — the holder's own recorded session has ended (adv_sessions
  // .ended_at set), the SAME teardown that cancels the wake await — so an ended
  // holder resolves to `dead`. Best-effort → no change on any query error.
  // EI-8106 is the inverse launch-window drift: the session is recorded live and
  // actively bootstrapping before it has registered coord presence/wakeability,
  // so a heartbeat-only read can mark its fresh claim orphaned. Fold the
  // recorded-live session log into the same reader before returning rows.
  const owners = [...new Set(mapped.filter((r) => r.agentId).map((r) => r.agentId as string))];
  if (owners.length === 0) return mapped;
  const [ended, recordedLiveRaw] = await Promise.all([
    endedRecordedOwnerIds(owners),
    recordedLiveOwnerIds(owners),
  ]);
  const recordedLive = new Set([...recordedLiveRaw].filter((id) => !ended.has(id)));
  return downgradeEndedHolders(upgradeRecordedLiveHolders(mapped, recordedLive), ended);
}

// ───────────────────────── pure projections (no PG) ─────────────────────────

/** A claim attached to an agent group (the by-agent projection). */
export interface AgentClaim {
  type: 'plan-item' | 'work-item' | 'assignment';
  harnessSlug: string | null;
  planSlug: string | null;
  /** P-NNN (plan-item/assignment) or the work-item id. */
  id: string | null;
  itemKind: string | null;
  detail: string;
  status: string | null;
  acquiredTs: string | null;
  expiresTs: string | null;
  active: boolean;
  orphaned: boolean;
  /** Holder alive but work not advancing — reclaimable (work-item claims only). */
  stalled: boolean | null;
  /** Last item-scoped progress on the claim (work-item claims only). */
  lastProgressAt: string | null;
  /** The single derived truth: free|reserved|alive|progressing|stalled|dead (P-005). */
  activity: ItemActivity;
  /** P-005: claim-progress health, separate from holder liveness/activity. */
  claimHealth?: ClaimHealth;
  /** Position in the holder's ordered work-list (work-item claims only; null otherwise). */
  rank: number | null;
  /** Who set the rank — 'cup' | 'mug' (D-008). */
  rankWriter: string | null;
}

/** One agent with everything it holds — "what is X doing" in one object. */
export interface AgentAssignment {
  agentId: string;
  label: string | null;
  /** Adopted agent-NAME, when any of its claims carry one. */
  name: string | null;
  present: boolean;
  /** The liveness verdict-gated flag: starts as the fleet_assignment view's
   *  heartbeat-freshness and is DOWNGRADED by reconcileWakeability /
   *  reconcileRecordedSessions when the oracle says ended/suspect/draining
   *  (unification P-008: read `sessionState` for the full truth; `alive` is
   *  its boolean projection, kept for compat — the raw freshness signal is
   *  `heartbeatFresh`). */
  alive: boolean;
  /** RAW heartbeat freshness (within PRESENCE_STALE_MS) — a process-keepalive
   *  signal, NOT a liveness verdict (unification P-008). Never downgraded by
   *  the oracle, so a warm-dead session reads heartbeatFresh:true +
   *  sessionState:'ended'. Optional: presence-only synthesizers may omit it. */
  heartbeatFresh?: boolean;
  heartbeatAt: string | null;
  /** Self-declared intent (presence). */
  intent: string;
  /** Self-declared current plan (presence). */
  declaredPlanSlug: string | null;
  /** named-su-agent-fleets P-005: the agent's named-fleet slug (the SOFT presence
   *  membership label), or null when in no fleet. Optional so presence-only
   *  synthesizers (hive-roster) need not set it. */
  fleetSlug?: string | null;
  /** named-su-agent-fleets P-005: role within the fleet ('leader' | 'member'), or null. */
  fleetRole?: string | null;
  claims: AgentClaim[];
  /** Any active claim whose holder (this agent) is DEAD — abandoned work. */
  orphaned: boolean;
  /** Any active work-item claim this agent holds that is ALIVE but not advancing
   *  (no item-scoped progress in the window) — reclaimable (P-002/P-005). */
  stalled: boolean;
  /** Declared a plan but holds no claim/assignment on it — the D-002 smell. */
  declaredUnclaimed: boolean;
  // ── the externalized per-bee ordered work-list (local-hive P-021) ──
  /** Head-of-line: the lowest-rank work-item the agent holds (what it's doing / next).
   *  null when it holds no work-items. The Queen reads this for evict judgment. */
  doing: WorkListItem | null;
  /** The agent's work-items in rank order (head-of-line first; unranked last). The
   *  ordered plan the Queen reads for affinity. */
  queued: WorkListItem[];
  /** How many work-items the agent holds — the load signal for warm-inject vs a fresh
   *  slot (P-052). Counts work-item claims only (not plan-item leases). */
  load: number;
}

function toClaim(r: FleetAssignmentRow): AgentClaim {
  return {
    type:
      r.source === 'plan_item_claim'
        ? 'plan-item'
        : r.source === 'plan_item_assignment'
          ? 'assignment'
          : 'work-item',
    harnessSlug: r.harnessSlug,
    planSlug: r.planSlug,
    id: r.itemId ?? r.workItemId,
    itemKind: r.itemKind,
    detail: r.detail,
    status: r.status,
    acquiredTs: r.claimAcquiredTs,
    expiresTs: r.claimExpiresTs,
    active: r.claimActive !== false,
    orphaned: r.orphaned,
    stalled: r.stalled,
    lastProgressAt: r.lastProgressAt,
    activity: deriveActivity(r),
    claimHealth: deriveClaimHealth(r),
    rank: r.assigneeRank,
    rankWriter: r.rankWriter,
  };
}

/** One ordered work-list item — the externalized TodoWrite entry (local-hive P-021). */
export interface WorkListItem {
  /** WI-/F-/EI- id. */
  id: string;
  itemKind: string | null;
  title: string;
  status: string | null;
  rank: number | null;
  /** Who placed it — 'cup' (self-authored) | 'mug' (overlay) | null (unranked). */
  rankWriter: string | null;
  /** The derived truth for this held item (P-005): progressing = actively worked;
   *  stalled/dead = reclaimable (the holder isn't really advancing it). */
  activity: ItemActivity;
}

/**
 * Group view rows into per-agent assignments. Claim-primary: an agent with
 * claims but NO presence row still gets a group (present=false — the orphan).
 * Name-keyed assignment rows merge into the ownerId group whose claims carry
 * that owner_name; otherwise they stand alone keyed by the name.
 */
export function groupByAgent(rows: FleetAssignmentRow[]): AgentAssignment[] {
  const groups = new Map<string, AgentAssignment>();
  // Per-agent ordered work-list, accumulated from work_item_claim rows (P-021).
  const workLists = new Map<string, WorkListItem[]>();
  const ensure = (key: string): AgentAssignment => {
    let g = groups.get(key);
    if (!g) {
      g = {
        agentId: key,
        label: null,
        name: null,
        present: false,
        alive: false,
        heartbeatAt: null,
        intent: '',
        declaredPlanSlug: null,
        fleetSlug: null,
        fleetRole: null,
        claims: [],
        orphaned: false,
        stalled: false,
        declaredUnclaimed: false,
        doing: null,
        queued: [],
        load: 0,
      };
      groups.set(key, g);
    }
    return g;
  };

  // Pass 1: presence + ownerId-keyed claims.
  const nameToOwner = new Map<string, string>();
  for (const r of rows) {
    if (!r.agentId) continue;
    if (r.source === 'plan_item_assignment') continue; // pass 2 (name-keyed)
    const g = ensure(r.agentId);
    g.label = g.label ?? r.agentLabel;
    if (r.source === 'presence') {
      g.present = true;
      g.alive = r.holderAlive;
      g.heartbeatFresh = r.holderAlive;
      g.heartbeatAt = r.holderHeartbeatAt;
      g.intent = r.detail;
      g.declaredPlanSlug = r.planSlug;
      // Named-fleet membership rides the presence backbone row (P-005).
      g.fleetSlug = r.fleetSlug ?? null;
      g.fleetRole = r.fleetRole ?? null;
    } else {
      g.claims.push(toClaim(r));
      // Accumulate the ordered work-list from work-item claims (P-021).
      if (r.source === 'work_item_claim' && r.workItemId) {
        const list = workLists.get(r.agentId) ?? [];
        list.push({
          id: r.workItemId,
          itemKind: r.itemKind,
          title: r.detail,
          status: r.status,
          rank: r.assigneeRank,
          rankWriter: r.rankWriter,
          activity: deriveActivity(r),
        });
        workLists.set(r.agentId, list);
      }
      if (r.orphaned) g.orphaned = true;
      if (r.stalled) g.stalled = true;
      // A claim joined to a presence row also proves the agent exists.
      if (r.holderPresent) {
        g.present = true;
        g.alive = g.alive || r.holderAlive;
        g.heartbeatFresh = (g.heartbeatFresh ?? false) || r.holderAlive;
        g.heartbeatAt = g.heartbeatAt ?? r.holderHeartbeatAt;
        g.intent = g.intent || (r.holderIntent ?? '');
        g.declaredPlanSlug = g.declaredPlanSlug ?? r.holderPlanSlug;
        // The holder-joined fleet label, as a fallback for an agent whose presence
        // backbone row didn't lead the group (P-005).
        g.fleetSlug = g.fleetSlug ?? r.fleetSlug ?? null;
        g.fleetRole = g.fleetRole ?? r.fleetRole ?? null;
      }
      if (r.agentName) {
        g.name = g.name ?? r.agentName;
        nameToOwner.set(r.agentName, r.agentId);
      }
    }
  }

  // Pass 2: name-keyed durable assignments → merge into the owner's group when
  // a claim linked the name; otherwise a standalone name-keyed group.
  for (const r of rows) {
    if (r.source !== 'plan_item_assignment' || !r.agentId) continue;
    const ownerKey = nameToOwner.get(r.agentId) ?? r.agentId;
    const g = ensure(ownerKey);
    g.name = g.name ?? r.agentId;
    g.claims.push(toClaim(r));
  }

  // The declared-but-unclaimed smell: a declared plan none of the claims back.
  // + the P-021 ordered work-list: rank ASC (NULLs last), head-of-line = doing.
  for (const g of groups.values()) {
    g.declaredUnclaimed = Boolean(
      g.declaredPlanSlug && !g.claims.some((c) => c.planSlug === g.declaredPlanSlug),
    );
    const list = workLists.get(g.agentId) ?? [];
    list.sort((a, b) => {
      const ar = a.rank ?? Number.POSITIVE_INFINITY;
      const br = b.rank ?? Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable tiebreak for unranked
    });
    g.queued = list;
    g.doing = list[0] ?? null;
    g.load = list.length;
  }

  // Live agents first, then abandoned/stalled-holders (the reclaimable smell),
  // newest heartbeat first.
  return [...groups.values()].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const aSmell = a.orphaned || a.stalled;
    const bSmell = b.orphaned || b.stalled;
    if (aSmell !== bSmell) return aSmell ? -1 : 1;
    return (b.heartbeatAt ?? '').localeCompare(a.heartbeatAt ?? '');
  });
}

/** Active claims whose holder is DEAD — the abandoned-work list. */
export function orphanedClaims(rows: FleetAssignmentRow[]): FleetAssignmentRow[] {
  return rows.filter((r) => r.orphaned && r.claimActive !== false);
}

/** Active work-item claims whose holder is ALIVE but the work is NOT advancing
 *  (no item-scoped progress in the window) — the stalled-work list (P-002/P-005). */
export function stalledClaims(rows: FleetAssignmentRow[]): FleetAssignmentRow[] {
  return rows.filter((r) => r.stalled === true && r.claimActive !== false);
}

/** Every reclaimable claim — DEAD (orphaned) OR alive-but-STALLED. The set the
 *  reconciler frees + the "is X really being worked?" reader treats as pickable. */
export function reclaimableClaims(rows: FleetAssignmentRow[]): FleetAssignmentRow[] {
  return rows.filter((r) => (r.orphaned || r.stalled === true) && r.claimActive !== false);
}

/**
 * The single per-item TRUTH (agent-activity-liveness-truth P-005, D-002): is this
 * work-item ACTUALLY being worked, by whom, and is it reclaimable? Derived live
 * from the reconciled fleet_assignment row (claim + holder-liveness + progress) —
 * NEVER from a coord broadcast that can outlive the work. This is what every
 * reader (the agent "is-X-covered" check, the Queen survey, placement) should
 * call instead of trusting a stale "spawned for X" announcement: it was a dead
 * bee mistaken for active for an hour that made this resolver necessary.
 *
 * A work-item with no live claim row (unclaimed OR terminal) resolves to `free`
 * with `activelyWorked:false` — the honest answer "nobody is advancing this now".
 */
export interface ItemActivityTruth {
  workItemId: string;
  /** A live (non-terminal) claim row exists for the item. */
  claimed: boolean;
  /** The holder's ownerId, or null when unclaimed/terminal. */
  holder: string | null;
  holderLabel: string | null;
  holderAlive: boolean;
  /** The derived label: free|reserved|alive|progressing|stalled|dead. */
  activity: ItemActivity;
  /** true ⇔ activity === 'progressing' — a LIVE holder making real progress. */
  activelyWorked: boolean;
  /** true ⇔ dead or stalled — free it + re-surface it (don't assume "covered"). */
  reclaimable: boolean;
  lastProgressAt: string | null;
  claimAcquiredTs: string | null;
  /** The work-item title (or holder intent), for a human-readable answer. */
  detail: string;
}

export async function whoIsDoingWhat(
  workItemId: string,
  opts: { workspaceId?: string | null } = {},
): Promise<ItemActivityTruth> {
  // Read the reconciled view (active claims only) and pick this item's work-item
  // claim row. The view excludes terminal statuses from the work_item_claim leg,
  // so a done/dropped item correctly resolves to `free` (nobody advancing it).
  const rows = await listFleetAssignments({ workspaceId: opts.workspaceId ?? null, activeOnly: true });
  const r = rows.find((row) => row.source === 'work_item_claim' && row.workItemId === workItemId);
  if (!r) {
    return {
      workItemId,
      claimed: false,
      holder: null,
      holderLabel: null,
      holderAlive: false,
      activity: 'free',
      activelyWorked: false,
      reclaimable: false,
      lastProgressAt: null,
      claimAcquiredTs: null,
      detail: '',
    };
  }
  const activity = deriveActivity(r);
  return {
    workItemId,
    claimed: true,
    holder: r.agentId,
    holderLabel: r.agentLabel,
    holderAlive: r.holderAlive,
    activity,
    activelyWorked: isActivelyWorked(activity),
    reclaimable: isReclaimable(activity),
    lastProgressAt: r.lastProgressAt,
    claimAcquiredTs: r.claimAcquiredTs,
    detail: r.detail,
  };
}

/**
 * EI-8995 (one liveness verdict): last recorded tool invocation per coord owner —
 * the "real work" freshness signal the member-verdict derivation fuses with
 * presence/wakeability. Top-1 per owner via DISTINCT ON over the
 * `tool_invocations (coord_owner_id, invoked_at DESC)` partial index — ONE bounded
 * read for a whole fleet, replacing the manual canary protocol's per-member
 * "check tool_invocations" query. Best-effort: any failure returns an empty map
 * (verdicts degrade to the presence-only states; the read never throws).
 */
export async function lastToolCallAtByOwner(coordOwnerIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Map();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ coord_owner_id: string; invoked_at: string | Date }[]>`
      SELECT DISTINCT ON (coord_owner_id) coord_owner_id, invoked_at
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ANY(${ids}::text[])
       ORDER BY coord_owner_id, invoked_at DESC
    `;
    const out = new Map<string, string>();
    for (const r of rows) {
      const iso = toIso(r.invoked_at);
      if (iso) out.set(r.coord_owner_id, iso);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * EI-19307414464301772: tool names emitted PER-TURN by the harness itself — a
 * PostToolUse hook fold (`activity:report`), a status-line refresh
 * (`coord:glance`), a Stop-hook journal write (`journal:record-turn`), a
 * per-call flag check (`flags:get`), an ask-gate mirror
 * (`sessions:ingest-gate-event`) — rather than chosen by the agent. Every
 * turn fires at least one of these regardless of what the agent is actually
 * doing, so `lastToolCallAtByOwner` above is guaranteed fresh for any agent
 * whose turns are firing at all and cannot, by itself, distinguish a member
 * doing real work from one spinning on nothing but this set. Both colon and
 * underscore spellings appear in `tool_invocations` depending on the
 * transport that recorded them (same convention as
 * `inbox-read-freshness.ts`'s `COORD_READ_TOOL_NAMES`).
 */
export const HOUSEKEEPING_TOOL_NAMES = [
  'coord:glance',
  'coord_glance',
  'activity:report',
  'activity_report',
  'journal:record-turn',
  'journal_record-turn',
  'flags:get',
  'flags_get',
  'sessions:ingest-gate-event',
  'sessions_ingest-gate-event',
] as const;

/**
 * EI-19307414464301772: the PRODUCTIVE-only sibling of `lastToolCallAtByOwner`
 * — same batched top-1-per-owner shape (one bounded read for a whole fleet),
 * excluding `HOUSEKEEPING_TOOL_NAMES`. A member whose recent activity is
 * entirely housekeeping has no entry here (or a much older one than
 * `lastToolCallAtByOwner` reports) even though it reads as freshly active on
 * every existing liveness surface — the gap between the two maps IS the
 * "taking turns, doing nothing" signal `fleet:leader-brief`'s spinning alert
 * is built on (see `computeSpinningAlert`). Fail-soft: any error returns an
 * empty map, exactly like its sibling.
 */
export async function lastProductiveToolCallAtByOwner(coordOwnerIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Map();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ coord_owner_id: string; invoked_at: string | Date }[]>`
      SELECT DISTINCT ON (coord_owner_id) coord_owner_id, invoked_at
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ANY(${ids}::text[])
         AND tool_name != ALL(${[...HOUSEKEEPING_TOOL_NAMES]}::text[])
       ORDER BY coord_owner_id, invoked_at DESC
    `;
    const out = new Map<string, string>();
    for (const r of rows) {
      const iso = toIso(r.invoked_at);
      if (iso) out.set(r.coord_owner_id, iso);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * WI-583276: read the exact owners that emitted an agent-origin tool call in
 * the recent execution window.  This is deliberately separate from
 * `lastProductiveToolCallAtByOwner`: a productive-looking tool name can still
 * be emitted by a hook, while `call_origin='agent'` is the telemetry writer's
 * authoritative turn provenance.  `null` means the telemetry leg failed or
 * timed out; callers must preserve that UNKNOWN state rather than treating it
 * as a fleet-wide zero.
 */
export async function agentOriginToolCallOwnersSince(
  coordOwnerIds: string[],
  windowMs = 30 * 60_000,
): Promise<Set<string> | null> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Set();
  if (!Number.isFinite(windowMs) || windowMs <= 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ coord_owner_id: string }[]>`
      SELECT DISTINCT coord_owner_id
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ANY(${ids}::text[])
         AND call_origin = 'agent'
         AND invoked_at > now() - (${windowMs} * interval '1 millisecond')
    `;
    return new Set(rows.map((row) => row.coord_owner_id).filter((id) => typeof id === 'string' && id.length > 0));
  } catch {
    return null;
  }
}

/**
 * WI-2034624: the NATIVE half of the same question `agentOriginToolCallOwnersSince`
 * answers with the MCP half.
 *
 * `tool_invocations` records MCP calls ONLY, so an agent reading with `cat`,
 * searching with `grep` and editing with the native Read/Edit tools produces NO
 * row there at all — and this box's bypass-permissions preamble actively steers
 * agents toward exactly those. `harness_shared.agent_activity` is the ledger
 * that DOES record them. Neither ledger is complete on its own and each is
 * incomplete in the SAME direction: a missing row can only make a working agent
 * look idle.
 *
 * Measured 2026-09-01 over live fleet members (60min window): fleet
 * `nonp2p-bug-drain-luna-max-50` had 50 live members, 28 visible in
 * tool_invocations, 30 in agent_activity, 30 in the union. Fleet
 * `windows-parity` had 1 live member, 0 in tool_invocations, 1 in
 * agent_activity — an MCP-only reading calls that fleet's only working member
 * idle and the governor replaces a filled seat.
 *
 * `null` means the leg failed; callers must preserve that UNKNOWN state.
 */
export async function nativeToolCallOwnersSince(
  coordOwnerIds: string[],
  windowMs = 30 * 60_000,
): Promise<Set<string> | null> {
  const ids = [...new Set(coordOwnerIds.filter((id) => !!id && !id.startsWith('fed:')))];
  if (ids.length === 0) return new Set();
  if (!Number.isFinite(windowMs) || windowMs <= 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ owner_id: string }[]>`
      SELECT DISTINCT owner_id
        FROM harness_shared.agent_activity
       WHERE owner_id = ANY(${ids}::text[])
         AND created_at > now() - (${windowMs} * interval '1 millisecond')
    `;
    return new Set(rows.map((row) => row.owner_id).filter((id) => typeof id === 'string' && id.length > 0));
  } catch {
    return null;
  }
}

/**
 * The complete execution signal: owners visible in EITHER tool ledger.
 *
 * ⚠ A PARTIAL union is not returned. If either leg fails this answers `null`
 * (UNKNOWN), because a half-read union UNDER-counts, and under-counting a
 * capacity signal is the precise harm WI-2034624 exists to remove: it spawns
 * replacements for seats that are already filled and working, and every
 * churned boot re-burns the quota that is the real constraint. Both legs query
 * the same Postgres, so in practice they fail together; a caller that fails
 * closed on the rare single-leg failure loses far less than one that silently
 * reports a fraction of the fleet as idle.
 */
export async function executingOwnersSince(
  coordOwnerIds: string[],
  windowMs = 30 * 60_000,
): Promise<Set<string> | null> {
  const [mcp, native] = await Promise.all([
    agentOriginToolCallOwnersSince(coordOwnerIds, windowMs),
    nativeToolCallOwnersSince(coordOwnerIds, windowMs),
  ]);
  if (mcp == null || native == null) return null;
  return new Set([...mcp, ...native]);
}

/**
 * EI-18763117665515043: does this work-item claim's LINKED plan item — resolved
 * via the SAME two-mechanism stamp `planItemLaneBlockReason` already uses for the
 * pre-claim self-select gate (payload.plan_item back-pointer, or the
 * source_plan_slug/source_plan_item_ids DB columns) — already carry a TERMINAL
 * (done/dropped) effectiveStatus?
 *
 * The bug this closes: the reclaim verdict (`summarizeOrphan`) was computed
 * PURELY from claim/holder liveness, so a claim whose linked plan item is
 * already `done` still resolved to `orphan`/`reclaim` (re-placing dead work) or
 * `held-by-live-agent`/`ask` (telling a leader to interrupt a live holder over
 * work that is already finished) — both wrong. `work_items:get`'s own
 * `planItemBlocked` field already performs this exact check for the UNCLAIMED
 * self-select path; this is its claimed-work counterpart for the reclaim path.
 *
 * Batched + deduped by work-item id (an agent can hold several claim rows across
 * the orphan/stalled lists that name the same work-item). Best-effort per item —
 * a lookup failure for one id just omits it from the map, leaving that row to
 * fall through to the existing liveness-only verdict; it never breaks the batch.
 */
export async function resolveTerminalPlanItemResidue(
  rows: readonly Pick<FleetAssignmentRow, 'source' | 'workItemId' | 'harnessSlug'>[],
): Promise<Map<string, PlanItemLaneBlock>> {
  const harnessById = new Map<string, string | undefined>();
  for (const r of rows) {
    if (r.source === 'work_item_claim' && r.workItemId && !harnessById.has(r.workItemId)) {
      harnessById.set(r.workItemId, r.harnessSlug ?? undefined);
    }
  }
  if (harnessById.size === 0) return new Map();
  const [{ getWorkItem }, { planItemLaneBlockReason }] = await Promise.all([
    import('../work-items'),
    import('../scheduler/plan-item-lane-guard'),
  ]);
  const out = new Map<string, PlanItemLaneBlock>();
  await Promise.all(
    [...harnessById.entries()].map(async ([id, harness]) => {
      try {
        const wi = await getWorkItem(id, harness);
        if (!wi) return;
        const block = await planItemLaneBlockReason(wi);
        if (block && (block.effectiveStatus === 'done' || block.effectiveStatus === 'dropped')) {
          out.set(id, block);
        }
      } catch {
        // Best-effort — one item's lookup failure never breaks the batch.
      }
    }),
  );
  return out;
}

/** Claims keyed by holder ownerId — the roster's per-agent enrichment. */
export function claimsByAgent(rows: FleetAssignmentRow[]): Map<string, AgentClaim[]> {
  const map = new Map<string, AgentClaim[]>();
  for (const r of rows) {
    if (r.source === 'presence' || !r.agentId) continue;
    const list = map.get(r.agentId);
    if (list) list.push(toClaim(r));
    else map.set(r.agentId, [toClaim(r)]);
  }
  return map;
}

/**
 * WI-5975 — how the claim's item-scoped progress signal is REPORTED, as an
 * explicit discriminator instead of a bare null.
 *
 *   never-checkpointed — the holder has recorded NO item-scoped progress at all.
 *                        This is the ABSENCE of a signal: it says nothing about
 *                        whether the work is advancing. Extremely common — an
 *                        agent can work productively for hours and simply never
 *                        checkpoint.
 *   stale-since        — progress WAS recorded, and the last one is older than
 *                        the window. This is a MEASURED staleness — a real signal.
 *
 * The two conditions used to render identically (a null/old `lastProgressAt`),
 * so a leader read both as "abandoned" and moved to reassign work off agents
 * that were alive and mid-task. Same defect class as a job-runner reporting a
 * pipeline's exit code as the command's: a layer that cannot answer returns a
 * confident-looking value instead of naming its own ignorance.
 */
export type ClaimProgressSignal = 'never-checkpointed' | 'stale-since';

/**
 * WI-5975 — the verdict a leader is meant to ACT on, paired with its sanctioned
 * action so the action is not invented at the moment of impatience.
 *
 *   orphan             → reclaim. The presence oracle says the holder is GONE;
 *                        the claim outlived the process. Nobody is coming back.
 *   held-by-live-agent → ask. The holder is LIVE. The item is not checkpointing,
 *                        which is worth surfacing, but a live holder's work is
 *                        NOT abandoned and must never be reclaimed out from
 *                        under it on a progress-recency signal alone.
 *   residue            → close. The claim's LINKED plan item is already
 *                        terminal (done/dropped) — see
 *                        {@link resolveTerminalPlanItemResidue}. Outranks the
 *                        liveness verdict entirely: whether the holder is alive
 *                        or gone is irrelevant when the work behind the claim is
 *                        already finished. Never `work_items:release` this (that
 *                        just re-places already-done work on the next self-select
 *                        pass) — close it with evidence instead.
 */
export type ClaimReclaimVerdict = 'orphan' | 'held-by-live-agent' | 'residue';

/**
 * The holder-liveness inputs {@link summarizeOrphan} needs to tell an abandoned
 * claim from a quiet-but-working one.
 *
 * `sessionState` mirrors the presence oracle's verdict (the `SessionState` union
 * in agent-tools/coordination/presence-wakeability) — declared structurally here
 * so this data-layer leaf keeps no agent-tools import; a drift test pins the two
 * unions together. It OUTRANKS the row's heartbeat-derived `holderAlive`, which
 * is raw process-keepalive freshness and reads true on a warm-dead session.
 */
export interface HolderActivity {
  sessionState?: 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded' | null;
  /** Last recorded tool invocation — GENUINE work, not a keepalive beat. */
  lastToolCallAt?: string | null;
  /** Last recorded non-housekeeping tool invocation — stronger work evidence. */
  productiveToolCallAt?: string | null;
  /** Whether the holder currently has an inbox wake delivery path. */
  wakeable?: boolean | null;
  /** Healthy loop lifecycle state, when fleet:assignments has decorated it. */
  monitorState?: 'monitoring' | 'waiting' | 'parked-awaiting-capability' | null;
  /** Exact non-inbox event keys the holder is deliberately parked on. */
  parkedOn?: readonly string[] | null;
  /** Expected progress cadence for this claim, when a caller knows it. */
  expectedCadenceMs?: number | null;
  /** Classification of the checkpoint writer, when known. */
  checkpointKind?: 'authored' | 'mechanical' | null;
  /** Context generation/epoch evidence, when the caller has it. */
  contextGeneration?: string | number | null;
}

/**
 * EI-18716042694888410: how recent a tool invocation must be for its holder to
 * count as WORKING regardless of `sessionState`.
 *
 * `sessionState` describes the SESSION's posture, not whether work is happening:
 * an agent that is mid-task can read `parked` (between wakes, warm-continued,
 * or relaunched under the same coord owner after a service reap) while invoking
 * tools continuously. Treating that as abandonment is how a leader comes to
 * force-release work out from under a live worker.
 *
 * 10 minutes is deliberately generous relative to a normal inter-call gap —
 * this is a SAFETY floor on a destructive action, so it should err toward
 * "still working". A genuinely wedged holder crosses it quickly.
 */
export const ACTIVE_TOOL_CALL_WINDOW_MS = 10 * 60 * 1000;

/** Has this holder done real work recently enough to be presumed alive? */
function isRecentlyActive(holder: HolderActivity | null | undefined, nowMs: number): boolean {
  if (!holder?.lastToolCallAt) return false;
  const t = Date.parse(holder.lastToolCallAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t < ACTIVE_TOOL_CALL_WINDOW_MS && t <= nowMs + ACTIVE_TOOL_CALL_WINDOW_MS;
}

/** The wire shape an orphaned claim is reported in (fleet:assignments + /api/adv/roster). */
export interface OrphanedClaimSummary {
  source: FleetAssignmentSource;
  agent: string | null;
  harness: string | null;
  plan: string | null;
  id: string | null;
  detail: string;
  expires: string | null;
  holder_present: boolean;
  holder_heartbeat_at: string | null;
  /** WI-5975: absence rendered AS absence — never a bare null. */
  progress: ClaimProgressSignal;
  /** The measured progress timestamp; null exactly when progress is 'never-checkpointed'. */
  last_progress_at: string | null;
  /** WI-5975: is this really abandoned, or just quiet? */
  verdict: ClaimReclaimVerdict;
  /** WI-5975: the sanctioned next step for that verdict. EI-18763117665515043:
   *  'close' for `verdict:'residue'` — never 'reclaim'/'release' a claim whose
   *  linked plan item is already terminal; that just re-places finished work. */
  action: 'reclaim' | 'ask' | 'close';
  /** The holder's last GENUINE work (tool invocation) — the signal that separates
   *  a working-but-not-checkpointing agent from a wedged one. */
  holder_last_tool_call_at?: string | null;
  /** EI-18763117665515043: set only when verdict:'residue' — the linked plan
   *  item + its terminal status, i.e. WHY this claim is stale residue rather
   *  than abandoned/quiet-but-live work. */
  residue?: { planSlug: string; itemId: string; effectiveStatus: string };
  /** P-005: progress-derived claim health, separate from liveness/activity. */
  claim_health: ClaimHealth;
}

/**
 * sessionState values the oracle itself documents as CONFIRMED-gone
 * (presence-wakeability.ts's own docblock: `ended`/`suspect` = the process is
 * gone; `draining` = "may be winding down and must not count as a healthy
 * member"). `live`/`parked`/`recorded` are ALL documented as alive — `parked`
 * explicitly "wakeable but idle... the ideal dispatch target", `recorded`
 * explicitly "it is alive, just not coord-wakeable". This is the SAME
 * dead-set already used for member-liveness in this codebase (see
 * agent-tools/fleet/assignments.ts's `a.alive = false` / `return 'dead'`
 * checks) — {@link summarizeOrphan} below now reuses it instead of its own
 * narrower (and wrong) `=== 'live'` test.
 */
const ORACLE_CONFIRMED_GONE = new Set<HolderActivity['sessionState']>([
  'ended',
  'suspect',
  'draining',
]);

/**
 * EI-19918812834215183: a freshly claimed work-item is still in the scheduler's
 * grace window even when its first heartbeat has not landed yet. Use the newest
 * claim/progress timestamp as the anchor: a re-claim may retain an older
 * `lastProgressAt`, which must not consume the fresh claim's grace window.
 */
function isWithinClaimGrace(r: FleetAssignmentRow, nowMs: number): boolean {
  const timestamps = [r.claimAcquiredTs, r.lastProgressAt]
    .map((value) => (value == null ? NaN : Date.parse(value)))
    .filter((value): value is number => Number.isFinite(value));
  if (timestamps.length === 0) return false;
  const anchorMs = Math.max(...timestamps);
  const ageMs = nowMs - anchorMs;
  // Match the existing recent-activity skew tolerance while keeping an
  // obviously-future timestamp from manufacturing an indefinitely fresh claim.
  return ageMs <= STALE_CLAIM_GRACE_MS && anchorMs <= nowMs + STALE_CLAIM_GRACE_MS;
}

export type ClaimHealthStatus = 'healthy' | 'waiting' | 'suspect' | 'recoverable' | 'contested';

export interface ClaimHealthEvidence {
  writer: string;
  signal: string;
  value: string | number | boolean | null | string[];
  at?: string | null;
}

export interface ClaimHealth {
  status: ClaimHealthStatus;
  reasons: string[];
  expected_cadence_ms: number;
  evidence: ClaimHealthEvidence[];
}

function isoAgeMs(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return nowMs - parsed;
}

function isFreshIso(value: string | null | undefined, nowMs: number, windowMs: number): boolean {
  const age = isoAgeMs(value, nowMs);
  return age != null && age >= -windowMs && age <= windowMs;
}

/**
 * P-005: the progress-derived health of a HELD CLAIM, deliberately separate
 * from session liveness (`holderAlive`/`sessionState`) and item activity
 * (`deriveActivity`). This is the writer-evidence surface a leader can inspect
 * before deciding whether a quiet claim is healthy, merely waiting, recoverable,
 * suspect, or internally contested.
 *
 * Key safety rule: heartbeat-only liveness and mechanical-only checkpoints can
 * never keep a claim `healthy` indefinitely. `healthy` needs fresh authored or
 * productive evidence (fresh non-housekeeping tool work, or a checkpoint known
 * to be authored). A live-but-quiet holder is at most `waiting`/`suspect`, never
 * silently healthy.
 */
export function deriveClaimHealth(
  r: FleetAssignmentRow,
  holder?: HolderActivity | null,
  nowMs: number = Date.now(),
): ClaimHealth {
  const expectedCadenceMs =
    holder?.expectedCadenceMs && Number.isFinite(holder.expectedCadenceMs) && holder.expectedCadenceMs > 0
      ? holder.expectedCadenceMs
      : STALE_CLAIM_GRACE_MS;
  const evidence: ClaimHealthEvidence[] = [
    { writer: 'fleet_assignment', signal: 'holder_alive', value: r.holderAlive, at: r.holderHeartbeatAt },
    { writer: 'fleet_assignment', signal: 'last_progress_at', value: r.lastProgressAt, at: r.lastProgressAt },
    { writer: 'fleet_assignment', signal: 'claim_acquired_at', value: r.claimAcquiredTs, at: r.claimAcquiredTs },
  ];
  if (holder?.sessionState !== undefined) {
    evidence.push({ writer: 'coord_presence', signal: 'session_state', value: holder.sessionState ?? null });
  }
  if (holder?.wakeable !== undefined) {
    evidence.push({ writer: 'coord_presence', signal: 'wakeable', value: holder.wakeable ?? null });
  }
  if (holder?.lastToolCallAt !== undefined) {
    evidence.push({ writer: 'tool_invocations', signal: 'last_tool_call_at', value: holder.lastToolCallAt ?? null, at: holder.lastToolCallAt ?? null });
  }
  if (holder?.productiveToolCallAt !== undefined) {
    evidence.push({
      writer: 'tool_invocations',
      signal: 'last_productive_tool_call_at',
      value: holder.productiveToolCallAt ?? null,
      at: holder.productiveToolCallAt ?? null,
    });
  }
  if (holder?.monitorState !== undefined) {
    evidence.push({ writer: 'loop_status', signal: 'monitor_state', value: holder.monitorState ?? null });
  }
  if (holder?.parkedOn?.length) {
    evidence.push({ writer: 'events_await', signal: 'exact_dependency_waits', value: [...holder.parkedOn] });
  }
  if (holder?.checkpointKind !== undefined) {
    evidence.push({ writer: 'work_items_checkpoint', signal: 'checkpoint_kind', value: holder.checkpointKind ?? null });
  }
  if (holder?.contextGeneration !== undefined) {
    evidence.push({ writer: 'memory_session_epochs', signal: 'context_generation', value: holder.contextGeneration ?? null });
  }

  const reasons: string[] = [];
  const freshProductive = isFreshIso(holder?.productiveToolCallAt, nowMs, expectedCadenceMs);
  const freshTool = isFreshIso(holder?.lastToolCallAt, nowMs, ACTIVE_TOOL_CALL_WINDOW_MS);
  const freshAuthoredCheckpoint =
    holder?.checkpointKind === 'authored' && isFreshIso(r.lastProgressAt, nowMs, expectedCadenceMs);
  const mechanicalOnly =
    holder?.checkpointKind === 'mechanical' && !freshProductive && !freshTool;
  const dependencyWait = (holder?.parkedOn?.length ?? 0) > 0 || holder?.monitorState === 'parked-awaiting-capability';
  const scheduledWait = holder?.monitorState === 'waiting' || holder?.monitorState === 'monitoring';
  const recoverable = holder?.sessionState === 'suspect' && holder.wakeable === true;
  const contradicted =
    (r.orphaned && (holder?.sessionState === 'live' || holder?.sessionState === 'parked' || holder?.sessionState === 'recorded')) ||
    (r.stalled === true && (freshProductive || freshTool)) ||
    r.declaredPlanMatches === false;

  if (contradicted) {
    reasons.push('claim progress/liveness writers disagree; inspect before acting');
    return { status: 'contested', reasons, expected_cadence_ms: expectedCadenceMs, evidence };
  }
  if (recoverable) {
    reasons.push('holder is suspect but wakeable, so wake/recover before takeover');
    return { status: 'recoverable', reasons, expected_cadence_ms: expectedCadenceMs, evidence };
  }
  if (freshProductive || freshTool || freshAuthoredCheckpoint) {
    if (freshProductive) reasons.push('fresh non-housekeeping tool progress within expected cadence');
    else if (freshTool) reasons.push('fresh tool progress within active work window');
    else reasons.push('fresh authored checkpoint progress within expected cadence');
    return { status: 'healthy', reasons, expected_cadence_ms: expectedCadenceMs, evidence };
  }
  if (dependencyWait || scheduledWait) {
    if (dependencyWait) reasons.push('holder is parked on exact dependency wait(s)');
    else reasons.push('holder has a healthy loop monitor state but no fresh progress evidence');
    if (mechanicalOnly) reasons.push('mechanical checkpoint alone is not healthy progress');
    return { status: 'waiting', reasons, expected_cadence_ms: expectedCadenceMs, evidence };
  }
  if (mechanicalOnly) reasons.push('mechanical-only checkpoint cannot keep claim healthy');
  else if (r.holderAlive) reasons.push('heartbeat/liveness exists but no fresh authored or productive progress');
  else reasons.push('no fresh authored/productive progress evidence');
  return { status: 'suspect', reasons, expected_cadence_ms: expectedCadenceMs, evidence };
}

/**
 * P-006: only a suspect claim-health verdict is eligible for automated recovery
 * surfaces (reclaim/bench/re-place). Healthy, waiting, recoverable, and contested
 * each require preserving the holder/checkpoint until a leader verifies or wakes
 * the owner; they are not safe takeover predicates.
 */
export function shouldRecoverClaimFromHealth(health: Pick<ClaimHealth, 'status'>): boolean {
  return health.status === 'suspect';
}

/**
 * Summarize one reclaim-candidate claim for a leader surface.
 *
 * WI-5975: `holder` carries the authoritative liveness. Unless the oracle
 * affirmatively says the holder is GONE ({@link ORACLE_CONFIRMED_GONE}), the
 * row is reported as `held-by-live-agent`/`ask` — NEVER as an orphan —
 * however old the progress signal is. Liveness outranks progress recency: a
 * claim not checkpointing is a reason to ASK the holder, and only a holder
 * the oracle says is GONE is a reason to reclaim.
 *
 * EI-18738329288671636: this used to require `sessionState === 'live'`
 * exactly, so a `parked` holder — the oracle's own "wakeable but idle, ideal
 * dispatch target" state, i.e. demonstrably NOT gone — fell through to
 * `orphan`/`reclaim` the moment its last tool call aged past the 10-minute
 * `isRecentlyActive` window below. Live-verified: `holder_present:true`,
 * a heartbeat seconds old, a session merely parked between turns — reported
 * `orphan`/`reclaim` anyway, which would have discarded a completed verdict
 * and an in-flight artifact if acted on. Checking against the documented
 * dead-set (rather than requiring the narrower alive-set membership `live`)
 * fixes this for every non-`live` alive state (`parked`, `recorded`), not
 * just the one this repro happened to hit.
 *
 * Falls back to the row's heartbeat-derived `holderAlive` only when no oracle
 * verdict is available, so an un-decorated caller degrades to the old behaviour
 * rather than manufacturing a confident verdict from missing input.
 *
 * `residue` (EI-18763117665515043), when passed, OUTRANKS the liveness
 * derivation entirely — see {@link resolveTerminalPlanItemResidue}. Whether the
 * holder is alive or gone says nothing about whether ALREADY-FINISHED work
 * should be reclaimed or asked-about; it should be closed, full stop.
 */
export function summarizeOrphan(
  r: FleetAssignmentRow,
  holder?: HolderActivity | null,
  nowMs: number = Date.now(),
  residue?: PlanItemLaneBlock | null,
): OrphanedClaimSummary {
  const base = {
    source: r.source,
    agent: r.agentId,
    harness: r.harnessSlug,
    plan: r.planSlug,
    id: r.itemId ?? r.workItemId,
    detail: r.detail,
    expires: r.claimExpiresTs,
    holder_present: r.holderPresent,
    holder_heartbeat_at: r.holderHeartbeatAt,
    progress: (r.lastProgressAt ? 'stale-since' : 'never-checkpointed') as ClaimProgressSignal,
    last_progress_at: r.lastProgressAt,
    ...(holder?.lastToolCallAt !== undefined
      ? { holder_last_tool_call_at: holder.lastToolCallAt }
      : {}),
    claim_health: deriveClaimHealth(r, holder, nowMs),
  };
  if (residue) {
    return {
      ...base,
      verdict: 'residue',
      action: 'close',
      residue: { planSlug: residue.planSlug, itemId: residue.itemId, effectiveStatus: residue.effectiveStatus },
    };
  }
  const freshClaim = isWithinClaimGrace(r, nowMs);
  // EI-18716042694888410: recent REAL work outranks session posture. `lastToolCallAt`
  // was already fetched and documented as the working-vs-wedged discriminator, but the
  // verdict consulted only `sessionState`, so an actively-invoking `parked` holder was
  // reported orphan/reclaim. Fuse it: no tool-call signal ⇒ unchanged prior behaviour.
  //
  // EI-18779583390738111: that fusion used to be `isRecentlyActive(...) || <sessionState
  // check>` — a plain OR that let a recent tool call override EVERY confirmed-gone
  // sessionState, `ended` included. That produced a same-payload self-contradiction: the
  // `agents[]` row for the SAME holder sets `alive:false` for exactly `ended` (and
  // `suspect`/`draining`, see reconcileWakeability in agent-tools/fleet/assignments.ts),
  // so a claim row could read `held-by-live-agent`/`ask` while the payload's own agents[]
  // row for that holder read `alive:false`/dead. `ended` fires only on the SessionEnd/Stop
  // lifecycle event (session-death-claim-release-2026-07-11), which ALREADY unconditionally
  // released every claim that session held — a confirmed, PERMANENT termination that a
  // tool call recorded before the session died cannot walk back. `suspect`/`draining` stay
  // overridable (the EI-18716042694888410 incident): those are heuristic, transitional
  // reads that can be wrong while the process is still very much alive.
  const liveHolder = (() => {
    const sessionState = holder?.sessionState;
    if (sessionState == null) {
      // No oracle signal at all — degrade to the pre-oracle heartbeat/recency behaviour.
      // A claim can reach this surface before its holder's first heartbeat. The
      // scheduler's claim-time grace is the only liveness signal in that gap.
      return freshClaim || isRecentlyActive(holder, nowMs) || r.holderAlive === true;
    }
    if (sessionState === 'ended') return false; // confirmed, permanent — never overridable.
    if (ORACLE_CONFIRMED_GONE.has(sessionState)) {
      return freshClaim || isRecentlyActive(holder, nowMs);
    }
    // A just-spawned holder may be recorded as alive before its first presence
    // heartbeat; the claim itself is the temporary safety signal in that window.
    return true; // live / parked / recorded — documented alive states.
  })();
  return {
    ...base,
    verdict: liveHolder ? 'held-by-live-agent' : 'orphan',
    action: liveHolder ? 'ask' : 'reclaim',
  };
}

/** WI-5975: a row a leader may actually reclaim — the holder is gone, not merely quiet. */
export function isReclaimCandidate(s: OrphanedClaimSummary): boolean {
  return s.verdict === 'orphan';
}

/** EI-18763117665515043: a row that is stale residue of already-finished work —
 *  close it (with evidence), never `work_items:release` it. */
export function isResidueCandidate(s: OrphanedClaimSummary): boolean {
  return s.verdict === 'residue';
}
