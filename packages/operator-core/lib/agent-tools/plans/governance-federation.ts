/**
 * Federated shared-pot governance events (P-005).
 *
 * Governance events are IMMUTABLE and append-only. Peers exchange them out of
 * order and after arbitrary offline periods, so the projection is a pure fold over
 * a canonically SORTED event set rather than an incremental reducer: convergence
 * is structural, not a property we hope the fold happens to have. Any permutation
 * of the same event set yields the identical projection.
 *
 * Three safety properties this module exists to enforce:
 *  - a fork in finalization QUARANTINES the round. Two certificates for one round
 *    with different hashes never resolve to a winner — an automatic tie-break here
 *    would silently ratify one side of a partition;
 *  - `pause` and `revoke` are themselves immutable federated events, and `revoke`
 *    is TERMINAL: a later `resume` cannot resurrect a revoked round, so a replayed
 *    control event cannot re-admit withdrawn work; and
 *  - a private pot's events never cross its boundary in either direction — foreign
 *    and non-member events are DROPPED on ingest (counted, not thrown), and
 *    `selectFederatableEvents` emits nothing to a non-member.
 *
 * Only `admissibleCertificate` may be consulted by admission (P-004) or by the
 * on-chain bridge (P-024, D-034). It returns a certificate exclusively for a round
 * that is opened, finalized, unforked and unrevoked. Its companion
 * `resolveRoundControls` reports WHY a round refuses, as a typed status the admission
 * door maps onto a refusal code — neither accessor exposes `round.certificates`, so a
 * consumer cannot re-derive a verdict this module has already refused (D-036).
 *
 * Signature verification on ingest FAILS CLOSED: `verifySignature` defaults to reject,
 * and accepting unverified events requires typing out `ACCEPT_ALL_SIGNATURES_TEST_ONLY`.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../authority/authority-rpc-envelope';
import { verifyFinalizationCertificate, type FinalizationCertificate, type GovernanceRound, type GovernanceVoteEvent } from './governance-round';

export type GovernanceEventBody =
  | { readonly kind: 'round-open'; readonly round: GovernanceRound }
  | { readonly kind: 'vote'; readonly vote: GovernanceVoteEvent }
  | { readonly kind: 'finalize'; readonly certificate: FinalizationCertificate }
  /** Owner-signed control halt. `expiresAtMs` bounds it in time; omitted means it holds until an explicit `resume`. */
  | { readonly kind: 'pause'; readonly expiresAtMs?: number }
  | { readonly kind: 'resume' }
  | { readonly kind: 'revoke'; readonly reason: string };

export type GovernanceEventKind = GovernanceEventBody['kind'];

export interface FederatedGovernanceEvent {
  readonly eventId: string;
  readonly potId: string;
  readonly roundId: string;
  readonly originPeerId: string;
  readonly occurredAtMs: number;
  readonly body: GovernanceEventBody;
  /** Signature over `governanceEventDigest`; verification is injected. */
  readonly signature: string;
}

export interface PotBoundary {
  readonly potId: string;
  readonly visibility: 'private' | 'shared';
  /** Peers permitted to originate and receive this pot's governance events. */
  readonly memberPeerIds: readonly string[];
}

export type RoundStatus = 'open' | 'paused' | 'finalized' | 'quarantined' | 'revoked';

export interface RoundProjection {
  readonly roundId: string;
  readonly status: RoundStatus;
  readonly roundOpened: boolean;
  /** Latest control state. A paused round never admits, even if a certificate arrives later. */
  readonly paused: boolean;
  /**
   * Wall-clock expiry of the active pause, or null for an unbounded one. The fold
   * stays time-free on purpose — two replicas must project identically regardless of
   * their clocks — so expiry is applied by `roundStatusAt`, never inside the fold.
   */
  readonly pausedUntilMs: number | null;
  /** Distinct certificates seen for this round; more than one means a fork. */
  readonly certificates: readonly FinalizationCertificate[];
  readonly voteEventIds: readonly string[];
  readonly quarantineReason: string | null;
  readonly revokedReason: string | null;
}

