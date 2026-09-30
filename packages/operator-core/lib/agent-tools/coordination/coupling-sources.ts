/**
 * coupling-sources.ts — the PRODUCTION reads behind P-013's querying coupling
 * signals (plan `unified-agent-state-plane-2026-07-27`, scoping ruling D-078).
 *
 * WHY A SEPARATE MODULE. `coord/coupling-derivation.ts` is pure and total: rows
 * in, `DerivedCoupling[]` out, no PG, no locks, no clock. That is what makes it
 * unit-testable without a database and what makes its no-widening guarantee hold
 * by construction. Keeping the IO here preserves that: this file is the only part
 * that touches a store, and it is injected as `CouplingDerivationSources` rather
 * than imported by the derivation.
 *
 * ⚠ EVERY READ HERE IS CALLER-SCOPED, BY CONSTRUCTION (D-044 / D-078 (c)).
 * Coupling may re-rank what a reader can ALREADY see and may never widen it:
 *   · held files — the caller's OWN coordination domain, restricted to ownerIds
 *     already on the caller's roster;
 *   · plan edges — the caller's OWN plan (the one its presence row declares);
 *   · recent partners — messages the caller itself sent or received.
 * `deriveCouplings` then filters every derived edge back through the roster, so
 * even a misbehaving source here cannot surface an agent the caller could not
 * already observe. Two independent guarantees, deliberately.
 *
 * ⚠ EVERY READ IS FAIL-SOFT AND BOUNDED. `coord:presence` is a hot poll surface;
 * a coupling signal is a nicety and the roster is not. Each source swallows its
 * own failure (the orchestrator also settles per leg) and each carries an
 * explicit row/time cap so a pathological workspace cannot turn a presence read
 * into a table scan.
 */
import type {
  CouplingDerivationSources,
  ObligationEdge,
  ObligationLiveness,
  ObligationRelation,
  PlanBlockingEdge,
} from '../../coord/coupling-derivation';
import { resolveSessionStates } from './liveness-oracle';
import { fetchFleetSupervisionRows } from './presence-fleet';
import { fetchPresencePathInterests } from './presence-snapshot';
import { coordSql, coordWorkspaceId, coordHasPgFastPath } from './log';
import { readPlanBySlug } from '../plans/source';

/** How far back a directed message still counts as a live working relationship.
 *  Deliberately short: this is "who am I working with RIGHT NOW", not history. */
export const COUPLING_EXCHANGE_WINDOW_MS = 30 * 60 * 1000;

/** Hard cap on the exchange scan — bounds a hot-path read on a busy workspace. */
export const COUPLING_EXCHANGE_ROW_CAP = 300;

/** Hard cap on the obligation scan. Far smaller than the exchange cap on purpose:
 *  an agent's OPEN consults are a handful, not a stream — measured 2026-08-25 over
 *  workspace papercusp-workspace, the whole table holds 159 consults and exactly 2
 *  are open-with-responder-and-undischarged. A cap this size is headroom, not a clip. */
export const COUPLING_OBLIGATION_ROW_CAP = 100;

/**
 * Post kinds that DISCHARGE a consult obligation.
 *
 * ⚠ THE OMISSIONS ARE THE DESIGN, and they are measured rather than guessed. The live
 * `consult_post_meta.kind` vocabulary (workspace papercusp-workspace, 2026-08-25) is
 * `answer` 49, `close` 39, `decline` 8, `new_fact` 6, `clarifying_question` 1. Only the
 * first three end the debt:
 *   · `new_fact` ADDS to a consult that is still owed an answer;
 *   · `clarifying_question` is the responder asking the REQUESTER for more — the debt has
 *     not been discharged, it has arguably reversed, and treating it as a discharge would
 *     silently retire exactly the consults that are going badly.
 * Both would read as progress while leaving the requester waiting, which is the failure
 * this relation exists to make visible.
 */
export const CONSULT_DISCHARGING_POST_KINDS = ['answer', 'decline', 'close'] as const;

