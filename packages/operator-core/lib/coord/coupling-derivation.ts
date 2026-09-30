/**
 * coupling-derivation.ts — P-013's DERIVED half of the coupling union.
 *
 * Plan: unified-agent-state-plane-2026-07-27, P-013. Scoping ruling: D-078.
 *
 * WHY THIS EXISTS. `resolveCoupledPeers` has always been `derived ∪ declared −
 * suppressed`, but `derived` was hard-coded `[]` at the only call site
 * (presence.ts), so `coord:presence`'s `expanded[]` block could only ever show
 * peers somebody had DECLARED by hand. This computes the derived half.
 *
 * ⚠ IT IS A CONSUMER OF THE UNION, NOT A SECOND COUPLING MECHANISM (D-078 (b)).
 * It returns a value that is passed INTO `resolveCoupledPeers`; it never writes
 * `agent_couplings` (that table is the DECLARED half, owned by coord:couple) and
 * never builds a parallel expansion path. Routing through the union is also what
 * keeps suppression winning: an agent that decoupled a peer stays decoupled even
 * though this derivation re-fires on every read (D-061 R4).
 *
 * ⚠ RE-RANKING ONLY, NEVER WIDENING (D-044, D-078 (c)). `deriveCouplingsFromRoster`
 * is computed purely from roster rows the caller is ALREADY being sent, so it
 * cannot surface a peer the caller could not otherwise observe — a guarantee that
 * holds BY CONSTRUCTION rather than by an access check that could be wrong.
 *
 * The QUERYING signals below (lock holds, plan `blocked-by`, recent coord
 * exchange) keep that property by a different route: each reads only things the
 * caller can ALREADY read — locks in its own coordination domain, its OWN plan's
 * item graph, its OWN messages — and each is keyed to a peer that must ALSO be
 * in the caller's roster to be emitted. No signal can introduce an ownerId the
 * roster did not already contain; see `deriveCouplings`.
 *
 * On D-078 (c) specifically: that ruling binds any CELL-backed input to
 * `getCell(cell, reader)` / `listCells(reader)` rather than the `Unchecked`
 * accessors. This derivation reads no cells at all — not a workaround but the
 * strongest form of compliance, and stated explicitly so a reviewer does not
 * read the absence of a `getCell` call as the ruling being ignored. Should a
 * signal ever need registry data, it MUST take the checked reader path or leg C
 * of the D-076 parity gate reds.
 *
 * ⚠ PURE AND TOTAL, like `resolveCoupledPeers` and `buildCoupledExpansion`
 * before it: rows come in as `unknown[]` and are read structurally, so it unit-
 * tests without PG and a malformed row is skipped rather than thrown on. A
 * derivation that throws would take down `coord:presence`, which is a far worse
 * outcome than a missing `expanded[]` entry.
 */
import { formatElapsedSince } from '../format/relative-time';
// TYPE-ONLY, deliberately: this module stays pure and PG-free, and a type import
// creates no runtime edge. Tying the liveness vocabulary to the SHARED oracle's
// `SessionState` rather than restating a literal union means a rename there breaks
// HERE at compile time — the same discipline `ObligationRelation` uses via `Extract`.
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { OBLIGATION_RELATIONS } from './couplings';
import type { DerivedCoupling, DerivedCouplingRelation } from './couplings';
import { censusDerivedSignals, type DerivedSignalCensus } from './derived-signal-census';

/**
 * ⚠ EVERY EMIT SITE BELOW SETS BOTH `relation` AND `because`, FROM THE SAME
 * BRANCH (D-087). The typed token is not extra bookkeeping bolted on next to the
 * prose — it is the value the branch already knew and used to be discarded:
 * every `out.push` here sits inside an `if` that has ALREADY decided which signal
 * fired, and then threw that decision away into a sentence. The rule for a new
 * signal: add its token to `DERIVED_COUPLING_RELATIONS`, and never render prose
 * for a signal that has no token — an untyped signal is invisible to the
 * divergence check while still looking fine to a human reading `expanded[]`.
 */

/** How many overlapping LOCK HOLDS to name before summarising the rest. */
export const DERIVATION_LOCKS_NAMED = 2;

/** The roster fields this derivation reads. Structural, so any roster row fits.
 *
 *  Every field here is a REAL emitted roster field — `PRESENCE_IDENTITY_FIELDS` /
 *  `PRESENCE_STATE_FIELDS` in presence-payload.ts. That is asserted by a contract
 *  test (coupling-derivation.test.ts) rather than left to review, because this
 *  interface is structural: a typo or a renamed producer field would still
 *  typecheck and every hand-built fixture would still pass. */
export interface DerivationRow {
  ownerId?: string | null;
  fleetSlug?: string | null;
  awaitingEventKey?: string | null;
  currentPlanSlug?: string | null;
  claimedItems?: readonly string[] | null;
  /** Plan-QUALIFIED (`<slug>#<item>`) occupancy from held, non-terminal work-items —
   *  see {@link planItemsHeldOn}. Produced by presence-tier1, emitted in the STATE
   *  lane. */
  claimedPlanItemRefs?: readonly string[] | null;
}

