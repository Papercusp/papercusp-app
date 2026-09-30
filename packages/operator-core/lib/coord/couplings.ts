/**
 * couplings.ts — DECLARED agent coupling edges, and the union every reader uses.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-031 (ruling D-061).
 * Table: harness_shared.agent_couplings (migration 687).
 *
 * WHAT COUPLING IS. The relevance gate on peer state (D-044, D-053): coupled
 * peers are the ones worth showing an agent in detail. It was DERIVED only —
 * recent coord exchange, overlapping lock holds, a plan blocked-by edge, awaiting
 * an event they emit (D-054 cut `same fleet`) — so an agent that already KNEW it
 * was working alongside a peer could not say so; it had to wait for a derivation
 * to notice. Owner ruling [owner 2026-07-27]: agents couple and decouple manually,
 * with no restrictions.
 *
 * ONE PREDICATE, TWO SOURCES. Declared edges are not a parallel mechanism —
 * {@link resolveCoupledPeers} returns `derived ∪ declared − suppressed`, and every
 * consumer calls it rather than re-implementing the merge. The derived half is
 * P-013's and is passed IN, so this module has no opinion about how a derivation
 * is computed and P-013 can land without touching it.
 *
 * THREE PROPERTIES THAT ARE EASY TO GET WRONG:
 *
 *   1. SYMMETRY IS STRUCTURAL, not a convention. The pair is normalized to
 *      (least, greatest) before it ever reaches SQL and the table CHECKs it, so
 *      "am I coupled to X" cannot answer differently depending on who asks.
 *   2. DECOUPLE SUPPRESSES, it does not delete. A decouple cannot un-make a
 *      derivation (the shared lock is still really held), so deleting the row
 *      would let the next derivation tick silently resurrect the edge. A
 *      suppression is a durable mask that survives the tick — and, being a row
 *      rather than an absence, stays visible with its author.
 *   3. NO AUTHORIZATION. Any agent may couple any two agents, including pairs it
 *      is not part of. Coupling decides RELEVANCE, never ACCESS: it changes which
 *      already-readable peers are worth surfacing, so there is nothing here to
 *      protect. `declaredBy` is audit, never a gate.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { RECORDED_LIVE_MAX_AGE_MS } from '../adv-sessions';

/** The literal every agent argument accepts for "me" (the repo-wide convention —
 *  `sessions:read { session:'self' }`, `sessions:digest { owner:'self' }`). */
export const SELF_TOKEN = 'self';

export type CouplingState = 'coupled' | 'suppressed';

/** Where a coupling edge came from, once the union is resolved. */
export type CouplingSource =
  /** P-013's derivation (shared locks, coord exchange, blocked-by, awaited event). */
  | 'derived'
  /** Declared via coord:couple. */
  | 'declared'
  /** Both — a declaration that a derivation independently agrees with. */
  | 'both';