/** Envelope shape this module reads out of `consult_state`. */
interface ConsultObligationRow {
  conversation_id: string | null;
  requester_id: string | null;
  responder_id: string | null;
  created_at: string | Date | null;
}

/** Envelope shape this module reads out of the coord event log. */
interface ExchangeRow {
  from_owner: string | null;
  to_owners: unknown;
}

/**
 * Peers the caller exchanged a DIRECTED coord message with inside the window.
 *
 * ⚠ BROADCASTS ARE DROPPED HERE, at the source. A `to:['*']` message reaches the
 * whole fleet, so treating it as an exchange would couple every agent to every
 * other the moment anyone broadcasts — `expanded[]` would degrade into a copy of
 * the roster and `expandedBecause` would stop meaning anything. `human` is
 * dropped for the same reason it is never a roster peer.
 */
export async function fetchRecentCoordPartners(selfOwnerId: string): Promise<string[]> {
  const self = selfOwnerId.trim();
  if (!self || !coordHasPgFastPath()) return [];
  try {
    const sql = coordSql();
    const since = new Date(Date.now() - COUPLING_EXCHANGE_WINDOW_MS).toISOString();
    const rows = await sql<ExchangeRow[]>`
      SELECT body->>'from' AS from_owner, body->'to' AS to_owners
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${coordWorkspaceId()}
         AND surface = 'messages'
         AND ts >= ${since}
         AND jsonb_typeof(body->'to') = 'array'
         AND (body->>'from' = ${self} OR jsonb_exists(body->'to', ${self}))
       ORDER BY ts DESC
       LIMIT ${COUPLING_EXCHANGE_ROW_CAP}
    `;
    const partners = new Set<string>();
    for (const r of rows) {
      const from = (r.from_owner ?? '').trim();
      const to = Array.isArray(r.to_owners) ? r.to_owners : [];
      const recipients: string[] = [];
      let broadcast = false;
      for (const raw of to) {
        const id = typeof raw === 'string' ? raw.trim() : '';
        if (!id) continue;
        // `*` (everyone) and any `@selector:` audience are NOT evidence that these
        // two agents work together — the sender addressed a SET, not a person.
        if (id === '*' || id === 'human' || id.startsWith('@')) {
          broadcast = true;
          continue;
        }
        recipients.push(id);
      }
      if (broadcast) continue;
      if (from === self) {
        for (const id of recipients) if (id !== self) partners.add(id);
      } else if (from && recipients.includes(self)) {
        partners.add(from);
      }
    }
    return [...partners];
  } catch {
    return [];
  }
}

/**
 * The caller's own plan's `blocked-by` graph.
 *
 * Reuses `readPlanBySlug` (the same read the promotion run uses) rather than
 * hand-rolling SQL over `harness_plans` — that table is multi-tenant and keys on
 * (workspace_id, harness_slug, plan_slug), so a raw slug filter can silently hit
 * another tenant's row. Prefers the PG-canonical `row.items` and falls back to the
 * parsed markdown, exactly as plan-workitem-promotion-run.ts does (EI-14024).
 */
export async function fetchPlanBlockingEdges(
  planSlug: string,
  opts: { harnessSlug?: string | undefined; workspaceId?: string | undefined },
): Promise<PlanBlockingEdge[]> {
  const slug = planSlug.trim();
  if (!slug) return [];
  try {
    const read = await readPlanBySlug(slug, {
      ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    });
    if (!read) return [];
    const items =
      read.row.items.length > 0
        ? read.row.items.map((i) => ({
            id: i.id,
            blockedBy: Array.isArray((i as { blockedBy?: unknown }).blockedBy)
              ? ((i as { blockedBy: string[] }).blockedBy ?? [])
              : [],
          }))
        : read.parsed.items.map((i) => ({ id: i.id, blockedBy: i.blockedBy ?? [] }));
    const edges: PlanBlockingEdge[] = [];
    for (const i of items) {
      if (i.id && i.blockedBy.length > 0) edges.push({ item: i.id, blockedBy: i.blockedBy });
    }
    return edges;
  } catch {
    return [];
  }
}

