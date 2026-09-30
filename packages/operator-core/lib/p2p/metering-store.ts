/**
 * metering-store.ts — the DURABLE IO edge for the P-205 metering + contribution
 * ledger (p2p-work-distribution-2026-07-02, WI-1938 [seq 3 of the wiring plan]).
 *
 * The DECISION CORE is metering-ledger.ts (pure — M22 per-attested-user cap,
 * H14 unit discipline, privacy projection). This module owns ONLY persistence,
 * backed by harness_shared.p2p_metering_spend / p2p_metering_contribution
 * (mig 483): each durable write runs the pure fn against the CURRENT counter row
 * inside a transaction (SELECT … FOR UPDATE → pure decision → UPSERT), so the
 * pure core stays the single source of the accumulate/refuse/cap semantics and
 * two concurrent draws serialize on the row, never lost-update.
 *
 * LOCAL-ONLY, never federated (PRIVACY — the raw ledger holds account totals +
 * per-user breakdowns that must not leave the machine; peers see only the
 * advertised projection metering-ledger.ts builds). Same store conventions as
 * resource-allotments.ts: getOrgPg().sql, `sqlOverride` for tests, and the
 * WI-1564 one-helper workspace resolver invariant.
 *
 * WIRED BY (when those legs land — the WI-1938 scope is the durable substrate):
 * a foreign-session spawn leg records spend as foreign sessions draw (the old
 * offer-executor leg was deleted as dead under D-023/D-092); the lease/serve
 * path records contribution. Until then the only
 * callers are the drill + tests — the LIVE-2 drill's METERING skip flips when
 * real rows flow, not at table creation.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from '../work-items';
import type { BudgetAxis, BudgetUnit } from './offer-budget';
import {
  emptyMeteringLedger,
  recordContribution,
  recordSpend,
  type MeteringLedger,
  type RecordContributionResult,
  type RecordSpendResult,
} from './metering-ledger';
import { resolveAllotmentWorkspace } from './resource-allotments';

/**
 * WI-1564 one-helper invariant: writer and reader resolve the workspace the
 * SAME way. Delegates to the allotment resolver — identical partition rules
 * (concrete, non-'*', non-'default'), and the two stores are siblings on the
 * same LOCAL/per-machine plane.
 */
export function resolveMeteringWorkspace(
  identWorkspaceId: string | null | undefined,
): string | undefined {
  return resolveAllotmentWorkspace(identWorkspaceId);
}

interface SpendRow {
  host_ref: string;
  fleet_slug: string;
  axis: string;
  amount: number | string;
  unit: string;
}
interface ContributionRow {
  attested_user_id: string;
  axis: string;
  amount: number | string;
  unit: string;
}

export type MeteringWorkspaceRefusal = {
  ok: false;
  code: 'workspace_unresolved';
  detail: string;
};

const WS_REFUSAL: MeteringWorkspaceRefusal = {
  ok: false,
  code: 'workspace_unresolved',
  detail:
    "Metering write refused: unresolvable workspace partition (WI-1564 — a ledger row under 'default' is unattributable). Thread the caller's identity.workspaceId (resolveMeteringWorkspace).",
};

export interface RecordSpendDurableArgs {
  /** The caller's RESOLVED identity workspace. */
  workspaceId: string | null | undefined;
  hostRef: string;
  fleetSlug: string;
  axis: BudgetAxis;
  amount: number;
  unit: BudgetUnit;
}

/**
 * Durably record a committed draw. Transactional read-decide-write: the pure
 * core sees exactly the persisted counter, so its H14 unit-mismatch refusal and
 * accumulate math ARE the durable semantics. Refusals write nothing.
 */
