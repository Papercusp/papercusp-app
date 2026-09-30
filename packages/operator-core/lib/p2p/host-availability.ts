/**
 * p2p/host-availability.ts — WI-1937 production build of the D-007
 * `HostAvailability` snapshot (claim-authority.ts's `{ remote, local }`
 * input to `evaluateClaimAuthority`), consumed by BOTH the P-103 standing
 * puller (`PullEvaluationInput.hostAvailability`) and the P-104
 * offer-executor's `OfferExecutorDeps.hostAvailability` — one builder, two
 * callers, so the two gates can never disagree about "what does this host
 * have right now".
 *
 * Composes:
 *   POLICY layer (real) — this host's P-201 resource-allotments for the
 *     offer's fleet, minus P-205 committed spend (metering-ledger /
 *     metering-store). Only the ABSOLUTE forward-seam fields
 *     (`axis.dollarCapUsd` for 'account' rows, `axis.slots` for 'gpu' rows —
 *     see resource-allotments.ts's `ResourceAllotment.axis` doc) are
 *     resolvable today; a `sharePct`-only row (no absolute cap set) has no
 *     defined "pool budget" to take a percentage OF anywhere in this
 *     codebase yet, so it contributes 0 to the cap rather than guess —
 *     fail-closed, not fail-open, on an unresolved axis.
 *   PHYSICS layer (real since WI-3590) — real-time headroom, read live from
 *     the inference gateway by `live-headroom.ts`: the local axis counts free
 *     slots on the local-backend pool (`GET /admin/local-backends`), the remote
 *     axis derates this host's policy cap by the binding rate window's live
 *     utilization (`GET /stats`). Every unknown — gateway unreachable, paused,
 *     hard-rejected, no serviceable accounts, or no utilization data at all —
 *     still resolves to 0, so the v1 fail-closed guarantee is intact: PHYSICS
 *     can only ever LOWER what POLICY already allowed, never raise it. See
 *     live-headroom.ts's module doc for why the remote axis is a derating
 *     rather than an independent quantity (its budget unit is usd-micros and
 *     no dollar-denominated capacity reader exists anywhere in this codebase).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from '../work-items';
import {
  axisForResourceKind,
  type AxisAvailability,
  type HostAvailability,
} from './claim-authority';
import type { BudgetAxis } from './offer-budget';
import {
  fetchGatewayHeadroom,
  fetchLocalBackends,
  type GatewayHeadroom,
  type LocalBackendsSnapshot,
} from '../inference-gateway/observability';
import { localLiveHeadroom, remoteLiveHeadroom } from './live-headroom';
import { spentOn } from './metering-ledger';
import { loadMeteringLedger } from './metering-store';
import { listResourceAllotments, resolveAllotmentWorkspace, type ResourceAllotment } from './resource-allotments';

/** The absolute cap (in the axis's native unit) ONE allotment row contributes,
 *  or 0 when the row carries no resolvable absolute forward-seam value (see
 *  module doc — a sharePct-only row is not yet resolvable). */
function absoluteCapOf(row: Pick<ResourceAllotment, 'resourceKind' | 'axis'>): number {
  if (row.resourceKind === 'account') {
    const usd = row.axis?.dollarCapUsd;
    // BudgetUnit for 'remote' is 'usd-micros' (offer-budget.ts) — dollarCapUsd is USD.
    return typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : 0;
  }
  if (row.resourceKind === 'gpu') {
    const slots = row.axis?.slots;
    return typeof slots === 'number' && Number.isFinite(slots) && slots > 0 ? slots : 0;
  }
  return 0; // agent_slot excluded from budget math (D-002, axisForResourceKind)
}

/**
 * The two live PHYSICS reads, injectable so a test can drive the gate deterministically.
 *
 * DEFAULTS ARE VITEST-SAFE: the production defaults fetch the live :8788 gateway, which under a
 * test runner would make every claim-gate test read whatever real gateway happens to be running on
 * the box. Under VITEST the defaults short-circuit to "unreachable" — i.e. fail-closed 0, the same
 * conservative answer as a down gateway — so a test that does not inject readers sees the v1
 * behaviour deterministically, and a test that DOES inject them opts into the real logic. Mirrors
 * the identical guard in observability.ts's `gatewayWholesaleThrottled`.
 */