/** Split a `<plan_slug>#<item_id>` occupancy ref. The producer builds these with
 *  `planItemRef`; this is the only place that takes one apart, so the format has
 *  exactly two sites and a test pins them to each other.
 *
 *  Splits on the FIRST `#`: plan slugs never contain one, and splitting last would
 *  mis-parse an item id that did. */
function splitPlanItemRef(ref: string): { plan: string; item: string } | null {
  const at = ref.indexOf('#');
  if (at <= 0 || at === ref.length - 1) return null;
  return { plan: ref.slice(0, at), item: ref.slice(at + 1) };
}

/**
 * Every plan item this row occupies ON `planSlug`, from BOTH surfaces that record
 * occupancy — the union that makes this signal reachable at all.
 *
 * `claimedItems` (from `plan_item_claims`) holds PLAN-LOCAL ids, so it counts only
 * when the row's declared `currentPlanSlug` IS this plan — a bare `P-003` compared
 * across plans is an identifier collision, not a match.
 *
 * `claimedPlanItemRefs` (from held work-items' `payload.plan_item` stamp) is already
 * plan-qualified, so it needs no declared plan and CANNOT collide. That is why a peer
 * counts as being on this plan through work it holds here even when it declares a
 * different `currentPlanSlug` — a strictly safer match than the declaration, since
 * holding the work is the stronger evidence.
 *
 * ⚠ EI-20200393414409502: keying this to `plan_item_claims` ALONE is what made
 * `blocks-me`/`blocked-by-me` unfirable. Fleet-wide, 31 agents held work-items and 5
 * held live plan-item claims; NO plan had the two co-holders the signal required, so
 * it censused a permanent, error-free zero — indistinguishable from "this never
 * happens" — while 6 plans had co-located agents and blocked items.
 */
function planItemsHeldOn(row: DerivationRow | undefined, planSlug: string): Set<string> {
  const out = new Set<string>();
  if (!row || !planSlug) return out;
  if (cleanId(row.currentPlanSlug) === planSlug) {
    for (const item of itemList(row.claimedItems)) out.add(item);
  }
  for (const ref of itemList(row.claimedPlanItemRefs)) {
    const parsed = splitPlanItemRef(ref);
    if (parsed && parsed.plan === planSlug) out.add(parsed.item);
  }
  return out;
}

/** One `blocked-by` edge within a single plan: `item` cannot start until each of
 *  `blockedBy` is done. Mirrors `PlanItem.blockedBy` (libs/generic/plan-parser). */
export interface PlanBlockingEdge {
  item: string;
  blockedBy: readonly string[];
}