export interface GovernanceFederationProjection {
  readonly potId: string;
  readonly rounds: ReadonlyMap<string, RoundProjection>;
  readonly eventCount: number;
}

export function governanceEventDigest(event: Omit<FederatedGovernanceEvent, 'signature'>): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

/** Content identity of an event, ignoring its signature — two events sharing an id must share this. */
function eventContentHash(event: FederatedGovernanceEvent): string {
  const { signature: _signature, ...unsigned } = event;
  void _signature;
  return governanceEventDigest(unsigned);
}

/** Total order used by the fold. Sorting first is what makes the projection order-independent. */
function canonicalOrder(a: FederatedGovernanceEvent, b: FederatedGovernanceEvent): number {
  return a.occurredAtMs - b.occurredAtMs || a.roundId.localeCompare(b.roundId) || a.eventId.localeCompare(b.eventId);
}

/**
 * Fold a set of federated events into round projections. Pure and total: it never
 * refuses, because refusal belongs to ingest — by the time an event is in the set
 * it has already passed the boundary and immutability checks.
 */
export function projectGovernanceFederation(potId: string, events: readonly FederatedGovernanceEvent[]): GovernanceFederationProjection {
  const ordered = [...events].filter((event) => event.potId === potId).sort(canonicalOrder);
  const rounds = new Map<string, RoundProjection>();

  for (const event of ordered) {
    const prior = rounds.get(event.roundId) ?? {
      roundId: event.roundId,
      status: 'open' as RoundStatus,
      roundOpened: false,
      paused: false,
      pausedUntilMs: null as number | null,
      certificates: [] as readonly FinalizationCertificate[],
      voteEventIds: [] as readonly string[],
      quarantineReason: null,
      revokedReason: null,
    };
    // `revoke` is terminal: once withdrawn, no later event — including a replayed
    // `resume` — can move the round back into an admitting state.
    if (prior.revokedReason !== null) continue;

    switch (event.body.kind) {
      case 'round-open':
        rounds.set(event.roundId, { ...prior, roundOpened: true });
        break;
      case 'vote':
        rounds.set(event.roundId, { ...prior, voteEventIds: [...prior.voteEventIds, event.body.vote.eventId].sort() });
        break;
      case 'finalize': {
        const cert = event.body.certificate;
        const known = prior.certificates.some((c) => c.certificateHash === cert.certificateHash);
        const certificates = known ? prior.certificates : [...prior.certificates, cert].sort((a, b) => a.certificateHash.localeCompare(b.certificateHash));
        rounds.set(event.roundId, { ...prior, certificates });
        break;
      }
      case 'pause':
        rounds.set(event.roundId, { ...prior, paused: true, pausedUntilMs: event.body.expiresAtMs ?? null });
        break;
      case 'resume':
        rounds.set(event.roundId, { ...prior, paused: false, pausedUntilMs: null });
        break;
      case 'revoke':
        rounds.set(event.roundId, { ...prior, revokedReason: event.body.reason });
        break;
    }
  }

  for (const [roundId, round] of rounds) {
    rounds.set(roundId, { ...round, ...resolveStatus(round) });
  }
  return { potId, rounds, eventCount: ordered.length };
}

function resolveStatus(round: RoundProjection): Pick<RoundProjection, 'status' | 'quarantineReason'> {
  if (round.revokedReason !== null) return { status: 'revoked', quarantineReason: null };
  if (round.certificates.length > 1) {
    return {
      status: 'quarantined',
      quarantineReason: `conflicting finalizations for round ${round.roundId}: ${round.certificates.map((c) => c.certificateHash.slice(0, 12)).join(', ')}`,
    };
  }
  // Pause outranks finalization deliberately: a certificate that lands while the
  // round is paused must not admit, or pausing would be advisory rather than a control.
  if (round.paused) return { status: 'paused', quarantineReason: null };
  if (round.certificates.length === 1) return { status: 'finalized', quarantineReason: null };
  return { status: 'open', quarantineReason: null };
}