export interface CouplingEdge {
  /** Normalized: always the lexically SMALLER ownerId of the pair. */
  agentA: string;
  /** Normalized: always the lexically LARGER ownerId of the pair. */
  agentB: string;
  state: CouplingState;
  /** The ownerId that declared this state. May be NEITHER member of the pair. */
  declaredBy: string;
  reason: string | null;
  /**
   * The typed relation for this DECLARED edge (migration 954 / P-009), or null when no
   * member of the vocabulary fits — which is the honest state for most rows today.
   *
   * ⚠ OPTIONAL HERE, DELIBERATELY, AND THE CONTRAST WITH D-011 IS THE POINT. D-011 made
   * `ObligationEdge.counterpartLiveness` REQUIRED because its omission renders as silence,
   * and silence about liveness reads as "they are fine" — a wrong answer. Omission here
   * reads as "this edge is untyped", which is ACCURATE: measured across 101 live declared
   * reasons, ~26% fit only shapes with no vocabulary member and ~30% do not classify at
   * all (D-017). The test for required-vs-optional is not consistency; it is whether the
   * absent case renders as a confident wrong answer or as an honest unknown.
   */
  relation?: DerivedCouplingRelation | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

/**
 * The COMPUTED coupling vocabulary — one token per signal the derivation can
 * actually emit (D-087).
 *
 * ⚠ WHY THIS EXISTS AT ALL. `forYouBecause` (message-fields.ts) is justified on
 * being "STRUCTURED so it can be diffed against the computed coupling graph (a
 * prose string cannot be)" — but the computed half WAS a prose string
 * (`DerivedCoupling.because`), so the two halves of that one comparison were
 * typed on opposite sides of the same seam and the diff was not buildable. Each
 * local decision was right: informative prose avoided P-029's contentless-field
 * error, and a typed asserted enum enabled the diff. The seam between them broke.
 *
 * ⚠ THIS IS NOT A COPY OF `FOR_YOU_BECAUSE_RELATIONS`, and must not be collapsed
 * into one enum. The two vocabularies are deliberately different sizes because
 * they describe different things — an ASSERTED claim about the recipient
 * ("you own X") versus an OBSERVED edge between two agents. Three consequences
 * that a naive equality diff gets wrong, all handled in
 * `couplingDivergenceVerdict`:
 *   · `owns` is 53% of live asserted uses and has NO token here — ownership is a
 *     work-item fact, not a coupling edge;
 *   · `is-blocked-on` is ONE asserted token but TWO tokens here, because the
 *     direction means opposite things to the reader;
 *   · `coord-exchange` has no asserted counterpart.
 */
export const DERIVED_COUPLING_RELATIONS = [
  // ⛔ `same-fleet` WAS the first entry here and is deliberately GONE (D-054, re-fixed
  // 2026-08-09). The owner cut it on 2026-07-27 — *"FLEETS CAN HAVE 30 MEMBERS THAT IS TOO
  // MUCH COUPLING NO?"* — because it is SET MEMBERSHIP, not a pairwise relation: it is O(n²)
  // in fleet size, and it is redundant with `fleetSlug`, which the base presence payload
  // already puts on every row. It shipped anyway and stayed live for 12 days; measured
  // 2026-08-09, fleet `nonp2p-bug-drain` had 18 live members, so one member calling
  // `include_coupling` derived 17 edges and the fleet as a whole 306 — exactly the
  // "expanded[] stops being an expansion and becomes a second roster" failure D-054 forbade.
  // D-054's test for any FUTURE entry: an expansion edge must (a) be a pairwise relation the
  // two agents actually ENTERED, and (b) carry information the base payload cannot already
  // express. Every relation below passes both; `same-fleet` failed both.
  // ⛔ `shared-file` (declared `current_files` overlap) was here and is GONE (D-093,
  // 2026-08-10). Unlike `same-fleet` above it was not too NOISY — it was permanently
  // STARVED: measured over 14 days of production divergence stamps it produced ZERO
  // edges, because `current_files` is populated only by an explicit declare-intent and
  // every declare omitting the arg resets it to `[]` (EI-18772330418885814: 119 live
  // rows, zero populated). `holds-a-lock-on` fully supersedes it. ⚠ The ROSTER FIELD
  // `current_files` STAYS — it has a live writer and consumers (D-095); only this
  // coupling signal went. A relation that cannot fire is not harmless: it sits in the
  // dead-signal census forever, where permanently-starved is indistinguishable from
  // newly-broken — which is the exact confusion the census exists to resolve.
  /** Overlapping LIVE lock holds — the file signal that actually fires. */
  'holds-a-lock-on',
  /** Both awaiting the same event key. */
  'awaits',
  /** A peer holds an item that BLOCKS one of mine — who to chase. */
  'blocks-me',
  /** One of MY items blocks a peer's — who is waiting on me. */
  'blocked-by-me',
  /** Recent DIRECTED coord exchange (broadcasts excluded at the source). */
  'coord-exchange',
  // ── THE OBLIGATION FAMILY (agent-obligation-coupling-and-consult-liveness-2026-08-25,
  // P-003). DIRECTIONAL, like `blocks-me`/`blocked-by-me` and for the same reason: the
  // reader's ACTION differs. A peer who owes you is someone to CHASE; a peer you owe is
  // work you have not discharged, and it is the one an agent is least likely to discover
  // on its own.
  //
  // Both entries are held to D-054's test for a new relation, stated above:
  //   (a) a pairwise relation the two agents actually ENTERED — a consult is ASSIGNED by
  //       the router to a named requester and a named responder, so the edge is recorded
  //       at the moment it is entered rather than inferred from co-occupancy. This is the
  //       property `same-fleet` failed: set membership nobody opted into.
  //   (b) information the base payload cannot express — a roster row cannot say "owes you
  //       a consult reply, open 14m". Age and direction exist nowhere else on the payload,
  //       and an obligation without its age invites "as expected" (58-hour means are
  //       invisible without it).
  //
  // ⚠ THESE ARE THE FIRST RELATIONS WHOSE `because` IS BUILT BY A CHECKED RENDERER
  // (`obligationPhrase`) RATHER THAN AN INLINE TEMPLATE. An obligation missing its age or
  // its handle degrades to "they owe you something", which reads as informative while
  // being unactionable — so the renderer REFUSES to emit a partial phrase and the
  // derivation skips that edge. See coupling-derivation.ts.
  /** A peer owes ME an outstanding answer/grade/decision — who to chase. */
  'owes-me',
  /** I owe a peer — an obligation I entered and have not discharged. */
  'i-owe',
] as const;

export type DerivedCouplingRelation = (typeof DERIVED_COUPLING_RELATIONS)[number];

/**
 * The OBLIGATION subset of the vocabulary — the relations that mean someone owes
 * something, as opposed to the symmetric "we are both near this" signals (P-008).
 *
 * Declared HERE, in the module that owns the vocabulary, because two consumers need it
 * and neither may own it: `resolveCoupledPeers` below sorts by it, and
 * `coupling-derivation.ts` derives its `ObligationRelation` type from it. Putting it in
 * the derivation would force this file to import from a module that imports IT — a cycle
 * — so the alternative was restating the two literals in both places, which is the exact
 * drift `ObligationRelation` was written to avoid.
 *
 * `satisfies` pins every member to the real vocabulary, so a rename in
 * `DERIVED_COUPLING_RELATIONS` breaks here at compile time rather than silently leaving a
 * subset describing relations that no longer exist.
 */
export const OBLIGATION_RELATIONS = ['owes-me', 'i-owe'] as const satisfies
  readonly DerivedCouplingRelation[];

/** Whether a relation means someone OWES something (vs. a symmetric co-location signal). */
export function isObligationRelation(rel: unknown): boolean {
  return typeof rel === 'string' && (OBLIGATION_RELATIONS as readonly string[]).includes(rel);
}

/**
 * One DERIVED coupling, as P-013's derivation hands it to the union (D-078 (a)).
 *
 * Carries the SIGNAL, not just the id. A flat `string[]` loses why the edge
 * exists, which forces every derived entry to render the same contentless
 * `expandedBecause` — and `expandedBecause` is the one field P-013's contract
 * requires to be meaningful. A populated-but-uninformative field is the P-029
 * error D-053 already called out, so the reason travels WITH the id.
 *
 * BOTH HALVES ARE REQUIRED, and neither substitutes for the other: `relation` is
 * what a machine diffs (D-087), `because` is what a reader reads. The derivation
 * emits them from the same branch so they cannot disagree.
 */
export interface DerivedCoupling {
  ownerId: string;
  /** The typed signal — what the divergence check compares. */
  relation: DerivedCouplingRelation;
  /** The specific signal, e.g. "same fleet" or "you both hold locks in packages/x". */
  because: string;
}

/** One coupled peer as a reader sees it, with WHY it is coupled. */
export interface CoupledPeer {
  ownerId: string;
  source: CouplingSource;
  /** Present for a declared edge — the stated why, and who stated it. */
  reason?: string | null;
  declaredBy?: string;
  /**
   * Present when a DERIVATION produced this edge (`derived` or `both`) — the
   * signal(s) that fired, joined with "; " when a peer is coupled several ways.
   * Distinct from `reason`, which is a HUMAN's stated why on a declared edge.
   */
  derivedBecause?: string;
  /**
   * The same signals, TYPED — the machine-readable half of `derivedBecause`
   * (D-087), deduped and in emission order.
   *
   * ⚠ CARRYING THIS THROUGH THE UNION IS THE LOAD-BEARING HALF OF D-087, not a
   * convenience. Typing `DerivedCoupling.relation` alone would have been useless:
   * this function joins the derived signals into ONE prose string, so the type
   * was erased exactly one layer after being introduced and every consumer —
   * including the divergence check that motivated the type — would still have
   * had only prose to work with. A discriminant that does not survive to the
   * consumer is the same defect it was added to fix, one layer down.
   */
  derivedRelations?: DerivedCouplingRelation[];
}

export const COUPLING_REASON_MAX = 500;

/** Keep the coupling read's session-log fallback aligned with the authoritative
 * recorded-live roster leg (adv_sessions, ended_at IS NULL + a zombie-age bound).
 * A session that has not self-registered presence is still a live peer, while an
 * ancient unreaped row is not evidence that the owner still exists. */
const RECORDED_LIVE_MAX_AGE_SEC = Math.max(1, Math.round(RECORDED_LIVE_MAX_AGE_MS / 1000));

/**
 * Normalize an unordered pair. Returns null for a self-pair — an agent coupled to
 * itself is not a relation, and it is the ONE refusal in an otherwise
 * unrestricted surface (D-061 R1). Callers resolve `'self'` BEFORE calling.
 */
export function normalizePair(a: string, b: string): { agentA: string; agentB: string } | null {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y || x === y) return null;
  return x < y ? { agentA: x, agentB: y } : { agentA: y, agentB: x };
}