/**
 * OPEN consult obligations the caller is a party to (P-004).
 *
 * The pairwise edge is ALREADY stored — `consult_state` names a requester and a responder
 * at ROUTING time — it simply never reached coupling. This is that read, and nothing more:
 * no inference, no co-occupancy, no set membership.
 *
 * ⚠ FOUR INDEPENDENT EXCLUSIONS, EACH MEASURED AGAINST LIVE ROWS rather than reasoned
 * about (workspace papercusp-workspace, 2026-08-25, n=159 consults):
 *   · `closed_at IS NULL` — 110 rows are closed (closed_answered 57, expired 37,
 *     closed_cant_help 12, declined 4). A closed consult owes nobody anything.
 *   · `responder_id IS NOT NULL` — 45 rows are `no_qualified_responder`, the router
 *     REFUSING honestly. There is no counterpart, so there is no pairwise edge to draw.
 *     This is the population that produced the plan's retracted "93 of 113 dead
 *     responders" figure (D-007); it must never surface as an obligation.
 *   · no substantive post — the discharge half. This is not belt-and-braces: it currently
 *     suppresses 2 `active` consults that already carry an `answer`/`close` post and would
 *     otherwise emit a FALSE debt against an agent who already replied.
 *   · `responder_id <> requester_id` — a self-consult is not a relation, matching
 *     `normalizePair` and the derivation's own self-edge refusal.
 * After all four, the live emitting population is 2 rows, both `awaiting_responder`.
 *
 * ⚠ CALLER-SCOPED like every other read here (D-044 / D-078 (c)): the `requester_id = self
 * OR responder_id = self` predicate means an agent can only ever learn about consults it is
 * ITSELF a party to. `deriveCouplings` then re-filters through the roster, so this cannot
 * widen what a reader can see even if this predicate were wrong.
 *
 * Ordered oldest-first because the derivation PRESERVES source order for obligations (and
 * P-008 renders that order) — the oldest unanswered debt is the one worth seeing first.
 */
export async function fetchConsultObligations(selfOwnerId: string): Promise<ObligationEdge[]> {
  const self = selfOwnerId.trim();
  if (!self || !coordHasPgFastPath()) return [];
  try {
    const sql = coordSql();
    const rows = await sql<ConsultObligationRow[]>`
      SELECT cs.conversation_id, cs.requester_id, cs.responder_id, cs.created_at
        FROM harness_shared.consult_state cs
       WHERE cs.workspace_id = ${coordWorkspaceId()}
         AND cs.closed_at IS NULL
         AND cs.responder_id IS NOT NULL
         AND cs.responder_id <> cs.requester_id
         AND (cs.requester_id = ${self} OR cs.responder_id = ${self})
         AND NOT EXISTS (
               SELECT 1
                 FROM harness_shared.consult_post_meta pm
                WHERE pm.workspace_id = cs.workspace_id
                  AND pm.conversation_id = cs.conversation_id
                  AND pm.kind = ANY(${[...CONSULT_DISCHARGING_POST_KINDS]})
             )
       ORDER BY cs.created_at ASC
       LIMIT ${COUPLING_OBLIGATION_ROW_CAP}
    `;
    const obligations: PendingObligation[] = [];
    for (const r of rows) {
      const requester = (r.requester_id ?? '').trim();
      const responder = (r.responder_id ?? '').trim();
      const handle = (r.conversation_id ?? '').trim();
      // `since` is REQUIRED for a renderable obligation — `obligationPhrase` refuses an
      // edge whose age it cannot state, so a row with no created_at is dropped HERE
      // rather than shipped downstream to be silently skipped.
      const since =
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : typeof r.created_at === 'string'
            ? r.created_at
            : '';
      if (!requester || !responder || !handle || !since) continue;
      const iAmRequester = requester === self;
      const counterpart = iAmRequester ? responder : requester;
      if (counterpart === self) continue;
      obligations.push({
        ownerId: counterpart,
        // The requester is OWED the reply; the responder OWES it. Direction is read off
        // which side of the stored pair the caller sits on — never inferred from state.
        direction: iAmRequester ? 'owes-me' : 'i-owe',
        what: 'a consult reply',
        since,
        handle,
      });
    }
    if (obligations.length === 0) return [];
    // P-011 — one BATCHED oracle call for every counterpart, after the loop rather than
    // inside it. Per-edge resolution would issue N point-reads on a hot presence path.
    const liveness = await resolveCounterpartLiveness(obligations.map((p) => p.ownerId));
    return obligations.map((p) => ({
      ...p,
      counterpartLiveness: liveness.get(p.ownerId) ?? 'unknown',
    }));
  } catch {
    return [];
  }
}

