/**
 * coupling-divergence-stamp.ts — the CONSUMER for `forYouBecause` (D-089, WI-6685).
 *
 * WHY THIS EXISTS. `forYouBecause` is justified on being "STRUCTURED so it can be
 * diffed against the computed coupling graph". D-087 found the computed half was
 * prose and D-089 typed it; this is the third and last piece — the thing that
 * actually performs the diff. Without it the whole chain is a declared mechanism
 * with no consumer, which is the exact defect the D-087 thread found twice
 * already (see the `mechanism-with-no-consumer-detector` fact).
 *
 * ⚠ IT MUST RUN AT SEND, and that is a property of the data, not a preference.
 * The computed graph is LIVE state — locks release, awaited events fire, fleet
 * membership changes. A retrospective pass over `coord_event_log` therefore
 * cannot reconstruct what the graph said when the sender made its claim, and
 * would score every message `not-comparable`. The one moment the comparison is
 * meaningful is the moment the claim is made.
 *
 * ⚠ THE RULE TABLE IS ALSO THE COST GATE, which is why this is affordable on a
 * hot path. Resolving the graph costs a presence snapshot plus the derivation's
 * bounded reads, so it is gated on `participatesInCouplingDivergence` FIRST:
 * `owns` (53% of live asserted uses) and `other` can never be compared, so a
 * message carrying only those does ZERO IO. The correctness rule and the
 * cheapness fall out of the same table — a second, hand-maintained "is this
 * worth computing" predicate would be free to drift from the scoring one.
 *
 * ⚠ FAIL-SOFT, TOTAL, AND NEVER LOAD-BEARING ON THE SEND. Same contract as
 * `resolveGateRefStamps` / `resolvePremiseStamps`: every failure degrades to an
 * empty stamp list. A measurement that can eat a message is a far worse outcome
 * than a message with no measurement — the availability coupling that turns one
 * PG blip into fleet-wide silence.
 */
import {
  participatesInCouplingDivergence,
  couplingDivergenceVerdict,
  type ForYouBecause,
  type ForYouBecauseRelation,
  type CouplingDivergenceVerdict,
} from './message-fields';
import type { DerivedCouplingRelation } from '../../coord/couplings';
import type { DerivedSignalCensus } from '../../coord/derived-signal-census';

// ⚠ EVERY IO DEPENDENCY IS IMPORTED DYNAMICALLY, INSIDE `readPeerRelations` —
// deliberately, and it is load-bearing twice over.
//
//   1. CORRECTNESS. `send.ts` imports this module, and a STATIC import here
//      would drag the whole presence-snapshot chain (→ presence-wakeability →
//      presence) into the send path's module graph at load time. That chain has
//      top-level constant initialisation, so it breaks every suite that
//      partially mocks `../presence` — with a "No PRESENCE_STALE_MS export is
//      defined on the mock" error in a test that never mentioned coupling.
//      Caught exactly that way here; the repo has hit this class before.
//   2. COST. The gate below means most messages never call this function at
//      all, so the heavy half should not be paid at import time either.
//
// The pure half (`message-fields`, and the `DerivedCouplingRelation` /
// `DerivedSignalCensus` TYPES) stays static: `send.ts` already imports
// message-fields, and a `import type` is erased entirely at compile time — it
// creates no runtime edge, so it cannot drag the IO chain in.

/** One asserted relation, scored against the graph as it stood at send. */
export interface CouplingDivergenceStamp {
  /** Index of the section that carried the assertion. */
  section: number;
  /** The recipient the assertion is ABOUT — the field is per-recipient by nature. */
  recipient: string;
  asserted: ForYouBecauseRelation;
  verdict: CouplingDivergenceVerdict;
  /** What the graph actually held for this pair — empty is a real answer. */
  computed: DerivedCouplingRelation[];
}

/** Bound on the stamp list: sections × recipients is quadratic in principle. */
export const COUPLING_DIVERGENCE_STAMPS_MAX = 40;

export const COUPLING_DIVERGENCE_FIELD = 'couplingDivergence';

/** A section as this module reads it — structural, so any section shape fits. */
interface SectionLike {
  forYouBecause?: ForYouBecause | undefined;
}

/**
 * Recipients this comparison can speak about at all.
 *
 * `*` and `human` and `@selector` audiences are dropped for the same reason the
 * coord-exchange coupling signal drops them: the sender addressed a SET, not a
 * person, so "why THIS recipient" has no single subject to be right or wrong
 * about. Scoring them would invent divergence out of a broadcast.
 */
