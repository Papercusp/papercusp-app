/**
 * p2p/delegated-spawn-outcome.ts — REQUESTER-SIDE reconciliation of a delegated
 * spawn request (EI-19333624101736074).
 *
 * ## The gap this closes
 *
 * The delegated-spawn path is LOUD on refusal and SILENT on success:
 *   - refusal ⇒ `emitReceipt({ kind:'refusal' })`, a federated `p2p_receipts`
 *     fact the requester can read;
 *   - success ⇒ `setDisposition(..., 'honored')` + a `console.log` on the
 *     HONORING host, and `local_disposition` is explicitly host-local and never
 *     federated (see `sync/hyperbee/projections/work-offers.ts` :22 and :330).
 *
 * So exactly TWO states cross the wire (refused, nothing) where THREE are
 * needed. A member that spawns, joins the fleet, and dies at boot *arrives and
 * then vanishes* — from the requesting host that is indistinguishable from a
 * request nobody honored. Measured live 2026-08-02 (tower → Win rig): member
 * joined fleet `fed-drill` at 08:11:25Z, died on auth seconds later; afterwards
 * the tower held no receipt, no disposition, and an aged-out presence row. Two
 * full wakes were spent concluding the honor path had *fabricated* "honored"
 * when it had genuinely spawned a member that died. An observability gap does
 * not merely hide a bug — it manufactures confident wrong diagnoses.
 *
 * ## Why it is reconciled HERE and not fixed on the honoring side
 *
 * The honoring host could simply emit a success receipt (and should — see
 * EI-19331694139523035's follow-up). But that code runs on the REMOTE rig, and
 * rigs run installed sidecar bundles with no update path (EI-19330215508907244):
 * verified 2026-08-02, the Win rig's sidecar carries neither the boot-receipt
 * detector nor the honor-attribution fix, both landed the same day. A requester-
 * side reconciler needs no rig cooperation at all — it runs entirely on evidence
 * the requesting host already has (its own federated receipts + fleet presence).
 *
 * ## Honesty rules baked in
 *
 *  1. `honored-then-died` is only claimed for a member whose session ENDED with
 *     a lifetime under the boot threshold. A member that ran and finished is
 *     `honored-completed`, never a phantom.
 *  2. Attribution is REPORTED, not assumed. Presence rows carry no request id,
 *     so when other spawn requests targeted the same fleet in the same window
 *     the verdict is stamped `attribution:'ambiguous'` rather than silently
 *     crediting this request with a peer's member.
 *  3. Absence of evidence inside the honor window is `pending`, never
 *     `no-response` — the request may simply not have been picked up yet.
 *
 * PURE: no I/O, no clock. The caller supplies the evidence and `nowMs`.
 */

/** Default: a member dying within this long of first being seen is a BOOT death,
 *  not a completed run. The live rig failures died 2-4s in; the honor path's own
 *  boot-receipt window is 6s. 120s is deliberately generous — it is far cheaper
 *  to call a genuine short run "died at boot" (the detail carries the lifetime,
 *  so a reader can see it) than to miss a phantom. */
export const BOOT_DEATH_LIFETIME_MS = 120_000;

/** Default honor window for a spawn request — mirrors SPAWN_REQUEST_HONOR_WINDOW_MS. */
export const DEFAULT_HONOR_WINDOW_MS = 60 * 60_000;

export type DelegatedSpawnVerdict =
  /** A member attributable to this request is alive and taking turns. */
  | 'honored-live'
  /** THE PHANTOM: a member appeared and died within the boot threshold. This is
   *  the state that does not exist today — the whole reason this module exists. */
  | 'honored-then-died'
  /** A member appeared, ran past the boot threshold, and has since ended. */
  | 'honored-completed'
  /** The honoring host proved a tool-backed first turn under D-029. Current
   * liveness may still be remote/unobservable, but boot is no longer unknown. */
  | 'honored-first-turn-proven'
  /** The honoring host refused, and said why (a federated refusal receipt). */
  | 'refused'
  /** The honor window elapsed with no receipt and no member. Nobody picked it up. */
  | 'no-response'
  /**
   * MEASURED 2026-08-02, and the reason this verdict exists: for a REMOTE honor
   * the requesting host holds NO evidence a member ever existed. The Win rig's
   * member joined fleet `fed-drill` at 08:11:25Z and the tower has no row for it
   * in `coord_presence` (reaped) AND none in the append-only
   * `fleet_membership_events` (the fleet registry is machine-local) — the newest
   * fed-drill membership rows are from 03:41Z. Only `p2p_receipts` demonstrably
   * crosses (verified: 2 rows, both origin='remote', kind='refusal').
   *
   * So absent a refusal, a remote spawn's outcome is UNKNOWABLE from this side.
   * Reporting that honestly is the whole point — emitting `no-response` here
   * would dress the exact ambiguity this module exists to remove up as a verdict.
   */
  | 'indeterminate'
  /**
   * The honoring host FEDERATED a success receipt (kind='honored',
   * EI-19333624101736074), but this host cannot observe the member itself.
   *
   * Strictly stronger than `indeterminate` and strictly weaker than
   * `honored-live`, and the distinction is the point: we now KNOW the request
   * was honored and by whom and on which account — we do NOT know whether the
   * member survived boot, because the receipt attests a LAUNCH, not a boot.
   * Never collapse this into `honored-live` (over-claims a booted member) or
   * into `no-response` (flatly false — someone did honor it).
   */
  | 'honored-unverified'
  /** Still inside the honor window with nothing observed yet. Not a failure. */
  | 'pending';