/** An obligation with everything but its P-011 liveness verdict, which is resolved in one
 *  batch after the row loop. `Omit` rather than a restated shape so a new required field
 *  on `ObligationEdge` breaks HERE instead of being quietly dropped from the spread. */
type PendingObligation = Omit<ObligationEdge, 'counterpartLiveness'>;

/**
 * Resolve each counterpart's CURRENT liveness through the shared oracle (P-011).
 *
 * ⚠ THE ORACLE, NOT THE HEARTBEAT COLUMN. `coord_presence.heartbeat_at` is not liveness:
 * a warm-dead session reads a fresh heartbeat with `sessionState: 'ended'`, so reading the
 * column directly reports the OPPOSITE of the truth on precisely the rows that matter —
 * a counterpart that died while still holding your debt. `resolveSessionStates` is the
 * same derivation `coord:presence` and `fleet:assignments` serve, so an obligation line
 * and the roster can never disagree about whether an agent is alive.
 *
 * ⚠ THIS IS A PRESENT-TENSE QUESTION, WHICH IS WHY `coord_presence` IS THE RIGHT SOURCE
 * HERE. D-007 established the converse rule — a PAST-tense liveness question ("was this
 * responder alive when it was routed?") must read `consult_state.routing`, persisted at
 * route time, because presence answers only NOW and is TTL-reaped. P-011 asks the now
 * question, so presence is correct; do not "fix" this to read routing.
 *
 * `hydratePerId` fills each subject's heartbeat/host/pid legs from its own presence row,
 * so a bare-id verdict is as strict as a roster one. THREE distinct paths land on
 * `'unknown'`, and all three are real: no row in the map, a row whose `sessionState` is
 * `null` (the oracle's in-band "not measured", D-038 axis 2), and a thrown oracle. None
 * may render as `'live'`.
 */
async function resolveCounterpartLiveness(
  ownerIds: readonly string[],
): Promise<Map<string, ObligationLiveness>> {
  const ids = [...new Set(ownerIds)].filter(Boolean);
  const out = new Map<string, ObligationLiveness>();
  if (ids.length === 0) return out;
  try {
    const verdicts = await resolveSessionStates(
      ids.map((ownerId) => ({ ownerId })),
      { hydratePerId: true },
    );
    for (const id of ids) out.set(id, verdicts.get(id)?.sessionState ?? 'unknown');
  } catch {
    // Fail-soft, like every read in this module — but note the degradation is to
    // 'unknown', never to a silently-omitted field. The obligation still surfaces.
    for (const id of ids) out.set(id, 'unknown');
  }
  return out;
}

/**
 * A grade older than this stops being an open debt and becomes history (P-006).
 *
 * Measured: of 53 in-scope scorecards, 47 are already terminal and 4 are open — and one
 * of those open cards is 218 hours (9 days) old. An unanswered grade from nine days ago
 * is not something a reader is going to act on today; surfacing it as a live debt just
 * teaches them to ignore the relation. Same residue reasoning as
 * {@link SUPERVISION_MEMBERSHIP_HORIZON_MS}, different natural timescale: a fleet lane is
 * stale in hours, a grade is stale in about a week.
 */
