import { getOrgPg } from '@papercusp/db-org';
import { buildSidecarAwareEmbedder } from '../memory/embed-sidecar-wiring';
import { backfillTable, type BackfillStats, type BackfillTarget } from '../search/embed-backfill';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';

export const PERSONAL_EMBEDDER_MODE = 'gemma' as const;
export const PERSONAL_EMBED_MAX_ROWS_PER_TICK = 16;

export const PERSONAL_EMBED_TARGET: BackfillTarget = {
  table: 'harness_shared.personal_documents',
  embedCol: 'embedding',
  bodySql: `left(COALESCE(title, '') || E'\\n' || COALESCE(text, ''), 2000)`,
  keyCols: ['workspace_id', 'user_id', 'id'],
  orderBySql: 'imported_at DESC',
  recencyCol: 'imported_at',
  recencyColKind: 'timestamptz',
};

export async function buildPersonalDocumentEmbedder() {
  return buildSidecarAwareEmbedder(PERSONAL_EMBEDDER_MODE, 'document');
}

export async function buildPersonalQueryEmbedder() {
  return buildSidecarAwareEmbedder(PERSONAL_EMBEDDER_MODE, 'query');
}

/** Bounded local-only pass. It deliberately rides the existing governed 5-minute
 * embed-backfill tick instead of introducing another scheduler. */
export async function runPersonalVaultEmbedBackfillOnce(): Promise<BackfillStats | { skipped: string }> {
  const { sql } = getOrgPg();
  const columns = await sql<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'harness_shared' AND table_name = 'personal_documents'
       AND column_name IN ('embedding', 'embedding_mode', 'embedding_profile')`;
  const names = new Set(columns.map((r) => r.column_name));
  if (!names.has('embedding')) return { skipped: 'personal_documents.embedding unavailable' };
  const embed = await buildPersonalDocumentEmbedder();
  return backfillTable(
    sql,
    PERSONAL_EMBED_TARGET,
    embed,
    PERSONAL_EMBED_MAX_ROWS_PER_TICK,
    PERSONAL_EMBEDDER_MODE,
    names.has('embedding_mode'),
    undefined,
    {
      profileColPresent: names.has('embedding_profile'),
      profile: EMBEDDER_DIM_SPECS[PERSONAL_EMBEDDER_MODE],
    },
  );
}
