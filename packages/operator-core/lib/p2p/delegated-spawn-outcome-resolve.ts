/**
 * p2p/delegated-spawn-outcome-resolve.ts — the IO half of WI-7042: gather the
 * evidence `classifyDelegatedSpawnOutcome` needs for ONE spawn request and hand
 * it the already-shaped facts.
 *
 * ## Why this is a composition and not a new PG reader
 *
 * WI-7042 was filed claiming "there is **no exported read helper** for
 * `harness_shared.p2p_work_offers`", derived from `projections/work-offers.ts`
 * exporting no `list*`/`read*`. That premise is FALSE — it looked at the
 * projection (the receive/apply leg) rather than at `offer-store.ts`, which is
 * the local read/authoring path and exports both `getWorkOffer` (an exact
 * primary-key point read) and `listOffers` (server-side filtered). Both
 * already parse `record_json` through the same closed-schema validator and
 * already expose `signerDevicePubkey`. So this module writes no SQL at all.
 *
 * The two reads map exactly onto the two questions:
 *   - `listOffers({ kind:'spawn_request' })` — this request AND its
 *     concurrent siblings in one read, which is what attribution needs anyway;
 *   - `getWorkOffer(ws, pot, targetPublisherGithubUserId, targetOfferId)` — the
 *     targeted seat, by full PK. The request payload carries BOTH halves of that
 *     key, so the seat never needs a scan.
 *
 * ## The identity question, and the two answers that are wrong
 *
 * Everything here turns on one bit: can THIS host see member evidence for the
 * host that honored? Two plausible discriminators were tried and MEASURED FALSE
 * against live data on 2026-08-02 — both are recorded because both look right:
 *
 *  1. **The GitHub account** (`targetPublisherGithubUserId` vs self). Every host
 *     in this deployment runs under ONE account: the local seat
 *     `seat-ec799e00fa1c9725` and the REMOTE `seat-78c6bba3c96de094` are both
 *     published by 279242982. This says "local" for every remote honor.
 *  2. **The `origin` column.** `origin='local'` does NOT mean "this host signed
 *     it": `seat-bdcd79d883466025` is `origin='local'` yet signed by
 *     `Lm1ABoMRKV…`, not this host's `IXfGu216EI…`.
 *
 * The answer is the DEVICE pubkey, compared against the keychain — the only
 * authority that actually knows which machine this is. Every unknown collapses
 * to `memberEvidenceAvailable: false`, i.e. `indeterminate` rather than a
 * confident `no-response`. That asymmetry is the whole point of the module it
 * feeds: absence of member rows is uninformative for a remote honor, and
 * dressing it up as a verdict is worse than silence.
 */
import { getWorkOffer, listOffers as listOffersDefault, type StoredWorkOffer } from './offer-store';
import {
  listP2pReceipts,
  parseResponderBuildMarker,
  type P2pReceipt,
  type ResponderBuildMarkerEvidence,
} from './receipts';
import {
  spawnRequestFactsFromRow,
  memberEvidenceAvailableForHonor,
  countConcurrentRequests,
  type SpawnRequestFactsResult,
} from './delegated-spawn-request-facts';
import {
  classifyDelegatedSpawnOutcome,
  DEFAULT_HONOR_WINDOW_MS,
  type DelegatedSpawnMemberFacts,
  type DelegatedSpawnOutcome,
  type DelegatedSpawnRequestFacts,
} from './delegated-spawn-outcome';

/** What the caller learns about one delegated spawn request. */
export interface DelegatedSpawnOutcomeResolution {
  outcome: DelegatedSpawnOutcome;
  request: DelegatedSpawnRequestFacts;
  /** Build evidence from the receipt that determines this outcome, if one exists. */
  responderBuild: ResponderBuildMarkerEvidence | null;
  /** The seat offer this request targeted (identifies the honoring MACHINE). */
  targetOfferId: string;
  /** The honoring host's device pubkey, when it could be established. */
  honoringDevicePubkey: string | null;
  /** Whether member evidence was consulted at all — see the header. */
  memberEvidenceAvailable: boolean;
  /** Overlapping requests on the same fleet (>0 ⇒ attribution is ambiguous). */
  concurrentRequests: number;
  requesterOwnerId: string;
  planSlug: string;
}

