/**
 * p2p/revocation-reaper.ts — P-106 (p2p-work-distribution-2026-07-02):
 * reap in-flight FOREIGN SESSIONS when the authorizing grant / publisher is
 * revoked.
 *
 * WHY: a foreign session runs on THIS host because the host granted the offering
 * fleet the `work-offer` capability. When that grant is revoked (or a publisher
 * is revoked), the host has WITHDRAWN CONSENT — every LIVE foreign session it
 * covers must be TERMINATED, not left running. Enforcement rides the existing
 * p2p_foreign_workspaces state machine: transitioning a session to `reaped`
 * FAIL-CLOSES it — foreign-guard.ts denies edits from any session whose row is
 * not `active`, and the foreign-git-sync commit lane commits nothing for it. C6:
 * this reads the registry DIRECTLY — no cache tier may sit between a landed
 * revocation and the reap (WI-1547 class). mig 463 header, verbatim: "Reaping
 * in-flight work is P-106."
 *
 * A refusal RECEIPT (kind='refusal', code 'grant-revoked' | 'publisher-revoked',
 * action 'work-offer:reap') is emitted per reaped session so the origin learns
 * why its work stopped (M15 authenticated → receipts; M21 offer_id threads it).
 *
 * H7/X6 (epoch-monotonic, fail-closed): only call this for a revocation that has
 * LANDED. revokePeerGrant bumps the grantor epoch + re-stamps the grantor's other
 * active grants IN-TXN BEFORE this runs, so the epoch fence is applied upstream;
 * the reaper never un-reaps and is idempotent (terminal rows are never matched).
 *
 * SCOPE (v1 — what lands NOW on existing substrate). One follow-up remains
 * DEFERRED and DOCUMENTED, never silently dropped:
 *   1. MECHANICAL KILL after the X13 wind-down grace (cgroup / dedicated OS user)
 *      is P-105's sandbox tier, which is unbuilt. Until it lands, the fail-closed
 *      guard is the boundary for honest sessions and the `reaped` registry state
 *      + a coord wake is the wind-down signal; a hostile shell is P-105's problem.
 * The second follow-up is now WIRED (WI-1935): CANCELLING UNCLAIMED OFFERS —
 * the P-102 signed-offer store landed (offer-store.ts, mig 490), and this path
 * marks every still-open offer the revocation covers with a HOST-LOCAL
 * disposition (setLocalOfferDisposition). Deliberately UNSIGNED + NON-FEDERATED:
 * this host cannot re-sign the publisher's record — it just stops serving it
 * (list reads + the puller exclude disposed rows); the publisher's own signed
 * cancel remains the only federated status change.
 * A third follow-up is now WIRED (WI-1940): FEDERATED reap (revoke on machine A
 * → reap on the executor machine B) — the p2p-peer-grants PROJECTION's
 * writeToPg calls this reaper for a landed, remote-origin, fleet-grant
 * revocation (sync/hyperbee/projections/p2p-peer-grants.ts). The LOCAL
 * owner-revoke path (the p2p-grant-set route) also calls THIS reaper directly
 * on the grantor's own host; both paths converge here.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from '../work-items';
import {
  listForeignWorkspaces,
  setForeignWorkspaceState,
  type ForeignWorkspace,
  type ForeignWorkspaceState,
} from './foreign-workspaces';
import { resolveP2pGrantWorkspace } from './grant-store';
import { emitP2pReceipt } from './receipts';
import { setLocalOfferDisposition, type LocalDispositionPredicate } from './offer-store';
import { deregisterEphemeralForeignHarness } from '../harness-registry';

/**
 * States where a foreign session is still LIVE and therefore reapable. The
 * terminal states (`parked`, `reaped`) are excluded — matching one would be a
 * no-op at best and a double-receipt at worst, so the reaper is idempotent by
 * never selecting them.
 */
export const REAPABLE_STATES: readonly ForeignWorkspaceState[] = [
  'provisioning',
  'active',
  'winding-down',
];

/** What triggered the reap — a revoked host→fleet grant, or a revoked publisher. */
export type RevocationTrigger =
  | { kind: 'grant-revoked'; fleetSlug: string }
  | { kind: 'publisher-revoked'; originGithubUserId: number };