/**
 * Declare (or re-declare) a coupling between two agents. Idempotent per pair:
 * re-coupling an already-coupled pair refreshes `reason`/`declaredBy`/TTL rather
 * than erroring, and coupling a SUPPRESSED pair lifts the suppression — that is
 * the natural "actually, do couple them after all" and needs no separate verb.
 *
 * Deliberately unauthorized: no check that the caller is a member of the pair.
 *
 * `ttlSec` DEFAULTS TO NONE, and that is a decision — D-006
 * (coupling-signal-liveness-and-lifecycle-2026-08-11 P-006), not an accident of the
 * original migration. Do not give it a default without reversing D-006 first. A
 * clock-based expiry fails SILENTLY here: it makes two live agents stop seeing each
 * other with nothing raised, which is the same confident-wrong-answer class that
 * plan was written to remove. Retirement is CAUSE-based instead — listCouplingsFor
 * drops an edge as soon as either member stops resolving live — and for a declared
 * edge the only other party who knows the work is over is the declarer, which is
 * what `coord:decouple` is for. An explicit ttlSec remains fully supported for the
 * genuinely bounded "couple us while we share this file" case.
 */
export async function declareCoupling(opts: {
  agentA: string;
  agentB: string;
  declaredBy: string;
  reason?: string | null;
  ttlSec?: number | null;
  workspaceId?: string;
}): Promise<CouplingEdge | null> {
  return upsertCoupling({ ...opts, state: 'coupled' });
}