export async function recordSpendDurable(
  args: RecordSpendDurableArgs,
  sqlOverride?: OrgSql,
): Promise<RecordSpendResult | MeteringWorkspaceRefusal> {
  const ws = resolveMeteringWorkspace(args.workspaceId);
  if (!ws) return WS_REFUSAL;
  const sql = sqlOverride ?? getOrgPg().sql;
  return (await sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT host_ref, fleet_slug, axis, amount, unit
        FROM harness_shared.p2p_metering_spend
       WHERE workspace_id = ${ws} AND host_ref = ${args.hostRef}
         AND fleet_slug = ${args.fleetSlug} AND axis = ${args.axis}
       FOR UPDATE
    `) as unknown as SpendRow[];
    const seeded = seedSpend(rows);
    const decision = recordSpend(seeded, {
      hostRef: args.hostRef,
      fleetSlug: args.fleetSlug,
      axis: args.axis,
      amount: args.amount,
      unit: args.unit,
    });
    if (!decision.ok) return decision;
    await tx`
      INSERT INTO harness_shared.p2p_metering_spend
        (workspace_id, host_ref, fleet_slug, axis, amount, unit, updated_at)
      VALUES (${ws}, ${args.hostRef}, ${args.fleetSlug}, ${args.axis}, ${decision.total}, ${args.unit}, now())
      ON CONFLICT (workspace_id, host_ref, fleet_slug, axis)
      DO UPDATE SET amount = ${decision.total}, updated_at = now()
    `;
    return decision;
  })) as RecordSpendResult;
}

export interface RecordContributionDurableArgs {
  workspaceId: string | null | undefined;
  /** M22: the ATTESTED numeric gh user id (string form) — never a device ref. */
  attestedUserId: string;
  axis: BudgetAxis;
  amount: number;
  unit: BudgetUnit;
  /** M22 cap; null = uncapped (test/host-local use). */
  perUserCap: number | null;
}

/**
 * Durably credit served contribution to an attested user, M22-capped by the
 * pure core against the PERSISTED total (so the cap holds across restarts and
 * across every device of the same user).
 */
export async function recordContributionDurable(
  args: RecordContributionDurableArgs,
  sqlOverride?: OrgSql,
): Promise<RecordContributionResult | MeteringWorkspaceRefusal> {
  const ws = resolveMeteringWorkspace(args.workspaceId);
  if (!ws) return WS_REFUSAL;
  const sql = sqlOverride ?? getOrgPg().sql;
  return (await sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT attested_user_id, axis, amount, unit
        FROM harness_shared.p2p_metering_contribution
       WHERE workspace_id = ${ws} AND attested_user_id = ${args.attestedUserId}
         AND axis = ${args.axis}
       FOR UPDATE
    `) as unknown as ContributionRow[];
    const seeded = seedContribution(rows);
    const decision = recordContribution(seeded, {
      attestedUserId: args.attestedUserId,
      axis: args.axis,
      amount: args.amount,
      unit: args.unit,
      perUserCap: args.perUserCap,
    });
    if (!decision.ok) return decision;
    await tx`
      INSERT INTO harness_shared.p2p_metering_contribution
        (workspace_id, attested_user_id, axis, amount, unit, updated_at)
      VALUES (${ws}, ${args.attestedUserId}, ${args.axis}, ${decision.total}, ${args.unit}, now())
      ON CONFLICT (workspace_id, attested_user_id, axis)
      DO UPDATE SET amount = ${decision.total}, updated_at = now()
    `;
    return decision;
  })) as RecordContributionResult;
}

/**
 * Load the whole persisted ledger for a workspace, REPLAYED through the pure
 * core (fold over recordSpend/recordContribution with the cap disabled — the
 * persisted totals are already post-cap), so key derivation lives in exactly
 * one place and the loaded shape is bit-identical to an in-memory ledger.
 */
export async function loadMeteringLedger(
  workspaceId: string | null | undefined,
  sqlOverride?: OrgSql,
): Promise<MeteringLedger> {
  const ws = resolveMeteringWorkspace(workspaceId);
  if (!ws) return emptyMeteringLedger();
  const sql = sqlOverride ?? getOrgPg().sql;
  const [spendRows, contribRows] = await Promise.all([
    sql`
      SELECT host_ref, fleet_slug, axis, amount, unit
        FROM harness_shared.p2p_metering_spend WHERE workspace_id = ${ws}
    ` as unknown as Promise<SpendRow[]>,
    sql`
      SELECT attested_user_id, axis, amount, unit
        FROM harness_shared.p2p_metering_contribution WHERE workspace_id = ${ws}
    ` as unknown as Promise<ContributionRow[]>,
  ]);
  return seedContribution(contribRows, seedSpend(spendRows));
}

/** Fold spend rows through the pure core (zero-amount rows are skipped: the core refuses <= 0). */
function seedSpend(rows: readonly SpendRow[], base?: MeteringLedger): MeteringLedger {
  let ledger = base ?? emptyMeteringLedger();
  for (const r of rows) {
    const amount = Number(r.amount);
    if (!(amount > 0)) continue;
    const res = recordSpend(ledger, {
      hostRef: r.host_ref,
      fleetSlug: r.fleet_slug,
      axis: r.axis as BudgetAxis,
      amount,
      unit: r.unit as BudgetUnit,
    });
    if (res.ok) ledger = res.ledger;
  }
  return ledger;
}

function seedContribution(rows: readonly ContributionRow[], base?: MeteringLedger): MeteringLedger {
  let ledger = base ?? emptyMeteringLedger();
  for (const r of rows) {
    const amount = Number(r.amount);
    if (!(amount > 0)) continue;
    const res = recordContribution(ledger, {
      attestedUserId: r.attested_user_id,
      axis: r.axis as BudgetAxis,
      amount,
      unit: r.unit as BudgetUnit,
      perUserCap: null, // persisted totals are already post-cap
    });
    if (res.ok) ledger = res.ledger;
  }
  return ledger;
}