/** IO seams — every one is injectable so the composition unit-tests without PG. */
export interface ResolveDelegatedSpawnOutcomeDeps {
  listOffers?: typeof listOffersDefault;
  getOffer?: typeof getWorkOffer;
  listReceipts?: typeof listP2pReceipts;
  /** This machine's device pubkey for a github user id (null = unknowable). */
  selfDevicePubkey?: (githubUserId: number) => Promise<string | null>;
  /** Fleet members as the classifier consumes them, or null when unavailable. */
  loadMembers?: (workspaceId: string, fleetSlug: string) => Promise<DelegatedSpawnMemberFacts[] | null>;
  nowMs?: () => number;
}

/**
 * This machine's device pubkey, READ-ONLY.
 *
 * `loadOrGenerateDeviceKeypair` (what the honor path uses) would MINT a keypair
 * on a miss — unacceptable on a read surface — so this uses the load-only
 * sibling and treats every failure as `null`, never as an answer.
 *
 * Dynamically imported to keep the identity/keychain modules off this file's
 * static import path, mirroring `delegated-spawn-honor.ts`'s own lazy deps.
 */
async function defaultSelfDevicePubkey(githubUserId: number): Promise<string | null> {
  try {
    const [{ resolveDeviceKeychainId }, { loadDeviceKeypairPubkey }] = await Promise.all([
      import('../identity/device-keychain-id'),
      import('../identity/attest'),
    ]);
    return await loadDeviceKeypairPubkey(resolveDeviceKeychainId(githubUserId));
  } catch {
    return null;
  }
}

/**
 * Fleet presence, projected onto the classifier's member shape.
 *
 * `sessionState` comes from `resolveSessionStates` — the ONE shared liveness
 * oracle every surface projects from — and never from a raw heartbeat boolean,
 * which reads `true` for a warm-dead session and would turn a died-at-boot
 * member into a phantom "live" one.
 *
 * Returns `null` (⇒ member evidence UNAVAILABLE, ⇒ `indeterminate`) rather than
 * a partial roster when any row fails to resolve. A dropped member is not a
 * neutral loss here: it can flip `honored-live` into `no-response`, which is
 * precisely the confident-false-verdict class this feature exists to remove.
 */
async function defaultLoadMembers(workspaceId: string, fleetSlug: string): Promise<DelegatedSpawnMemberFacts[] | null> {
  const [{ listFleetPresence }, { resolveSessionStates }] = await Promise.all([
    import('../agent-tools/coordination/presence-fleet'),
    import('../agent-tools/coordination/liveness-oracle'),
  ]);
  const rows = await listFleetPresence(workspaceId, fleetSlug);
  if (rows.length === 0) return [];
  const verdicts = await resolveSessionStates(
    rows.map((r) => ({ ownerId: r.ownerId, heartbeatAt: r.heartbeatAt.toISOString() })),
  );
  const members: DelegatedSpawnMemberFacts[] = [];
  for (const r of rows) {
    const verdict = verdicts.get(r.ownerId);
    // EI-18771777750306094: the oracle is now TOTAL, so a missing key can only
    // mean "not asked about". An unmeasurable member instead arrives IN BAND as
    // a null `sessionState` — and that is the case this guard was always really
    // defending against, since projecting an unknown as a definite state is
    // exactly what flips `honored-live` into `no-response`. Both readings stay
    // fail-closed.
    if (!verdict || verdict.sessionState == null) return null; // fail closed — see the doc comment
    members.push({
      ownerId: r.ownerId,
      fleetSlug,
      firstSeenMs: r.startedAt.getTime(),
      lastActiveMs: r.heartbeatAt.getTime(),
      lastToolCallAtMs: r.lastToolCallAt?.getTime() ?? null,
      sessionState: verdict.sessionState,
    });
  }
  return members;
}

/**
 * The honoring host's device pubkey.
 *
 * Preferred source is an `honored`/`refusal` receipt's `responderDevicePubkey`:
 * a receipt is direct evidence of who actually answered. The targeted seat's
 * signer is the fallback — it names who we ASKED, which is the same machine in
 * every case the request lifecycle allows, but is an inference rather than an
 * observation. Both may be absent (a request nobody has answered and a seat row
 * that has not federated here yet), and absent is reported as `null`.
 */
function honoringDevicePubkeyFrom(receipts: P2pReceipt[], seat: StoredWorkOffer | null): string | null {
  const answered = receipts
    .filter((r) => r.responderDevicePubkey && (r.kind === 'honored' || r.kind === 'refusal'))
    .sort((a, b) => a.receiptTs - b.receiptTs)[0];
  return answered?.responderDevicePubkey ?? seat?.signerDevicePubkey ?? null;
}