/**
 * The round's status as of `nowMs`. Identical to the projected status except that a
 * TIME-BOUNDED pause whose expiry has passed no longer holds — an owner-signed pause
 * is a temporary control, so letting it outlive its own window would silently turn
 * every bounded pause into a revoke.
 *
 * A lapsed pause can only reveal what was underneath it: `revoked` and `quarantined`
 * already outrank `paused` in `resolveStatus`, so a round reading `paused` has at
 * most one certificate and is not revoked.
 */
export function roundStatusAt(round: RoundProjection, nowMs: number): RoundStatus {
  if (round.status !== 'paused') return round.status;
  if (round.pausedUntilMs === null || !Number.isFinite(nowMs) || nowMs < round.pausedUntilMs) return 'paused';
  return round.certificates.length === 1 ? 'finalized' : 'open';
}

/**
 * The governance verdict `assertPlanAdmission` (P-004) consumes. Produced here so the
 * admission door never reads `round.certificates` — or a raw status — for itself.
 */
export interface PlanGovernanceControls {
  readonly roundId: string;
  readonly status: RoundStatus;
  readonly quarantineReason: string | null;
  readonly revokedReason: string | null;
}

/** Time-evaluated controls for one round, or null when the round is unknown to this projection. */
export function resolveRoundControls(projection: GovernanceFederationProjection, roundId: string, nowMs: number): PlanGovernanceControls | null {
  const round = projection.rounds.get(roundId);
  if (!round) return null;
  return { roundId, status: roundStatusAt(round, nowMs), quarantineReason: round.quarantineReason, revokedReason: round.revokedReason };
}

/**
 * The ONLY certificate accessor admission may use. Returns null for a round that
 * is unopened, unfinalized, paused, forked, revoked, or whose certificate fails
 * its own hash check.
 *
 * `nowMs` is optional and only ever WIDENS the result, by letting a time-bounded
 * pause expire. Omitting it keeps the conservative structural reading, so a caller
 * with no clock can never be admitted by one.
 */
export function admissibleCertificate(projection: GovernanceFederationProjection, roundId: string, nowMs?: number): FinalizationCertificate | null {
  const round = projection.rounds.get(roundId);
  if (!round || !round.roundOpened) return null;
  const status = nowMs === undefined ? round.status : roundStatusAt(round, nowMs);
  if (status !== 'finalized') return null;
  const cert = round.certificates[0];
  if (!cert || !verifyFinalizationCertificate(cert)) return null;
  // A certificate carrying no weighted tally was finalized without consulting
  // reduceGovernanceVotes, so its `admitted` bit rests on an unweighted count
  // that ignores revocation, delegation and key epochs. Federation refuses it
  // rather than importing an unreduced verdict from a peer pot.
  if (!isReducedTally(cert.tally)) return null;
  return cert;
}

/** A federated certificate arrives as untrusted JSON: verify the tally's shape, not just its presence. */
function isReducedTally(tally: FinalizationCertificate['tally']): boolean {
  if (tally == null || typeof tally !== 'object') return false;
  const fields = ['approveWeight', 'rejectWeight', 'abstainWeight', 'totalEligibleWeight', 'participatingWeight', 'replacements'] as const;
  return fields.every((f) => Number.isFinite(tally[f]) && tally[f] >= 0);
}

export type IngestDropReason = 'foreign-pot' | 'non-member-peer' | 'unverified-signature' | 'immutable-conflict';

export interface IngestResult {
  readonly accepted: readonly FederatedGovernanceEvent[];
  readonly dropped: readonly { readonly eventId: string; readonly reason: IngestDropReason; readonly detail: string }[];
  readonly projection: GovernanceFederationProjection;
}

/**
 * Accept every signature without checking one. TEST-ONLY, and named so that a
 * production call site reads as the mistake it is — the default is to REJECT, so
 * fail-open has to be typed out on purpose rather than reached by omission.
 */
