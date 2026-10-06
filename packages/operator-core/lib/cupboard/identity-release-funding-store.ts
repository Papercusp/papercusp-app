/**
 * Local store for the identity activation gate (agent-economy-flywheel-2026-08-30
 * P-016, decision D-011): `harness_shared.identity_release_funding` holds, per
 * workspace and identity release, the cached pricing verdict and the hosted
 * payment channel bound to pay for it.
 *
 * A LEAF module on purpose. The commerce checkout door binds a channel through it,
 * and that door is compiled into apps/operator-public (the Worker). Reaching it
 * through `identity-activation-gate-io.ts` dragged the layer resolver — blueprint
 * releases, installed blueprints, and from there most of operator-core — into the
 * Worker's stricter typecheck (EI-24768138245089371). Keep its imports to types,
 * the pure gate module and the SKU helpers.
 */
import type { Sql } from 'postgres';
import type { IdentityPricingVerdict } from './identity-activation-gate';
import { isIdentityReleaseSkuRef } from './identity-per-use-offer';

export type IdentityChannelSource = 'per-use-checkout' | 'explicit';

/** One row of `harness_shared.identity_release_funding`. */
export interface IdentityReleaseFundingRow {
  readonly skuRef: string;
  readonly channelId: string | null;
  readonly pricingState: 'free' | 'priced' | null;
  readonly pricingOfferId: string | null;
  readonly pricingUnitMicros: number | null;
  readonly pricingCheckedAtMs: number | null;
}

export async function readIdentityReleaseFunding(
  sql: Sql,
  workspaceId: string,
  skuRefs: readonly string[],
): Promise<Map<string, IdentityReleaseFundingRow>> {
  if (skuRefs.length === 0) return new Map();
  const rows = await sql<{
    sku_ref: string; channel_id: string | null; pricing_state: 'free' | 'priced' | null;
    pricing_offer_id: string | null; pricing_unit_micros: string | number | null; pricing_checked_at: Date | null;
  }[]>`
    SELECT sku_ref, channel_id, pricing_state, pricing_offer_id, pricing_unit_micros, pricing_checked_at
      FROM harness_shared.identity_release_funding
     WHERE workspace_id = ${workspaceId} AND sku_ref = ANY(${[...skuRefs]}::text[])`;
  return new Map(rows.map((row) => [row.sku_ref, {
    skuRef: row.sku_ref,
    channelId: row.channel_id,
    pricingState: row.pricing_state,
    pricingOfferId: row.pricing_offer_id,
    pricingUnitMicros: row.pricing_unit_micros === null ? null : Number(row.pricing_unit_micros),
    pricingCheckedAtMs: row.pricing_checked_at ? row.pricing_checked_at.getTime() : null,
  }]));
}

/** Cache a pricing verdict read from the hosted offers. Unverifiable verdicts are never cached. */
export async function recordIdentityReleasePricing(
  sql: Sql,
  workspaceId: string,
  skuRef: string,
  verdict: IdentityPricingVerdict,
): Promise<void> {
  if (verdict.kind === 'unverifiable') return;
  const offerId = verdict.kind === 'priced' ? verdict.offerId : null;
  const unitMicros = verdict.kind === 'priced' ? verdict.unitPriceMicros : null;
  await sql`
    INSERT INTO harness_shared.identity_release_funding
      (workspace_id, sku_ref, pricing_state, pricing_offer_id, pricing_unit_micros, pricing_checked_at)
    VALUES (${workspaceId}, ${skuRef}, ${verdict.kind}, ${offerId}, ${unitMicros}, now())
    ON CONFLICT (workspace_id, sku_ref) DO UPDATE SET
      pricing_state = EXCLUDED.pricing_state,
      pricing_offer_id = EXCLUDED.pricing_offer_id,
      pricing_unit_micros = EXCLUDED.pricing_unit_micros,
      pricing_checked_at = EXCLUDED.pricing_checked_at,
      updated_at = now()`;
}

/**
 * Record which hosted payment channel pays for an identity release (D-011).
 * Callers confirm the channel first: the per-use checkout preflight names it, or
 * the explicit bind door has read it back from the owner-only hosted route.
 */
export async function bindIdentityReleaseFundingChannel(
  sql: Sql,
  input: {
    readonly workspaceId: string;
    readonly skuRef: string;
    readonly channelId: string;
    readonly source: IdentityChannelSource;
    readonly boundBy: string;
  },
): Promise<void> {
  if (!isIdentityReleaseSkuRef(input.skuRef)) throw new Error(`not an identity release skuRef: ${input.skuRef}`);
  if (!input.channelId.trim()) throw new Error('a funding channel binding needs a channelId');
  await sql`
    INSERT INTO harness_shared.identity_release_funding
      (workspace_id, sku_ref, channel_id, channel_source, channel_bound_by, channel_bound_at)
    VALUES (${input.workspaceId}, ${input.skuRef}, ${input.channelId}, ${input.source}, ${input.boundBy}, now())
    ON CONFLICT (workspace_id, sku_ref) DO UPDATE SET
      channel_id = EXCLUDED.channel_id,
      channel_source = EXCLUDED.channel_source,
      channel_bound_by = EXCLUDED.channel_bound_by,
      channel_bound_at = EXCLUDED.channel_bound_at,
      updated_at = now()`;
}
