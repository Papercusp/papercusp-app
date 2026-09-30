/**
 * p2p/foreign-supervision.ts — P-104's SUPERVISION SWEEP over live foreign
 * sessions (p2p-work-distribution-2026-07-02): H12 liveness revalidation +
 * H13 orphan detection, feeding X8-classified wind-downs.
 *
 *   H12 — the executor periodically revalidates a claimed offer's liveness:
 *         an explicit cancel (delivered via coord wake) wins immediately
 *         (excused breach); liveness unconfirmable within the TTL defaults to
 *         WIND-DOWN (a partition fails safe, not keeps spending).
 *   H13 — ORPHAN SUPERVISION: when the ORIGIN peer has been unreachable for T,
 *         the foreign session is wound down + receipted. An origin NEVER seen
 *         (null) counts as unreachable — fail-closed; production callers seed
 *         `originLastSeenAt` with the claim/offer arrival time as a floor so a
 *         fresh spawn is not instantly orphaned.
 *
 * The decision heart (`decideSupervision`) is PURE (offer-budget discipline);
 * the sweep composes it over the mig-467 registry exactly like P-106's reaper
 * (direct registry read — C6 no cache tier — plus best-effort receipts that
 * never abort the sweep). Wind-down here means state → 'winding-down': the
 * commit lane stops committing (it only serves 'active') and the session gets
 * its grace to drain; the MECHANICAL kill after grace is P-105's sandbox tier
 * (same documented deferral as the reaper's §1).
 *
 * `windDownForeignSession` is exported as the single wind-down primitive so
 * the P-107 budget-exhaustion path (reserve → 'budget_exhausted' →
 * decideWindDown) lands the SAME transition + receipt as the sweep.
 *
 * SCHEDULING (repo rule: no bare setInterval, no new scheduler): run this as a
 * tier:ephemeral blueprint `triggers.schedule` — deterministic action id
 * `system:p2p-foreign-supervision`, intervalSec ~60 — executed by the per-host
 * ephemeral-executor. The blueprint lands with the host-supervisor production
 * wiring (the same seam that binds launchSession), since the deps below
 * (liveness from coord cancel-signals, originLastSeenAt from presence gossip)
 * only exist there.
 */
import type { OrgSql } from '../work-items';
import {
  listForeignWorkspaces,
  setForeignWorkspaceState,
  type ForeignWorkspace,
} from './foreign-workspaces';
import {
  decideWindDown,
  resolveOfferLiveness,
  type WindDownDecision,
} from './offer-budget';
import { emitP2pReceipt } from './receipts';
import { resolveP2pGrantWorkspace } from './grant-store';
import { enforceForeignWorkspaceQuota } from './sandbox/quota-volume';

/** States the sweep supervises. 'winding-down' is already decided (grace is
 *  P-105's kill tier); 'parked'/'reaped' are terminal. */
export const SUPERVISED_STATES: readonly ForeignWorkspace['state'][] = ['provisioning', 'active'];

/** PURE: should this live foreign session wind down, and why? Order: an
 *  explicit cancel wins (excused breach), then H12 liveness TTL, then H13
 *  origin-unreachable-for-T. Null = healthy, leave it running. Clock skew
 *  (negative ages) never winds down. */
export function decideSupervision(input: {
  cancelSignalSeen: boolean;
  /** ms epoch of the last CONFIRMED offer liveness (H12; claim time seeds it). */
  lastConfirmedAt: number;
  /** ms epoch the ORIGIN peer was last seen; null = never (H13 fail-closed). */
  originLastSeenAt: number | null;
  now: number;
  livenessTtlMs: number;
  orphanAfterMs: number;
}): WindDownDecision | null {
  const liveness = resolveOfferLiveness({
    cancelSignalSeen: input.cancelSignalSeen,
    lastConfirmedAt: input.lastConfirmedAt,
    now: input.now,
    livenessTtlMs: input.livenessTtlMs,
  });
  if (liveness === 'cancelled') return decideWindDown('cancelled');
  if (liveness === 'wind-down') return decideWindDown('liveness_unconfirmable');

  if (input.originLastSeenAt == null) {
    return decideWindDown('liveness_unconfirmable', {
      detail:
        'offer wound down: origin peer never seen by this host (H13 orphan supervision, fail-closed — seed originLastSeenAt with the claim arrival time)',
    });
  }
  const originAge = input.now - input.originLastSeenAt;
  if (originAge >= 0 && originAge > input.orphanAfterMs) {
    return decideWindDown('liveness_unconfirmable', {
      detail: `offer wound down: origin peer unreachable for ${originAge}ms (> ${input.orphanAfterMs}ms — H13 orphan supervision)`,
    });
  }
  return null;
}