/** The refusal code stamped on the receipt for each trigger kind. */
const RECEIPT_CODE: Record<RevocationTrigger['kind'], string> = {
  'grant-revoked': 'grant-revoked',
  'publisher-revoked': 'publisher-revoked',
};

/**
 * PURE: does this foreign session fall under the revocation? Live-state + identity
 * match, no IO — the exhaustively-testable heart of the reaper.
 *   - grant-revoked   ⇒ the session's offering fleet lost `work-offer` on this host.
 *   - publisher-revoked ⇒ the session's origin peer is no longer an authorized publisher.
 */
export function foreignSessionMatchesRevocation(
  ws: ForeignWorkspace,
  trigger: RevocationTrigger,
): boolean {
  if (!REAPABLE_STATES.includes(ws.state)) return false; // terminal ⇒ idempotent
  switch (trigger.kind) {
    case 'grant-revoked':
      return ws.fleetSlug === trigger.fleetSlug;
    case 'publisher-revoked':
      return ws.originGithubUserId === trigger.originGithubUserId;
  }
}

export interface ReapArgs {
  /** The caller's RESOLVED identity workspace (C3). A `default`/`*`/null partition
   *  is REFUSED loudly — a stranded reap that never federates is a security hole. */
  workspaceId: string | null | undefined;
  potSlug: string;
  /** The enforcing side = the receipt author = this host's grantor user (X9 numeric). */
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  trigger: RevocationTrigger;
  /** Audit actor label (session/owner id); defaults to 'p2p:reaper'. */
  actor?: string;
  /** Extra human breadcrumb for the park_reason + receipt detail. */
  reason?: string;
}

export interface ReapedSession {
  offerId: string;
  fleetSlug: string;
  originGithubUserId: number;
  priorState: ForeignWorkspaceState;
}

export type ReapResult =
  | {
      ok: true;
      reaped: ReapedSession[];
      /** Receipts successfully emitted (one per reaped session, best-effort). */
      receiptsEmitted: number;
      /** Reaped sessions whose receipt emit FAILED — surfaced, never swallowed
       *  (the reap itself still landed; the origin just may not learn why). */
      receiptFailures: number;
      /** WI-1935 (deferred #2): still-open offers the revocation covers, newly
       *  refused HOST-LOCALLY (offer-store local_disposition — unsigned,
       *  non-federated; the puller stops claiming them on this host). */
      offersCancelled: number;
      /** The offer-cancel sweep failed (the session reap still landed) —
       *  surfaced, never swallowed. */
      offerCancelError: string | null;
    }
  | { ok: false; refusal: { code: string; detail: string } };

/** Injectable IO deps (defaults = the real store fns) so orchestration is unit-
 *  testable without a live Postgres. */
export interface ReaperDeps {
  listForeignWorkspaces: typeof listForeignWorkspaces;
  setForeignWorkspaceState: typeof setForeignWorkspaceState;
  emitP2pReceipt: typeof emitP2pReceipt;
  setLocalOfferDisposition: typeof setLocalOfferDisposition;
  /** WI-1937 step 5: deregister the ephemeral harness_registry row (if any)
   *  once a session actually transitions to 'reaped' here — this is the ONLY
   *  production path that reaches 'reaped' (foreign-supervision.ts's sweep
   *  only ever reaches 'winding-down'; the P-105 sandbox mechanical kill is
   *  unbuilt), so this is the correct — and only — place to clean up the row. */
  deregisterEphemeralForeignHarness: typeof deregisterEphemeralForeignHarness;
}

const defaultDeps: ReaperDeps = {
  listForeignWorkspaces,
  setForeignWorkspaceState,
  emitP2pReceipt,
  setLocalOfferDisposition,
  deregisterEphemeralForeignHarness,
};

/**
 * Reap every LIVE foreign session on THIS host that `args.trigger` covers:
 * transition it to `reaped` (fail-closing it, C6 no-cache) and emit a refusal
 * receipt. Idempotent, order-independent, and continues past a single receipt
 * failure (the reap is the safety-critical half; the receipt is best-effort).
 */
