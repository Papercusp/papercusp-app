/**
 * comms-trust — the per-user COMMS-TRUST tier store + resolution
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-011, D-003/D-004).
 *
 * user_trust_list's coordination twin: that list governs whether a verified
 * author's remote WORK may auto-run; this one governs what a hive member's
 * agents may do to YOUR agents across the federation boundary — the tier
 * lattice observe < message < wake < steer (see the mig-435 header). A wake is
 * a billable turn and a steer is your agents' autonomy, so the grant is the
 * OWNER's, per user, local, and never federated.
 *
 * Resolution order (effectiveCommsTier): non-expired LOCAL override →
 * owner-signed hive-policy default (hive_policy.comms.defaultTier, P-012) →
 * the conservative fallback ('message': deliver, never wake). Enforcement is
 * NOT here — P-013 wires it receiver-side at the projection chokepoint, keyed
 * on the VERIFIED author github_user_id (attestation chain), never envelope
 * fields. Everything workspace-scoped (D-004 — admin handle bypasses RLS).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export const COMMS_TIERS = ['observe', 'message', 'wake', 'steer'] as const;
export type CommsTier = (typeof COMMS_TIERS)[number];

const TIER_RANK: Record<CommsTier, number> = { observe: 0, message: 1, wake: 2, steer: 3 };

/** The conservative fallback when neither an override nor a policy default
 *  exists: deliver to inboxes, never re-invoke (spend) or steer. */
export const FALLBACK_COMMS_TIER: CommsTier = 'message';

export function isCommsTier(v: unknown): v is CommsTier {
  return typeof v === 'string' && (COMMS_TIERS as readonly string[]).includes(v);
}

/** Lattice comparison: does `have` grant at least `need`? */
export function commsTierAtLeast(have: CommsTier, need: CommsTier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need];
}

export interface CommsTrustEntry {
  githubUserId: number;
  /** The tier OVERRIDE, or null when the row exists only for other grants
   *  (e.g. gate) — a null tier never shadows the hive-policy default. */
  tier: CommsTier | null;
  /** DG-4 (P-047): do this member's distributed-test-gate verdicts count
   *  toward green(S)? Separable from the tier lattice; default false. */
  gate: boolean;
  note: string | null;
  /** epoch ms, null = no expiry. */
  expiresAtMs: number | null;
  createdTs: number;
  updatedTs: number;
}

function asId(raw: string | number): number {
  return typeof raw === 'string' ? Number(raw) : raw;
}