/** Store/receipt seams (defaults = the real PG-backed fns). */
export interface SupervisionStoreDeps {
  listForeignWorkspaces?: typeof listForeignWorkspaces;
  setForeignWorkspaceState?: typeof setForeignWorkspaceState;
  emitP2pReceipt?: typeof emitP2pReceipt;
}

/** REQUIRED world-reads (no fail-open defaults): per-offer H12 liveness inputs
 *  + H13 origin presence. Production binds coord cancel-signals / presence
 *  gossip; tests stub. */
export interface SupervisionDeps extends SupervisionStoreDeps {
  livenessInput: (w: ForeignWorkspace) => Promise<{ cancelSignalSeen: boolean; lastConfirmedAt: number }>;
  originLastSeenAt: (originGithubUserId: number) => Promise<number | null>;
}

export interface WindDownArgs {
  /** The caller's RESOLVED identity workspace (C3). */
  workspaceId: string | null | undefined;
  potSlug: string;
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  offerId: string;
  fleetSlug: string;
  originGithubUserId: number;
  decision: WindDownDecision;
  actor?: string;
}

export type WindDownOutcome =
  | { ok: true; transitioned: boolean; receiptEmitted: boolean }
  | { ok: false; refusal: { code: string; detail: string } };

/**
 * The single wind-down primitive: guarded state transition (only from the
 * supervised states — never resurrects a parked/reaped row) + the X8-classified
 * receipt ('excused-breach' for cancels, 'refusal' otherwise; M21 offer-id
 * threaded, action 'work-offer:wind-down'). Receipt is best-effort: a failed
 * emit is reported, never un-transitions the row.
 */
export async function windDownForeignSession(
  args: WindDownArgs,
  deps: SupervisionStoreDeps = {},
  sqlOverride?: OrgSql,
): Promise<WindDownOutcome> {
  const setState = deps.setForeignWorkspaceState ?? setForeignWorkspaceState;
  const emit = deps.emitP2pReceipt ?? emitP2pReceipt;
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: {
        code: 'workspace_unresolved',
        detail: 'wind-down refused: unresolvable workspace partition (WI-1564) — the origin would never receive the receipt.',
      },
    };
  }
  const hive = args.potSlug?.trim();
  if (!hive) return { ok: false, refusal: { code: 'hive_required', detail: 'wind-down is hive-scoped; pass the hive HOME slug.' } };

  const updated = await setState(
    ws,
    args.offerId,
    'winding-down',
    { parkReason: args.decision.detail, fromStates: SUPERVISED_STATES },
    sqlOverride,
  );
  // Raced to terminal (or already winding down) — idempotent: no double receipt.
  if (!updated) return { ok: true, transitioned: false, receiptEmitted: false };

  let receiptEmitted = false;
  try {
    const r = await emit(
      {
        workspaceId: ws,
        potSlug: hive,
        kind: args.decision.receiptKind,
        offerId: args.offerId,
        action: 'work-offer:wind-down',
        refusal: { code: args.decision.cause, detail: args.decision.detail },
        budgetAxis: args.decision.axis,
        requester: { ref: args.fleetSlug, githubUserId: args.originGithubUserId },
        responderGithubUserId: args.responderGithubUserId,
        responderDevicePubkey: args.responderDevicePubkey ?? null,
        actor: args.actor ?? 'p2p:foreign-supervision',
      },
      sqlOverride,
    );
    receiptEmitted = r.ok;
  } catch {
    /* receipt is best-effort; the transition is the safety-critical half */
  }
  return { ok: true, transitioned: true, receiptEmitted };
}

export interface SuperviseArgs {
  workspaceId: string | null | undefined;
  potSlug: string;
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
  /** Injected clock (pure-decision discipline; the scheduler passes Date.now()). */
  now: number;
  /** H12: max ms since last confirmed liveness before defaulting to wind-down. */
  livenessTtlMs: number;
  /** H13: the T after which an unreachable origin orphans its sessions. */
  orphanAfterMs: number;
  actor?: string;
}

export interface SuperviseOutcomeWoundDown {
  offerId: string;
  fleetSlug: string;
  cause: WindDownDecision['cause'];
  receiptKind: WindDownDecision['receiptKind'];
}

export type SuperviseResult =
  | {
      ok: true;
      /** Sessions inspected (in a supervised state). */
      swept: number;
      woundDown: SuperviseOutcomeWoundDown[];
      receiptsEmitted: number;
      receiptFailures: number;
    }
  | { ok: false; refusal: { code: string; detail: string } };

