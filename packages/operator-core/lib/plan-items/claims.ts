/**
 * plan-item claim store — the live, mutually-exclusive, heartbeat-LEASED grip.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 1, D-001..D-004).
 *
 * Low-level lease mechanics ONLY (acquire / heartbeat / release), mirroring the
 * su-lock-store agent_file_locks pattern: a `claim_id` uuid, a TTL'd `expires_ts`,
 * owner-checked heartbeat + release. Mutual exclusion is the PK (one holder per
 * item). Every op routes through the claim AUTHORITY (authority.ts) — local on a
 * single box, an RPC to the authority peer once Track B lands.
 *
 * POLICY (who may claim an assigned vs pooled item; work-group gating) lives one
 * layer up in liveness.ts (`claimPlanItem`). Liveness MODE (availability vs
 * activity) is set at acquire and changes only WHAT renews the lease in
 * `heartbeatClaim`. A lapsed claim is simply one whose `expires_ts <= now()`:
 * `acquireClaim` steals it (so the item returns to its assignee / the pool, D-004);
 * nothing is "moved" on lapse — the durable assignment (assignments.ts) is the
 * anchor a re-claim resolves against.
 *
 * NOT federated. NO RLS (coord-family); org handle + workspace_id filter.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../workspace-id-constant';
import { getClaimAuthority } from './claim-authority';
import { notifyAgentOrdersChanged } from '../agent-orders-notify';
import { clearGoalClaimedIfMatches } from '../agent-state-stamp';
import { planItemRef } from '../agent-goal-ref';
import { SESSION_END_MARKER } from '../agent-tools/activity/lifecycle-markers';
import { LIVE_TURN_WINDOW_MS } from '../agent-tools/coordination/presence-wakeability';

export type LivenessMode = 'availability' | 'activity';
export type HeartbeatKind = 'activity' | 'extend' | 'keepalive';

export interface PlanItemClaim {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  claimId: string;
  owner: string;
  ownerLabel: string | null;
  ownerName: string | null;
  intent: string;
  livenessMode: LivenessMode;
  ttlSec: number;
  acquiredTs: string;
  expiresTs: string;
  lastActivityTs: string;
  /** Derived: the lease has lapsed (reclaimable) as of the read. */
  expired: boolean;
}

export interface AcquireOpts {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  owner: string;
  ownerLabel?: string | null;
  ownerName?: string | null;
  intent?: string;
  livenessMode?: LivenessMode;
  ttlSec?: number;
}

export type AcquireResult =
  | { ok: true; claim: PlanItemClaim }
  | {
      ok: false;
      conflict: PlanItemClaim;
      /** EI-8997: the steal was refused because the EXPIRED incumbent shows fresh
       *  tool activity — its lease was auto-renewed; do NOT treat it as reclaimable. */
      reason?: 'holder-active-lease-renewed';
    };

export const DEFAULT_AVAILABILITY_TTL_SEC = 1200; // 20m — LOCAL, session keeps it alive
export const DEFAULT_ACTIVITY_TTL_SEC = 1800; // 30m — SHARED, generous; renewed by a completed turn
export const MAX_TTL_SEC = 7200; // 2h hard cap (an explicit extend for a long op)

/**
 * EI-8997 (lapse = holder DEAD, not holder BUSY): before an acquire STEALS an
 * expired claim — and before the GC sweep deletes one — the incumbent gets this
 * activity grace: a holder with a recorded tool call (harness_shared.agent_activity,
 * the per-tool-call PostToolUse bridge) within the window is BUSY, not dead. The two
 * real lapse-while-working shapes this closes: (a) ONE long turn outlasting the TTL
 * (renewals fire per activity event, but the bus consumer throttles/misses), and
 * (b) the renewal CONSUMER being down — it runs only on the bg-host, so bg-host
 * churn used to lapse every busy holder's claim fleet-wide (the 2026-07-10 WI-1729
 * incident). On refusal the incumbent's lease AUTO-RENEWS (self-healing), so a
 * lapsed-but-alive claim can no longer invite the double-placement the claim system
 * exists to prevent. Env-tunable; capped at 1h.
 */
const rawLapseGrace = Number(process.env.PAPERCUSP_CLAIM_LAPSE_ACTIVITY_GRACE_SEC ?? 600);
export const CLAIM_LAPSE_ACTIVITY_GRACE_SEC =
  Number.isFinite(rawLapseGrace) && rawLapseGrace >= 0 ? Math.min(Math.floor(rawLapseGrace), 3600) : 600;