function comparableRecipients(to: readonly string[], self: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of to) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || id === '*' || id === 'human' || id.startsWith('@')) continue;
    if (id === self || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The COMPARABLE claims in a message, in section order — and the reason nothing
 * else in this module runs when it is empty.
 *
 * Exported because it IS the cost gate: a caller can ask "would this message
 * cost a coupling read?" without performing one.
 */
export function comparableClaims(
  sections: readonly SectionLike[],
): Array<{ section: number; f: ForYouBecause }> {
  const claims: Array<{ section: number; f: ForYouBecause }> = [];
  sections.forEach((s, i) => {
    const f = s?.forYouBecause;
    if (f && participatesInCouplingDivergence(f)) claims.push({ section: i, f });
  });
  return claims;
}

/**
 * The scoring half — PURE over an injected peer→relations map, so it unit-tests
 * without PG, exactly as `deriveCouplingsFromHeldFiles` and `resolvePremiseStamps`
 * are pure over their injected sources. The IO lives in the wrapper below.
 */
export function scoreCouplingDivergence(
  claims: readonly { section: number; f: ForYouBecause }[],
  recipients: readonly string[],
  byPeer: ReadonlyMap<string, readonly DerivedCouplingRelation[]>,
): CouplingDivergenceStamp[] {
  const stamps: CouplingDivergenceStamp[] = [];
  for (const { section, f } of claims) {
    for (const recipient of recipients) {
      if (stamps.length >= COUPLING_DIVERGENCE_STAMPS_MAX) return stamps;
      // A recipient MISSING from the map and one mapped to an empty array mean
      // the same thing to the verdict: the graph holds nothing for this pair.
      // `couplingDivergenceVerdict` already treats absence correctly per
      // relation (silence for a one-sided claim, divergence for a two-sided
      // one), so there is deliberately no special case here.
      const computed = [...(byPeer.get(recipient) ?? [])];
      stamps.push({
        section,
        recipient,
        asserted: f.relation,
        verdict: couplingDivergenceVerdict(f, computed),
        computed,
      });
    }
  }
  return stamps;
}

/** The one IO leg, injectable so the wrapper is testable without a database. */
export type PeerRelationsReader = (
  selfOwnerId: string,
  opts: {
    workspaceId?: string | null;
    harnessSlug?: string | null;
    /**
     * P-009 — the dead-signal census sink, supplied by the TOOL layer (`send.ts`
     * via `censusObserverFor(ctx)`), because that is the only layer holding a
     * `ctx.metadata` channel. Optional: a caller that omits it changes nothing,
     * so tests and internal re-use wire no instrument.
     */
    observe?: (census: DerivedSignalCensus) => void;
  },
) => Promise<ReadonlyMap<string, readonly DerivedCouplingRelation[]>>;

/**
 * The production read: the SAME union `coord:presence` and the coupled-topic
 * feed use — never a private notion of "coupled" (D-078 (b) / D-081). A peer the
 * sender DECOUPLED stays decoupled here too, which is correct rather than
 * unfortunate: the sender has explicitly said that edge should not surface.
 */
export const readPeerRelations: PeerRelationsReader = async (selfOwnerId, opts) => {
  const [{ resolvePresenceScope, assemblePresenceSnapshot }, { couplingSourcesFor }, { deriveCouplings }, { listCouplingsFor, resolveCoupledPeers }, { fileLockCoordinationDomain }] =
    await Promise.all([
      import('./presence-snapshot'),
      import('./coupling-sources'),
      import('../../coord/coupling-derivation'),
      import('../../coord/couplings'),
      import('../locks/coordination-domain'),
    ]);
  // EI-20042650315152947: WITHOUT a `coordinationDomain`, `couplingSourcesFor`
  // omits the `heldFiles` source ENTIRELY (coupling-sources.ts:201-206), so
  // `holds-a-lock-on` cannot derive here at all — it is structurally unwired,
  // not merely empty. That matters because THIS is the coord:send path, the only
  // coupling path that runs at volume: the relation was wired on the presence
  // path (11 calls ever) and produced 0 edges in 14 days everywhere else.
  //
  // Resolved HERE rather than threaded from `send.ts` because the domain is a
  // PROCESS fact, not a caller fact: it takes no arguments, and the presence
  // path resolves the same value. Threading it through `sendOne` would add a
  // parameter carrying no caller-specific information. Imported dynamically to
  // honour this file's import contract above: a static import would put it in
  // `send.ts`'s load-time graph.
  //
  // WI-38252: it must be `fileLockCoordinationDomain()` — the tree agents EDIT
  // — not `lockCoordinationDomain()`, the tree whose code this process loaded.
  // On `:3070` those are different checkouts, and the file-lock rows live under
  // the former, so reading the latter derived `holds-a-lock-on` edges from an
  // empty namespace and produced 0 edges regardless of what was held.
  //
  // Fail-soft, like every other leg here: a throw degrades to the previous
  // behaviour (no lock signal) rather than failing a send.
  let coordinationDomain: string | undefined;
  try {
    coordinationDomain = fileLockCoordinationDomain();
  } catch {
    coordinationDomain = undefined;
  }
  const ctx = {
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
  };
  const resolved = await resolvePresenceScope(ctx, {});
  const snapshot = await assemblePresenceSnapshot(resolved, {});
  const rosterOwnerIds = snapshot.active
    .map((r) => (r as { ownerId?: unknown }).ownerId)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

  const derived = await deriveCouplings(
    selfOwnerId,
    snapshot.active,
    {
      ...couplingSourcesFor({
        selfOwnerId,
        rosterOwnerIds,
        // The line that makes `holds-a-lock-on` derivable on this path at all.
        ...(coordinationDomain ? { coordinationDomain } : {}),
        ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      }),
      // P-009: THE path that runs at volume. Wiring the census here is what makes
      // "has `holds-a-lock-on` ever fired in production?" answerable at all — the
      // sink previously existed only on `coord:presence` (11 calls ever), so the
      // detector could not observe the surface whose 12-day silence (D-088) is the
      // reason it exists.
      ...(opts.observe ? { observe: opts.observe } : {}),
    },
  );
  const edges = await listCouplingsFor(selfOwnerId, opts.workspaceId ?? undefined);
  const byPeer = new Map<string, readonly DerivedCouplingRelation[]>();
  for (const p of resolveCoupledPeers(selfOwnerId, derived, edges)) {
    byPeer.set(p.ownerId, p.derivedRelations ?? []);
  }
  return byPeer;
};

/**
 * Score every comparable (section, recipient) assertion against the live graph.
 *
 * Returns `[]` — never throws, never partially fails a send — when there is
 * nothing comparable, when the sender is unresolvable, or when the coupling read
 * is unavailable.
 */
export async function resolveCouplingDivergenceStamps(
  opts: {
    selfOwnerId: string;
    to: readonly string[];
    sections: readonly SectionLike[];
    workspaceId?: string | null;
    harnessSlug?: string | null;
    /** P-009 — the census sink, forwarded to the reader. See `PeerRelationsReader`. */
    observe?: (census: DerivedSignalCensus) => void;
  },
  readRelations: PeerRelationsReader = readPeerRelations,
): Promise<CouplingDivergenceStamp[]> {
  try {
    const self = (opts.selfOwnerId ?? '').trim();
    if (!self) return [];

    // THE GATE, before any IO.
    const claims = comparableClaims(opts.sections);
    if (claims.length === 0) return [];

    const recipients = comparableRecipients(opts.to, self);
    if (recipients.length === 0) return [];

    const byPeer = await readRelations(self, {
      workspaceId: opts.workspaceId ?? null,
      harnessSlug: opts.harnessSlug ?? null,
      ...(opts.observe ? { observe: opts.observe } : {}),
    });
    return scoreCouplingDivergence(claims, recipients, byPeer);
  } catch {
    return [];
  }
}

/**
 * The stamps worth a reader's attention: an assertion the graph CONTRADICTS.
 *
 * ⚠ A DIVERGENCE IS DATA ABOUT THE SENDER'S MODEL, NEVER A FAULT — and this is a
 * design constraint on every future consumer, not a nicety (D-090
 * [owner 2026-08-01]). `forYouBecause` exists so agents can hold a theory of mind
 * for each other; a model that is sometimes wrong is the signal working, exactly
 * as `youMayNotKnow`'s authored entries are "valuable precisely because they can
 * be WRONG".
 *
 * So do NOT wire this to a warning, a nag, a score an agent is judged on, or a
 * refusal. The mechanism is obvious once stated: if asserting a checkable
 * relation can be held against you and asserting an uncheckable one cannot, every
 * sender learns to assert `owns`/`other` — or to say nothing — and the field
 * collapses to what the graph already knew. The measurement would have destroyed
 * the thing it was measuring. Read divergence in AGGREGATE, to learn where
 * agents' models of each other drift from the shared state; never per-message, at
 * a sender.
 */
export function divergentStamps(
  stamps: readonly CouplingDivergenceStamp[],
): CouplingDivergenceStamp[] {
  return stamps.filter((s) => s.verdict === 'diverges');
}