function cleanId(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function fileSet(v: unknown): Set<string> {
  if (!Array.isArray(v)) return new Set();
  const out = new Set<string>();
  for (const f of v) {
    const s = cleanId(f);
    if (s) out.add(s);
  }
  return out;
}

/**
 * Derive coupled peers from the caller's own roster.
 *
 * Emits ONE {@link DerivedCoupling} per (peer, signal) pair — the union
 * accumulates them into a single `derivedBecause` per peer (D-078 (a)), which is
 * why a peer coupled three ways reads "same fleet; both working in x; ..." and
 * not just the first signal that happened to fire.
 *
 * Rows are visited in the order given, so two readers with the same roster
 * derive the same string.
 *
 * ⛔ NO `shared-file` EDGE HERE — the `currentFiles` signal was REMOVED
 * 2026-08-10 (D-093) after measuring ZERO shared-file edges across 14 days of
 * production divergence stamps. It was never a bug, just permanently starved:
 * `current_files` is populated ONLY by an explicit
 * `coord:declare-intent { current_files }`, and every declare that OMITS the arg
 * RESETS it to `[]`, so measured live 2026-07-27 (EI-18772330418885814) 119 live
 * presence rows carried ZERO non-empty `current_files`. A live FILE LOCK is the
 * strongest, and the only AUTOMATIC, "this agent is on this file" signal there
 * is, so `deriveCouplingsFromHeldFiles` fully supersedes it. Keeping a signal
 * that cannot fire is not free: it sat in the dead-signal census forever, where
 * a permanently-starved leg is indistinguishable from a newly-broken one.
 *
 * ⚠ THE ROSTER FIELD `current_files` ITSELF STAYS — do not "finish the job" by
 * removing it (D-095). It has a real writer (session-brief.ts) and live
 * consumers (adv-roster.ts, agent-orders-notify.ts). Only the COUPLING SIGNAL
 * derived from it is gone. The comment this file used to carry — "populated only
 * by explicit declare-intent, 119 live rows zero populated" — is a statement
 * about AGENTS not populating the field, NOT about the code lacking a writer,
 * and it was misread as the latter once already.
 *
 * The general lesson, since it nearly shipped silently here: a green unit test
 * over hand-built fixtures cannot distinguish "field is wrong" from "field is
 * real but always empty" — both pass. Only a check against the PRODUCER can.
 */
/**
 * THE BINDING INPUT OF THE `awaits` LEG — how many peers this run could actually
 * have matched, which is ZERO whenever the caller is not itself awaiting anything.
 *
 * ── WHY THIS EXISTS (EI-20088486454213771) ──────────────────────────────────
 *
 * The census used to report this leg's `inputs` as the PEER ROW COUNT, while the
 * computation is decided by a SELF-side field before the peer loop begins:
 * `myAwait` empty ⇒ zero edges however many peers there are. So a short-circuited
 * run published "armed, 1023 inputs, 0 edges", which reads unambiguously as *we
 * compared 1023 candidates and rejected them all* — a predicate-bug signature.
 * That exact number sent three separate readings hunting a phantom bug in correct
 * code before each was refuted by reading the writer.
 *
 * The verdict vocabulary in `check-derived-signal-firings.mjs` could ALREADY tell
 * the two cases apart — `starved` (consulted, input empty: nothing was evaluated)
 * versus `armed-silent` (had input, emitted nothing: a true negative). It was
 * simply being fed a number that made a starved run look armed-silent. So the
 * repair is to count the input that BINDS, not to add a verdict.
 *
 * GENERAL RULE THIS INSTANTIATES: a metric that counts the candidates a
 * computation WOULD have examined, without recording whether it examined any,
 * cannot distinguish a true negative from a skipped evaluation — and a reader
 * resolves that ambiguity toward the alarming reading every time.
 */
export function awaitsBindingInputs(selfOwnerId: string, rows: readonly unknown[]): number {
  const self = cleanId(selfOwnerId);
  if (!self) return 0;
  let myAwait = '';
  const peers = new Set<string>();
  for (const raw of rows) {
    const row = (raw ?? {}) as DerivationRow;
    const id = cleanId(row.ownerId);
    if (!id) continue;
    if (id === self) {
      // First self row wins, matching the derivation's own `selfRow ??=`.
      if (!myAwait) myAwait = cleanId(row.awaitingEventKey);
      continue;
    }
    peers.add(id);
  }
  // The self-side precondition decides the run BEFORE any peer is examined, so an
  // empty key means nothing was measured — not that every peer was rejected.
  return myAwait ? peers.size : 0;
}

export function deriveCouplingsFromRoster(
  selfOwnerId: string,
  rows: readonly unknown[],
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self) return [];

  let selfRow: DerivationRow | undefined;
  const peers: DerivationRow[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as DerivationRow;
    const id = cleanId(row.ownerId);
    if (!id) continue;
    if (id === self) {
      selfRow ??= row;
      continue;
    }
    peers.push(row);
  }
  // No row for the caller ⇒ nothing to compare against. Honest empty, not a throw:
  // a caller outside its own roster is a scope question, not a coupling question.
  if (!selfRow) return [];

  // ⚠ EARLY-RETURN THROUGH THE CENSUS'S OWN COUNTER, ON PURPOSE — do not inline
  // this back into the loop guard. Routing both through `awaitsBindingInputs`
  // makes "the census recorded 0 inputs" and "this leg could not emit" the SAME
  // fact rather than two facts that agree until someone edits one of them
  // (EI-20088486454213771). See that helper for the defect it repairs.
  if (awaitsBindingInputs(self, rows) === 0) return [];

  const myAwait = cleanId(selfRow.awaitingEventKey);

  const out: DerivedCoupling[] = [];
  const seen = new Set<string>();
  for (const row of peers) {
    const ownerId = cleanId(row.ownerId);
    // A roster can legitimately repeat an ownerId (federated/overlay rows); the
    // first row wins so the derivation stays deterministic.
    if (seen.has(ownerId)) continue;
    seen.add(ownerId);

    // ⛔ NO `same-fleet` EDGE HERE — D-054 cut it and this file emitted it anyway for 12 days.
    // Do not "restore the missing fleet signal": fleet membership is already on every roster
    // row as `fleetSlug`, so deriving an edge from it buys volume and no information. See
    // DERIVED_COUPLING_RELATIONS for the measured blast radius (18-member fleet ⇒ 306 edges).

    if (myAwait && cleanId(row.awaitingEventKey) === myAwait) {
      out.push({ ownerId, relation: 'awaits', because: `both awaiting ${myAwait}` });
    }
  }
  return out;
}

/** Render the lock-overlap signal, naming a bounded number of paths. */
function sharedLocksPhrase(shared: readonly string[]): string {
  const named = shared.slice(0, DERIVATION_LOCKS_NAMED);
  const rest = shared.length - named.length;
  const list = named.join(', ');
  // ⚠ "working in", NOT "hold locks in". The source is held locks UNION in-flight
  // waiter tickets (EI-20199756190949760): a mutual-exclusion table can never show
  // two owners on one path, so co-interest is the only satisfiable predicate — and
  // one side of an edge may be QUEUED for the path rather than holding it. Claiming
  // both "hold locks" would be false for exactly the edges this signal now emits,
  // which is a lie in the one signal the auto-coupling rubric grades for honesty.
  return rest > 0
    ? `you are both working in ${list} (+${rest} more shared ${rest === 1 ? 'path' : 'paths'})`
    : `you are both working in ${list}`;
}