/**
 * The authority-RPC op kinds for the mutating claim ops (D-002). A claim op
 * routed to a REMOTE authority carries one of these `kind`s + a serialisable payload
 * over the peer-RPC transport; the authority re-runs the matching `*Local` fn against
 * ITS store (registered via plan-item-claim-authority-ops.ts). Distinct from
 * su-584a8's `lock.*` kinds — registerAuthorityOp throws on a duplicate kind.
 */
export const PLAN_ITEM_CLAIM_OP_KINDS = {
  acquire: 'plan-item.claim.acquire',
  heartbeat: 'plan-item.claim.heartbeat',
  release: 'plan-item.claim.release',
  forceRelease: 'plan-item.claim.force-release',
  forceTakeover: 'plan-item.claim.force-takeover',
} as const;

/**
 * Acquire the live claim on a plan item. Atomically takes a FREE item, STEALS an
 * expired (lapsed) claim, or extends the caller's OWN claim; refuses (ok:false) if
 * a live claim is held by another owner. Routed through the claim authority: runs
 * `acquireClaimLocal` here when we are the authority (single box → always), else
 * RPCs the authority peer (which runs `acquireClaimLocal` on its store), else fails
 * open to a local advisory lease (D-004).
 */
export async function acquireClaim(opts: AcquireOpts): Promise<AcquireResult> {
  return getClaimAuthority().route(opts.harnessSlug, {
    local: () => acquireClaimLocal(opts),
    remote: { kind: PLAN_ITEM_CLAIM_OP_KINDS.acquire, payload: opts, decode: (raw) => raw as AcquireResult },
  });
}

/**
 * The LOCAL (un-routed) execution of acquire — the raw SQL against THIS peer's PG.
 * Exported so the authority-op registry can run it on the authority's store on a
 * remote peer's behalf (the receiving side of the RPC); normal callers use
 * `acquireClaim`, which adds authority routing on top.
 */