export async function reapForeignSessionsForRevocation(
  args: ReapArgs,
  sqlOverride?: OrgSql,
  depsOverride?: Partial<ReaperDeps>,
): Promise<ReapResult> {
  const deps = { ...defaultDeps, ...depsOverride };
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: {
        code: 'workspace_unresolved',
        detail:
          'P2P revocation reap refused: unresolvable workspace partition (WI-1564) — a stranded reap leaves a revoked peer running.',
      },
    };
  }
  const hive = args.potSlug?.trim();
  if (!hive) {
    return { ok: false, refusal: { code: 'hive_required', detail: 'revocation reap is hive-scoped; pass the hive HOME slug.' } };
  }
  const sql = sqlOverride ?? getOrgPg().sql;

  // C6: read the registry DIRECTLY (no cache tier). One scan; the pure predicate
  // selects the live sessions the revocation covers.
  const all = await deps.listForeignWorkspaces(ws, {}, sql);
  const matches = all.filter((w) => foreignSessionMatchesRevocation(w, args.trigger));

  const reaped: ReapedSession[] = [];
  let receiptsEmitted = 0;
  let receiptFailures = 0;
  const parkReason = `revocation:${args.trigger.kind}${args.reason ? `:${args.reason}` : ''}`;
  const code = RECEIPT_CODE[args.trigger.kind];

  for (const w of matches) {
    // 1. Fail-close the session: state != 'active' ⇒ guard denies edits + no commits.
    //    fromStates makes the raced-to-terminal skip real at the row level.
    const updated = await deps.setForeignWorkspaceState(
      ws,
      w.offerId,
      'reaped',
      { parkReason, fromStates: REAPABLE_STATES },
      sql,
    );
    if (!updated) continue; // raced to terminal by another actor — idempotent skip
    reaped.push({
      offerId: w.offerId,
      fleetSlug: w.fleetSlug,
      originGithubUserId: w.originGithubUserId,
      priorState: w.state,
    });

    // 1b. WI-1937: the session is now fail-closed — deregister its ephemeral
    //     harness_registry row (if `provisionForeignClone` registered one for
    //     it) so it stops appearing in harness listings/default-inference. A
    //     row that was never registered (e.g. reaped before the clone leg
    //     landed) is a no-op — deregister is idempotent. Best-effort like the
    //     receipt below: a leaked row is caught later by the orphan sweep
    //     (sweepOrphanedEphemeralForeignHarnesses), never allowed to abort
    //     the reap itself.
    try {
      await deps.deregisterEphemeralForeignHarness(w.offerId, ws);
    } catch {
      /* leaked row — orphan sweep catches it; reap already landed */
    }

    // 2. Receipt so the origin learns WHY its work stopped (M15/M21). Best-effort:
    //    a receipt failure is COUNTED + surfaced, never allowed to abort the sweep.
    try {
      const res = await deps.emitP2pReceipt(
        {
          workspaceId: ws,
          potSlug: hive,
          kind: 'refusal',
          offerId: w.offerId,
          action: 'work-offer:reap',
          refusal: {
            code,
            detail: `foreign session reaped: ${parkReason} (fleet=${w.fleetSlug})`,
          },
          requester: { ref: w.fleetSlug, githubUserId: w.originGithubUserId },
          responderGithubUserId: args.responderGithubUserId,
          responderDevicePubkey: args.responderDevicePubkey ?? null,
          actor: args.actor ?? 'p2p:reaper',
        },
        sql,
      );
      if (res.ok) receiptsEmitted += 1;
      else receiptFailures += 1;
    } catch {
      receiptFailures += 1;
    }
  }

  // WI-1935 (deferred #2): the revocation also covers UNCLAIMED offers — mark
  // every still-open offer it matches with a host-local disposition so the
  // puller stops claiming them HERE. Unsigned + non-federated by design (this
  // host cannot re-sign the publisher's record). Best-effort like the receipts:
  // a failure is surfaced in the result, never allowed to undo the session reap.
  const offerPredicate: LocalDispositionPredicate =
    args.trigger.kind === 'grant-revoked'
      ? { fleetSlug: args.trigger.fleetSlug }
      : { publisherGithubUserId: args.trigger.originGithubUserId };
  let offersCancelled = 0;
  let offerCancelError: string | null = null;
  try {
    offersCancelled = await deps.setLocalOfferDisposition(ws, hive, offerPredicate, parkReason, sql);
  } catch (e) {
    offerCancelError = e instanceof Error ? e.message : String(e);
  }

  return { ok: true, reaped, receiptsEmitted, receiptFailures, offersCancelled, offerCancelError };
}
