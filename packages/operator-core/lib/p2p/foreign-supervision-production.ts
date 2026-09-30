/**
 * p2p/foreign-supervision-production.ts — production bindings for
 * foreign-supervision.ts's `SupervisionDeps` (P-407, plan
 * p2p-public-release-remaining-lanes-2026-07-16, split from P-406 per D-004).
 * Closes the gap that module's own doc comment names: `livenessInput` (H12
 * cancel + last-confirmed) and `originLastSeenAt` (H13) had no production
 * implementation — only test stubs existed.
 *
 * Both bindings REUSE existing canonical reads rather than inventing new
 * queries (reuse-first):
 *   - originLastSeenAt: `queryFederatedPresenceRows` (the canonical
 *     shared_presence query already used by the roster/federated-presence
 *     surfaces), filtered to the origin's github_user_id, scoped to the hive
 *     (potSlug).
 *   - livenessInput: `getWorkOffer` (the canonical p2p_work_offers reader).
 *     cancelSignalSeen = the offer is gone OR its signed status is
 *     'cancelled'. lastConfirmedAt = the ForeignWorkspace row's own
 *     updatedAt (P-407 extended `ForeignWorkspace`/`fromRow` to expose it) —
 *     bumped at bind-to-active and every state transition, matching
 *     foreign-supervision.ts's own doc comment ("H12; claim time seeds it").
 *
 * KNOWN V1 LIMITATION (documented, not silently swept under): there is no
 * periodic session-ACTIVITY heartbeat yet, so H12's TTL measures "time since
 * last state transition", not continuous liveness. This is an acceptable v1
 * because a wind-down here is SOFT (state -> 'winding-down', a grace drain;
 * the mechanical kill is P-105's sandbox tier, deferred/on-hold per the
 * P-201 owner decision) and H13 (origin presence) is the tighter practical
 * signal in the common case. A real heartbeat (e.g. bumped by the
 * foreign-git-sync commit lane observing activity) is a legitimate
 * fast-follow, not a blocker for landing the sweep — file it separately if
 * wanted.
 */
import { getOrgPg } from '@papercusp/db-org';
import { queryFederatedPresenceRows } from '../agent-tools/coordination/federated-presence';
import type { OrgSql } from '../work-items';
import type { SupervisionDeps } from './foreign-supervision';
import type { ForeignWorkspace } from './foreign-workspaces';
import { getWorkOffer } from './offer-store';

export interface ProductionSupervisionDepsOpts {
  workspaceId: string;
  /** The hive HOME slug (= `superviseForeignSessions`' own `potSlug` arg) —
   *  scopes both the offer lookup (harness_slug) and the presence query
   *  (potSlug). */
  potHomeSlug: string;
  /** Test/multi-peer seam — defaults to the process-global org PG. */
  sql?: OrgSql;
}

/** H12 production liveness read for one foreign workspace row. */
export function productionLivenessInput(
  opts: ProductionSupervisionDepsOpts,
): SupervisionDeps['livenessInput'] {
  return async (w: ForeignWorkspace) => {
    const sql = opts.sql ?? getOrgPg().sql;
    const offer = await getWorkOffer(opts.workspaceId, opts.potHomeSlug, w.originGithubUserId, w.offerId, sql);
    return {
      // A vanished offer record (e.g. purged by the publisher) is treated the
      // same as an explicit cancel — there is nothing left to confirm
      // liveness against, and H12's cancel branch already carries the
      // "excused breach" receipt semantics that fit a clean withdrawal.
      cancelSignalSeen: offer == null || offer.status === 'cancelled',
      lastConfirmedAt: w.updatedAt,
    };
  };
}

/** H13 production origin-presence read — one instance serves every offer in
 *  a sweep (not per-workspace-row scoped). */
export function productionOriginLastSeenAt(
  opts: ProductionSupervisionDepsOpts,
): SupervisionDeps['originLastSeenAt'] {
  return async (originGithubUserId: number) => {
    const sql = opts.sql ?? getOrgPg().sql;
    // postgres-js's Sql<{}> call-signature doesn't structurally match the
    // generic tagged-template shape queryFederatedPresenceRows declares —
    // the SAME mismatch its other production caller (listFederatedPresence,
    // federated-presence.ts) already casts around.
    const rows = await queryFederatedPresenceRows(sql as never, {
      workspaceId: opts.workspaceId,
      potSlug: opts.potHomeSlug,
    });
    let latest: number | null = null;
    for (const r of rows) {
      if (r.github_user_id !== originGithubUserId) continue;
      if (latest == null || r.last_seen_ms > latest) latest = r.last_seen_ms;
    }
    return latest;
  };
}

/** Full production SupervisionDeps for one hive — pass straight to
 *  `superviseForeignSessions` (the store defaults cover
 *  listForeignWorkspaces/setForeignWorkspaceState/emitP2pReceipt). */
export function buildProductionSupervisionDeps(opts: ProductionSupervisionDepsOpts): SupervisionDeps {
  return {
    livenessInput: productionLivenessInput(opts),
    originLastSeenAt: productionOriginLastSeenAt(opts),
  };
}
