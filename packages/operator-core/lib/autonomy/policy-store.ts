/**
 * policy-store.ts — DB access for the per-category autonomy policy
 * (queen-autonomy-policy-2026-06-13 B-03 / P-021, P-022).
 *
 * Backs `harness_shared.autonomy_policy` (migration 259). The pure value type +
 * gate arithmetic live in {@link ./policy}; the taxonomy in {@link ./categories};
 * the risk vocabulary in {@link ./risk-tiers}. The tools ({@link
 * ../agent-tools/autonomy/get}, {@link ../agent-tools/autonomy/set}) and the sync
 * resolver call these; tests call them directly against a real PG.
 *
 * Every function takes the `postgres` client explicitly (the admin handle from
 * `getOrgPg().sql` in production, a test client under integration) so the store
 * is decoupled from connection management and trivially testable.
 *
 * Fail-safe posture (D-007, D-010): a read for a (workspace, category) with no
 * stored row returns the behavior-neutral default (never-auto) — so an unseeded
 * workspace, or a pre-boot-apply table-missing state, is already correct and an
 * unknown category never auto-decides.
 */
import type { Sql } from 'postgres';
import type { AutonomyCeiling } from '@papercusp/plan-parser';
import { type AutonomyCategory, AUTONOMY_CATEGORY_IDS, isAutonomyCategory } from './categories';
import {
  type AutonomyCategoryPolicy,
  defaultPolicyFor,
  isAutonomyCeiling,
  minCeiling,
} from './policy';
import { trackDetached } from '../detached-imports';

/** PG error code for "relation does not exist" — table not applied yet. */
const UNDEFINED_TABLE = '42P01';

interface PolicyRow {
  category: string;
  ceiling: string;
  locked: boolean;
  graduated_level: string;
  threshold_overrides: Record<string, unknown> | null;
  owner_override: Record<string, unknown> | null;
}

/** Normalize a raw DB row into the value type, defensively clamping levels. */
function rowToPolicy(r: PolicyRow): AutonomyCategoryPolicy {
  const category = r.category as AutonomyCategory;
  const ceiling: AutonomyCeiling = isAutonomyCeiling(r.ceiling) ? r.ceiling : 'never-auto';
  const storedGraduated: AutonomyCeiling = isAutonomyCeiling(r.graduated_level)
    ? r.graduated_level
    : 'never-auto';
  return {
    category,
    ceiling,
    locked: !!r.locked,
    // Graduation never exceeds the ceiling (defensive; the writer also clamps).
    graduatedLevel: minCeiling(storedGraduated, ceiling),
    thresholdOverrides: (r.threshold_overrides ?? {}) as Record<string, unknown>,
    ownerOverride: (r.owner_override ?? null) as Record<string, unknown> | null,
  };
}

/**
 * Read the COMPLETE policy for a workspace: all 13 categories in canonical order
 * (AUTONOMY_CATEGORY_IDS), each as its stored row overlaid on the behavior-neutral
 * default. Guarantees a total view regardless of which rows are seeded, and
 * degrades to all-defaults if the table isn't applied yet (42P01).
 */
export async function readAutonomyPolicy(
  sql: Sql,
  workspaceId: string,
): Promise<AutonomyCategoryPolicy[]> {
  const stored = new Map<AutonomyCategory, AutonomyCategoryPolicy>();
  try {
    const rows = (await sql`
      SELECT category, ceiling, locked, graduated_level, threshold_overrides, owner_override
        FROM harness_shared.autonomy_policy
       WHERE workspace_id = ${workspaceId}`) as unknown as PolicyRow[];
    for (const r of rows) {
      // Ignore rows for ids not in the canonical taxonomy (fail-safe).
      if (isAutonomyCategory(r.category)) stored.set(r.category, rowToPolicy(r));
    }
  } catch (err) {
    if ((err as { code?: string }).code !== UNDEFINED_TABLE) throw err;
  }
  return AUTONOMY_CATEGORY_IDS.map((id) => stored.get(id) ?? defaultPolicyFor(id));
}

/**
 * Read one category's policy (stored row, else the behavior-neutral default).
 * An unknown category id returns its default (protected-aware) — never throws.
 */
export async function getAutonomyCategoryPolicy(
  sql: Sql,
  workspaceId: string,
  category: string,
): Promise<AutonomyCategoryPolicy> {
  const id = category as AutonomyCategory;
  if (!isAutonomyCategory(category)) return defaultPolicyFor(id);
  try {
    const rows = (await sql`
      SELECT category, ceiling, locked, graduated_level, threshold_overrides, owner_override
        FROM harness_shared.autonomy_policy
       WHERE workspace_id = ${workspaceId} AND category = ${category}
       LIMIT 1`) as unknown as PolicyRow[];
    if (rows.length > 0 && isAutonomyCategory(rows[0]!.category)) return rowToPolicy(rows[0]!);
  } catch (err) {
    if ((err as { code?: string }).code !== UNDEFINED_TABLE) throw err;
  }
  return defaultPolicyFor(id);
}

/** Partial update to one category's policy. Omitted fields keep their current value. */
export interface SetAutonomyPolicyInput {
  category: string;
  ceiling?: string;
  locked?: boolean;
  graduatedLevel?: string;
  thresholdOverrides?: Record<string, unknown>;
  /** Pass `null` to clear; omit to leave unchanged. */
  ownerOverride?: Record<string, unknown> | null;
  /** Recorded in the audit row; not stored on the policy. */
  reason?: string;
}