export interface DelegatedSpawnRequestFacts {
  offerId: string;
  fleetSlug: string;
  /** Seats asked for. A shortfall is reported, never silently rounded away. */
  count: number;
  requestedAtMs: number;
  /** Defaults to {@link DEFAULT_HONOR_WINDOW_MS}. */
  honorWindowMs?: number;
}

/** A federated receipt already filtered to this request's offerId. */
export interface DelegatedSpawnReceiptFacts {
  kind: string;
  code?: string | null;
  detail?: string | null;
  tsMs: number;
}

/**
 * A fleet presence row on the REQUESTING host. `firstSeenMs`/`lastActiveMs` are
 * the member's own lifetime bounds; `sessionState` is the shared liveness oracle
 * verdict (live | parked | draining | suspect | ended | recorded) — NOT a raw
 * heartbeat boolean, which reads `true` for a warm-dead session.
 */
export interface DelegatedSpawnMemberFacts {
  ownerId: string;
  fleetSlug: string;
  firstSeenMs: number;
  lastActiveMs: number;
  /** First attributed tool invocation for this presence lifetime. Presence
   * alone is not boot proof (D-029 / WI-35786). */
  lastToolCallAtMs: number | null;
  sessionState: string;
}

export interface DelegatedSpawnOutcome {
  verdict: DelegatedSpawnVerdict;
  /** Human detail — always states what evidence produced the verdict. */
  detail: string;
  /** Whether a member could be uniquely credited to THIS request. */
  attribution: 'unique' | 'ambiguous' | 'none';
  /** Members attributed to this request (may be empty). */
  members: Array<{ ownerId: string; sessionState: string; lifetimeMs: number; firstTurnAtMs: number }>;
  /** Seats asked for minus members observed — positive means a shortfall. */
  shortfall: number;
  /** The refusal code, when the verdict is `refused`. */
  refusalCode?: string;
  /** True when the verdict is one a requester should ACT on. */
  actionable: boolean;
}

const LIVE_STATES = new Set(['live', 'parked', 'draining']);

/**
 * Reconcile a delegated spawn request against requester-side evidence.
 *
 * `members` should already be scoped to the request's fleet; rows that first
 * appeared BEFORE the request are dropped here (they cannot have come from it).
 */
