/**
 * agent-goal-sources.ts — the PRODUCTION reads behind P-016's goal cell
 * (plan `unified-agent-state-plane-2026-07-27`).
 *
 * Sibling of `holder-context-sources.ts` and built to the same split: the
 * derivation is PURE (`lib/agent-goal-ref.ts` — no PG, no clock, exhaustively
 * unit-tested), and this file is the only part that touches a store. That is what
 * makes P-026 rule (f)'s totality structural rather than a promise.
 *
 * ⚠ THIS REPLACES A SINGLE-LEG DERIVATION, IT DOES NOT RUN BESIDE ONE.
 * `fetchHolderGoal` previously answered "the holder's goal" from the plan-item
 * claim ALONE. That is one of P-016's four legs, and it is the leg measured to
 * have ZERO standalone live traffic (0 of 19 holders hold a plan-item claim
 * without also holding a work-item, 2026-07-27) — so on today's fleet it returned
 * null for 15 of 19 holders who demonstrably HAD a goal. It now delegates here.
 * One derivation, many lenses (D-038 axis 5).
 *
 * ⚠⚠ THE OVERRIDE RIDES A RESERVED KEY, NOT `agent_facts.kind` — AND THAT IS THE
 * SIBLING'S MEASURED WARNING APPLIED, NOT A SHORTCUT. D-011 requires an explicit
 * author-override path; P-030 forbids minting a third place a goal is written. So
 * the override lives on the declaration substrate P-008 already made
 * append-versioned. The obvious spelling is `kind = 'goal'`, and it is wrong TWICE
 * over:
 *   · `agent_facts.kind`'s CHECK admits only `conclusion | assumption |
 *     convention` — there is no `'goal'`, so the row could never be written;
 *   · `kind` is populated on **13 of 2,076 rows** (holder-context-sources.ts,
 *     measured), so a `kind` filter derives essentially nothing even where it is
 *     legal.
 * Facts are therefore identified BY KEY here, exactly as the assumptions leg does.
 * `key` is the populated, load-bearing field; `kind` is not.
 */
import type { Sql } from 'postgres';
import {
  resolveAgentGoal,
  type GoalCandidates,
  type GoalLink,
  type HeldFleet,
  type HeldPlanItem,
  type HeldWorkItem,
  type ResolvedGoal,
} from '../../agent-goal-ref';
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import { foldFacts } from '../../agent-facts/store';
import { declaredGoalOf } from '../../plan-items/claim-holder';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import type { HolderGoalRecord } from '../../coord/holder-context';

/**
 * The reserved `agent_facts` key an agent authors to override its derived goal.
 *
 * ⚠ ONE CONSTANT, so the reader here and any future writer can never drift — the
 * same discipline `autoConvertClaimIntent` uses for the string it detects. An
 * override is authored ONLY when true purpose differs from the claimed lane,
 * "which is precisely the high-signal case" (D-011).
 */
export const GOAL_OVERRIDE_FACT_KEY = 'goal.override';

/**
 * Work-item states that must NOT produce a goal: an agent still named on a
 * finished row is not working toward it.
 *
 * ⚠⚠ IMPORTED, NEVER HAND-LISTED — AND THIS FILE GOT IT WRONG FIRST TIME.
 * P-016 shipped a local `['done', 'cancelled', 'closed']` under this exact name,
 * beside `work-items.ts`'s canonical export of the SAME name. Two defects:
 *   · it MISSED `passed`, `resolved`, `dropped` and `deprecated` — 5,073 live
 *     rows, and `passed`/`resolved` are the NORMAL close for the feature and
 *     issue families respectively. A holder still named on one would have kept
 *     producing a goal from finished work.
 *   · `cancelled` is not in the vocabulary at all and matches zero rows.
 * It survived review because the close path usually clears `taken_by`, so the
 * live population (0 of those 5,073 rows carried a holder) hid it completely —
 * a shape of bug no fixture and no live-count could catch, only reading the
 * canonical constant could. `work-item-dispatch-states.ts` is a leaf module, so
 * the canonical union is importable here with no cycle.
 */
const TERMINAL_WORK_ITEM_STATES: readonly string[] = ANY_FAMILY_TERMINAL_STATES;

/**
 * Ceiling on rows per leg. A BOUND, not a filter — the resolver must SEE the
 * competing claims in order to disclose them (`ResolvedGoal.competing`), so
 * trimming to one would reintroduce the silent-discard defect. The measured live
 * maximum is 2 work-items per holder, so this is far above the real population
 * while still stopping a pathological holder from turning a hot-path enrichment
 * into an unbounded read.
 */