/**
 * Match the classifier's evidence precedence: an explicit refusal determines
 * the outcome before any honor, otherwise the first honor is authoritative.
 * This keeps the build identity attached to the host response the displayed
 * outcome actually rests on rather than an unrelated sibling receipt.
 */
function responderBuildForOutcome(receipts: P2pReceipt[]): ResponderBuildMarkerEvidence | null {
  const byTime = (a: P2pReceipt, b: P2pReceipt) => a.receiptTs - b.receiptTs;
  const decisive =
    receipts.filter((receipt) => receipt.kind === 'refusal').sort(byTime)[0] ??
    receipts.filter((receipt) => receipt.kind === 'honored').sort(byTime)[0];
  return decisive ? parseResponderBuildMarker(decisive.detail) : null;
}

/**
 * Reconcile ONE delegated spawn request against everything this host can see.
 *
 * Returns `null` when `offerId` is not a usable spawn request here — a seat
 * offer, an unknown id, or a row whose signed record does not validate. That is
 * deliberately indistinguishable to the caller: all three mean "there is no
 * spawn outcome to report for this id", and `p2p:trace` simply omits the field
 * rather than emitting an error shaped like a finding.
 */
export async function resolveDelegatedSpawnOutcome(
  args: { workspaceId: string; potSlug: string; offerId: string },
  deps: ResolveDelegatedSpawnOutcomeDeps = {},
): Promise<DelegatedSpawnOutcomeResolution | null> {
  const listOffers = deps.listOffers ?? listOffersDefault;
  const getOffer = deps.getOffer ?? getWorkOffer;
  const listReceipts = deps.listReceipts ?? listP2pReceipts;
  const selfDevicePubkey = deps.selfDevicePubkey ?? defaultSelfDevicePubkey;
  const loadMembers = deps.loadMembers ?? defaultLoadMembers;
  const nowMs = (deps.nowMs ?? Date.now)();

  // includeLocallyDisposed: this is an AUDIT read. A request this host locally
  // refused still has an outcome worth reporting — hiding it would make the
  // one case a user is most likely to be asking about silently unanswerable.
  const requests = await listOffers(args.workspaceId, args.potSlug, {
    kind: 'spawn_request',
    includeLocallyDisposed: true,
  });

  let self: SpawnRequestFactsResult | null = null;
  const others: DelegatedSpawnRequestFacts[] = [];
  for (const row of requests) {
    const mapped = spawnRequestFactsFromRow({ offer_id: row.offerId, record_json: row.recordJson });
    if (!mapped) continue;
    if (row.offerId === args.offerId) self = mapped;
    else others.push(mapped.facts);
  }
  if (!self) return null;

  const seat = await getOffer(args.workspaceId, args.potSlug, self.targetPublisherGithubUserId, self.targetOfferId);
  const receipts = await listReceipts({
    workspaceId: args.workspaceId,
    potSlug: args.potSlug,
    offerId: args.offerId,
  });

  const honoringDevicePubkey = honoringDevicePubkeyFrom(receipts, seat);
  const selfPubkey = await selfDevicePubkey(self.targetPublisherGithubUserId);
  let memberEvidenceAvailable = memberEvidenceAvailableForHonor({
    honoringDevicePubkey,
    selfDevicePubkey: selfPubkey,
  });

  // Only read presence when it can mean something. Skipping it for a remote
  // honor is not an optimization — it makes the honesty rule STRUCTURAL: rows
  // we have already decided prove nothing are never even fetched, so they
  // cannot leak into a verdict by a later edit.
  let members: DelegatedSpawnMemberFacts[] = [];
  if (memberEvidenceAvailable) {
    const loaded = await loadMembers(args.workspaceId, self.facts.fleetSlug);
    if (loaded === null) memberEvidenceAvailable = false;
    else members = loaded;
  }

  const concurrentRequests = countConcurrentRequests({
    self: self.facts,
    others,
    honorWindowMs: DEFAULT_HONOR_WINDOW_MS,
  });

  const outcome = classifyDelegatedSpawnOutcome({
    request: self.facts,
    receipts: receipts.map((r) => ({
      kind: r.kind,
      code: r.refusalCode,
      detail: r.detail,
      tsMs: r.receiptTs,
    })),
    members,
    nowMs,
    concurrentRequests,
    memberEvidenceAvailable,
  });

  return {
    outcome,
    request: self.facts,
    responderBuild: responderBuildForOutcome(receipts),
    targetOfferId: self.targetOfferId,
    honoringDevicePubkey,
    memberEvidenceAvailable,
    concurrentRequests,
    requesterOwnerId: self.requesterOwnerId,
    planSlug: self.planSlug,
  };
}