/**
 * Sweep every supervised foreign session on this host (C6: direct registry
 * read) and wind down the ones H12/H13 condemn. Idempotent (guarded
 * transitions), order-independent, continues past per-session failures — a
 * broken liveness read for one offer fails CLOSED (that session winds down,
 * loudly) rather than aborting the sweep.
 */
export async function superviseForeignSessions(
  args: SuperviseArgs,
  deps: SupervisionDeps,
  sqlOverride?: OrgSql,
): Promise<SuperviseResult> {
  const list = deps.listForeignWorkspaces ?? listForeignWorkspaces;
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: {
        code: 'workspace_unresolved',
        detail: 'supervision sweep refused: unresolvable workspace partition (WI-1564).',
      },
    };
  }
  const hive = args.potSlug?.trim();
  if (!hive) return { ok: false, refusal: { code: 'hive_required', detail: 'supervision is hive-scoped; pass the hive HOME slug.' } };

  const all = await list(ws, {}, sqlOverride);
  const candidates = all.filter((w) => SUPERVISED_STATES.includes(w.state));

  const woundDown: SuperviseOutcomeWoundDown[] = [];
  let receiptsEmitted = 0;
  let receiptFailures = 0;

  for (const w of candidates) {
    let decision: WindDownDecision | null;
    try {
      const [liveness, originSeen] = [
        await deps.livenessInput(w),
        await deps.originLastSeenAt(w.originGithubUserId),
      ];
      decision = decideSupervision({
        cancelSignalSeen: liveness.cancelSignalSeen,
        lastConfirmedAt: liveness.lastConfirmedAt,
        originLastSeenAt: originSeen,
        now: args.now,
        livenessTtlMs: args.livenessTtlMs,
        orphanAfterMs: args.orphanAfterMs,
      });
    } catch (e) {
      // A liveness read we cannot make is a liveness we cannot confirm — H12's
      // fail-safe direction, with the read error as the loud detail.
      decision = decideWindDown('liveness_unconfirmable', {
        detail: `offer wound down: liveness inputs unreadable (${e instanceof Error ? e.message : String(e)}) — failing safe (H12)`,
      });
    }
    if (!decision) continue;

    const res = await windDownForeignSession(
      {
        workspaceId: ws,
        potSlug: hive,
        responderGithubUserId: args.responderGithubUserId,
        responderDevicePubkey: args.responderDevicePubkey,
        offerId: w.offerId,
        fleetSlug: w.fleetSlug,
        originGithubUserId: w.originGithubUserId,
        decision,
        actor: args.actor,
      },
      deps,
      sqlOverride,
    );
    if (!res.ok || !res.transitioned) continue;
    woundDown.push({
      offerId: w.offerId,
      fleetSlug: w.fleetSlug,
      cause: decision.cause,
      receiptKind: decision.receiptKind,
    });
    if (res.receiptEmitted) receiptsEmitted += 1;
    else receiptFailures += 1;
  }

  // P-105 §1: periodic quota enforcement sweep.
  // Poll quota on 'active' foreign workspaces; wind down those that exceed.
  // Default quota cap: 10GB per foreign workspace.
  const quotaCapBytes = 10 * 1024 * 1024 * 1024; // 10GB default
  const activeWorkspaces = all.filter((w) => w.state === 'active');
  for (const w of activeWorkspaces) {
    try {
      const quota = await enforceForeignWorkspaceQuota(w.rootPath, quotaCapBytes);
      if (quota.decision.exceeded) {
        const decision = decideWindDown('quota_exceeded', {
          detail: `foreign workspace exceeds quota (used ${quota.usedBytes} bytes > cap ${quota.capBytes} bytes)`,
        });
        const res = await windDownForeignSession(
          {
            workspaceId: ws,
            potSlug: hive,
            responderGithubUserId: args.responderGithubUserId,
            responderDevicePubkey: args.responderDevicePubkey,
            offerId: w.offerId,
            fleetSlug: w.fleetSlug,
            originGithubUserId: w.originGithubUserId,
            decision,
            actor: 'p2p:foreign-supervision-quota-sweep',
          },
          deps,
          sqlOverride,
        );
        if (res.ok && res.transitioned) {
          woundDown.push({
            offerId: w.offerId,
            fleetSlug: w.fleetSlug,
            cause: decision.cause,
            receiptKind: decision.receiptKind,
          });
          if (res.receiptEmitted) receiptsEmitted += 1;
          else receiptFailures += 1;
        }
      }
    } catch (e) {
      // Log but don't abort sweep — quota enforcement is defensive, not fatal
      console.warn(`quota sweep error for offer ${w.offerId}:`, e);
    }
  }

  return { ok: true, swept: candidates.length, woundDown, receiptsEmitted, receiptFailures };
}
