/**
 * model-pricing-sync — keep `harness_shared.model_pricing` a live projection of the
 * canonical in-code price table (B-TOK-ROLL, token-tracking-plan-and-briefs-2026-06-20).
 *
 * `@papercusp/model-pricing`'s MODEL_PRICES is the SINGLE source of truth for list
 * prices (cross-backend-cost-capture D-002-A: "update THIS table only"). The DB
 * `model_pricing` table (migration 334) is a DERIVED PROJECTION used for SQL-side
 * $-transparency (showing the per-MTok rates — especially the cache-read tier, which
 * is ~82-92% of all tokens) + effective-dated history. This helper UPSERTs MODEL_PRICES
 * → the table so the projection never drifts: it runs at boot (host-bootstrap, right
 * after the migration apply) and is safe to call on-demand.
 *
 * Cache rates are materialized EXPLICITLY (not as multipliers) so SQL can price
 * directly: cache_read = cacheRead ?? in×0.1, cache_creation = cacheWrite ?? in×1.25
 * (the same defaults `costFromTokens` applies).
 *
 * Best-effort: a pricing-table sync must never wedge boot (the table is for display /
 * audit; cost_usd is already stored per sample). Pure row-builder + a thin DB writer.
 */
import { MODEL_PRICES, type ModelPrice } from '@papercusp/model-pricing';
import { getOrgPg } from '@papercusp/db-org';

export interface ModelPricingRow {
  modelId: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheCreationPerMtok: number;
}

/** Materialize the explicit per-MTok rates for one MODEL_PRICES entry (pure). */
export function pricingRowFor(modelId: string, p: ModelPrice): ModelPricingRow {
  return {
    modelId,
    inputPerMtok: p.in,
    outputPerMtok: p.out,
    cacheReadPerMtok: p.cacheRead ?? p.in * 0.1,
    cacheCreationPerMtok: p.cacheWrite ?? p.in * 1.25,
  };
}

/** Build the full projection row-set from the canonical MODEL_PRICES table (pure). */
export function buildPricingRows(prices: Record<string, ModelPrice> = MODEL_PRICES): ModelPricingRow[] {
  return Object.entries(prices).map(([modelId, p]) => pricingRowFor(modelId, p));
}

/**
 * UPSERT the canonical MODEL_PRICES into harness_shared.model_pricing. Idempotent;
 * a price change in MODEL_PRICES updates the row (and bumps effective_date/updated_at).
 * Best-effort — never throws into the boot path.
 */
export async function syncModelPricingFromCode(): Promise<{ synced: number } | null> {
  try {
    const { sql } = getOrgPg();
    const rows = buildPricingRows();
    let synced = 0;
    for (const r of rows) {
      await sql`
        INSERT INTO harness_shared.model_pricing
          (model_id, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_creation_per_mtok,
           effective_date, source, updated_at)
        VALUES (
          ${r.modelId}, ${r.inputPerMtok}, ${r.outputPerMtok}, ${r.cacheReadPerMtok}, ${r.cacheCreationPerMtok},
          CURRENT_DATE, 'code-table', now())
        ON CONFLICT (model_id) DO UPDATE SET
          input_per_mtok          = EXCLUDED.input_per_mtok,
          output_per_mtok         = EXCLUDED.output_per_mtok,
          cache_read_per_mtok     = EXCLUDED.cache_read_per_mtok,
          cache_creation_per_mtok = EXCLUDED.cache_creation_per_mtok,
          effective_date          = EXCLUDED.effective_date,
          source                  = EXCLUDED.source,
          updated_at              = now()
        WHERE
          harness_shared.model_pricing.input_per_mtok          IS DISTINCT FROM EXCLUDED.input_per_mtok
          OR harness_shared.model_pricing.output_per_mtok         IS DISTINCT FROM EXCLUDED.output_per_mtok
          OR harness_shared.model_pricing.cache_read_per_mtok     IS DISTINCT FROM EXCLUDED.cache_read_per_mtok
          OR harness_shared.model_pricing.cache_creation_per_mtok IS DISTINCT FROM EXCLUDED.cache_creation_per_mtok
      `;
      synced++;
    }
    return { synced };
  } catch {
    /* projection sync is best-effort; never wedge the boot path */
    return null;
  }
}