export const GRADING_OBLIGATION_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** Statuses that mean a scorecard has been dealt with — the lifecycle half of D-010. */
const GRADING_TERMINAL_STATUSES = ['done', 'resolved', 'dropped', 'closed', 'deprecated'];

/** Envelope shape for the grading read. */
interface GradingObligationRow {
  handle: string | null;
  created_ts: string | number | null;
  grader: string | null;
  author: string | null;
}

/**
 * The GRADING obligation: after a grade lands, its subject's AUTHOR owes the response
 * (P-006, scoped by D-014).
 *
 * ⚠ SCOPED TO `agent-run` AND `work-item` SUBJECTS ONLY, and the omission is deliberate.
 * Measured over 281 scorecards in 7 days, the item's phrase "the graded subject's author"
 * resolves for just 13% of cards: `agent-run` (the subject ref IS an ownerId) and
 * `work-item` (the ref resolves through that item's `created_by`). The DOMINANT kind is
 * `plan` at 54%, where "author" would have to mean the plan's owner — a different person
 * from whoever did the graded work, on any plan several agents implemented. Emitting a
 * debt against a guessed counterpart is not a smaller version of this feature; it is the
 * failure D-011 exists to prevent, because a reader cannot tell it is wrong and will
 * chase it. Plan-subject coverage is a deliberate follow-up, not an oversight — D-014.
 *
 * ⚠ SELF-GRADE IS REFUSED HERE TOO, even though it is already forbidden upstream. Measured:
 * `grader = subject_ref` is 0 across all 281 cards, so this branch never fires in
 * production — which is exactly why it cannot be verified against production and is
 * proved by a constructed fixture instead. It stays because an obligation an agent owes
 * ITSELF is nonsense the moment the upstream forbid ever slips.
 *
 * Direction per D-013: the author owes the response (`i-owe`), the grader is owed it
 * (`owes-me`) — read off which side of the stored pair the caller occupies.
 */
export async function fetchGradingObligations(
  selfOwnerId: string,
  nowMs: number = Date.now(),
): Promise<ObligationEdge[]> {
  const self = selfOwnerId.trim();
  if (!self || !coordHasPgFastPath()) return [];
  try {
    const sql = coordSql();
    const cutoffTs = nowMs - GRADING_OBLIGATION_HORIZON_MS;
    const rows = await sql<GradingObligationRow[]>`
      WITH cards AS (
        SELECT sc.feature_id AS handle,
               sc.created_ts,
               sc.payload->'_ei'->>'created_by' AS grader,
               CASE
                 WHEN sc.payload->'observation'->'subject'->>'kind' = 'agent-run'
                   THEN sc.payload->'observation'->'subject'->>'ref'
                 ELSE subj.payload->'_ei'->>'created_by'
               END AS author
          FROM harness_shared.work_items sc
          LEFT JOIN harness_shared.work_items subj
            ON subj.workspace_id = sc.workspace_id
           AND subj.feature_id = sc.payload->'observation'->'subject'->>'ref'
         WHERE sc.workspace_id = ${coordWorkspaceId()}
           AND sc.lane = 'observation'
           AND sc.payload->'observation'->>'rubricRef' IS NOT NULL
           AND sc.payload->'observation'->'subject'->>'kind' = ANY(${['agent-run', 'work-item']})
           AND NOT (sc.status = ANY(${GRADING_TERMINAL_STATUSES}))
           AND sc.created_ts > ${cutoffTs}
      )
      SELECT handle, created_ts, grader, author
        FROM cards
       WHERE grader IS NOT NULL
         AND author IS NOT NULL
         AND grader <> author
         AND (grader = ${self} OR author = ${self})
       ORDER BY created_ts ASC
       LIMIT ${COUPLING_OBLIGATION_ROW_CAP}
    `;
    const obligations: PendingObligation[] = [];
    for (const r of rows) {
      const grader = (r.grader ?? '').trim();
      const author = (r.author ?? '').trim();
      const handle = (r.handle ?? '').trim();
      const ts = typeof r.created_ts === 'string' ? Number(r.created_ts) : r.created_ts;
      if (!grader || !author || !handle) continue;
      if (grader === author) continue; // belt-and-braces on the SQL guard above
      if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
      const iAmAuthor = author === self;
      const counterpart = iAmAuthor ? grader : author;
      if (counterpart === self) continue;
      obligations.push({
        ownerId: counterpart,
        // The AUTHOR owes the response to a grade; the grader is owed it.
        direction: iAmAuthor ? 'i-owe' : 'owes-me',
        what: 'a response to a grade',
        since: new Date(ts).toISOString(),
        handle,
      });
    }
    if (obligations.length === 0) return [];
    const liveness = await resolveCounterpartLiveness(obligations.map((p) => p.ownerId));
    return obligations.map((p) => ({
      ...p,
      counterpartLiveness: liveness.get(p.ownerId) ?? 'unknown',
    }));
  } catch {
    return [];
  }
}

