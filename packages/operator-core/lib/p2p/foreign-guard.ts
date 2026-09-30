/**
 * p2p/foreign-guard.ts — leg (i) of P-109: the worktree-guard FOREIGN-WORKSPACE
 * POLICY (p2p-work-distribution-2026-07-02, design doc §2). Pure decision
 * logic over injected registry reads; the loopback route
 * (`endpoint-route/routes/su-locks/foreign-guard.ts`) wraps it and the
 * PreToolUse hook (`apps/operator/scripts/hooks/cc/pretooluse-locks-acquire.sh`)
 * enforces its verdicts on tool-mediated edits.
 *
 * TWO DIRECTIONAL POLICIES, both derived from the `p2p_foreign_workspaces`
 * REGISTRY — never from a local config flag (that is what "security-relevant
 * policy surface" means in the item text):
 *
 *   - HOST sessions: DENY edits under any registered foreign root. A host
 *     agent editing a foreign workspace is the C7 blending hazard inverted —
 *     host work would be swept by the foreign commit lane and attributed to
 *     the ORIGIN author. The deny names the offer id (M21) + bumps a P-004
 *     counter.
 *   - FOREIGN-marked sessions (spawn-injected env: PAPERCUSP_FOREIGN_OFFER_ID
 *     + PAPERCUSP_FOREIGN_SESSION_ID, minted by P-104 — NOT trusted alone):
 *     ALLOW ONLY paths under their own registered root_path, and only while
 *     the registry row is live (provisioning|active) AND its session_id
 *     matches the presented one. FAIL-CLOSED: no row / mismatch / wound-down
 *     state ⇒ the session edits NOTHING.
 *
 * HONESTY NOTE (X1 posture, verbatim from the design): PreToolUse hooks bind
 * tool-mediated edits of HONEST clients only — a hostile foreign shell
 * bypasses hooks entirely. The real boundary is P-105 (dedicated OS user,
 * netns, quota). This guard is the honest-path policy + the loud-receipt
 * source: defense-in-depth and UX, NOT containment.
 */
import { resolve, sep } from 'node:path';
import type { OrgSql } from '../work-items';
import {
  getForeignWorkspaceByOffer,
  listLiveForeignRoots,
  type ForeignRootEntry,
  type ForeignWorkspace,
} from './foreign-workspaces';

/** Is `child` inside (or equal to) `parent`, path-wise? */
function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

export interface ForeignGuardQuery {
  /** Absolute paths the edit touches. Empty = a pure roots refresh. */
  paths: string[];
  /** Foreign-marked session identity (spawn-injected env), if any. */
  offerId?: string | null;
  sessionId?: string | null;
}

export interface ForeignGuardSeams {
  getByOffer?: typeof getForeignWorkspaceByOffer;
  listRoots?: typeof listLiveForeignRoots;
  sql?: OrgSql;
}

export type ForeignGuardVerdict = {
  /** Live foreign roots — the hook caches these for its host-direction fast path. */
  roots: Array<Pick<ForeignRootEntry, 'offerId' | 'rootPath'>>;
} & (
  | { decision: 'allow' }
  | {
      decision: 'deny';
      /** Human/agent-facing reason (M21: names the offer id). */
      reason: string;
      /** Stable counter key (P-004). */
      refusalCode: string;
      /** For the counter's workspace/hive attribution (null = unattributable). */
      workspaceId: string | null;
      fleetSlug: string | null;
    }
);

/**
 * Evaluate the guard policy for one edit batch. Pure over the injected
 * registry reads; never throws on policy grounds (a thrown seam error is the
 * caller's fail-posture decision: the route 500s, the hook then fails CLOSED
 * for foreign sessions and open for host sessions).
 */
export async function evaluateForeignGuard(
  query: ForeignGuardQuery,
  seams: ForeignGuardSeams = {},
): Promise<ForeignGuardVerdict> {
  const listRoots = seams.listRoots ?? listLiveForeignRoots;
  const getByOffer = seams.getByOffer ?? getForeignWorkspaceByOffer;
  const roots = (await listRoots(seams.sql)).map((r) => ({
    offerId: r.offerId,
    rootPath: r.rootPath,
    workspaceId: r.workspaceId,
    fleetSlug: r.fleetSlug,
  }));
  const publicRoots = roots.map(({ offerId, rootPath }) => ({ offerId, rootPath }));

  if (query.offerId) {
    // ── FOREIGN-marked session: fail-closed allowlist of exactly one root ──
    const row: ForeignWorkspace | null = await getByOffer(query.offerId, seams.sql);
    const denyAll = (refusalCode: string, detail: string): ForeignGuardVerdict => ({
      decision: 'deny',
      reason: `foreign-work guard: refused — ${detail} (offer ${query.offerId}). A foreign-marked session edits nothing without a live registry row bound to it.`,
      refusalCode,
      workspaceId: row?.workspaceId ?? null,
      fleetSlug: row?.fleetSlug ?? null,
      roots: publicRoots,
    });
    if (!row) return denyAll('foreign_guard_no_registry_row', 'no registry row for this offer');
    if (!row.sessionId || row.sessionId !== (query.sessionId ?? null)) {
      return denyAll('foreign_guard_session_mismatch', 'session token does not match the registered session');
    }
    if (row.state !== 'provisioning' && row.state !== 'active') {
      return denyAll('foreign_guard_workspace_not_live', `workspace state is '${row.state}'`);
    }
    const offender = query.paths.find((p) => !isWithin(row.rootPath, p));
    if (offender !== undefined) {
      return {
        decision: 'deny',
        reason:
          `foreign-work guard: refused — '${offender}' is outside your registered foreign root ` +
          `'${row.rootPath}' (offer ${row.offerId}). A foreign session edits ONLY its own workspace.`,
        refusalCode: 'foreign_guard_outside_registered_root',
        workspaceId: row.workspaceId,
        fleetSlug: row.fleetSlug,
        roots: publicRoots,
      };
    }
    return { decision: 'allow', roots: publicRoots };
  }

  // ── HOST session: deny any edit under a registered foreign root ──
  for (const root of roots) {
    const hit = query.paths.find((p) => isWithin(root.rootPath, p));
    if (hit !== undefined) {
      return {
        decision: 'deny',
        reason:
          `foreign-work guard: refused — '${hit}' is inside the FOREIGN workspace of offer ` +
          `${root.offerId} (root ${root.rootPath}). Host agents never edit foreign workspaces: ` +
          `your work would be swept by the foreign commit lane and attributed to the ORIGIN ` +
          `author (C7). If this workspace is stale, reap it via the p2p surface instead.`,
        refusalCode: 'foreign_guard_host_edit_in_foreign_root',
        workspaceId: root.workspaceId,
        fleetSlug: root.fleetSlug,
        roots: publicRoots,
      };
    }
  }
  return { decision: 'allow', roots: publicRoots };
}