export async function acquireClaimLocal(opts: AcquireOpts): Promise<AcquireResult> {
  const mode: LivenessMode = opts.livenessMode ?? 'availability';
  const ttlSec = clampTtl(opts.ttlSec ?? (mode === 'activity' ? DEFAULT_ACTIVITY_TTL_SEC : DEFAULT_AVAILABILITY_TTL_SEC));
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, owner_label, owner_name,
       intent, liveness_mode, ttl_sec, acquired_ts, expires_ts, last_activity_ts)
    VALUES
      (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.planSlug}, ${opts.itemId},
       ${opts.owner}, ${opts.ownerLabel ?? null}, ${opts.ownerName ?? null},
       ${opts.intent ?? ''}, ${mode}, ${ttlSec}, clock_timestamp(),
       clock_timestamp() + make_interval(secs => ${ttlSec}), clock_timestamp())
    ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO UPDATE SET
      claim_id         = gen_random_uuid(),
      owner            = EXCLUDED.owner,
      owner_label      = EXCLUDED.owner_label,
      owner_name       = EXCLUDED.owner_name,
      intent           = EXCLUDED.intent,
      liveness_mode    = EXCLUDED.liveness_mode,
      ttl_sec          = EXCLUDED.ttl_sec,
      acquired_ts      = clock_timestamp(),
      expires_ts       = clock_timestamp() + make_interval(secs => ${ttlSec}),
      last_activity_ts = clock_timestamp()
    WHERE harness_shared.plan_item_claims.owner = EXCLUDED.owner
       -- EI-8997: steal an EXPIRED claim only when its holder has been quiet past the
       -- activity grace. A lapsed-but-ACTIVE holder is busy, not dead (one long turn
       -- outlasting the TTL / the bg-host renewal consumer down) — the held-branch
       -- below auto-renews its lease instead of handing the item to a second agent.
       OR (harness_shared.plan_item_claims.expires_ts <= clock_timestamp()
           AND NOT EXISTS (
             SELECT 1 FROM harness_shared.agent_activity aa
              WHERE aa.owner_id = harness_shared.plan_item_claims.owner
                AND aa.created_at > clock_timestamp() - make_interval(secs => ${CLAIM_LAPSE_ACTIVITY_GRACE_SEC})))
    RETURNING workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
           owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
  `;
  if (rows[0]) {
    // WI-6974: a claim ACQUIRED/STOLEN/re-taken changes this owner's declared lane,
    // which the Orders panel renders. Pushed HERE and not from a plan_item_claims row
    // trigger, because `renewOwnerActivityClaims` rewrites `last_activity_ts` on EVERY
    // TURN of every claim-holding owner — a trigger cannot tell that heartbeat from a
    // real lane change, so it would push the panel on a timer.
    await notifyAgentOrdersChanged(opts.owner);
    return { ok: true, claim: claimFromDb(rows[0]) };
  }
  // Conflict update skipped → a LIVE claim held by another owner. Report it.
  // Use SELECT FOR UPDATE to lock the row during check to prevent concurrent claims
  // on a freed item (race condition: two agents both get null from getClaim(), then both
  // execute INSERT). The lock ensures only one agent can proceed if the row was just released.
  const held = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
           owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
      FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harnessSlug}
       AND plan_slug = ${opts.planSlug} AND item_id = ${opts.itemId}
      FOR UPDATE
  `;
  if (held[0]) {
    const conflict = claimFromDb(held[0]);
    // EI-8997: the steal above was REFUSED for an expired claim because its holder
    // shows fresh tool activity (busy, not dead). Auto-renew the incumbent's lease
    // here — self-healing, so the next reader sees a LIVE claim — and report the
    // refusal with a reason instead of a phantom "held by another owner". The UPDATE
    // re-checks claim_id + owner + expired + fresh-activity, so a holder that went
    // quiet between the two statements is NOT resurrected (the caller just retries).
    if (conflict.expired) {
      const renewed = await sql<ClaimDbRow[]>`
        UPDATE harness_shared.plan_item_claims
           SET expires_ts = clock_timestamp() + make_interval(secs => ttl_sec)
         WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harnessSlug}
           AND plan_slug = ${opts.planSlug} AND item_id = ${opts.itemId}
           AND claim_id = ${conflict.claimId}::uuid AND owner = ${conflict.owner}
           AND expires_ts <= clock_timestamp()
           AND EXISTS (
             SELECT 1 FROM harness_shared.agent_activity aa
              WHERE aa.owner_id = ${conflict.owner}
                AND aa.created_at > clock_timestamp() - make_interval(secs => ${CLAIM_LAPSE_ACTIVITY_GRACE_SEC}))
        RETURNING workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
               owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
               last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
      `;
      if (renewed[0]) {
        return { ok: false, conflict: claimFromDb(renewed[0]), reason: 'holder-active-lease-renewed' };
      }
    }
    return { ok: false, conflict };
  }
  // Lost a race (the holder released between INSERT and SELECT) — retry once.
  const retry = await sql<ClaimDbRow[]>`
    INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, owner_label, owner_name,
       intent, liveness_mode, ttl_sec, acquired_ts, expires_ts, last_activity_ts)
    VALUES
      (${opts.workspaceId}, ${opts.harnessSlug}, ${opts.planSlug}, ${opts.itemId},
       ${opts.owner}, ${opts.ownerLabel ?? null}, ${opts.ownerName ?? null},
       ${opts.intent ?? ''}, ${mode}, ${ttlSec}, clock_timestamp(),
       clock_timestamp() + make_interval(secs => ${ttlSec}), clock_timestamp())
    ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO NOTHING
    RETURNING workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
           owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
  `;
  if (retry[0]) {
    await notifyAgentOrdersChanged(opts.owner); // WI-6974 — same lane change, won on the retry.
    return { ok: true, claim: claimFromDb(retry[0]) };
  }
  const after = await getClaim(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.itemId);
  return after ? { ok: false, conflict: after } : { ok: false, conflict: synthMissing(opts) };
}

export interface HeartbeatResult {
  /** The lease was renewed (expires_ts pushed out). */
  renewed: boolean;
  /** The claim is still held by the caller (even if not renewed — e.g. activity-mode keepalive). */
  held: boolean;
  expiresTs: string | null;
  reason?: string;
}

/** Serialisable heartbeat params — the payload an authority RPC carries (D-002). */
export interface HeartbeatClaimParams {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  claimId: string;
  owner: string;
  kind?: HeartbeatKind;
  ttlSecOverride?: number;
}

/**
 * Renew the lease. The MODE governs what renews it (D-003): availability renews on
 * ANY heartbeat (the session proving it is alive); activity renews ONLY on an
 * activity (a completed turn) or an explicit extend — a bare keepalive does NOT, so
 * an idle SHARED claim ages toward lapse. Owner + claim_id + not-yet-expired are
 * required (a lapsed claim must be re-acquired, not heartbeated back to life).
 * Routed through the claim authority (runs `heartbeatClaimLocal` at the authority).
 */