/**
 * A fleet peer whose presence row is colder than this is membership RESIDUE, not a
 * supervision relationship (P-007).
 *
 * ⚠ THIS CUT IS LOAD-BEARING, AND THE NUMBER SAYING SO IS MEASURED. Of 401 rows in this
 * workspace carrying a `fleet_slug`, **84 sit beyond this horizon** (83 members and 1
 * leader). Deriving supervision from the membership label alone would therefore emit ~28%
 * false obligations — a leader chased about dozens of agents that stopped existing hours
 * ago, which buries the handful that are real. Same shape as the consult case in D-010:
 * the lifecycle LABEL and the world disagree, so the label needs a second opinion.
 */
export const SUPERVISION_MEMBERSHIP_HORIZON_MS = 2 * 60 * 60 * 1000;

/**
 * The SUPERVISION obligation: fleet leader ↔ fleet member (P-007, re-scoped by D-012).
 *
 * ⚠ SOURCE RE-SCOPED — do not "restore" this to `spawned_agents`. The plan item named
 * `parent_spawn_id` / `session_owner`, and that table cannot produce a live edge: all
 * 9,040 rows across all 7 workspaces are terminal, and **0 of 354 live agents appear in
 * it** (the nursery-cup tier it served is retired). The live supervision relationship
 * lives on `coord_presence` as `fleet_slug` + `fleet_role` — 275 live members under 8
 * live leaders at the time of writing. Full evidence and the ruling: D-012.
 *
 * ⚠ MEMBER ↔ MEMBER DELIBERATELY EMITS NOTHING. Two agents in one fleet are not coupled
 * by that fact — D-002 REJECTED bare set membership as a coupling signal precisely
 * because nobody opted into it, and emitting it would turn a 292-member fleet into a
 * quadratic wall of meaningless edges. Only the HIERARCHICAL pair is an obligation.
 *
 * Direction: a leader OWES supervision to each member (watching, unblocking, relaunching
 * a dead one), so the leader emits `i-owe` and the member emits `owes-me` for the same
 * pair. As with consults, direction is read off which side of the stored relationship the
 * caller occupies — never inferred from activity.
 *
 * A DEAD member still emits, on purpose: that is the most actionable supervision
 * obligation there is, and D-011's `counterpartLiveness` is what carries `ended` onto the
 * line. The horizon above discharges only rows so cold that the label is residue.
 */