export const ACCEPT_ALL_SIGNATURES_TEST_ONLY = (): boolean => true;

/**
 * Merge incoming events into a known set, then re-project.
 *
 * Drops are recorded, never thrown: a peer sending events for a pot we do not
 * carry is normal federation traffic, not an error — and treating it as one would
 * make a private-pot boundary crossing look like a bug in the sender.
 *
 * `verifySignature` defaults to REJECT. Governed admission fails closed on
 * signature and federation errors (D-002), and a permissive default is exactly the
 * shape that fails open silently: a caller that forgets to inject a verifier gets a
 * projection built from unauthenticated events and no error anywhere to say so.
 * Dropping everything instead is loud, and visible in `dropped`.
 */
export function ingestGovernanceEvents(input: {
  boundary: PotBoundary;
  known: readonly FederatedGovernanceEvent[];
  incoming: readonly FederatedGovernanceEvent[];
  verifySignature?: (event: FederatedGovernanceEvent) => boolean;
}): IngestResult {
  const verify = input.verifySignature ?? (() => false);
  const members = new Set(input.boundary.memberPeerIds);
  const byId = new Map(input.known.map((event) => [event.eventId, event]));
  const dropped: { eventId: string; reason: IngestDropReason; detail: string }[] = [];
  const accepted: FederatedGovernanceEvent[] = [];

  for (const event of input.incoming) {
    if (event.potId !== input.boundary.potId) {
      dropped.push({ eventId: event.eventId, reason: 'foreign-pot', detail: `event belongs to pot '${event.potId}'` });
      continue;
    }
    if (input.boundary.visibility === 'private' && !members.has(event.originPeerId)) {
      dropped.push({ eventId: event.eventId, reason: 'non-member-peer', detail: `peer '${event.originPeerId}' is outside the private pot boundary` });
      continue;
    }
    if (!verify(event)) {
      dropped.push({ eventId: event.eventId, reason: 'unverified-signature', detail: 'signature did not verify' });
      continue;
    }
    const existing = byId.get(event.eventId);
    if (existing) {
      // Re-delivery of an identical event is normal and idempotent; the SAME id
      // carrying different content is an attempt to mutate an immutable record.
      if (eventContentHash(existing) !== eventContentHash(event)) {
        dropped.push({ eventId: event.eventId, reason: 'immutable-conflict', detail: 'an event with this id already exists with different content' });
      }
      continue;
    }
    byId.set(event.eventId, event);
    accepted.push(event);
  }

  return { accepted, dropped, projection: projectGovernanceFederation(input.boundary.potId, [...byId.values()]) };
}

/**
 * Events this node may send to `toPeerId`. A private pot emits nothing to a
 * non-member — the outbound half of the boundary that `ingestGovernanceEvents`
 * enforces inbound.
 */
export function selectFederatableEvents(input: {
  boundary: PotBoundary;
  events: readonly FederatedGovernanceEvent[];
  toPeerId: string;
}): readonly FederatedGovernanceEvent[] {
  if (input.boundary.visibility === 'private' && !input.boundary.memberPeerIds.includes(input.toPeerId)) return [];
  return [...input.events].filter((event) => event.potId === input.boundary.potId).sort(canonicalOrder);
}

/** Stable identity of a projection, for asserting that two replicas converged. */
export function projectionDigest(projection: GovernanceFederationProjection): string {
  const rounds = [...projection.rounds.values()]
    .sort((a, b) => a.roundId.localeCompare(b.roundId))
    .map((round) => ({
      certificateHashes: round.certificates.map((c) => c.certificateHash),
      paused: round.paused,
      pausedUntilMs: round.pausedUntilMs,
      quarantineReason: round.quarantineReason,
      revokedReason: round.revokedReason,
      roundId: round.roundId,
      roundOpened: round.roundOpened,
      status: round.status,
      voteEventIds: [...round.voteEventIds],
    }));
  return createHash('sha256').update(canonicalJson({ potId: projection.potId, rounds })).digest('hex');
}