export interface HostAvailabilityReaders {
  gatewayHeadroom: () => Promise<GatewayHeadroom>;
  localBackends: () => Promise<LocalBackendsSnapshot>;
}

function defaultReaders(): HostAvailabilityReaders {
  if (process.env.VITEST) {
    return {
      gatewayHeadroom: async () => ({ reachable: false, error: 'VITEST: live gateway read suppressed' }),
      localBackends: async () => ({ reachable: false, configured: false, candidates: [], error: 'VITEST: live gateway read suppressed' }),
    };
  }
  // Short timeouts: this runs on the claim hot path and is RE-RUN at every reservation (D-007),
  // so a wedged gateway must degrade to fail-closed quickly, never stall the gate.
  return {
    gatewayHeadroom: () => fetchGatewayHeadroom({ timeoutMs: 800 }),
    localBackends: () => fetchLocalBackends({ timeoutMs: 800 }),
  };
}

export interface HostAvailabilityContext {
  /** The caller's RESOLVED identity workspace (same C3/WI-1564 partition every other p2p store uses). */
  workspaceId: string | null | undefined;
  /** THIS host's own identity ref for the P-205 metering ledger (`host_ref` column) —
   *  must be the SAME ref the spend-recording leg stamps when a foreign session draws,
   *  or `allotmentRemaining` will never reflect real spend. */
  hostRef: string;
}

/**
 * Build a live `HostAvailability` snapshot for `fleetSlug` on this host. No
 * caching — always freshly read (D-007 requires a spawn-time re-check, never
 * a stale snapshot: leases ADVISE, this gate DECIDES). `null` per-axis = M11
 * default-zero (this host serves no allotment for that axis on this fleet).
 */
export async function hostAvailability(
  ctx: HostAvailabilityContext,
  fleetSlug: string,
  sqlOverride?: OrgSql,
  readersOverride?: HostAvailabilityReaders,
): Promise<HostAvailability> {
  const ws = resolveAllotmentWorkspace(ctx.workspaceId);
  if (!ws) return { remote: null, local: null };

  const sql = sqlOverride ?? getOrgPg().sql;
  const readers = readersOverride ?? defaultReaders();
  const [allotments, ledger] = await Promise.all([
    listResourceAllotments({ workspaceId: ctx.workspaceId, fleetSlug }, sql),
    loadMeteringLedger(ws, sql),
  ]);

  const capByAxis: Record<BudgetAxis, number> = { remote: 0, local: 0 };
  const servedByAxis: Record<BudgetAxis, boolean> = { remote: false, local: false };
  for (const row of allotments) {
    if (row.resourceKind !== 'account' && row.resourceKind !== 'gpu') continue;
    const axis = axisForResourceKind(row.resourceKind);
    servedByAxis[axis] = true;
    capByAxis[axis] += absoluteCapOf(row);
  }

  // PHYSICS reads run ONLY for an axis this host actually serves (M11) — an unserved axis is null
  // regardless, so probing the gateway for it would be a wasted hot-path round-trip. Both run
  // concurrently; each fails closed on its own (never throws) so one dead reader cannot deny the
  // other axis.
  const [remoteRead, localRead] = await Promise.all([
    servedByAxis.remote ? readers.gatewayHeadroom() : Promise.resolve(null),
    servedByAxis.local ? readers.localBackends() : Promise.resolve(null),
  ]);

  const axisSnapshot = (axis: BudgetAxis): AxisAvailability | null => {
    if (!servedByAxis[axis]) return null; // M11: no allotment row on this axis for this fleet
    const spent = spentOn(ledger, ctx.hostRef, fleetSlug, axis);
    const allotmentRemaining = Math.max(0, capByAxis[axis] - spent);
    // PHYSICS (WI-3590). Remote is a derating OF the policy cap (its budget unit is usd-micros and
    // the gateway knows rate room, not dollars), so it takes the cap as input; local is a direct
    // free-slot count. Either way the result is <= the cap — PHYSICS never raises POLICY.
    const live =
      axis === 'remote'
        ? remoteRead
          ? remoteLiveHeadroom(remoteRead, allotmentRemaining)
          : null
        : localRead
          ? localLiveHeadroom(localRead)
          : null;
    return {
      allotmentRemaining,
      liveHeadroom: live?.headroom ?? 0,
      liveHeadroomDetail: live?.detail,
    };
  };

  return { remote: axisSnapshot('remote'), local: axisSnapshot('local') };
}