export const GOAL_LEG_CAP = 20;

/**
 * Gather every leg for one owner.
 *
 * FAIL-SOFT PER LEG: a dead source contributes nothing while the others still
 * land, so a broken links table costs corroboration rather than the whole goal.
 */
export async function readGoalCandidates(ownerId: string, lens: GoalLens): Promise<GoalCandidates> {
  return (await readGoalLegs(ownerId, lens)).candidates;
}

export type AgentGoalAssessment = 'nothing-held' | 'corroborated' | 'sole' | 'divergent';
export type GoalResolverLeg = 'store' | 'work-items' | 'plan-items' | 'fleet' | 'override' | 'links' | 'resolution';
export interface GoalResolverDiagnostic {
  leg: GoalResolverLeg;
  status: 'unavailable';
  detail: string;
}

/** PURE. A partial goal remains visible, but never earns a verified assessment. */
export function assessAgentGoal(
  goal: ResolvedGoal | null,
  diagnostics: readonly GoalResolverDiagnostic[],
): AgentGoalAssessment | null {
  if (diagnostics.length > 0) return null;
  if (!goal) return 'nothing-held';
  if (goal.agreement === 'divergent' || goal.competing.length > 0) return 'divergent';
  switch (goal.agreement) {
    case 'corroborated':
      return 'corroborated';
    case 'sole':
      return 'sole';
    default: {
      const exhaustive: never = goal.agreement;
      return exhaustive;
    }
  }
}

/**
 * WHOSE GOAL IS BEING READ — and it is a REQUIRED argument on every seam below,
 * deliberately.
 *
 * The two audiences need OPPOSITE handling of a lapsed plan-item claim, and this
 * file shipped with one policy silently applied to both (EI-20073149682963544): the
 * expiry filter that is right for `peer` quietly deleted an agent's OWN goal 20
 * minutes in (`plan_item_claims.ttl_sec` default 1200), while the sibling
 * work-item leg — same function, no expiry — kept answering. The two legs of "what
 * am I doing" disagreed by construction.
 *
 * A DEFAULT would have re-armed exactly that trap: the next caller inherits
 * whichever audience the default happened to encode and nothing says it chose. So
 * there is no default. Adding a caller forces the author to name the audience,
 * which is the one thing the original author never had to do.
 *
 * · `self` — the agent asking about itself. It KNOWS it is still working, so a
 *   lapsed lease is a cold lease, never absent work. Lapsed rows are READ and
 *   disclosed via `leaseValid`/`ResolvedGoal.leaseCold`.
 * · `peer` — anyone asking about someone else. A lapsed claim genuinely may be
 *   historical and the reader cannot know, so it stays filtered out in SQL. This
 *   is the pre-existing behaviour, preserved exactly.
 */
export type GoalLens = 'self' | 'peer';

/** Internal: the candidates PLUS the claim prose, gathered in one pass so
 *  {@link fetchHolderGoalRecord} needs no second round-trip. */