export async function heartbeatClaim(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
  claimId: string,
  owner: string,
  kind: HeartbeatKind = 'activity',
  ttlSecOverride?: number,
): Promise<HeartbeatResult> {
  const p: HeartbeatClaimParams = { workspaceId, harnessSlug, planSlug, itemId, claimId, owner, kind, ttlSecOverride };
  return getClaimAuthority().route(harnessSlug, {
    local: () => heartbeatClaimLocal(p),
    remote: { kind: PLAN_ITEM_CLAIM_OP_KINDS.heartbeat, payload: p, decode: (raw) => raw as HeartbeatResult },
  });
}

/** The LOCAL (un-routed) heartbeat — raw SQL against THIS peer's PG. See `acquireClaimLocal`. */
export async function heartbeatClaimLocal(p: HeartbeatClaimParams): Promise<HeartbeatResult> {
  const { workspaceId, harnessSlug, planSlug, itemId, claimId, owner, ttlSecOverride } = p;
  const kind: HeartbeatKind = p.kind ?? 'activity';
  const isActivity = kind === 'activity' || kind === 'extend';
  const { sql } = getOrgPg();
  const rows = await sql<{ expires_ts: string }[]>`
    UPDATE harness_shared.plan_item_claims
       SET ttl_sec = ${ttlSecOverride != null ? clampTtl(ttlSecOverride) : sql`ttl_sec`},
           expires_ts = clock_timestamp() + make_interval(secs => ${ttlSecOverride != null ? clampTtl(ttlSecOverride) : sql`ttl_sec`}),
           last_activity_ts = CASE WHEN ${isActivity} THEN clock_timestamp() ELSE last_activity_ts END
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND item_id = ${itemId}
       AND claim_id = ${claimId}::uuid AND owner = ${owner}
       AND expires_ts > clock_timestamp()
       AND (liveness_mode = 'availability' OR ${isActivity})
    RETURNING expires_ts
  `;
  if (rows[0]) return { renewed: true, held: true, expiresTs: rows[0].expires_ts };
  // Not renewed — distinguish "still held, activity-mode keepalive (no-op)" from "gone".
  const held = await getClaim(workspaceId, harnessSlug, planSlug, itemId);
  if (held && held.claimId === claimId && held.owner === owner && !held.expired) {
    return {
      renewed: false,
      held: true,
      expiresTs: held.expiresTs,
      reason: 'activity-mode claim not renewed by a keepalive — send an activity/extend heartbeat',
    };
  }
  // A lapsed row still physically exists (acquire steals lazily) — report it
  // as lapsed, not as "held by another owner", so the caller re-acquires
  // instead of chasing a phantom holder.
  const isOwnLapsed = held != null && held.claimId === claimId && held.owner === owner && held.expired;
  return {
    renewed: false,
    held: false,
    expiresTs: null,
    reason:
      held && !isOwnLapsed
        ? 'claim is held by another owner or under a new claim_id'
        : 'claim has lapsed or was released — re-acquire it',
  };
}

/** Serialisable release params — the payload an authority RPC carries (D-002). */
export interface ReleaseClaimParams {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  itemId: string;
  claimId: string;
  owner: string;
}

/**
 * A checked force-release still carries the exact claim identity that the caller
 * proved reclaimable. The authority must match BOTH claim_id and owner; a later
 * holder cannot be deleted if the row changed between the liveness read and this
 * mutation (EI-21618203307569668).
 */
export type ForceReleaseClaimParams = ReleaseClaimParams;

/**
 * A checked force-takeover replaces exactly one previously-read holder. This is
 * deliberately separate from acquireClaim: force authorization belongs at the
 * tool/policy layer, while this low-level op only provides the authority-routed
 * exact CAS mutation.
 */
export interface ForceTakeoverClaimParams extends AcquireOpts {
  expectedClaimId: string;
  expectedOwner: string;
}

/** Release the caller's claim. Owner + claim_id checked. Returns whether a row was freed.
 *  Routed through the claim authority (runs `releaseClaimLocal` at the authority). */