/**
 * THE FILE SIGNAL THAT ACTUALLY FIRES: overlapping live LOCK HOLDS.
 *
 * D-078's item text names "overlapping/adjacent lock holds", and this is it —
 * the automatic signal `current_files` was supposed to be but is not (see
 * `deriveCouplingsFromRoster`'s note). Pure over an INJECTED map so it unit-tests
 * without the lock DB; `fetchPresenceHeldFiles` supplies it in production.
 *
 * NEVER WIDENS: it emits only ownerIds already present in `held`, which the
 * caller's own presence read produced, restricted to its own coordination domain.
 */
/**
 * THE BINDING INPUT OF THE `holds-a-lock-on` LEG — peers whose holds this run
 * could actually have overlapped, which is ZERO whenever the caller holds no
 * files of its own.
 *
 * Same defect and same repair as {@link awaitsBindingInputs}, which carries the
 * full rationale. Two distinct ways the old `held.size` misreported:
 *
 *   · the caller holding NOTHING short-circuits before the loop, yet every
 *     peer's map entry was still counted as an examined input;
 *   · `held` contains the CALLER's own entry, so a run where only the caller
 *     held locks reported `inputs: 1` — an examined-and-rejected reading of a
 *     comparison that had no candidate in it at all.
 */
export function heldFilesBindingInputs(
  selfOwnerId: string,
  held: ReadonlyMap<string, readonly string[]>,
): number {
  const self = cleanId(selfOwnerId);
  if (!self) return 0;
  // The caller's own holds are what every comparison is made AGAINST; with none,
  // the run is decided before any peer is examined.
  if (fileSet(held.get(self) ?? []).size === 0) return 0;
  let peers = 0;
  for (const [rawId] of held) {
    const id = cleanId(rawId);
    if (id && id !== self) peers += 1;
  }
  return peers;
}

export function deriveCouplingsFromHeldFiles(
  selfOwnerId: string,
  held: ReadonlyMap<string, readonly string[]>,
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self) return [];
  // Early-return through the census's own counter — see `awaitsBindingInputs`.
  if (heldFilesBindingInputs(self, held) === 0) return [];
  const mine = fileSet(held.get(self) ?? []);
  if (mine.size === 0) return [];

  const out: DerivedCoupling[] = [];
  for (const [rawId, paths] of held) {
    const ownerId = cleanId(rawId);
    if (!ownerId || ownerId === self) continue;
    const shared: string[] = [];
    for (const p of fileSet(paths)) if (mine.has(p)) shared.push(p);
    if (shared.length === 0) continue;
    shared.sort();
    out.push({ ownerId, relation: 'holds-a-lock-on', because: sharedLocksPhrase(shared) });
  }
  // Map iteration order is insertion order, which the caller controls; sort so the
  // derived string is identical for two readers with the same holds (D-006).
  out.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  return out;
}

/**
 * Plan `blocked-by` edges — the dependency signal, and the only one here that is
 * DIRECTIONAL. Both directions are emitted because they mean opposite things to
 * the reader: a peer holding what blocks you is who to CHASE; a peer blocked on
 * what you hold is who is waiting on YOU. The second is the more actionable and
 * the one an agent is least likely to discover on its own.
 *
 * Scoped to a single plan — `edges` are the caller's OWN plan's item graph, which
 * the caller can already read, and a peer is considered only when the roster says
 * it is working that same plan. Pure over injected edges, so no PG in tests.
 */