/**
 * Suppress a coupling — the decouple verb. Records state='suppressed' rather than
 * deleting, so the mask survives the next derivation tick (D-061 R4). Suppressing
 * a pair with no prior edge is valid and meaningful: it pre-empts a derivation
 * that has not fired yet.
 */
export async function suppressCoupling(opts: {
  agentA: string;
  agentB: string;
  declaredBy: string;
  reason?: string | null;
  ttlSec?: number | null;
  workspaceId?: string;
}): Promise<CouplingEdge | null> {
  return upsertCoupling({ ...opts, state: 'suppressed' });
}

async function upsertCoupling(opts: {
  agentA: string;
  agentB: string;
  declaredBy: string;
  state: CouplingState;
  reason?: string | null;
  ttlSec?: number | null;
  workspaceId?: string;
}): Promise<CouplingEdge | null> {
  const pair = normalizePair(opts.agentA, opts.agentB);
  if (!pair) return null;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const reason = clampReason(opts.reason);
  const ttl = opts.ttlSec != null && Number.isFinite(opts.ttlSec) && opts.ttlSec > 0 ? Math.floor(opts.ttlSec) : null;
  const { sql } = getOrgPg();
  const rows = await sql<CouplingRow[]>`
    INSERT INTO harness_shared.agent_couplings
      (workspace_id, agent_a, agent_b, state, declared_by, reason, expires_at)
    VALUES
      (${ws}, ${pair.agentA}, ${pair.agentB}, ${opts.state}, ${opts.declaredBy}, ${reason},
       ${ttl == null ? null : sql`clock_timestamp() + make_interval(secs => ${ttl})`})
    ON CONFLICT (workspace_id, agent_a, agent_b) DO UPDATE SET
      state       = EXCLUDED.state,
      declared_by = EXCLUDED.declared_by,
      reason      = EXCLUDED.reason,
      expires_at  = EXCLUDED.expires_at,
      updated_at  = clock_timestamp()
    RETURNING agent_a, agent_b, state, declared_by, reason,
              created_at::text, updated_at::text, expires_at::text
  `;
  return rows[0] ? rowToEdge(rows[0]) : null;
}