export async function releaseClaim(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
  claimId: string,
  owner: string,
): Promise<boolean> {
  const p: ReleaseClaimParams = { workspaceId, harnessSlug, planSlug, itemId, claimId, owner };
  return getClaimAuthority().route(harnessSlug, {
    local: () => releaseClaimLocal(p),
    remote: { kind: PLAN_ITEM_CLAIM_OP_KINDS.release, payload: p, decode: (raw) => raw as boolean },
  });
}

/** The LOCAL (un-routed) release — raw SQL against THIS peer's PG. See `acquireClaimLocal`. */
export async function releaseClaimLocal(p: ReleaseClaimParams): Promise<boolean> {
  return deleteClaimLocal(p);
}

/**
 * Force-release the exact claim the caller's policy guard inspected. The SQL is
 * intentionally the same owner+claim_id CAS as ordinary release; the distinct
 * routed verb makes the audited override explicit and prevents callers from
 * treating a foreign-holder release as a normal voluntary release.
 */
export async function forceReleaseClaim(p: ForceReleaseClaimParams): Promise<boolean> {
  return getClaimAuthority().route(p.harnessSlug, {
    local: () => forceReleaseClaimLocal(p),
    remote: {
      kind: PLAN_ITEM_CLAIM_OP_KINDS.forceRelease,
      payload: p,
      decode: (raw) => raw as boolean,
    },
  });
}

/** The LOCAL exact-CAS force release against THIS peer's claim store. */
export async function forceReleaseClaimLocal(p: ForceReleaseClaimParams): Promise<boolean> {
  return deleteClaimLocal(p);
}

async function deleteClaimLocal(p: ReleaseClaimParams): Promise<boolean> {
  const { workspaceId, harnessSlug, planSlug, itemId, claimId, owner } = p;
  const { sql } = getOrgPg();
  const rows = await sql<{ item_id: string }[]>`
    DELETE FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND item_id = ${itemId}
       AND claim_id = ${claimId}::uuid AND owner = ${owner}
    RETURNING item_id
  `;
  // WI-6974: a RELEASE empties the lane the Orders panel shows. Only on a real
  // delete — a no-op release (wrong claim_id / already gone) wrote nothing.
  if (rows.length > 0) {
    const ref = planItemRef(planSlug, itemId);
    if (ref) clearGoalClaimedIfMatches(owner, ref);
    await notifyAgentOrdersChanged(owner);
  }
  return rows.length > 0;
}

/**
 * Replace a foreign holder after a checked force decision. This is a single
 * UPDATE keyed by the previously observed claim_id + owner, so a holder change
 * between the guard read and this write fails closed instead of stealing the
 * successor's newer claim.
 */
export async function forceTakeoverClaim(opts: ForceTakeoverClaimParams): Promise<AcquireResult> {
  return getClaimAuthority().route(opts.harnessSlug, {
    local: () => forceTakeoverClaimLocal(opts),
    remote: {
      kind: PLAN_ITEM_CLAIM_OP_KINDS.forceTakeover,
      payload: opts,
      decode: (raw) => raw as AcquireResult,
    },
  });
}