/**
 * Upsert one category's policy, enforcing the invariants and writing an audit
 * row. Returns the resulting (post-clamp) policy.
 *
 * Invariants:
 *  - `category` must be one of the 13 canonical ids (else throws — you can't
 *    create policy for an unmapped category; the gate fails such actions safe).
 *  - `ceiling` / `graduatedLevel`, when provided, must be valid levels (else throws).
 *  - `graduatedLevel` is CLAMPED to ≤ `ceiling` (D-005: graduation moves only
 *    within the owner cap) — the safe direction, never raising autonomy.
 *
 * Note: this does NOT block unlocking a protected category — that is a
 * deliberate, audited OWNER action via the control surface (authority, D-005);
 * the recursion-safety invariant that protected can't *graduate* is B-19's. Per
 * `effectiveCeiling`, a `locked` category is never-auto regardless of ceiling,
 * so autonomy on a protected category requires an explicit unlock.
 */
export async function setAutonomyPolicy(
  sql: Sql,
  workspaceId: string,
  input: SetAutonomyPolicyInput,
  actor: string,
): Promise<AutonomyCategoryPolicy> {
  if (!isAutonomyCategory(input.category)) {
    throw new Error(`autonomy:policy_set — unknown category "${input.category}"`);
  }
  if (input.ceiling !== undefined && !isAutonomyCeiling(input.ceiling)) {
    throw new Error(`autonomy:policy_set — invalid ceiling "${input.ceiling}"`);
  }
  if (input.graduatedLevel !== undefined && !isAutonomyCeiling(input.graduatedLevel)) {
    throw new Error(`autonomy:policy_set — invalid graduated_level "${input.graduatedLevel}"`);
  }
  const category = input.category as AutonomyCategory;
  const current = await getAutonomyCategoryPolicy(sql, workspaceId, category);

  const ceiling: AutonomyCeiling = (input.ceiling ?? current.ceiling) as AutonomyCeiling;
  const locked = input.locked ?? current.locked;
  const requestedGraduated: AutonomyCeiling = (input.graduatedLevel ??
    current.graduatedLevel) as AutonomyCeiling;
  const graduatedLevel = minCeiling(requestedGraduated, ceiling);
  const thresholdOverrides = input.thresholdOverrides ?? current.thresholdOverrides;
  const ownerOverride =
    input.ownerOverride !== undefined ? input.ownerOverride : current.ownerOverride;

  // jsonb columns bound as `${JSON.stringify(v)}::text::jsonb` — the
  // client-agnostic idiom that stores a real jsonb object under BOTH the
  // operator runtime client and the testcontainer client (a bare `::jsonb`
  // double-encodes under the test client). See agent-insights/postgres-js-jsonb-binding.
  await sql`
    INSERT INTO harness_shared.autonomy_policy
      (workspace_id, category, ceiling, locked, graduated_level, threshold_overrides, owner_override, updated_by, updated_at)
    VALUES (${workspaceId}, ${category}, ${ceiling}, ${locked}, ${graduatedLevel},
            ${JSON.stringify(thresholdOverrides)}::text::jsonb,
            ${ownerOverride == null ? null : JSON.stringify(ownerOverride)}::text::jsonb,
            ${actor}, now())
    ON CONFLICT (workspace_id, category) DO UPDATE SET
      ceiling = EXCLUDED.ceiling,
      locked = EXCLUDED.locked,
      graduated_level = EXCLUDED.graduated_level,
      threshold_overrides = EXCLUDED.threshold_overrides,
      owner_override = EXCLUDED.owner_override,
      updated_by = EXCLUDED.updated_by,
      updated_at = EXCLUDED.updated_at`;

  await recordAutonomyAudit(sql, actor, 'autonomy:policy_set', category, workspaceId, {
    ceiling,
    locked,
    graduatedLevel,
    ...(input.reason ? { reason: input.reason } : {}),
  });

  // Push-on-write for the Health tab's autonomy panel
  // (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007).
  // Lazy import so this store stays decoupled from the sync/health layers (the
  // same fire-and-forget discipline as the improvements-lane capture/decay/
  // triage/hygiene writes) — a cold health cache makes this a safe no-op.
  void trackDetached(import('../system-health/compute'))
    .then((m) => m.refreshHealthPanel('autonomy', workspaceId))
    .catch(() => {});

  return { category, ceiling, locked, graduatedLevel, thresholdOverrides, ownerOverride };
}

/**
 * Append an `audit_log` row for an autonomy-policy change. Fire-and-forget:
 * the policy write already succeeded; never block it on the audit (mirrors
 * recordFlagAudit / the canonical full-column shape — audit_log has no defaults
 * for `id` / `workspace_id`, so both are always supplied).
 */
export async function recordAutonomyAudit(
  sql: Sql,
  actor: string,
  action: string,
  subject: string,
  workspaceId: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const id = `aut-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // `::text::jsonb` — the client-agnostic jsonb bind (see policy-store upsert).
    await sql`
      INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (${id}, ${Date.now()}, ${actor}, ${action}, ${subject},
              ${JSON.stringify(extra ?? {})}::text::jsonb, ${workspaceId})`;
  } catch (err) {
    console.warn('[autonomy] audit write failed:', (err as Error)?.message);
  }
}