export function deriveCouplingsFromPlanBlocking(
  selfOwnerId: string,
  rows: readonly unknown[],
  edges: readonly PlanBlockingEdge[],
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self || edges.length === 0) return [];

  let selfRow: DerivationRow | undefined;
  const peers: DerivationRow[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as DerivationRow;
    const id = cleanId(row.ownerId);
    if (!id) continue;
    if (id === self) selfRow ??= row;
    else peers.push(row);
  }
  if (!selfRow) return [];

  // The plan under comparison still comes from the caller's DECLARATION, so exactly
  // one plan's edges are ever read. Widening `myPlan` to every plan the caller holds
  // stamped work on would multiply the expensive plan read — the cost this signal is
  // gated on — for a case the declaration already covers (43 agents declare a plan).
  const myPlan = cleanId(selfRow.currentPlanSlug);
  if (!myPlan) return [];
  const myItems = planItemsHeldOn(selfRow, myPlan);
  if (myItems.size === 0) return [];

  /** item → the items it is blocked BY. */
  const blockedBy = new Map<string, Set<string>>();
  for (const e of edges) {
    const item = cleanId(e.item);
    if (!item) continue;
    const deps = new Set(itemList(e.blockedBy));
    if (deps.size > 0) blockedBy.set(item, deps);
  }

  const out: DerivedCoupling[] = [];
  const seen = new Set<string>();
  for (const row of peers) {
    const ownerId = cleanId(row.ownerId);
    if (seen.has(ownerId)) continue;
    // Same plan only: a `blocked-by` id is plan-local, so comparing it against an
    // item claimed on a DIFFERENT plan would couple two agents over a collision of
    // identifiers ("P-003") that mean unrelated things. `planItemsHeldOn` IS that
    // scoping now — it admits a peer's plan-local `claimedItems` only when the peer
    // declares this same plan, and admits its work-item occupancy only through refs
    // already qualified with this plan. So the guard moved INTO the helper; it did
    // not go away, and a peer on another plan still yields an empty set here.
    const theirItems = [...planItemsHeldOn(row, myPlan)].sort();
    if (theirItems.length === 0) continue;
    seen.add(ownerId);

    for (const mineItem of [...myItems].sort()) {
      const deps = blockedBy.get(mineItem);
      if (!deps) continue;
      for (const t of theirItems) {
        if (deps.has(t)) {
          out.push({
            ownerId,
            relation: 'blocks-me',
            because: `your ${mineItem} is blocked by ${t}, which they hold`,
          });
        }
      }
    }
    for (const t of [...theirItems].sort()) {
      const deps = blockedBy.get(t);
      if (!deps) continue;
      for (const mineItem of myItems) {
        if (deps.has(mineItem)) {
          out.push({
            ownerId,
            relation: 'blocked-by-me',
            because: `their ${t} is blocked by ${mineItem}, which you hold`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Recent DIRECTED coord exchange.
 *
 * ⚠ BROADCASTS ARE EXCLUDED AT THE SOURCE, and that exclusion is the whole design
 * of this signal. A `to:['*']` message reaches the entire fleet, so counting it as
 * an exchange would couple every agent to every other after a single broadcast —
 * turning `expanded[]` from a relevance signal into a roster copy and making
 * `expandedBecause` meaningless. Only a message naming a concrete counterpart
 * says these two agents are actually working together.
 *
 * Pure over an injected partner list (already deduped + broadcast-filtered by the
 * source), keyed to the roster by the caller in `deriveCouplings`.
 */
export function deriveCouplingsFromCoordExchange(
  selfOwnerId: string,
  partnerIds: readonly string[],
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self) return [];
  const out: DerivedCoupling[] = [];
  const seen = new Set<string>();
  for (const raw of partnerIds) {
    const ownerId = cleanId(raw);
    if (!ownerId || ownerId === self || seen.has(ownerId)) continue;
    seen.add(ownerId);
    out.push({ ownerId, relation: 'coord-exchange', because: 'recent coord exchange' });
  }
  out.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  return out;
}

/**
 * The two DIRECTIONAL members of the obligation family, tied to the vocabulary by
 * `Extract` rather than restated. A rename in `DERIVED_COUPLING_RELATIONS` then breaks
 * HERE at compile time instead of leaving a second literal union quietly describing a
 * relation that no longer exists.
 */
export type ObligationRelation = (typeof OBLIGATION_RELATIONS)[number];

/**
 * The counterpart's liveness as an obligation line reports it (P-011).
 *
 * `SessionState` verbatim from the shared oracle — the same verdict `coord:presence` and
 * `fleet:assignments` derive, never a raw heartbeat boolean (a warm-dead session reads
 * `heartbeatFresh: true` with `sessionState: 'ended'`, so a heartbeat would report the
 * OPPOSITE of the truth on exactly the rows that matter) — WIDENED by one explicit
 * `'unknown'` member for a counterpart the oracle could not measure.
 *
 * ⚠ `'unknown'` IS A VERDICT, NOT A MISSING VALUE. The oracle already reports an
 * unmeasured subject in band (`sessionState: null` alongside `signalMissing`) rather than
 * dropping it from its result map, precisely so a caller cannot mistake "not measured"
 * for "fine". Naming it here carries that discipline through to the rendered line: the
 * reader is told the difference between "they are alive", "they are gone", and "I do not
 * know", and the third never disguises itself as the first.
 */
export type ObligationLiveness = SessionState | 'unknown';

/**
 * ONE outstanding obligation between the caller and a peer, as a source hands it over.
 *
 * Deliberately NOT consult-shaped. The plan feeds three producers into this one relation
 * family — consults (P-004), grading (P-006) and supervision (P-007) — so the edge carries
 * `what` as a noun phrase rather than a `kind` enum this module would have to branch on.
 * A new producer then adds a source, never a case here.
 */
export interface ObligationEdge {
  /** The COUNTERPART — never the caller. */
  ownerId: string;
  /** Which way the debt runs. This IS the emitted relation (see below). */
  direction: ObligationRelation;
  /** WHAT is owed, as a short noun phrase: "a consult reply", "a grade". */
  what: string;
  /** When the obligation was ENTERED — ISO string or epoch ms. Renders as its age. */
  since: string | number;
  /** The id the reader can ACT on without having to go find one: a conversation id, a
   *  rubric ref, a work-item id. */
  handle: string;
  /**
   * The COUNTERPART's liveness RIGHT NOW (P-011). REQUIRED — see below.
   *
   * ⚠ THIS FIELD IS NOT OPTIONAL, AND MAKING IT OPTIONAL WOULD SILENTLY REINTRODUCE THE
   * BUG IT EXISTS TO FIX. P-011's contract is that a counterpart with no presence row
   * renders an EXPLICIT unknown, "never an omitted field that reads as live". An optional
   * field has exactly one failure mode — a producer forgets it — and that failure renders
   * as silence, which a reader interprets as "nothing to worry about". Requiring it makes
   * a forgetful producer a COMPILE error instead of a confident wrong answer.
   *
   * `'unknown'` is a first-class member, not a fallback: the shared oracle reports an
   * unmeasured subject IN BAND (`sessionState: null` + `signalMissing`, D-038 axis 2)
   * rather than by omitting it from the result map, and this mirrors that. A producer
   * that could not measure must pass `'unknown'` — never guess `'live'`.
   */
  counterpartLiveness: ObligationLiveness;
}

/**
 * Render an obligation's `because` — direction + age + handle — or `null` when it cannot
 * be rendered in full.
 *
 * ⚠ THE `null` IS THE POINT, AND IT IS WHY THIS IS A FUNCTION RATHER THAN A TEMPLATE AT
 * THE EMIT SITE. Every other signal here degrades gracefully when a part is missing,
 * because its parts are decorative: "you are both working in x" loses a path and still
 * says the true thing. An obligation does not degrade — it INVERTS. Drop the age and
 * "they owe you a consult reply" reads as routine when it may be 58 hours old; drop the
 * handle and the reader is told they are owed something with no way to act on it and no
 * way to find out what. Both render as a confident sentence, which is worse than silence:
 * a reader cannot tell a rendered-thin obligation from a genuinely minor one.
 *
 * So the three parts are a CONJUNCTION, not a best-effort concatenation. A source that
 * cannot supply all three has not established an obligation worth surfacing, and the
 * derivation skips the edge rather than emitting a bare string. This is the same contract
 * `formatElapsedSince` already keeps for its own value — `''` rather than `"0s"` for a
 * duration it never measured, because "0s" is a number a reader would act on.
 *
 * `nowMs` is injectable so a test asserts an exact string without freezing the clock.
 */
export function obligationPhrase(
  edge: ObligationEdge,
  nowMs: number = Date.now(),
): string | null {
  if (edge?.direction !== 'owes-me' && edge?.direction !== 'i-owe') return null;
  const what = cleanId(edge.what);
  const handle = cleanId(edge.handle);
  // '' whenever `since` is absent or unparseable — the age half of the conjunction.
  const age = formatElapsedSince(edge.since, nowMs);
  if (!what || !handle || !age) return null;
  const lead = edge.direction === 'owes-me' ? `they owe you ${what}` : `you owe them ${what}`;
  // P-011. ALWAYS rendered, for every verdict including `live`. Rendering it only for
  // the alarming states would make ABSENCE mean "fine", which is the same silence that
  // lets an unmeasured counterpart read as healthy — the exact failure this carries.
  return `${lead}, open ${age}, counterpart ${obligationLiveness(edge.counterpartLiveness)} (${handle})`;
}

/**
 * Every member of {@link ObligationLiveness}, as runtime values.
 *
 * The `satisfies` catches a value that is NOT in the union; `_ObligationLivenessCovered`
 * below catches the opposite and more dangerous direction — the union GAINING a member
 * (a new `SessionState`) that this list forgets. Without it a newly-added state would
 * silently fall through to `'unknown'`, i.e. a real verdict quietly downgraded to "I do
 * not know" with nothing failing.
 */
const OBLIGATION_LIVENESS_VALUES = [
  'live',
  'parked',
  'draining',
  'suspect',
  'ended',
  'recorded',
  'unknown',
] as const satisfies readonly ObligationLiveness[];

/** Compile-time exhaustiveness: errors if `ObligationLiveness` gains an unlisted member. */
type _ObligationLivenessCovered =
  Exclude<ObligationLiveness, (typeof OBLIGATION_LIVENESS_VALUES)[number]> extends never
    ? true
    : never;

const OBLIGATION_LIVENESS_SET: ReadonlySet<string> = new Set(OBLIGATION_LIVENESS_VALUES);

/**
 * Normalize a counterpart-liveness value, defaulting to `'unknown'`.
 *
 * ⚠ AN UNRECOGNISED VALUE BECOMES `'unknown'`, NEVER `'live'`, AND NEVER DROPS THE EDGE.
 * Two failure modes are being steered between. Rendering an unmeasurable counterpart as
 * live is the bug P-011 names outright. But REFUSING the edge would be worse than either:
 * the debt is real regardless of whether we can see the peer, so suppressing it would
 * hide an outstanding obligation because of a gap in our own instrumentation — silence
 * about a thing the reader is owed. So the edge always survives; only the confidence
 * degrades, and it degrades visibly.
 *
 * The type makes this branch unreachable from TypeScript. It exists for JS callers and
 * for a row that crossed a boundary the compiler does not police.
 */
function obligationLiveness(raw: unknown): ObligationLiveness {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return OBLIGATION_LIVENESS_SET.has(v) ? (v as ObligationLiveness) : 'unknown';
}

/**
 * The OBLIGATION signal: edges a source has already established as pairwise facts.
 *
 * Pure over an injected list, like every other querying leg, so it unit-tests with no PG
 * and no consult table. The producers land in P-004/P-006/P-007.
 *
 * `relation` and `because` come from the SAME field (`direction`) — the strongest form of
 * D-087's "both from the same branch": there is no branch that could set one and forget
 * the other, because the discriminant IS the input.
 *
 * ⚠ SOURCE ORDER IS PRESERVED, unlike the lock and coord-exchange legs which sort by
 * ownerId. Those sort because their input is a Map whose iteration order carries no
 * meaning. An obligation list DOES carry meaning in its order — oldest-first is the
 * reading a source should supply and the one P-008 renders — and sorting by ownerId
 * would destroy it for no determinism gain, since an ordered query is already
 * deterministic. A source that returns rows in an arbitrary order must impose its own.
 */
export function deriveCouplingsFromObligations(
  selfOwnerId: string,
  obligations: readonly ObligationEdge[],
  nowMs: number = Date.now(),
): DerivedCoupling[] {
  const self = cleanId(selfOwnerId);
  if (!self) return [];
  const out: DerivedCoupling[] = [];
  for (const raw of obligations) {
    const edge = (raw ?? {}) as ObligationEdge;
    const ownerId = cleanId(edge.ownerId);
    // A self-obligation is not a relation (couplings.ts `normalizePair` refuses the same
    // pair), and an unrenderable one is skipped rather than emitted thin — see above.
    if (!ownerId || ownerId === self) continue;
    const because = obligationPhrase(edge, nowMs);
    if (!because) continue;
    // NOT deduped by peer: two open consults with the same agent are two real debts, and
    // the union joins them into one `derivedBecause`. Collapsing them would under-report
    // exactly the agent who owes you most.
    out.push({ ownerId, relation: edge.direction, because });
  }
  return out;
}

/** Normalize a claimed-items / blocked-by list to clean ids. */
function itemList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = cleanId(x);
    if (s) out.push(s);
  }
  return out;
}

/** The bounded, caller-scoped reads the querying signals need. Each is OPTIONAL:
 *  an unavailable source degrades that one signal, never the whole derivation. */
export interface CouplingDerivationSources {
  /** ownerId → live lock paths, for the roster's own agents. */
  heldFiles?: () => Promise<ReadonlyMap<string, readonly string[]>>;
  /** The caller's OWN plan's `blocked-by` graph. */
  planEdges?: (planSlug: string) => Promise<readonly PlanBlockingEdge[]>;
  /** Concrete peers the caller exchanged DIRECTED messages with recently. */
  recentPartners?: () => Promise<readonly string[]>;
  /**
   * Outstanding OBLIGATIONS in both directions, already established as pairwise facts by
   * the producer (consults P-004, grading P-006, supervision P-007).
   *
   * Absent until a producer lands, and that is a REPORTED state rather than a silent one:
   * the census reads `armed: !!sources.obligations`, so the relations census as
   * wired-but-unsupplied instead of looking like honest scarcity. That distinction is the
   * whole reason the census exists (D-088), and it is why the relation is allowed to enter
   * the vocabulary ahead of its producer instead of being born unobservable.
   */
  obligations?: () => Promise<readonly ObligationEdge[]>;
  /**
   * P-007 — the DEAD-SIGNAL CENSUS sink. Optional and fail-soft: a caller that
   * wires it gets one `DerivedSignalCensus` per run (see derived-signal-census.ts
   * for why `armed` is recorded separately from `edges`); a caller that does not
   * changes nothing. Never let it affect the derivation's result — an observer
   * that can alter or break what it observes is worse than no observer.
   */
  observe?: (census: DerivedSignalCensus) => void;
}

/**
 * THE ORCHESTRATOR: the pure roster derivation ∪ the querying signals.
 *
 * FAIL-SOFT PER LEG, deliberately: each source is awaited independently and a
 * thrown/rejected one contributes nothing while the others still land. A single
 * dead source must not cost the reader every OTHER signal — and none of them may
 * cost it the roster, which is why `coord:presence` also wraps the whole call.
 *
 * ⚠ THE ROSTER IS THE ACCESS BOUNDARY. Every derived edge is filtered to ownerIds
 * present in `rows` before it is returned. The querying sources are already
 * caller-scoped, so this is belt-and-braces — but it is what makes "coupling may
 * re-rank what a reader can already see and may never widen it" (D-044 / D-078
 * (c)) true STRUCTURALLY for the querying half, exactly as purity makes it true
 * for the roster half, instead of resting on each source staying well-behaved.
 */
export async function deriveCouplings(
  selfOwnerId: string,
  rows: readonly unknown[],
  sources: CouplingDerivationSources = {},
): Promise<DerivedCoupling[]> {
  const self = cleanId(selfOwnerId);
  if (!self) return [];

  const inRoster = new Set<string>();
  let selfRow: DerivationRow | undefined;
  for (const raw of rows) {
    const row = (raw ?? {}) as DerivationRow;
    const id = cleanId(row.ownerId);
    if (!id) continue;
    inRoster.add(id);
    if (id === self) selfRow ??= row;
  }

  const settle = async <T>(f: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
    if (!f) return fallback;
    try {
      return await f();
    } catch {
      return fallback;
    }
  };

  // The plan read is the EXPENSIVE leg — `readPlanBySlug` fetches and PARSES a
  // whole plan, and plans in this repo reach 90KB+ of prose. So it is gated on a
  // precondition computed purely from rows already in hand: the signal can only
  // fire if the caller claims items on a plan AND some peer in the roster is on
  // that same plan holding items of its own. In the common case (nobody else on
  // your plan) the read never happens at all, rather than being paid on every
  // poll to produce nothing — the P-013 analogue of the per-process fleet-wide
  // recomputation costed in WI-6126.
  //
  // ⚠ THE PEER CONDITION STAYS (D-004). EI-20200393414409502 made this precondition
  // unsatisfiable fleet-wide, and the tempting one-line "fix" is to drop the peer
  // clause so a lone claimant triggers the read. That would put the 90KB+ plan parse
  // back on the common path — the cost argument above is still sound. What was wrong
  // was never the SHAPE of the gate, only the narrow surface it measured occupancy
  // on: `plan_item_claims` alone, while the fleet records its work in work-items.
  // `planItemsHeldOn` reads both, so the same two-holder gate is now REACHABLE
  // instead of being a permanent false.
  const myPlan = cleanId(selfRow?.currentPlanSlug);
  let planSignalPossible = false;
  if (myPlan && planItemsHeldOn(selfRow, myPlan).size > 0) {
    for (const raw of rows) {
      const row = (raw ?? {}) as DerivationRow;
      const id = cleanId(row.ownerId);
      if (!id || id === self) continue;
      if (planItemsHeldOn(row, myPlan).size > 0) {
        planSignalPossible = true;
        break;
      }
    }
  }

  const [held, partners, edges, obligations] = await Promise.all([
    settle(sources.heldFiles, new Map<string, readonly string[]>() as ReadonlyMap<string, readonly string[]>),
    settle(sources.recentPartners, [] as readonly string[]),
    planSignalPossible && myPlan && sources.planEdges
      ? settle(() => sources.planEdges!(myPlan), [] as readonly PlanBlockingEdge[])
      : Promise.resolve([] as readonly PlanBlockingEdge[]),
    settle(sources.obligations, [] as readonly ObligationEdge[]),
  ]);

  const all = [
    ...deriveCouplingsFromRoster(self, rows),
    ...deriveCouplingsFromHeldFiles(self, held),
    ...deriveCouplingsFromPlanBlocking(self, rows, edges),
    ...deriveCouplingsFromCoordExchange(self, partners),
    ...deriveCouplingsFromObligations(self, obligations),
  ];
  // ⚠ OBLIGATIONS PASS THROUGH THIS BOUNDARY LIKE EVERY OTHER EDGE, and that has a
  // consequence P-004/P-011 must design around rather than discover: an obligation whose
  // COUNTERPART is not in the caller's roster is not emitted. A debt owed to an agent that
  // has since ended is exactly the case P-011 wants to surface ("responder dead"), so the
  // fix is to widen what the ROSTER contains (couplings.ts already carries a recorded-live
  // leg for this), never to let this leg bypass the boundary. Widening here would break the
  // never-widens guarantee (D-044 / D-078 (c)) for the one relation most likely to point at
  // an agent the reader cannot otherwise see.
  const delivered = all.filter((d) => d.ownerId !== self && inRoster.has(d.ownerId));

  // P-007: census the run for the dead-signal detector. Censused from `delivered`,
  // NOT `all` — an edge dropped by the roster access boundary reached nobody, so
  // counting it would report a signal alive on output no caller received.
  //
  // `armed` is the wiring bit, deliberately independent of whether the leg found
  // anything: `heldFiles` absent is the exact shape that hid `holds-a-lock-on` for
  // 12 days, and it is indistinguishable from honest scarcity in an emit count.
  // `planEdges` counts as armed whenever the SOURCE is wired even if
  // `planSignalPossible` short-circuited the read, so an unreachable precondition
  // reports as starved-of-input rather than as a dead gate — different defect,
  // different remedy.
  if (sources.observe) {
    try {
      sources.observe(
        censusDerivedSignals(
          {
            // ⚠ `inputs` IS THE BINDING INPUT, NOT THE CANDIDATE POOL — via the same
            // helper each leg early-returns on, so a censused 0 and an unemittable
            // run are one fact (EI-20088486454213771). A pool count here republishes
            // the defect: it makes a short-circuited run read `armed-silent`
            // (evaluated, found nothing) when the honest verdict is `starved`.
            roster: { armed: true, inputs: awaitsBindingInputs(self, rows) },
            heldFiles: { armed: !!sources.heldFiles, inputs: heldFilesBindingInputs(self, held) },
            planEdges: { armed: !!sources.planEdges, inputs: edges.length },
            recentPartners: { armed: !!sources.recentPartners, inputs: partners.length },
            // The obligation list IS its own binding input — an obligation is already a
            // pairwise fact, so there is no self-side precondition that could short-
            // circuit the leg the way `myAwait` does for the roster. Same shape as
            // `planEdges`/`recentPartners` above, which is why neither needs a helper.
            obligations: { armed: !!sources.obligations, inputs: obligations.length },
          },
          delivered,
        ),
      );
    } catch {
      /* an observer must never degrade what it observes */
    }
  }

  return delivered;
}