/** The LOCAL exact-CAS force takeover against THIS peer's claim store. */
export async function forceTakeoverClaimLocal(opts: ForceTakeoverClaimParams): Promise<AcquireResult> {
  const mode: LivenessMode = opts.livenessMode ?? 'availability';
  const ttlSec = clampTtl(
    opts.ttlSec ?? (mode === 'activity' ? DEFAULT_ACTIVITY_TTL_SEC : DEFAULT_AVAILABILITY_TTL_SEC),
  );
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    UPDATE harness_shared.plan_item_claims
       SET claim_id         = gen_random_uuid(),
           owner            = ${opts.owner},
           owner_label      = ${opts.ownerLabel ?? null},
           owner_name       = ${opts.ownerName ?? null},
           intent           = ${opts.intent ?? ''},
           liveness_mode    = ${mode},
           ttl_sec          = ${ttlSec},
           acquired_ts      = clock_timestamp(),
           expires_ts       = clock_timestamp() + make_interval(secs => ${ttlSec}),
           last_activity_ts = clock_timestamp()
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND plan_slug = ${opts.planSlug}
       AND item_id = ${opts.itemId}
       AND claim_id = ${opts.expectedClaimId}::uuid
       AND owner = ${opts.expectedOwner}
    RETURNING workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
           owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
           last_activity_ts, (expires_ts <= clock_timestamp()) AS expired
  `;
  if (rows[0]) {
    const ref = planItemRef(opts.planSlug, opts.itemId);
    if (ref && opts.expectedOwner !== opts.owner) {
      clearGoalClaimedIfMatches(opts.expectedOwner, ref);
    }
    if (opts.expectedOwner !== opts.owner) {
      await notifyAgentOrdersChanged(opts.expectedOwner);
    }
    await notifyAgentOrdersChanged(opts.owner);
    return { ok: true, claim: claimFromDb(rows[0]) };
  }

  // The exact CAS lost. Return the current holder as a normal claim conflict so
  // callers can distinguish a race from a successful takeover.
  const current = await getClaim(opts.workspaceId, opts.harnessSlug, opts.planSlug, opts.itemId);
  return current
    ? { ok: false, conflict: current }
    : {
        ok: false,
        conflict: synthMissing({
          workspaceId: opts.workspaceId,
          harnessSlug: opts.harnessSlug,
          planSlug: opts.planSlug,
          itemId: opts.itemId,
          owner: opts.owner,
          ownerLabel: opts.ownerLabel,
          ownerName: opts.ownerName,
          intent: opts.intent,
          livenessMode: mode,
          ttlSec,
        }),
      };
}

/** Release every claim held by a session owner (session-end cleanup). Returns count. */
export async function releaseAllClaimsForOwner(workspaceId: string, owner: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ plan_slug: string; item_id: string }[]>`
    DELETE FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId} AND owner = ${owner}
    RETURNING plan_slug, item_id
  `;
  if (rows.length > 0) {
    for (const row of rows) {
      const ref = planItemRef(row.plan_slug, row.item_id);
      if (ref) clearGoalClaimedIfMatches(owner, ref);
    }
    await notifyAgentOrdersChanged(owner); // WI-6974 — lane emptied.
  }
  return rows.length;
}

/**
 * Renew (push the lease out on) every NON-EXPIRED claim an owner holds — the D-003
 * per-turn auto-renewal driven by the activity bridge: an owner that is completing
 * turns (reporting activity) is alive + working, so its claims stay; an owner that
 * goes idle (no turns) lets them lapse so others can pull.
 *
 * BOTH liveness modes renew here (EI-295 residual, 2026-06-11): the original
 * activity-only filter assumed availability claims "renew on any heartbeat" — but no
 * heartbeat path existed, so every availability-mode lane claim (the declare-intent
 * default on this box, where the shared-resolver sees one human contributor) silently
 * lapsed ~20min into long turns while the agent kept working — the claim-discipline
 * watcher then nagged live agents, and the Queen's placement reads went empty. The
 * property that matters — lapse-on-IDLE — is preserved: an owner producing no turns
 * renews nothing either way. An ALREADY-EXPIRED claim is NOT resurrected
 * (`expires_ts > now()` guard — a lapsed claim must be re-acquired). The workspace
 * filter accepts the plan-store DEFAULT domain alongside the caller's workspace
 * (the same two-domain split EI-295 fixed in the assignments reader — claims are
 * keyed by the PLAN-STORE scope, activity by the AGENT workspace). We renew all of
 * the owner's claims rather than one item: owner ids are globally unique, so this
 * is exactly the owner's live working set. The latest `adv_sessions` row for the
 * owner is the session authority: a freshly opened row covers only the short
 * bootstrap window; an older open row requires recent native `tool`/`todos` activity
 * after that row's start (or after the latest exact session-end marker). An ended row
 * uses the same genuine post-end activity proof. Lifecycle and wake-only reports
 * therefore cannot keep a stale owner alive, and an owner with no session authority
 * fails closed. Returns the renewed item ids.
 *
 * Local (not authority-routed): on a single box the authority is self, so the renewal
 * runs on the same store the claim lives in. Cross-machine the renewal would route to
 * the authority alongside acquire/heartbeat — that whole live-mesh path is hardware-
 * gated (distributed-coordination-shared-harness-2026-06-04), so the local renewal is
 * correct for the testable single-box reality.
 */
export async function renewOwnerActivityClaims(workspaceId: string, owner: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const liveTurnWindowSec = Math.max(1, Math.round(LIVE_TURN_WINDOW_MS / 1000));
  const rows = await sql<{ item_id: string }[]>`
    UPDATE harness_shared.plan_item_claims
       SET expires_ts = clock_timestamp() + make_interval(secs => ttl_sec),
           last_activity_ts = clock_timestamp()
     WHERE (workspace_id = ${workspaceId} OR workspace_id = ${DEFAULT_WORKSPACE_ID})
       AND owner = ${owner}
       -- BOTH liveness modes renew here (EI-295 residual): no explicit
       -- availability-heartbeat path exists yet, so the per-turn renewal is
       -- the ONLY thing keeping a turn-active owner's availability lane from
       -- lapsing mid-session (activity-claim-renewal.integration.test.ts).
       AND expires_ts > clock_timestamp()
       -- EI-216473 / EI-22022750549019083: NOTIFY carries only owner_id, so
       -- lifecycle/wake-only reports from an ended session used to renew every
       -- claim the owner ever held. The newest adv_sessions row is authoritative.
       -- A newly opened row is trusted only during the short bootstrap window;
       -- an older open row (for example, one left open by a crash) needs recent
       -- native tool/todo activity after that row's start. An ended row uses the
       -- same genuine post-end activity proof. No session row is fail-closed.
       AND EXISTS (
         SELECT 1
           FROM (
             SELECT started_at, ended_at
               FROM harness_shared.adv_sessions
              WHERE coord_owner_id = ${owner}
              ORDER BY started_at DESC, id DESC
              LIMIT 1
            ) AS latest_session
          WHERE (
            latest_session.ended_at IS NULL
            AND (
              latest_session.started_at > clock_timestamp() - make_interval(secs => ${liveTurnWindowSec})
              OR EXISTS (
                SELECT 1
                  FROM harness_shared.agent_activity AS resumed
                 WHERE resumed.owner_id = ${owner}
                   AND resumed.kind IN ('tool', 'todos')
                   AND resumed.created_at > clock_timestamp() - make_interval(secs => ${liveTurnWindowSec})
                   AND resumed.created_at > GREATEST(
                     latest_session.started_at,
                     COALESCE(
                       (
                         SELECT max(end_marker.created_at)
                           FROM harness_shared.agent_activity AS end_marker
                          WHERE end_marker.owner_id = ${owner}
                            AND end_marker.kind = 'lifecycle'
                            AND end_marker.summary = ${SESSION_END_MARKER}
                       ),
                       latest_session.started_at
                     )
                   )
              )
            )
          )
          OR (
            latest_session.ended_at IS NOT NULL
            AND EXISTS (
               SELECT 1
                 FROM harness_shared.agent_activity AS resumed
                WHERE resumed.owner_id = ${owner}
                  AND resumed.kind IN ('tool', 'todos')
                  AND resumed.created_at > clock_timestamp() - make_interval(secs => ${liveTurnWindowSec})
                  AND resumed.created_at > COALESCE(
                    (
                      SELECT max(end_marker.created_at)
                        FROM harness_shared.agent_activity AS end_marker
                       WHERE end_marker.owner_id = ${owner}
                         AND end_marker.kind = 'lifecycle'
                         AND end_marker.summary = ${SESSION_END_MARKER}
                    ),
                    latest_session.ended_at
                  )
             )
          )
       )
    RETURNING item_id
  `;
  return rows.map((r) => r.item_id);
}

/**
 * EI-383: extend an owner's currently-HELD (non-expired) claims' `expires_ts` to
 * survive a genuine push-wake sleep (`events:await` + END TURN), where NO turn
 * runs — and therefore no activity-bus event fires `renewOwnerActivityClaims` —
 * until the wake. Without this, a claim held while correctly parked (the designed
 * push-not-poll pattern) lapses mid-sleep: claim-discipline nags a live-but-asleep
 * agent, `fleet:assignments` shows the lane as unclaimed (the exact double-
 * placement window claims exist to prevent), and the agent burns a wake re-
 * claiming it.
 *
 * Sizes the extension to `targetTtlSec` (typically the await's `timeout_sec`) but
 * NEVER beyond `MAX_TTL_SEC` — the same 2h hard cap every other lease respects
 * (`clampTtl`), so this does not weaken dead-holder detection: a holder that goes
 * silent (crashes, never re-invokes on the wake) is still reclaimable within the
 * existing ceiling. It also never SHRINKS an existing longer expiry (`GREATEST`),
 * and — mirroring `renewOwnerActivityClaims` — an already-EXPIRED claim is not
 * resurrected (`expires_ts > now()` guard): only a still-live claim survives the
 * sleep, so a claim that lapsed before the await was registered must be re-
 * acquired as before. Only `expires_ts` moves; `ttl_sec` is left untouched so the
 * claim's normal per-turn renewal cadence resumes unchanged once the wake fires
 * and activity-bus renewals resume. Best-effort by design: callers must never let
 * a failure here block the await registration itself.
 */
export async function extendOwnerClaimsForAwait(
  workspaceId: string,
  owner: string,
  targetTtlSec: number,
): Promise<string[]> {
  const capped = clampTtl(targetTtlSec);
  const { sql } = getOrgPg();
  const rows = await sql<{ item_id: string }[]>`
    UPDATE harness_shared.plan_item_claims
       SET expires_ts = GREATEST(expires_ts, clock_timestamp() + make_interval(secs => ${capped}))
     WHERE (workspace_id = ${workspaceId} OR workspace_id = ${DEFAULT_WORKSPACE_ID})
       AND owner = ${owner}
       AND expires_ts > clock_timestamp()
    RETURNING item_id
  `;
  return rows.map((r) => r.item_id);
}

/** The current claim on an item (with derived `expired`), or null. */
export async function getClaim(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  itemId: string,
): Promise<PlanItemClaim | null> {
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
             owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
             last_activity_ts, (expires_ts <= clock_timestamp()) AS expired FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND item_id = ${itemId}
  `;
  return rows[0] ? claimFromDb(rows[0]) : null;
}