/**
 * Every LIVE (unexpired) declared edge touching an agent, from either side of the
 * pair. A coupled edge is only relevant while both members still exist: the
 * ephemeral coord_presence row is positive liveness evidence (the retention reaper
 * removes it only after the owner is ended), and a live adv_sessions row covers the
 * recorded-but-not-yet-registered launch window. This is a READ-TIME retirement,
 * so dead edges stop costing every projection without deleting their audit rows.
 *
 * Suppressions intentionally bypass the member-liveness check. D-061 R4 requires a
 * decouple to remain a durable mask even after a member exits; dropping the mask
 * would let a later derivation resurrect the pair if that owner id is reused.
 */
export async function listCouplingsFor(ownerId: string, workspaceId?: string): Promise<CouplingEdge[]> {
  const id = ownerId.trim();
  if (!id) return [];
  const ws = workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<CouplingRow[]>`
    WITH live_owner AS (
      -- coord_presence is the retained live-roster projection. Do not add a
      -- heartbeat-age predicate here: an old heartbeat with a standing wake can
      -- still be a parked, dispatchable session, and the presence reaper is the
      -- authority that distinguishes that case from an ended owner.
      SELECT cp.workspace_id, cp.owner_id
        FROM harness_shared.coord_presence cp
      UNION
      -- Presence is self-registered, so the session log is the authoritative
      -- fallback during the launch/first-heartbeat window. Keep the same 12h
      -- zombie bound as listRecordedLiveSessions.
      SELECT s.workspace_id, s.coord_owner_id
        FROM harness_shared.adv_sessions s
       WHERE s.coord_owner_id IS NOT NULL
         AND s.ended_at IS NULL
         AND s.started_at > clock_timestamp() - make_interval(secs => ${RECORDED_LIVE_MAX_AGE_SEC})
    )
    SELECT c.agent_a, c.agent_b, c.state, c.declared_by, c.reason, c.relation,
           created_at::text, updated_at::text, expires_at::text
      FROM harness_shared.agent_couplings c
     WHERE c.workspace_id = ${ws}
       AND (c.agent_a = ${id} OR c.agent_b = ${id})
       AND (c.expires_at IS NULL OR c.expires_at > clock_timestamp())
       AND (
         c.state = 'suppressed'
         OR (
           EXISTS (
             SELECT 1
               FROM live_owner l
              WHERE l.workspace_id = c.workspace_id
                AND l.owner_id = c.agent_a
           )
           AND EXISTS (
             SELECT 1
               FROM live_owner l
              WHERE l.workspace_id = c.workspace_id
                AND l.owner_id = c.agent_b
           )
         )
       )
     ORDER BY c.updated_at DESC
  `;
  return rows.map(rowToEdge);
}