export function classifyDelegatedSpawnOutcome(args: {
  request: DelegatedSpawnRequestFacts;
  receipts: DelegatedSpawnReceiptFacts[];
  members: DelegatedSpawnMemberFacts[];
  nowMs: number;
  /** Other spawn requests targeting the SAME fleet whose windows overlap this
   *  one. >0 ⇒ a member cannot be uniquely credited to this request. */
  concurrentRequests?: number;
  bootDeathLifetimeMs?: number;
  /**
   * Whether THIS host can see member evidence (presence / fleet-membership) for
   * the honoring host. True for a LOCAL honor (same machine — the rows are
   * local). FALSE for a remote honor: the fleet registry is machine-local and
   * presence rows are reaped, so their absence proves NOTHING. Defaults to true
   * to keep the local path unchanged; the remote caller must opt out explicitly.
   */
  memberEvidenceAvailable?: boolean;
}): DelegatedSpawnOutcome {
  const { request, receipts, members, nowMs } = args;
  const bootMs = args.bootDeathLifetimeMs ?? BOOT_DEATH_LIFETIME_MS;
  const windowMs = request.honorWindowMs ?? DEFAULT_HONOR_WINDOW_MS;
  const windowEndsAtMs = request.requestedAtMs + windowMs;
  const withinWindow = nowMs < windowEndsAtMs;

  // A refusal is the one thing that DOES federate today — trust it first.
  const refusal = receipts
    .filter((r) => r.kind === 'refusal')
    .sort((a, b) => a.tsMs - b.tsMs)[0];
  if (refusal) {
    return {
      verdict: 'refused',
      detail:
        `the honoring host refused this request${refusal.code ? ` (${refusal.code})` : ''}` +
        `${refusal.detail ? `: ${refusal.detail}` : ''}`,
      attribution: 'none',
      members: [],
      shortfall: request.count,
      refusalCode: refusal.code ?? undefined,
      actionable: true,
    };
  }

  // EI-19333624101736074: the honoring host now federates a SUCCESS receipt too.
  // Legacy receipts attest only that a process was launched. D-029 receipts are
  // stronger: their detail carries the stable `first-turn check CONFIRMED`
  // marker after a post-start tool invocation was observed. Keep the distinction
  // explicit so mixed-version peers never turn a launch-only receipt into boot
  // proof, while current peers do not get mislabeled "unverified" after proving
  // the very first turn the release gate requires.
  const honoredReceipt = receipts
    .filter((r) => r.kind === 'honored')
    .sort((a, b) => a.tsMs - b.tsMs)[0];
  const honoredReceiptProvesFirstTurn = /\bfirst-turn check CONFIRMED\b/i.test(honoredReceipt?.detail ?? '');

  // Presence rows carry no request id, so candidacy is "same fleet, appeared
  // after the request was published". That is a heuristic, and it is REPORTED
  // as one whenever another request could also claim these members.
  const candidates = members
    .filter(
      (m) =>
        m.fleetSlug === request.fleetSlug &&
        m.firstSeenMs >= request.requestedAtMs &&
        m.lastToolCallAtMs != null &&
        m.lastToolCallAtMs >= Math.max(request.requestedAtMs, m.firstSeenMs),
    )
    .map((m) => ({
      ownerId: m.ownerId,
      sessionState: m.sessionState,
      lifetimeMs: Math.max(0, m.lastActiveMs - m.firstSeenMs),
      firstTurnAtMs: m.lastToolCallAtMs!,
    }));

  if (candidates.length === 0) {
    // D-029: a current honored receipt is emitted only AFTER a fresh attributed
    // tool invocation. That is direct cross-machine first-turn proof even when
    // this requester cannot see the remote host's machine-local presence rows.
    // The receipt also reports opened/requested counts; retain a conservative
    // shortfall if an older/malformed detail somehow carries the marker without
    // the count.
    if (honoredReceipt && honoredReceiptProvesFirstTurn) {
      const openedMatch = honoredReceipt.detail?.match(/\bopened\s+(\d+)\/(\d+)\b/i);
      const opened = Math.min(
        request.count,
        openedMatch ? Math.max(0, Number.parseInt(openedMatch[1], 10)) : Math.min(1, request.count),
      );
      const shortfall = Math.max(0, request.count - opened);
      return {
        verdict: 'honored-first-turn-proven',
        detail:
          `the honoring host federated D-029 first-turn proof for this request: ${honoredReceipt.detail}. ` +
          (args.memberEvidenceAvailable === false
            ? 'This requester cannot observe the remote member\'s current machine-local presence, so current liveness is unknown; boot and one tool-backed turn are proven.'
            : 'No currently qualifying member row remains on this host, but boot and one tool-backed turn are proven by the receipt.') +
          (shortfall > 0 ? ` Asked for ${request.count} seat(s), but the receipt proves ${opened}.` : ''),
        attribution: 'none',
        members: [],
        shortfall,
        actionable: shortfall > 0,
      };
    }
    // A success receipt settles WHETHER it was honored even when nothing else
    // crosses the wire — which is exactly the remote case. A LEGACY receipt that
    // lacks D-029's proof marker does NOT settle whether the member booted, so it
    // stays short of `honored-first-turn-proven` / `honored-live`.
    if (honoredReceipt) {
      return {
        verdict: 'honored-unverified',
        detail:
          `the honoring host federated a success receipt for this request${
            honoredReceipt.detail ? `: ${honoredReceipt.detail}` : ''
          } — so it WAS honored. ` +
          (args.memberEvidenceAvailable === false
            ? 'This host cannot see the member itself (a remote honor: the fleet registry is machine-local and ' +
              'presence rows are reaped), and the receipt attests that the member PROCESS was launched, not that it ' +
              'booted — so whether it survived boot is still unknown from here. Read the member log ON the honoring host.'
            : 'No member matching this request appeared on this host, though member evidence IS available here — so ' +
              'the member most likely died before it could register presence. Read its boot log for the cause.'),
        attribution: 'none',
        members: [],
        shortfall: request.count,
        actionable: true,
      };
    }
    // A remote honor leaves NO member trace on this host, so "no members" is not
    // evidence of anything. Say so instead of manufacturing a verdict from an
    // absence we already know to be uninformative.
    if (args.memberEvidenceAvailable === false && !withinWindow) {
      return {
        verdict: 'indeterminate',
        detail:
          `the ${Math.round(windowMs / 60_000)}-min honor window elapsed with no receipt of any kind, and this host holds ` +
          'NO member evidence for a remote honor (the fleet registry is machine-local and presence rows are reaped) — ' +
          'so honored-and-died, honored-and-finished, and never-honored are INDISTINGUISHABLE from here. This is a ' +
          'gap in the protocol, not a finding about this request. The honoring host emits a success receipt ' +
          "(kind='honored') as of EI-19333624101736074, so a peer that emits NEITHER receipt is most likely running a " +
          'build that predates it — check its version before concluding anything. Otherwise read the member log ON that host.',
        attribution: 'none',
        members: [],
        shortfall: request.count,
        actionable: true,
      };
    }
    return withinWindow
      ? {
          verdict: 'pending',
          detail:
            `no receipt and no member yet, but the ${Math.round(windowMs / 60_000)}-min honor window is still open ` +
            `(${Math.round((windowEndsAtMs - nowMs) / 60_000)} min left) — not yet a failure`,
          attribution: 'none',
          members: [],
          shortfall: request.count,
          actionable: false,
        }
      : {
          verdict: 'no-response',
          detail:
            `the ${Math.round(windowMs / 60_000)}-min honor window elapsed with no refusal receipt and no member ` +
            `joining '${request.fleetSlug}' — nobody honored it. Check that the target host has accept-delegated-seats enabled.`,
          attribution: 'none',
          members: [],
          shortfall: request.count,
          actionable: true,
        };
  }

  const attribution: DelegatedSpawnOutcome['attribution'] =
    (args.concurrentRequests ?? 0) > 0 ? 'ambiguous' : 'unique';
  const caveat =
    attribution === 'ambiguous'
      ? ` ⚠ ${args.concurrentRequests} other spawn request(s) overlapped this one on the same fleet, and presence rows ` +
        'carry no request id — these members cannot be credited to this request with certainty.'
      : '';
  const shortfall = Math.max(0, request.count - candidates.length);
  const shortfallNote = shortfall > 0 ? ` Asked for ${request.count} seat(s), observed ${candidates.length}.` : '';

  const live = candidates.filter((m) => LIVE_STATES.has(m.sessionState));
  if (live.length > 0) {
    return {
      verdict: 'honored-live',
      detail:
        `${live.length} member(s) joined '${request.fleetSlug}' after the request, completed a tool-backed first turn, and are ${live[0].sessionState}.` +
        shortfallNote +
        caveat,
      attribution,
      members: candidates,
      shortfall,
      actionable: shortfall > 0,
    };
  }

  // Every candidate has ended. Short-lived ⇒ the phantom this module exists for.
  const diedAtBoot = candidates.filter((m) => m.lifetimeMs < bootMs);
  if (diedAtBoot.length > 0) {
    return {
      verdict: 'honored-then-died',
      detail:
        `PHANTOM HONOR: ${diedAtBoot.length} member(s) joined '${request.fleetSlug}' and then died within ` +
        `${Math.round(bootMs / 1000)}s (shortest lifetime ${Math.min(...diedAtBoot.map((m) => m.lifetimeMs))}ms). ` +
        'The seat was consumed but no work can have been done. ' +
        (honoredReceipt
          ? // The success receipt attests the LAUNCH and names the account, which is
            // the first thing to check when the member then dies at boot.
            `The honoring host's success receipt says${honoredReceipt.detail ? `: ${honoredReceipt.detail}` : ' it launched'} — ` +
            'so compare that account against the boot error (an auth failure is the common cause; see EI-19331694139523035).'
          : 'The honoring host emitted no success receipt, so this is only visible by reconciliation — read the member ' +
            'log ON that host for the boot error (an auth failure is the common cause; see EI-19331694139523035).') +
        shortfallNote +
        caveat,
      attribution,
      members: candidates,
      shortfall,
      actionable: true,
    };
  }

  return {
    verdict: 'honored-completed',
    detail:
      `${candidates.length} member(s) joined '${request.fleetSlug}', ran past the ${Math.round(bootMs / 1000)}s boot ` +
      'threshold, and have since ended — a normal completed run, not a phantom.' +
      shortfallNote +
      caveat,
    attribution,
    members: candidates,
    shortfall,
    actionable: shortfall > 0,
  };
}
