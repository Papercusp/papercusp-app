/**
 * `system:p2p-foreign-supervision` — P-407 (plan
 * p2p-public-release-remaining-lanes-2026-07-16, split from P-406 per D-004):
 * schedules `superviseForeignSessions` (p2p/foreign-supervision.ts, P-104's
 * H12/H13 liveness + orphan-origin wind-down) against production data via
 * `buildProductionSupervisionDeps` (p2p/foreign-supervision-production.ts).
 * Mirrors sweep-orphaned-foreign-harnesses-action.ts / foreign-git-sync-action.ts
 * (registered system action + upsertRoutine,
 * repo rule: no bare setInterval, no new scheduler).
 *
 * Distinct from `system:sweep-orphaned-foreign-harnesses` (registry-row
 * cleanup only — see that file's own doc comment) and from
 * `system:foreign-git-sync` (the commit lane) — this is the liveness/orphan
 * SUPERVISION sweep foreign-supervision.ts's own module doc named as the
 * remaining gap.
 *
 * HOST IDENTITY: `responderGithubUserId` /
 * `responderDevicePubkey` are the identity THIS host wound-down receipts are
 * attributed to. That is an OWNER-CONFIGURED value (which github user id /
 * device this host authenticates as) with no seam to discover on its own —
 * inventing one would silently diverge from (or silently coincide by
 * accident with) whatever an owner sets up elsewhere. Read from the routine's
 * `triggerConfig`; missing/malformed config is a LOUD no-op, never a
 * fabricated identity.
 *
 * SEEDING: `ensureP2pForeignSupervisionRoutine` is called at boot by
 * p2p/ensure-host-routines.ts (WI-5327), which resolves this host's identity
 * from existing seams — it needs only responderGithubUserId + the device
 * pubkey and therefore seeds on a packaged install. The previous "NOT YET
 * CALLED FROM ANYWHERE" note was stale from 2026-07-18 and was corrected under
 * WI-6680.
 */
import { getOrgPg, upsertRoutine, type RoutineRow } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { superviseForeignSessions } from '../../p2p/foreign-supervision';
import { buildProductionSupervisionDeps } from '../../p2p/foreign-supervision-production';
import { computeNextFireAt } from './cron';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const P2P_FOREIGN_SUPERVISION_ROUTINE_NAME = 'p2p-foreign-supervision';
export const P2P_FOREIGN_SUPERVISION_TARGET = 'system:p2p-foreign-supervision';
/** foreign-supervision.ts's own doc comment: "intervalSec ~60". */
export const DEFAULT_P2P_FOREIGN_SUPERVISION_CRON = '*/60 * * * * *';

/**
 * H12 default: no session-activity heartbeat exists yet (see
 * foreign-supervision-production.ts's module doc for the full rationale), so
 * this TTL effectively measures "time since the ForeignWorkspace row's last
 * state transition" — a coarse safety ceiling, not continuous liveness.
 * Generous on purpose: H13 (origin presence) is the tighter practical signal;
 * this exists so a session whose origin genuinely vanishes AND never
 * transitions state still eventually winds down. Override via
 * PAPERCUSP_FOREIGN_SUPERVISION_LIVENESS_TTL_MS.
 */
export const DEFAULT_FOREIGN_SUPERVISION_LIVENESS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * H13 default: how long an origin peer may go unseen (shared_presence) before
 * its foreign sessions are treated as orphaned. Generous relative to the
 * per-agent PRESENCE_STALE_MS (minutes) because a device-gossip gap of a few
 * minutes is routine (sleep/reconnect), not abandonment. Override via
 * PAPERCUSP_FOREIGN_SUPERVISION_ORPHAN_AFTER_MS.
 */
export const DEFAULT_FOREIGN_SUPERVISION_ORPHAN_AFTER_MS = 30 * 60 * 1000; // 30m

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ForeignSupervisionHostIdentity {
  responderGithubUserId: number;
  responderDevicePubkey?: string | null;
}

function readHostIdentity(cfg: Record<string, unknown>): ForeignSupervisionHostIdentity | null {
  const responderGithubUserId = cfg.responderGithubUserId;
  if (typeof responderGithubUserId !== 'number' || !Number.isFinite(responderGithubUserId)) return null;
  return {
    responderGithubUserId,
    responderDevicePubkey: typeof cfg.responderDevicePubkey === 'string' ? cfg.responderDevicePubkey : null,
  };
}

registerSystemAction(P2P_FOREIGN_SUPERVISION_ROUTINE_NAME, async (ctx: SystemActionCtx) => {
  const host = readHostIdentity(ctx.triggerConfig ?? {});
  if (!host) {
    // LOUD, not silent — see module doc: this routine cannot attribute a
    // wind-down receipt without knowing who it is, and never fabricates one.
    console.log(
      `[p2p-foreign-supervision] NO-OP: routine '${P2P_FOREIGN_SUPERVISION_ROUTINE_NAME}' triggerConfig is missing/malformed ` +
        `host identity (responderGithubUserId) — see foreign-supervision-action.ts module doc.`,
    );
    return;
  }

  const { potHomeSlugForHarness } = await import('../../hive-federation');
  const potHomeSlug = (await potHomeSlugForHarness(ctx.workspaceId, ctx.installSlug)) ?? ctx.installSlug;

  const deps = buildProductionSupervisionDeps({ workspaceId: ctx.workspaceId, potHomeSlug });
  const result = await superviseForeignSessions(
    {
      workspaceId: ctx.workspaceId,
      potSlug: potHomeSlug,
      responderGithubUserId: host.responderGithubUserId,
      responderDevicePubkey: host.responderDevicePubkey,
      now: Date.now(),
      livenessTtlMs: envMs('PAPERCUSP_FOREIGN_SUPERVISION_LIVENESS_TTL_MS', DEFAULT_FOREIGN_SUPERVISION_LIVENESS_TTL_MS),
      orphanAfterMs: envMs('PAPERCUSP_FOREIGN_SUPERVISION_ORPHAN_AFTER_MS', DEFAULT_FOREIGN_SUPERVISION_ORPHAN_AFTER_MS),
      actor: P2P_FOREIGN_SUPERVISION_TARGET,
    },
    deps,
  );

  if (!result.ok) {
    console.log(`[p2p-foreign-supervision] refused: ${result.refusal.code} — ${result.refusal.detail}`);
    return;
  }
  if (result.swept) {
    console.log(
      `[p2p-foreign-supervision] ${result.swept} supervised session(s) inspected, ` +
        `${result.woundDown.length} wound down (${result.receiptsEmitted} receipted, ${result.receiptFailures} receipt-failed)` +
        (result.woundDown.length ? `: ${result.woundDown.map((w) => `${w.offerId}(${w.cause})`).join(', ')}` : ''),
    );
  }
});

/**
 * Idempotent upsert of the workspace's foreign-supervision routine (active).
 * The host identity lives in `triggerConfig` — see module doc for why it is
 * not resolved any other way (mirrors ensureWorkIntakeRoutine exactly).
 */
export async function ensureP2pForeignSupervisionRoutine(
  input: { workspaceId: string; installSlug: string; host: ForeignSupervisionHostIdentity; cron?: string },
  sql: Sql = getOrgPg().sql,
): Promise<RoutineRow> {
  return upsertRoutine(
    sql,
    {
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
      name: P2P_FOREIGN_SUPERVISION_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: { cron: input.cron ?? DEFAULT_P2P_FOREIGN_SUPERVISION_CRON, ...input.host },
      targetRole: P2P_FOREIGN_SUPERVISION_TARGET,
      active: true,
    },
    computeNextFireAt,
  );
}
