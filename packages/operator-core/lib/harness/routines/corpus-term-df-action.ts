/**
 * `system:corpus-term-df` — the ephemeral cadence that rebuilds the corpus
 * document-frequency table behind BANDED term selection in `corpusQueryText`
 * (P-018 / D-064). Config (routine `trigger_config`, from
 * corpus-term-df-routine.ts):
 *   - `sample_docs` — optional (default `CORPUS_TERM_DF_SAMPLE_DOCS`).
 *
 * Runs as ONE step and REPLACES the workspace's table transactionally, so it is
 * safe to re-run from the top and a reader never observes a half-built table.
 *
 * An empty corpus sample is treated as "measure nothing, change nothing" rather
 * than as an empty result: wiping a good table would silently drop every
 * workspace query back to length ordering — which D-064 measured as strictly
 * worse — while looking like a successful tick.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getOrgPg } from '@papercusp/db-org';
import { refreshCorpusTermDf } from '../../memory/corpus-term-df';

registerSystemAction('corpus-term-df', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const sampleDocs = Number(cfg.sample_docs);
  const { sql } = getOrgPg();

  const result = await refreshCorpusTermDf(sql, {
    workspaceId: ctx.workspaceId,
    ...(Number.isFinite(sampleDocs) && sampleDocs > 0 ? { sampleDocs } : {}),
  });

  if (result.ndocs === 0) {
    console.warn(
      `[corpus-term-df] ${ctx.workspaceId}: corpus sample was EMPTY — kept the existing table rather than wiping it`,
    );
    return;
  }

  const dropped = result.distinctSeen - result.stored;
  console.log(
    `[corpus-term-df] ${ctx.workspaceId}: folded ${result.ndocs} docs → ` +
      `stored ${result.stored} term(s) with df ≥ ${result.minDf}, ` +
      `dropped ${dropped} unattested (${((100 * dropped) / Math.max(1, result.distinctSeen)).toFixed(1)}% of the vocabulary)`,
  );
});