function assertGithubUserId(id: number, verb: string): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${verb} — githubUserId must be a positive integer (got ${id})`);
  }
}

interface CommsTrustRow {
  trusted_github_user_id: string | number;
  tier: string | null;
  gate?: boolean | null;
  note: string | null;
  expires_at: Date | string | null;
  created_ts: string | number;
  updated_ts: string | number;
}

function rowToEntry(r: CommsTrustRow): CommsTrustEntry {
  return {
    githubUserId: asId(r.trusted_github_user_id),
    // NULL / unrecognized ⇒ no tier override (the row may exist only for gate).
    tier: isCommsTier(r.tier) ? r.tier : null,
    gate: r.gate === true,
    note: r.note,
    expiresAtMs: r.expires_at == null ? null : new Date(r.expires_at).getTime(),
    createdTs: Number(r.created_ts),
    updatedTs: Number(r.updated_ts),
  };
}

/** The workspace's comms-trust overrides, newest-updated first. */
export async function listCommsTrust(workspaceId: string, sqlIn?: Sql): Promise<CommsTrustEntry[]> {
  if (!workspaceId) return [];
  const sql = sqlIn ?? getOrgPg().sql;
  const rows = await sql<CommsTrustRow[]>`
    SELECT trusted_github_user_id, tier, gate, note, expires_at, created_ts, updated_ts
      FROM harness_shared.comms_trust_list
     WHERE workspace_id = ${workspaceId}
     ORDER BY updated_ts DESC, trusted_github_user_id ASC`;
  return rows.map(rowToEntry);
}

export interface SetCommsTrustInput {
  githubUserId: number;
  tier: CommsTier;
  note?: string | null;
  /** epoch ms; omit/null = no expiry. */
  expiresAtMs?: number | null;
  /** Audit actor + timestamp, injected by the caller. */
  actor: string;
  nowMs: number;
}

/** Set (upsert) a user's comms tier. Idempotent; re-setting updates tier/note/
 *  expiry and preserves created_ts. Audited (a wake/steer grant is a spend/
 *  autonomy grant; an observe row is an explicit downgrade). */
export async function setCommsTrust(
  workspaceId: string,
  input: SetCommsTrustInput,
  sqlIn?: Sql,
): Promise<CommsTrustEntry> {
  if (!workspaceId) throw new Error('comms-trust set — no workspace');
  assertGithubUserId(input.githubUserId, 'comms-trust set');
  if (!isCommsTier(input.tier)) throw new Error(`comms-trust set — invalid tier ${String(input.tier)}`);
  const sql = sqlIn ?? getOrgPg().sql;
  const expires = input.expiresAtMs == null ? null : new Date(input.expiresAtMs);
  const [row] = await sql<CommsTrustRow[]>`
    INSERT INTO harness_shared.comms_trust_list
      (workspace_id, trusted_github_user_id, tier, note, expires_at, created_ts, updated_ts)
    VALUES (${workspaceId}, ${input.githubUserId}, ${input.tier}, ${input.note ?? null},
            ${expires}, ${input.nowMs}, ${input.nowMs})
    ON CONFLICT (workspace_id, trusted_github_user_id) DO UPDATE SET
      tier = EXCLUDED.tier,
      note = EXCLUDED.note,
      expires_at = EXCLUDED.expires_at,
      updated_ts = EXCLUDED.updated_ts
    RETURNING trusted_github_user_id, tier, gate, note, expires_at, created_ts, updated_ts`;
  await recordCommsTrustAudit(sql, input.actor, 'trust:comms-set', String(input.githubUserId), workspaceId, {
    tier: input.tier,
    ...(input.expiresAtMs ? { expiresAtMs: input.expiresAtMs } : {}),
  });
  return rowToEntry(row!);
}

/** Remove a user's comms override (falls back to the policy default). */
export async function removeCommsTrust(
  workspaceId: string,
  githubUserId: number,
  actor: string,
  sqlIn?: Sql,
): Promise<{ removed: boolean }> {
  if (!workspaceId) throw new Error('comms-trust remove — no workspace');
  assertGithubUserId(githubUserId, 'comms-trust remove');
  const sql = sqlIn ?? getOrgPg().sql;
  const rows = await sql`
    DELETE FROM harness_shared.comms_trust_list
     WHERE workspace_id = ${workspaceId} AND trusted_github_user_id = ${githubUserId}
    RETURNING trusted_github_user_id`;
  const removed = rows.length > 0;
  if (removed) {
    await recordCommsTrustAudit(sql, actor, 'trust:comms-remove', String(githubUserId), workspaceId, {});
  }
  return { removed };
}

export interface SetGateTrustInput {
  githubUserId: number;
  granted: boolean;
  note?: string | null;
  /** epoch ms; omit/null = no expiry. Applies to the ROW (shared with a tier
   *  override when one exists on the same row). */
  expiresAtMs?: number | null;
  actor: string;
  nowMs: number;
}

/**
 * DG-4 (P-047): grant / revoke the GATE trust bit — "this member's
 * distributed-test-gate verdicts count toward green(S)". SEPARABLE from the
 * comms tier: a row created purely for a gate grant stores tier = NULL, which
 * resolution skips, so granting gate never fabricates a tier override.
 * Audited (a gate grant lets a member green YOUR release).
 */
export async function setGateTrust(
  workspaceId: string,
  input: SetGateTrustInput,
  sqlIn?: Sql,
): Promise<CommsTrustEntry> {
  if (!workspaceId) throw new Error('gate-trust set — no workspace');
  assertGithubUserId(input.githubUserId, 'gate-trust set');
  const sql = sqlIn ?? getOrgPg().sql;
  const expires = input.expiresAtMs == null ? null : new Date(input.expiresAtMs);
  // ON CONFLICT touches ONLY gate/expiry/updated_ts — an existing tier
  // override (and its note) on the same row survives a gate flip.
  const [row] = await sql<CommsTrustRow[]>`
    INSERT INTO harness_shared.comms_trust_list
      (workspace_id, trusted_github_user_id, tier, gate, note, expires_at, created_ts, updated_ts)
    VALUES (${workspaceId}, ${input.githubUserId}, NULL, ${input.granted},
            ${input.note ?? null}, ${expires}, ${input.nowMs}, ${input.nowMs})
    ON CONFLICT (workspace_id, trusted_github_user_id) DO UPDATE SET
      gate = EXCLUDED.gate,
      expires_at = EXCLUDED.expires_at,
      updated_ts = EXCLUDED.updated_ts
    RETURNING trusted_github_user_id, tier, gate, note, expires_at, created_ts, updated_ts`;
  await recordCommsTrustAudit(
    sql,
    input.actor,
    input.granted ? 'trust:gate-grant' : 'trust:gate-revoke',
    String(input.githubUserId),
    workspaceId,
    input.expiresAtMs ? { expiresAtMs: input.expiresAtMs } : {},
  );
  return rowToEntry(row!);
}

/**
 * Is this member gate-trusted RIGHT NOW? True iff an unexpired row carries
 * gate = true. FAIL-CLOSED: no row, expired row, or a store error ⇒ false —
 * the aggregator must never count a verdict on a defective trust read.
 */
export async function hasGateGrant(
  workspaceId: string,
  githubUserId: number,
  nowMs?: number,
  sqlIn?: Sql,
): Promise<boolean> {
  if (!workspaceId || !Number.isInteger(githubUserId) || githubUserId <= 0) return false;
  const now = nowMs ?? Date.now();
  try {
    const sql = sqlIn ?? getOrgPg().sql;
    const rows = await sql<Array<{ gate: boolean | null; expires_at: Date | string | null }>>`
      SELECT gate, expires_at
        FROM harness_shared.comms_trust_list
       WHERE workspace_id = ${workspaceId}
         AND trusted_github_user_id = ${githubUserId}
       LIMIT 1`;
    if (rows.length === 0) return false;
    const r = rows[0];
    if (r.gate !== true) return false;
    return r.expires_at == null || new Date(r.expires_at).getTime() > now;
  } catch {
    return false;
  }
}

export interface EffectiveCommsTier {
  tier: CommsTier;
  source: 'override' | 'policy' | 'fallback';
}

export interface EffectiveCommsTierDeps {
  /** The owner-signed hive-policy default (P-012: hive_policy.comms.defaultTier).
   *  Injected; production binds getHivePolicy. Null/invalid → policy leg skipped. */
  loadPolicyDefaultTier: (workspaceId: string, potHomeSlug: string) => Promise<unknown>;
}

const defaultDeps: EffectiveCommsTierDeps = {
  loadPolicyDefaultTier: async (workspaceId, potHomeSlug) => {
    const { getHivePolicy } = await import('../hive-policy-store');
    const policy = await getHivePolicy(workspaceId, potHomeSlug);
    return (policy?.policy as { comms?: { defaultTier?: unknown } } | null | undefined)?.comms
      ?.defaultTier;
  },
};

/**
 * Resolve the sender-user's EFFECTIVE comms tier toward this owner:
 * non-expired local override → hive-policy default → FALLBACK_COMMS_TIER.
 * Fail-soft: a store/policy read error resolves to the fallback (enforcement
 * must never throw at the projection chokepoint).
 */
export async function effectiveCommsTier(
  input: {
    workspaceId: string;
    potHomeSlug: string;
    githubUserId: number;
    nowMs?: number;
  },
  deps: EffectiveCommsTierDeps = defaultDeps,
  sqlIn?: Sql,
): Promise<EffectiveCommsTier> {
  const now = input.nowMs ?? Date.now();
  try {
    const sql = sqlIn ?? getOrgPg().sql;
    const rows = await sql<CommsTrustRow[]>`
      SELECT trusted_github_user_id, tier, gate, note, expires_at, created_ts, updated_ts
        FROM harness_shared.comms_trust_list
       WHERE workspace_id = ${input.workspaceId}
         AND trusted_github_user_id = ${input.githubUserId}
       LIMIT 1`;
    if (rows.length > 0) {
      const entry = rowToEntry(rows[0]);
      // A null tier is NOT an override (the row may exist only for a gate
      // grant, mig 443) — fall through to the policy default.
      if (entry.tier !== null && (entry.expiresAtMs == null || entry.expiresAtMs > now)) {
        return { tier: entry.tier, source: 'override' };
      }
    }
  } catch {
    /* fall through to policy/fallback */
  }
  try {
    const policyTier = await deps.loadPolicyDefaultTier(input.workspaceId, input.potHomeSlug);
    if (isCommsTier(policyTier)) return { tier: policyTier, source: 'policy' };
  } catch {
    /* fall through */
  }
  return { tier: FALLBACK_COMMS_TIER, source: 'fallback' };
}

/** Audit append (fire-safe — mirrors user-trust-list's recordTrustAudit). */
async function recordCommsTrustAudit(
  sql: Sql,
  actor: string,
  action: string,
  subject: string,
  workspaceId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    const id = `ctrust-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql`
      INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (${id}, ${Date.now()}, ${actor}, ${action}, ${subject},
              ${JSON.stringify(extra)}::text::jsonb, ${workspaceId})`;
  } catch {
    /* never block the grant write on the audit */
  }
}