/** The other member of a pair, relative to `ownerId`. */
export function peerOf(edge: Pick<CouplingEdge, 'agentA' | 'agentB'>, ownerId: string): string {
  return edge.agentA === ownerId ? edge.agentB : edge.agentA;
}

/**
 * THE UNION (D-061, P-031 leg d) — `derived ∪ declared − suppressed`, as one
 * pure function every consumer calls so nobody re-implements the merge.
 *
 * PURE: both inputs are passed in, so it unit-tests without PG and P-013 can plug
 * its derivation in without this module knowing how a derivation is computed.
 *
 * Suppression wins over BOTH sources — that is the whole point of D-061 R4: a
 * decouple that lost to a live derivation would be a lie, since the derivation
 * re-fires every tick and the agent asked for it to stop showing.
 */
export function resolveCoupledPeers(
  ownerId: string,
  derived: readonly DerivedCoupling[],
  declaredEdges: readonly CouplingEdge[],
): CoupledPeer[] {
  const id = ownerId.trim();
  const suppressed = new Set<string>();
  const declared = new Map<string, CouplingEdge>();
  for (const e of declaredEdges) {
    const peer = peerOf(e, id);
    if (!peer || peer === id) continue;
    if (e.state === 'suppressed') suppressed.add(peer);
    else declared.set(peer, e);
  }
  // Dedupe derived peers while KEEPING every distinct signal: P-013 has five
  // derivations and a peer can trip several at once ("same fleet" AND "recent
  // coord exchange"). Collapsing those to one id would throw away the most
  // useful half of the answer, so signals accumulate per peer.
  const derivedSignals = new Map<string, string[]>();
  // The TYPED half, accumulated in lockstep (D-087). Kept as a separate map
  // rather than parsed back out of the joined prose — round-tripping a
  // discriminant through a rendered string is exactly the erasure this fixes.
  const derivedRelations = new Map<string, DerivedCouplingRelation[]>();
  for (const d of derived) {
    const peer = (d?.ownerId ?? '').trim();
    if (!peer || peer === id) continue;
    const why = (d?.because ?? '').trim();
    const existing = derivedSignals.get(peer);
    if (existing) {
      if (why && !existing.includes(why)) existing.push(why);
    } else {
      derivedSignals.set(peer, why ? [why] : []);
    }
    // Structural, not typechecked-away: `derived` reaches this pure function from
    // callers that hand-build rows, so an absent/garbage relation is skipped
    // rather than propagated as a token no consumer can interpret.
    const rel = d?.relation;
    if (rel && DERIVED_COUPLING_RELATIONS.includes(rel)) {
      const rels = derivedRelations.get(peer);
      if (rels) {
        if (!rels.includes(rel)) rels.push(rel);
      } else {
        derivedRelations.set(peer, [rel]);
      }
    }
  }
  const out: CoupledPeer[] = [];
  const seen = new Set<string>();
  for (const [peer, signals] of derivedSignals) {
    if (suppressed.has(peer)) continue;
    seen.add(peer);
    const d = declared.get(peer);
    const because = signals.join('; ');
    // P-009: a DECLARED relation joins the SAME typed list, so a declared edge
    // participates in the P-008 obligation sort and the P-010 census instead of being
    // invisible to both — which was the whole point of giving the table a relation column.
    // Provenance is not lost: `source` already distinguishes declared/derived/both.
    const rels = mergeDeclaredRelation(derivedRelations.get(peer), d?.relation);
    const derivedWhy = {
      ...(because ? { derivedBecause: because } : {}),
      ...(rels && rels.length > 0 ? { derivedRelations: rels } : {}),
    };
    out.push(
      d
        ? { ownerId: peer, source: 'both', reason: d.reason, declaredBy: d.declaredBy, ...derivedWhy }
        : { ownerId: peer, source: 'derived', ...derivedWhy },
    );
  }
  for (const [peer, e] of declared) {
    if (suppressed.has(peer) || seen.has(peer)) continue;
    // A declared-ONLY peer (no derived signal at all) still carries its typed relation, so
    // a declared obligation sorts with the obligations rather than below them.
    const rels = mergeDeclaredRelation(undefined, e.relation);
    out.push({
      ownerId: peer,
      source: 'declared',
      reason: e.reason,
      declaredBy: e.declaredBy,
      ...(rels ? { derivedRelations: rels } : {}),
    });
  }
  // P-008: OBLIGATIONS FIRST, then everything else; ownerId only as the tiebreaker.
  //
  // ⚠ THE ORDER IS THE FEATURE, NOT A PRESENTATION DETAIL. Every other derived relation
  // says "we are both near this" — a shared file, a shared plan edge, a recent message.
  // An obligation says someone is WAITING. Sorted alphabetically among dozens of
  // symmetric peers (one live leader here supervises 234), a 4-hour-old unanswered
  // consult from a counterpart who has since died renders in the same visual weight as
  // "recent coord exchange", and reads as "as expected". Hoisting it is what makes it
  // unmissable, which is the whole point of the relation existing.
  //
  // ownerId REMAINS the tiebreaker inside each group so the result is still totally
  // ordered and deterministic — callers (and the roster etag) depend on a stable order,
  // and a partial sort would make identical state render differently between reads.
  //
  // Age would be the ideal order WITHIN the obligation group, but a `CoupledPeer` carries
  // no structural timestamp — only the rendered `because`. Parsing an age back out of
  // that prose is precisely the "round-tripping a discriminant through a rendered string"
  // erasure D-087 exists to forbid, so it is deliberately not done here; the age is on
  // every obligation line either way (`obligationPhrase` refuses to render without one).
  const carriesObligation = (p: CoupledPeer): boolean =>
    (p.derivedRelations ?? []).some(isObligationRelation);
  return out.sort((a, b) => {
    const byObligation = Number(carriesObligation(b)) - Number(carriesObligation(a));
    return byObligation !== 0 ? byObligation : a.ownerId.localeCompare(b.ownerId);
  });
}