export async function fetchFleetSupervision(
  selfOwnerId: string,
  rosterOwnerIds: readonly string[],
  nowMs: number = Date.now(),
): Promise<ObligationEdge[]> {
  const self = selfOwnerId.trim();
  if (!self || !coordHasPgFastPath()) return [];
  try {
    const rows = await fetchFleetSupervisionRows([self, ...rosterOwnerIds]);
    const me = rows.get(self);
    // No fleet, no role, or my own row is residue ⇒ I am not in a live supervision
    // relationship and must not claim one.
    if (!me?.fleetSlug || !me.fleetRole) return [];
    const withinHorizon = (at: Date): boolean => {
      const t = at?.getTime?.();
      return typeof t === 'number' && Number.isFinite(t) && nowMs - t <= SUPERVISION_MEMBERSHIP_HORIZON_MS;
    };
    if (!withinHorizon(me.heartbeatAt)) return [];
    const obligations: PendingObligation[] = [];
    for (const [ownerId, peer] of rows) {
      if (ownerId === self) continue;
      if (peer.fleetSlug !== me.fleetSlug) continue;
      if (!withinHorizon(peer.heartbeatAt)) continue; // residue, not a relationship
      const direction: ObligationRelation | null =
        me.fleetRole === 'leader' && peer.fleetRole === 'member'
          ? 'i-owe'
          : me.fleetRole === 'member' && peer.fleetRole === 'leader'
            ? 'owes-me'
            : null;
      // null covers member↔member AND leader↔leader AND any unrecognised role — all of
      // which are co-membership, not supervision.
      if (!direction) continue;
      obligations.push({
        ownerId,
        direction,
        what: 'supervision of this fleet lane',
        // The peer's session start: when this supervision lane began to exist.
        since: peer.startedAt.toISOString(),
        // The fleet slug is what a reader can ACT on — `fleet:assignments { fleet }`.
        handle: me.fleetSlug,
      });
    }
    if (obligations.length === 0) return [];
    const liveness = await resolveCounterpartLiveness(obligations.map((p) => p.ownerId));
    return obligations.map((p) => ({
      ...p,
      counterpartLiveness: liveness.get(p.ownerId) ?? 'unknown',
    }));
  } catch {
    return [];
  }
}

/**
 * Which `coord:presence` reads need the lock COORDINATION DOMAIN resolved.
 *
 * ⚠ THIS PREDICATE IS THE FIX FOR A SIGNAL THAT NEVER FIRED ONCE IN PRODUCTION.
 * The domain used to be resolved under `include_detail` ALONE, because detail's
 * held-files lane was its first consumer. `include_coupling` then became a second,
 * INDEPENDENT consumer (the `holds-a-lock-on` derivation) and inherited detail's
 * gate by accident — so the lock signal required the INTERSECTION of two unrelated
 * opt-ins. Measured 2026-08-09 over the full retained history of
 * `tool_invocations` (workspace papercusp-workspace, 2026-07-26 → 2026-08-09):
 * 243 `coord:presence` calls passed neither flag, 11 passed `include_coupling`
 * alone, 9 passed `include_detail` alone, and **the both-flags row does not
 * exist**. Zero. The one AUTOMATIC "this agent is on this file" signal was dead on
 * arrival, exactly like the `current_files` field it was introduced to replace
 * (119 live rows, zero populated — EI-18772330418885814).
 *
 * The general shape, because it is what makes this invisible: a gate that is
 * correct for its first consumer becomes a silent AND-condition the moment a
 * second consumer reuses it. Nothing errors, every test over injected fixtures
 * passes, and the signal simply never fires. Give each consumer its own reason to
 * need the input — hence a named predicate rather than `if (args.include_detail)`.
 */
export function presenceNeedsCoordinationDomain(args: {
  include_detail?: boolean | undefined;
  include_coupling?: boolean | undefined;
}): boolean {
  return !!args.include_detail || !!args.include_coupling;
}