/** All claims for a plan (with derived `expired`), for the merged view. */
export async function listClaimsForPlan(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<PlanItemClaim[]> {
  const { sql } = getOrgPg();
  const rows = await sql<ClaimDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, item_id, claim_id, owner,
             owner_label, owner_name, intent, liveness_mode, ttl_sec, acquired_ts, expires_ts,
             last_activity_ts, (expires_ts <= clock_timestamp()) AS expired FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}
     ORDER BY item_id
  `;
  return rows.map(claimFromDb);
}

/** Delete lapsed claims (a GC convenience — acquire already steals them lazily). Returns count.
 *  EI-8997: a lapsed claim whose holder shows fresh tool activity is BUSY, not dead —
 *  the sweep skips it (same grace as the acquire steal-guard), so a GC pass can never
 *  free a live holder's item out from under a long turn. */
export async function sweepLapsedClaims(workspaceId: string, harnessSlug?: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ item_id: string }[]>`
    DELETE FROM harness_shared.plan_item_claims
     WHERE workspace_id = ${workspaceId}
       AND ${harnessSlug ? sql`harness_slug = ${harnessSlug}` : sql`TRUE`}
       AND expires_ts <= clock_timestamp()
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.agent_activity aa
          WHERE aa.owner_id = harness_shared.plan_item_claims.owner
            AND aa.created_at > clock_timestamp() - make_interval(secs => ${CLAIM_LAPSE_ACTIVITY_GRACE_SEC}))
    RETURNING item_id
  `;
  return rows.length;
}

function clampTtl(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AVAILABILITY_TTL_SEC;
  return Math.min(Math.floor(n), MAX_TTL_SEC);
}

interface ClaimDbRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  item_id: string;
  claim_id: string;
  owner: string;
  owner_label: string | null;
  owner_name: string | null;
  intent: string;
  liveness_mode: string;
  ttl_sec: number;
  acquired_ts: string;
  expires_ts: string;
  last_activity_ts: string;
  expired: boolean;
}
function claimFromDb(r: ClaimDbRow): PlanItemClaim {
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    itemId: r.item_id,
    claimId: r.claim_id,
    owner: r.owner,
    ownerLabel: r.owner_label,
    ownerName: r.owner_name,
    intent: r.intent,
    livenessMode: (r.liveness_mode as LivenessMode) ?? 'availability',
    ttlSec: Number(r.ttl_sec),
    acquiredTs: r.acquired_ts,
    expiresTs: r.expires_ts,
    lastActivityTs: r.last_activity_ts,
    expired: Boolean(r.expired),
  };
}
function synthMissing(opts: AcquireOpts): PlanItemClaim {
  const now = new Date().toISOString();
  return {
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    planSlug: opts.planSlug,
    itemId: opts.itemId,
    claimId: '00000000-0000-0000-0000-000000000000',
    owner: 'unknown',
    ownerLabel: null,
    ownerName: null,
    intent: '',
    livenessMode: 'availability',
    ttlSec: 0,
    acquiredTs: now,
    expiresTs: now,
    lastActivityTs: now,
    expired: true,
  };
}