/**
 * Fold a DECLARED edge's typed relation into the peer's relation list (P-009).
 *
 * Deduped on purpose: a peer can be BOTH declared and derived carrying the same relation,
 * and listing it twice would double-count it in the P-010 concentration census — inflating
 * exactly the share that guard measures.
 */
function mergeDeclaredRelation(
  rels: DerivedCouplingRelation[] | undefined,
  declaredRelation: DerivedCouplingRelation | null | undefined,
): DerivedCouplingRelation[] | undefined {
  if (!declaredRelation) return rels;
  if (!rels || rels.length === 0) return [declaredRelation];
  return rels.includes(declaredRelation) ? rels : [...rels, declaredRelation];
}

function clampReason(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  return s.length > COUPLING_REASON_MAX ? s.slice(0, COUPLING_REASON_MAX - 1) + '…' : s;
}

interface CouplingRow {
  agent_a: string;
  agent_b: string;
  state: string;
  declared_by: string;
  reason: string | null;
  relation: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

function rowToEdge(r: CouplingRow): CouplingEdge {
  // The column is deliberately unconstrained in SQL (migration 954 / D-017): the
  // vocabulary lives in `DERIVED_COUPLING_RELATIONS` and a CHECK would be a second
  // hand-maintained copy that drifts. So the narrowing happens HERE, at the read
  // boundary — an unrecognised or NULL value becomes null rather than being passed
  // through as a token no consumer can interpret, exactly as `resolveCoupledPeers`
  // already does for derived rows.
  const rel = (r.relation ?? '').trim();
  const relation = DERIVED_COUPLING_RELATIONS.includes(rel as DerivedCouplingRelation)
    ? (rel as DerivedCouplingRelation)
    : null;
  return {
    agentA: r.agent_a,
    agentB: r.agent_b,
    state: (r.state as CouplingState) ?? 'coupled',
    declaredBy: r.declared_by,
    reason: r.reason,
    relation,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
  };
}