/**
 * Build the injected source set for one `coord:presence` read.
 *
 * `rosterOwnerIds` bounds the lock read to the agents this caller is already
 * being shown. `coordinationDomain` absent ⇒ the lock-hold signal degrades to
 * nothing rather than failing — correct, but it must be the caller's DELIBERATE
 * choice: see {@link presenceNeedsCoordinationDomain} for the 12 days this
 * degraded silently on every `include_coupling` read.
 *
 * ON COST, since that was the original objection: this never opens a connection
 * the process does not already hold. `getTxPool()` is a memoized module-level
 * singleton behind ~29 call sites (every `locks:*` verb), so it is warm in any
 * operator serving lock traffic. The real cost is its `max: 10` cap on a pool
 * that has saturated before (2026-07-26: 34 idle `su-lock-tx` connections, the
 * second-largest consumer of a 343/512 `max_connections`), and the read is paid
 * ONLY on the opt-in coupling branch — 11 calls in the whole retained window, not
 * the 243-call default path. Bounded to `rosterOwnerIds` and fail-soft per leg.
 */
export function couplingSourcesFor(opts: {
  selfOwnerId: string;
  rosterOwnerIds: string[];
  coordinationDomain?: string | undefined;
  harnessSlug?: string | undefined;
  workspaceId?: string | undefined;
}): CouplingDerivationSources {
  // ⚠ NOT gated on `coordinationDomain` any more, and NOT the holds-only lane.
  // Two independent reasons the old form emitted exactly zero, forever:
  //   · it read `agent_granular_locks`, abandoned by production 2026-07-02 (0 live
  //     rows since) — EI-20199756190949760;
  //   · even repointed, `agent_file_locks_pkey` is PRIMARY KEY (coordination_domain,
  //     path), so at most ONE owner exists per path and the "two agents hold the same
  //     path" predicate is UNSATISFIABLE BY CONSTRUCTION. A mutual-exclusion table
  //     records who WON contention, never that contention happened.
  // The contention is in `agent_lock_waiters`; `fetchPresencePathInterests` unions it
  // in. The domain is a partition key, not an access control — the roster bound below
  // plus `deriveCouplings`' own roster intersection are the access boundary (D-044 /
  // D-078c), so reading across domains does not widen. Passing the reader's domain is
  // what BROKE it: agents write locks under the proxying operator's checkout while a
  // reader resolves its own tree.
  return {
    heldFiles: async (): Promise<ReadonlyMap<string, readonly string[]>> =>
      fetchPresencePathInterests(opts.rosterOwnerIds, opts.coordinationDomain ?? null),
    planEdges: (planSlug: string) =>
      fetchPlanBlockingEdges(planSlug, {
        harnessSlug: opts.harnessSlug,
        workspaceId: opts.workspaceId,
      }),
    recentPartners: () => fetchRecentCoordPartners(opts.selfOwnerId),
    // P-004. Wired here rather than at each call site so all three readers
    // (coord:presence, coupled-topics, the divergence stamp) get it at once — the
    // per-site wiring is exactly how `holds-a-lock-on` stayed dark for 12 days (D-088).
    // Always supplied, never conditional: the census reads `armed: !!sources.obligations`,
    // so an omitted source would report the leg STARVED rather than absent, and a
    // genuinely empty obligation list would be indistinguishable from an unwired one.
    // ⚠ ONE leg, MANY producers — and that is the design, not a shortcut. `ObligationEdge`
    // carries `what` as a noun phrase rather than a `kind` enum precisely so a new
    // producer adds a SOURCE here and never a case in the derivation. P-006 (grading)
    // joins this list the same way.
    //
    // Producers run in PARALLEL and each is INDEPENDENTLY fail-soft (both already return
    // [] on any error), so a broken consult read cannot suppress supervision edges or
    // vice versa — the failure mode a naive `await a(); await b();` would introduce.
    obligations: async () => {
      const [consults, supervision, grading] = await Promise.all([
        fetchConsultObligations(opts.selfOwnerId),
        fetchFleetSupervision(opts.selfOwnerId, opts.rosterOwnerIds),
        fetchGradingObligations(opts.selfOwnerId),
      ]);
      return [...consults, ...supervision, ...grading];
    },
  };
}