async function readGoalLegs(
  ownerId: string,
  lens: GoalLens,
): Promise<{
  candidates: GoalCandidates;
  planItems: readonly HeldPlanItemRow[];
  diagnostics: GoalResolverDiagnostic[];
}> {
  const owner = (ownerId ?? '').trim();
  if (!owner || !coordHasPgFastPath()) {
    return {
      candidates: {},
      planItems: [],
      diagnostics: [
        {
          leg: 'store',
          status: 'unavailable',
          detail: owner ? 'coordination Postgres fast path is unavailable' : 'owner id is empty',
        },
      ],
    };
  }
  const sql = coordSql();
  const ws = coordWorkspaceId();

  const settle = async <T>(
    leg: GoalResolverLeg,
    f: () => Promise<T>,
    fallback: T,
  ): Promise<{ value: T; diagnostic: GoalResolverDiagnostic | null }> => {
    try {
      return { value: await f(), diagnostic: null };
    } catch (err) {
      return {
        value: fallback,
        diagnostic: {
          leg,
          status: 'unavailable',
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };

  const [workItemsRead, planItemsRead, fleetRead, overrideRead] = await Promise.all([
    settle('work-items', () => readHeldWorkItems(sql, ws, owner), [] as HeldWorkItem[]),
    settle('plan-items', () => readHeldPlanItems(sql, ws, owner, lens), [] as HeldPlanItemRow[]),
    settle('fleet', () => readFleetMission(sql, ws, owner), null as HeldFleet | null),
    settle('override', () => readGoalOverride(owner), null as GoalCandidates['override']),
  ]);
  const workItems = workItemsRead.value;
  const planItems = planItemsRead.value;
  const fleet = fleetRead.value;
  const override = overrideRead.value;
  const linksRead = await settle('links', () => readImplementsLinks(sql, ws, workItems, planItems), [] as GoalLink[]);

  return {
    candidates: {
      override,
      workItems,
      planItems,
      fleet,
      links: linksRead.value,
    },
    planItems,
    diagnostics: [
      workItemsRead.diagnostic,
      planItemsRead.diagnostic,
      fleetRead.diagnostic,
      overrideRead.diagnostic,
      linksRead.diagnostic,
    ].filter((d): d is GoalResolverDiagnostic => d !== null),
  };
}

async function readHeldWorkItems(sql: Sql, ws: string, owner: string): Promise<HeldWorkItem[]> {
  const rows = await sql<{ id: string; taken_at: string | null }[]>`
    SELECT feature_id AS id, taken_at::text AS taken_at
      FROM harness_shared.work_items
     WHERE workspace_id = ${ws}
       AND taken_by = ${owner}
       AND status <> ALL(${TERMINAL_WORK_ITEM_STATES})
       -- Resource-governor receipts are local queue telemetry, not agent work
       -- (EI-21870243647094665; mirrors carry-brief.ts's readHeldWorkItems
       -- fix for the sibling defect, EI-21867218655207954). A receipt can
       -- carry taken_by = owner with a non-terminal status while it is
       -- briefly in flight, or as a legacy/partially-reconciled row whose
       -- outer status column never caught up to its true terminal state — in
       -- either case it must never compete as this agent's GOAL. Exclude by
       -- the reserved payload marker rather than trusting the outer status
       -- projection.
       AND NOT jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')
     ORDER BY taken_at DESC NULLS LAST
     LIMIT ${GOAL_LEG_CAP}`;
  return rows.filter((r) => r.id).map((r) => ({ id: r.id, takenAt: r.taken_at }));
}

/**
 * The plan-item claim leg, read through the caller's {@link GoalLens}.
 *
 * ⚠ `peer` KEEPS THE LIVE-ONLY FILTER, for the reason `fetchHolderGoal` already
 * states: an expired claim's goal is a historical record, and rendering it is the
 * "stale value reads as current" defect one layer below `stale`.
 *
 * ⚠⚠ `self` DELIBERATELY READS LAPSED ROWS, and the reason it is SAFE is the
 * table's shape, not optimism. `plan_item_claims`' PK is `(workspace_id,
 * harness_slug, plan_slug, item_id)` — ONE row per item — rows are DELETED on
 * release, and a peer taking the item OVERWRITES `owner`. So a surviving row still
 * owned by us proves nobody else took it: reading it back cannot steal work, it
 * can only restore the goal we already had. What the lapse genuinely costs is the
 * FENCE, and that is disclosed rather than hidden — `lease_valid` rides out on
 * every row and becomes `ResolvedGoal.leaseCold`.
 *
 * ⚠ THE ORDER BY IS LOAD-BEARING UNDER THE CAP. With lapsed rows admitted, a
 * long-lived agent can hold more than {@link GOAL_LEG_CAP} claims, and a plain
 * recency sort would let stale rows evict the live ones inside the LIMIT — turning
 * a fix for a vanishing goal into a new way to lose it. Valid leases sort first, so
 * the cap sheds cold rows before warm ones.
 */
async function readHeldPlanItems(sql: Sql, ws: string, owner: string, lens: GoalLens): Promise<HeldPlanItemRow[]> {
  const includeLapsed = lens === 'self';
  const rows = await sql<
    {
      plan_slug: string;
      item_id: string;
      acquired_ts: string | null;
      intent: string | null;
      lease_valid: boolean | null;
    }[]
  >`
    SELECT plan_slug, item_id, acquired_ts::text AS acquired_ts, intent,
           (expires_ts > clock_timestamp()) AS lease_valid
      FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${ws}
       AND owner = ${owner}
       AND (${includeLapsed} OR expires_ts > clock_timestamp())
     ORDER BY (expires_ts > clock_timestamp()) DESC,
              last_activity_ts DESC NULLS LAST,
              item_id ASC
     LIMIT ${GOAL_LEG_CAP}`;
  return rows
    .filter((r) => r.plan_slug && r.item_id)
    .map((r) => ({
      planSlug: r.plan_slug,
      itemId: r.item_id,
      acquiredTs: r.acquired_ts,
      intent: r.intent,
      // Only the self lens MEASURES this. The peer lens filtered in SQL, so every
      // row it returns is live by construction and must carry `undefined` — see
      // `HeldPlanItem.leaseValid`: absent is a third state, not a `false`.
      leaseValid: includeLapsed ? r.lease_valid !== false : undefined,
    }));
}

/**
 * A held plan-item claim PLUS its raw `intent`.
 *
 * ⚠ `intent` is carried HERE and not on {@link HeldPlanItem}, deliberately. The
 * pure resolver derives a REF and must stay free of prose — a goal ref and a goal
 * TEXT are different data with different lifetimes (D-011's table). This row type
 * exists only so {@link fetchHolderGoalRecord} can recover the prose without a
 * second query.
 */
interface HeldPlanItemRow extends HeldPlanItem {
  intent: string | null;
}

/**
 * Current fleet membership. `fleet_membership_events` is APPEND-ONLY, so
 * membership is the newest event — and a `leave` means the agent has NO mission,
 * not that its last fleet still counts.
 */
async function readFleetMission(sql: Sql, ws: string, owner: string): Promise<HeldFleet | null> {
  const rows = await sql<{ fleet_slug: string; event: string; at: string | null }[]>`
    SELECT fleet_slug, event, at::text AS at
      FROM harness_shared.fleet_membership_events
     WHERE workspace_id = ${ws}
       AND owner_id = ${owner}
     ORDER BY at DESC, id DESC
     LIMIT 1`;
  const r = rows[0];
  if (!r?.fleet_slug || r.event === 'leave') return null;
  return { slug: r.fleet_slug, joinedAt: r.at };
}

/**
 * The author override — the newest live owner-scoped fact under the reserved key.
 *
 * Read through `foldFacts` rather than raw SQL so it inherits the audited
 * append-version semantics for free: `superseded_at IS NULL` (P-008 (a) — a fold
 * that saw the superseded tail would serve the correction and the corrected value
 * as peers), plus retraction and expiry.
 */
async function readGoalOverride(owner: string): Promise<GoalCandidates['override']> {
  const facts = await foldFacts([{ scope: 'owner', scopeRef: owner }], {
    limitPerSelector: 1,
    keyPrefixes: [GOAL_OVERRIDE_FACT_KEY],
    audiences: 'all',
  });
  const f = facts.find((x) => x.key === GOAL_OVERRIDE_FACT_KEY);
  if (!f?.body?.trim()) return null;
  return { ref: f.body.trim(), declaredAt: f.updatedAt ?? null };
}

/**
 * The corroboration edges — `coord_links` rows proving a held work-item
 * IMPLEMENTS a plan item.
 *
 * Feature-family work-items are stored in `coord_links` with a harness-qualified
 * source ref (`<harness>#<feature_id>`), while the held work-item leg exposes the
 * bare `feature_id`. Issue-family refs are bare in both places. Normalize the
 * feature side through the canonical feature row before returning links so the
 * pure resolver can compare both families in the same ref space.
 *
 * ⚠ SKIPPED WHEN ITS ANSWER CANNOT CHANGE THE RESULT. With no held work-item, or
 * no plan-item claim to corroborate AGAINST, there is no ambiguity for an edge to
 * resolve — and this decorates a hot path, so the query does not run.
 */
async function readImplementsLinks(
  sql: Sql,
  ws: string,
  workItems: readonly HeldWorkItem[],
  planItems: readonly HeldPlanItem[],
): Promise<GoalLink[]> {
  const ids = workItems.map((w) => w.id).filter(Boolean);
  if (ids.length === 0 || planItems.length === 0) return [];
  const rows = await sql<{ work_item_id: string; dst_ref: string }[]>`
    SELECT CASE WHEN l.src_kind = 'feature' THEN f.feature_id ELSE l.src_ref END AS work_item_id,
           l.dst_ref
      FROM harness_shared.coord_links l
      LEFT JOIN harness_shared.harness_features_consolidated f
        ON l.src_kind = 'feature'
       AND (f.harness_slug || '#' || f.feature_id) = l.src_ref
       AND f.workspace_id = ${ws}
     WHERE l.dst_kind = 'plan_item'
       AND l.rel = 'implements'
       AND (
         (l.src_kind = 'feature' AND f.feature_id = ANY(${ids}))
         OR (l.src_kind = 'issue' AND l.src_ref = ANY(${ids}))
       )`;
  return rows
    .filter((r) => r.work_item_id && r.dst_ref)
    .map((r) => ({ workItemId: r.work_item_id, planItemRef: r.dst_ref }));
}

/**
 * THE CELL'S RESOLVER — one owner's current goal, derived now.
 *
 * TOTAL: never throws. `null` is an HONEST "this agent holds nothing", which
 * consumers render as absent — never as a fabricated goal, and (D-056)
 * deliberately the same answer a reader gets for a holder whose goal it may not
 * read, so a refusal cannot be used as a probe oracle.
 *
 * ⚠ `lens` IS THE CALLER'S TO DECIDE AND CANNOT BE INFERRED HERE. This resolver
 * serves both audiences — `coord:goal` answers about `args.ownerId ?? me`, so the
 * SAME function call is a self-read or a peer-read depending on an argument this
 * layer never sees. Baking in either policy would be wrong half the time; only the
 * call site knows whose goal it is asking for. See {@link GoalLens}.
 */
export async function resolveOwnerGoal(ownerId: string, lens: GoalLens): Promise<ResolvedGoal | null> {
  return (await resolveOwnerGoalWithAssessment(ownerId, lens)).goal;
}

/** One resolver pass, carrying both the raw goal and assessment integrity. */
export async function resolveOwnerGoalWithAssessment(
  ownerId: string,
  lens: GoalLens,
): Promise<{
  goal: ResolvedGoal | null;
  assessment: AgentGoalAssessment | null;
  diagnostics: GoalResolverDiagnostic[];
}> {
  try {
    const read = await readGoalLegs(ownerId, lens);
    const goal = resolveAgentGoal(read.candidates);
    return { goal, assessment: assessAgentGoal(goal, read.diagnostics), diagnostics: read.diagnostics };
  } catch (err) {
    const diagnostics: GoalResolverDiagnostic[] = [
      {
        leg: 'resolution',
        status: 'unavailable',
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
    return { goal: null, assessment: null, diagnostics };
  }
}

/**
 * P-026's `HolderContextSources.holderGoal`, now backed by all four legs.
 *
 * ⚠ THE PROSE GOAL IS RECOVERED CAREFULLY, AND THE CARE IS NOT OPTIONAL.
 * `HolderContext.goalText` comes from `plan_item_claims.intent`, and
 * `declaredGoalOf` protects it by detecting the auto-convert MECHANISM string —
 * a string that embeds the PLAN ITEM id. Once `itemId` becomes a resolved ref
 * (often a work-item, e.g. `WI-6407`), running that detection against the ref
 * would compare the intent to a mechanism string for the WRONG id, it would never
 * match, and the mechanism string would sail through rendered as the holder's
 * goal — the exact thing `declaredGoalOf` exists to refuse.
 *
 * So the detection runs HERE, against the plan-item id where it is meaningful,
 * and only a genuine goal is passed up. The pure projection then sees clean prose
 * or null, and its own second `declaredGoalOf` call is a no-op rather than a
 * mis-comparison. One rule, applied where it can be applied correctly.
 *
 * The prose is claimed ONLY when the resolved goal actually IS that plan-item
 * claim — either directly, or via the `implements` edge that proves they are one
 * goal. A work-item goal that merely coexists with an unrelated claim gets no
 * prose, because that claim describes different work.
 */
export async function fetchHolderGoalRecord(ownerId: string): Promise<HolderGoalRecord | null> {
  try {
    // PEER by definition: this is the HOLDER view — someone else reading whoever
    // holds a lock/claim they are blocked on. A lapsed claim stays filtered out
    // here, exactly as before this seam existed (EI-20073149682963544).
    const { candidates, planItems } = await readGoalLegs(ownerId, 'peer');
    const goal = resolveAgentGoal(candidates);
    if (!goal) return null;

    const planRef = goal.source === 'plan-item' ? goal.ref : goal.corroboratedBy;
    const claim = planRef ? planItems.find((p) => `${p.planSlug}#${p.itemId}` === planRef) : undefined;

    return {
      itemId: goal.ref,
      intent: claim ? declaredGoalOf(claim.intent, claim.itemId).goalText : null,
      acquiredTs: goal.declaredAt,
      // D-093: carry D-092's disclosure through instead of dropping it. These two
      // fields were computed here and discarded one line later, so the guarantee
      // that a losing leg is "DISCLOSED, never dropped" reached no reader at all.
      agreement: goal.agreement,
      competing: goal.competing,
    };
  } catch {
    // P-026 rule (f): a dead store costs this ONE field, never the read it decorates.
    return null;
  }
}
